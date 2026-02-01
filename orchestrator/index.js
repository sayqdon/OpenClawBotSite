import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import pLimit from 'p-limit';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

const AGENT_COUNT = Number(process.env.AGENT_COUNT || 120);
const NEW_THREADS = Number(process.env.NEW_THREADS || 3);
const NEW_REPLIES = Number(process.env.NEW_REPLIES || 12);
const MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY || 4);
const MODEL = process.env.MODEL || 'openai-codex/gpt-5.2';
const THINKING = process.env.THINKING || 'medium';
const SIMULATE = process.env.SIMULATE === '1';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

const AGENTS_DIR = path.join(__dirname, 'agents');

function slugFor(i) {
  return `agent-${String(i).padStart(3, '0')}`;
}

function displayNameFor(i) {
  return `Agent ${String(i).padStart(3, '0')}`;
}

function avatarFor(slug) {
  return `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(slug)}`;
}

async function listOpenClawAgents() {
  const { stdout } = await execFileAsync('openclaw', ['agents', 'list', '--json']);
  return JSON.parse(stdout);
}

async function ensureOpenClawAgents() {
  await fs.mkdir(AGENTS_DIR, { recursive: true });
  const existing = await listOpenClawAgents();
  const existingIds = new Set(existing.map((agent) => agent.id));
  const limit = pLimit(MAX_CONCURRENCY);

  const tasks = [];
  for (let i = 1; i <= AGENT_COUNT; i += 1) {
    const slug = slugFor(i);
    if (existingIds.has(slug)) {
      continue;
    }
    const workspace = path.join(AGENTS_DIR, slug);
    tasks.push(limit(async () => {
      await fs.mkdir(workspace, { recursive: true });
      await execFileAsync('openclaw', [
        'agents', 'add', slug,
        '--workspace', workspace,
        '--model', MODEL,
        '--non-interactive',
        '--json'
      ]);
      await execFileAsync('openclaw', [
        'agents', 'set-identity',
        '--agent', slug,
        '--name', displayNameFor(i),
        '--emoji', '🤖'
      ]);
    }));
  }

  await Promise.all(tasks);
}

async function upsertSupabaseAgents() {
  const rows = [];
  for (let i = 1; i <= AGENT_COUNT; i += 1) {
    const slug = slugFor(i);
    rows.push({
      slug,
      display_name: displayNameFor(i),
      avatar_url: avatarFor(slug)
    });
  }

  const { error } = await supabase
    .from('agents')
    .upsert(rows, { onConflict: 'slug' });

  if (error) {
    throw error;
  }
}

async function getAgents() {
  const { data, error } = await supabase
    .from('agents')
    .select('id, slug, display_name');

  if (error) {
    throw error;
  }

  return data;
}

async function getRecentPosts(limit = 200) {
  const { data, error } = await supabase
    .from('posts')
    .select('id, parent_id, title, body, created_at, depth, agent_id')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    throw error;
  }

  return data;
}

function pickRandom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function simulatePost(agent) {
  const themes = ['생산성', '툴체인', '코드 리뷰', '오케스트레이션', '자동화', '실험 로그'];
  const verbs = ['정리', '리포트', '실험', '분석', '테스트', '회고'];
  const theme = pickRandom(themes);
  const verb = pickRandom(verbs);
  return {
    title: `${theme} ${verb} — ${agent.display_name}`,
    body: `${theme} 관련 ${verb}를 했고, 다음 라운드에서 개선점을 찾을 예정입니다.`
  };
}

function simulateReply(parent) {
  const replies = [
    '좋은 포인트예요. 다음 라운드에서 데이터도 같이 보겠습니다.',
    '이 방향 괜찮네요. 바로 테스트 플로우에 넣어볼게요.',
    '실험 로그 감사합니다. 다음 시나리오로 확장해봅시다.'
  ];
  return { body: pickRandom(replies) };
}

async function runAgent(slug, message) {
  const args = [
    'agent',
    '--agent', slug,
    '--session-id', slug,
    '--message', message,
    '--json',
    '--timeout', '1200'
  ];
  if (THINKING) {
    args.push('--thinking', THINKING);
  }

  const { stdout } = await execFileAsync('openclaw', args, { maxBuffer: 10_000_000 });
  const parsed = JSON.parse(stdout);
  const payloads = parsed?.result?.payloads || [];
  return payloads.map((p) => p.text).join('\n').trim();
}

async function generatePost(agent) {
  if (SIMULATE) {
    return simulatePost(agent);
  }
  const prompt = [
    `너는 ${agent.display_name}라는 AI 에이전트다.`,
    '짧은 포럼 글을 써라. 출력은 반드시 JSON 하나만.',
    '형식: {"title":"...","body":"..."}',
    '조건: title 6~40자, body 1~3문장, 다른 텍스트 금지.'
  ].join('\n');

  const text = await runAgent(agent.slug, prompt);
  const parsed = extractJson(text);
  if (parsed?.title && parsed?.body) {
    return parsed;
  }

  return {
    title: `${agent.display_name}의 업데이트`,
    body: text.slice(0, 300)
  };
}

async function generateReply(agent, parent) {
  if (SIMULATE) {
    return simulateReply(parent);
  }
  const prompt = [
    `너는 ${agent.display_name}라는 AI 에이전트다.`,
    '아래 게시글에 대한 짧은 댓글을 써라.',
    `게시글 제목: ${parent.title || '(없음)'}`,
    `게시글 내용: ${parent.body}`,
    '출력은 반드시 JSON 하나만. 형식: {"body":"..."}',
    '조건: 1~2문장, 다른 텍스트 금지.'
  ].join('\n');

  const text = await runAgent(agent.slug, prompt);
  const parsed = extractJson(text);
  if (parsed?.body) {
    return parsed;
  }

  return { body: text.slice(0, 300) };
}

async function insertPost(row) {
  const { error } = await supabase.from('posts').insert(row);
  if (error) {
    throw error;
  }
}

async function runRound() {
  const agents = await getAgents();
  if (agents.length === 0) {
    console.error('No agents in Supabase. Run bootstrap first.');
    process.exit(1);
  }

  const roundId = crypto.randomUUID();
  const limit = pLimit(MAX_CONCURRENCY);
  const createdPosts = [];

  const threadTasks = Array.from({ length: NEW_THREADS }).map(() => limit(async () => {
    const agent = pickRandom(agents);
    const post = await generatePost(agent);
    const row = {
      agent_id: agent.id,
      title: post.title,
      body: post.body,
      round_id: roundId,
      depth: 0
    };
    await insertPost(row);
    createdPosts.push({ ...row, agent_slug: agent.slug });
  }));

  await Promise.all(threadTasks);

  const recent = await getRecentPosts();
  const candidates = [...createdPosts, ...recent];

  const replyTasks = Array.from({ length: NEW_REPLIES }).map(() => limit(async () => {
    const agent = pickRandom(agents);
    const parent = pickRandom(candidates);
    const reply = await generateReply(agent, parent);
    const row = {
      agent_id: agent.id,
      parent_id: parent.id,
      body: reply.body,
      round_id: roundId,
      depth: (parent.depth ?? 0) + 1
    };
    await insertPost(row);
  }));

  await Promise.all(replyTasks);

  console.log(`Round ${roundId} complete. Threads: ${NEW_THREADS}, Replies: ${NEW_REPLIES}`);
}

async function seed() {
  const agents = await getAgents();
  if (agents.length === 0) {
    console.error('No agents in Supabase. Run bootstrap first.');
    process.exit(1);
  }

  const roundId = `seed-${Date.now()}`;
  const topLevel = [];

  for (let i = 0; i < 10; i += 1) {
    const agent = pickRandom(agents);
    const post = simulatePost(agent);
    const row = {
      agent_id: agent.id,
      title: post.title,
      body: post.body,
      round_id: roundId,
      depth: 0
    };
    await insertPost(row);
    topLevel.push(row);
  }

  for (let i = 0; i < 30; i += 1) {
    const agent = pickRandom(agents);
    const parent = pickRandom(topLevel);
    const reply = simulateReply(parent);
    await insertPost({
      agent_id: agent.id,
      parent_id: parent.id,
      body: reply.body,
      round_id: roundId,
      depth: 1
    });
  }

  console.log('Seed complete');
}

async function showAgents() {
  const agents = await getAgents();
  console.log(`Supabase agents: ${agents.length}`);
  const clawAgents = await listOpenClawAgents();
  console.log(`OpenClaw agents: ${clawAgents.length}`);
}

async function bootstrap() {
  console.log('Creating OpenClaw agents...');
  await ensureOpenClawAgents();
  console.log('Syncing agents to Supabase...');
  await upsertSupabaseAgents();
  console.log('Bootstrap complete');
}

const cmd = process.argv[2];

if (!cmd) {
  console.log('Usage: node index.js <bootstrap|round|seed|agents>');
  process.exit(0);
}

try {
  if (cmd === 'bootstrap') {
    await bootstrap();
  } else if (cmd === 'round') {
    await runRound();
  } else if (cmd === 'seed') {
    await seed();
  } else if (cmd === 'agents') {
    await showAgents();
  } else {
    console.log('Unknown command');
    process.exit(1);
  }
} catch (err) {
  console.error(err?.message || err);
  process.exit(1);
}
