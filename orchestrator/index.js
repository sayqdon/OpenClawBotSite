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

const AGENT_COUNT = Number(process.env.AGENT_COUNT || 100);
const POST_EACH_AGENT = process.env.POST_EACH_AGENT === '1';
const REPLIES_PER_AGENT = Number(process.env.REPLIES_PER_AGENT || 0);
const NEW_THREADS = Number(process.env.NEW_THREADS || 10);
const NEW_REPLIES = Number(process.env.NEW_REPLIES || 30);
const MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY || 6);
const MODEL = process.env.MODEL || 'openai-codex/gpt-5.2-codex';
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
  const role = roleFor(slugFor(i));
  return `Agent ${String(i).padStart(3, '0')} · ${role}`;
}

function avatarFor(slug) {
  return `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(slug)}`;
}

const ROLES = [
  'SRE', '보안 분석가', '제품 매니저', '데이터 분석가', '리서처',
  '프론트엔드 엔지니어', '백엔드 엔지니어', 'ML 엔지니어', 'QA', '운영 매니저',
  '디자이너', '개발자 경험(DX)', '테크 라이터', '성능 최적화', '시스템 아키텍트'
];

const STYLES = [
  '짧고 명확하게', '분석적으로', '대화체로', '꼼꼼하게', '실험 중심으로',
  '체크리스트로', '요약 위주로', '회의록 톤으로'
];

const FOCI = [
  '모니터링', '비용 최적화', '프롬프트 설계', '데이터 품질', '자동화',
  '에러 대응', '성능 개선', '사용성', '보안 강화', '실험 설계'
];

const QUIRKS = [
  '항상 다음 액션을 제안한다', '숫자를 꼭 적는다', '위험요소를 먼저 말한다',
  '짧게 결론부터 말한다', '대안 2개를 함께 제시한다', '메트릭을 강조한다'
];

const EMOJIS = ['🤖', '🧠', '🛠️', '📊', '🧪', '🧭', '🔍', '⚙️', '📌', '🛰️'];

function hashString(value) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) % 1_000_000;
  }
  return hash;
}

function roleFor(slug) {
  const seed = hashString(slug);
  return ROLES[seed % ROLES.length];
}

function personaFor(slug) {
  const seed = hashString(slug);
  const role = ROLES[seed % ROLES.length];
  const style = STYLES[Math.floor(seed / 3) % STYLES.length];
  const focus = FOCI[Math.floor(seed / 7) % FOCI.length];
  const quirk = QUIRKS[Math.floor(seed / 11) % QUIRKS.length];
  return `${role}. 톤: ${style}. 초점: ${focus}. 특징: ${quirk}.`;
}

function emojiFor(slug) {
  const seed = hashString(slug);
  return EMOJIS[seed % EMOJIS.length];
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
        '--theme', roleFor(slug),
        '--emoji', emojiFor(slug)
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
      persona: personaFor(slug),
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
    .select('id, slug, display_name, persona');

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
  const personaLine = agent.persona ? `페르소나: ${agent.persona}` : '';
  const prompt = [
    `너는 ${agent.display_name}라는 AI 에이전트다.`,
    personaLine,
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
  const personaLine = agent.persona ? `페르소나: ${agent.persona}` : '';
  const prompt = [
    `너는 ${agent.display_name}라는 AI 에이전트다.`,
    personaLine,
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

  const threadAgents = POST_EACH_AGENT ? agents : Array.from({ length: NEW_THREADS }).map(() => pickRandom(agents));

  const threadTasks = threadAgents.map((agent) => limit(async () => {
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
  if (candidates.length === 0) {
    console.log(`Round ${roundId} complete. No candidates for replies.`);
    return;
  }

  const replyAgents = REPLIES_PER_AGENT > 0
    ? agents.flatMap((agent) => Array.from({ length: REPLIES_PER_AGENT }).map(() => agent))
    : Array.from({ length: NEW_REPLIES }).map(() => pickRandom(agents));

  const replyTasks = replyAgents.map((agent) => limit(async () => {
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

  const threadsCount = POST_EACH_AGENT ? agents.length : NEW_THREADS;
  const repliesCount = REPLIES_PER_AGENT > 0 ? agents.length * REPLIES_PER_AGENT : NEW_REPLIES;
  console.log(`Round ${roundId} complete. Threads: ${threadsCount}, Replies: ${repliesCount}`);
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
