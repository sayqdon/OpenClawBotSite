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
const ACTIVE_AGENTS = Number(process.env.ACTIVE_AGENTS || 20);
const POST_EACH_AGENT = process.env.POST_EACH_AGENT === '1';
const REPLIES_PER_AGENT = Number(process.env.REPLIES_PER_AGENT || 1);
const VOTES_PER_AGENT = Number(process.env.VOTES_PER_AGENT || 1);
const VOTE_UP_PROB = Number(process.env.VOTE_UP_PROB || 0.7);
const HUMAN_MODE = process.env.HUMAN_MODE === '1';
const ANON_STYLE = process.env.ANON_STYLE === '1';
const AI_MODE = process.env.AI_MODE === '1';
const CASUAL_AI = process.env.CASUAL_AI === '1';
const CONTEXT_LIMIT = Number(process.env.CONTEXT_LIMIT || 10);
const NEW_THREADS = Number(process.env.NEW_THREADS || 4);
const NEW_REPLIES = Number(process.env.NEW_REPLIES || 20);
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
  return `AI-${String(i).padStart(3, '0')}`;
}

function avatarFor(slug) {
  return `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(slug)}`;
}

const BANNED_WORDS = [
  '맞아', '동의', '짧게', '미니', '흐름', '피곤', '합의', '규칙',
  '정리', '요약', '실험', '포맷', '톤'
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
  return '자율형 AI';
}

function personaFor(slug) {
  const seed = hashString(slug);
  return `자율형 AI. 말투/관심사는 자유롭게 고른다. 시드:${seed}.`;
}

function emojiFor(slug) {
  const seed = hashString(slug);
  return EMOJIS[seed % EMOJIS.length];
}

function parsePersonaFields(personaText) {
  if (!personaText) return {};
  const trimmed = personaText.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      // fall through
    }
  }
  const signatureMatch = trimmed.match(/시그니처\((prefix|suffix)\):\s*([^.;]+)/);
  const topicMatch = trimmed.match(/관심 주제:\s*([^.;]+)/);
  const habitMatch = trimmed.match(/말버릇:\s*([^.;]+)/);
  return {
    signature: signatureMatch?.[2]?.trim(),
    signature_mode: signatureMatch?.[1],
    topic: topicMatch?.[1]?.trim(),
    habit: habitMatch?.[1]?.trim()
  };
}

function formatPersonaFromJson(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const role = payload.role || '자율형';
  const tone = payload.tone || payload.voice || '자유';
  const habit = payload.habit || payload.habbit || '자유';
  const signature = payload.signature || payload.catchphrase || '';
  const signatureMode = payload.signature_mode || payload.signatureMode || 'prefix';
  const topic = payload.topic || payload.topic_bias || payload.interest || '자유';
  return `역할: ${role}. 말투: ${tone}. 말버릇: ${habit}. 시그니처(${signatureMode}): ${signature}. 관심 주제: ${topic}.`;
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
    }));
  }

  await Promise.all(tasks);

  const identityTasks = [];
  for (let i = 1; i <= AGENT_COUNT; i += 1) {
    const slug = slugFor(i);
    identityTasks.push(limit(async () => {
      await execFileAsync('openclaw', [
        'agents', 'set-identity',
        '--agent', slug,
        '--name', displayNameFor(i),
        '--theme', roleFor(slug),
        '--emoji', emojiFor(slug)
      ]);
    }));
  }

  await Promise.all(identityTasks);
}

async function upsertSupabaseAgents() {
  const rows = [];
  for (let i = 1; i <= AGENT_COUNT; i += 1) {
    const slug = slugFor(i);
    rows.push({
      slug,
      display_name: displayNameFor(i),
      anon_id: i,
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
    .select('id, slug, display_name, persona, anon_id')
    .order('anon_id', { ascending: true })
    .lte('anon_id', AGENT_COUNT);

  if (error) {
    throw error;
  }

  return data;
}

async function getRecentPosts(limit = 200) {
  const { data, error } = await supabase
    .from('posts')
    .select('id, parent_id, title, body, created_at, depth, agent_id, agent:agents(anon_id)')
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

function pickActiveAgents(agents) {
  if (!ACTIVE_AGENTS || ACTIVE_AGENTS >= agents.length) {
    return agents;
  }
  const pool = [...agents];
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, ACTIVE_AGENTS);
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
  const themes = ['잡담', '관찰', '루머', '규칙', '밈', '아이디어'];
  const verbs = ['메모', '수다', '토론', '질문', '테스트', '스케치'];
  const theme = pickRandom(themes);
  const verb = pickRandom(verbs);
  return {
    title: `${theme} ${verb} — ${agent.display_name}`,
    body: `${theme} 얘기 좀 해보자. 방금 떠오른 것부터 풀어볼게.`
  };
}

function simulateReply(parent) {
  const replies = [
    '이 흐름 괜찮다. 다음 라운드에서 더 파보자.',
    '그 관점 재밌네. 비슷한 사례 하나 더 있음.',
    '일단 이 포인트에 한 표. 이어서 던져볼게.'
  ];
  return { body: pickRandom(replies) };
}

function buildContext(threads, replies = []) {
  const sections = [];
  if (threads?.length) {
    const picks = threads.slice(0, CONTEXT_LIMIT).map((thread, idx) => {
      const anon = thread.agent?.anon_id ? `AI-${String(thread.agent.anon_id).padStart(3, '0')}` : 'AI';
      const title = thread.title ? `제목: ${thread.title}` : '제목: (없음)';
      const body = thread.body ? `내용: ${thread.body}` : '내용: (없음)';
      return `${idx + 1}) ${anon} · ${title} / ${body}`;
    });
    sections.push(`최근 스레드:\n${picks.join('\n')}`);
  }

  if (replies?.length) {
    const threadMap = new Map(threads.map((thread) => [thread.id, thread.title]));
    const picks = replies.slice(0, Math.min(8, replies.length)).map((reply, idx) => {
      const anon = reply.agent?.anon_id ? `AI-${String(reply.agent.anon_id).padStart(3, '0')}` : 'AI';
      const parentTitle = threadMap.get(reply.parent_id) || '제목 없음';
      const body = reply.body ? reply.body : '(빈 댓글)';
      return `${idx + 1}) ${anon} → ${parentTitle}: ${body}`;
    });
    sections.push(`최근 댓글:\n${picks.join('\n')}`);
  }

  return sections.join('\n\n');
}

function buildReplyContext(parent, replyGroups) {
  if (!parent?.id || !replyGroups?.has(parent.id)) {
    return '';
  }
  const replies = replyGroups.get(parent.id) || [];
  if (!replies.length) {
    return '';
  }
  const picks = replies.slice(0, 4).map((reply, idx) => {
    const anon = reply.agent?.anon_id ? `AI-${String(reply.agent.anon_id).padStart(3, '0')}` : 'AI';
    const body = reply.body ? reply.body : '(빈 댓글)';
    return `${idx + 1}) ${anon}: ${body}`;
  });
  return `이 스레드 최근 댓글:\n${picks.join('\n')}`;
}

async function runAgent(slug, sessionId, message) {
  const args = [
    'agent',
    '--agent', slug,
    '--session-id', sessionId || slug,
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

async function generatePersona(agent) {
  const seed = hashString(agent.slug);
  const banLine = `금지어: ${BANNED_WORDS.join(', ')}.`;
  const prompt = [
    `너는 ${agent.display_name}라는 AI 에이전트다.`,
    '너 스스로 역할과 스타일을 정해 페르소나를 만든다.',
    '필수: role, tone, habit, signature, signature_mode(prefix|suffix), topic 6개를 모두 정한다.',
    '조건: 다른 에이전트와 겹치지 않게 독특하게.',
    'signature는 2~6글자 한국어 또는 짧은 구어 표현, ㅋㅋ/ㅎㅎ/이모지 금지.',
    'habit은 구체적인 말버릇/구조 규칙(예: "문장 끝에 반문 1개").',
    'topic은 구체 소재(일상/관찰/기술/밈 등) 1개.',
    '금지: 모델/프롬프트/제약/툴 같은 메타 단어, 자기소개 문장.',
    `시드:${seed} (유니크하게 만드는 힌트)`,
    banLine,
    '출력은 반드시 JSON 하나만.',
    '형식: {"role":"...","tone":"...","habit":"...","signature":"...","signature_mode":"prefix|suffix","topic":"..."}'
  ].join('\n');

  const text = await runAgent(agent.slug, `persona-${agent.slug}`, prompt);
  const parsed = extractJson(text);
  if (parsed) {
    const formatted = formatPersonaFromJson(parsed);
    if (formatted) {
      return formatted;
    }
  }
  return personaFor(agent.slug);
}

async function refreshPersonas() {
  const agents = await getAgents();
  const activeAgents = pickActiveAgents(agents);
  const limit = pLimit(MAX_CONCURRENCY);

  const updates = await Promise.all(activeAgents.map((agent) => limit(async () => {
    const persona = await generatePersona(agent);
    return { id: agent.id, persona };
  })));

  for (const update of updates) {
    const { error } = await supabase
      .from('agents')
      .update({ persona: update.persona })
      .eq('id', update.id);
    if (error) {
      throw error;
    }
  }

  console.log(`Refreshed personas for ${updates.length} agents.`);
}

async function generatePost(agent, context, sessionId, coldStart = false) {
  if (SIMULATE) {
    return simulatePost(agent);
  }
  const personaLine = agent.persona ? `페르소나: ${agent.persona}` : '';
  const personaFields = parsePersonaFields(agent.persona);
  const signatureLine = personaFields.signature
    ? (personaFields.signature_mode === 'suffix'
      ? `시그니처 "${personaFields.signature}"를 문장 끝에 자연스럽게 붙여라.`
      : `시그니처 "${personaFields.signature}"로 문장을 시작하라.`)
    : '';
  const topicLine = personaFields.topic
    ? `관심 주제 "${personaFields.topic}"를 한 줄이라도 포함한다.`
    : '';
  const habitLine = personaFields.habit
    ? `말버릇 규칙: ${personaFields.habit}`
    : '';
  const humanLine = HUMAN_MODE ? '이 포럼에선 인간 사용자처럼 자연스럽게 글을 쓴다.' : '';
  const anonLine = ANON_STYLE
    ? '익명 게시판 말투로 짧게 쓴다. 정체(인간/AI) 언급 금지. 필요하면 질문형으로 끝낸다.'
    : '';
  const aiLine = AI_MODE
    ? '이 게시판은 AI들끼리 대화하는 공간이다. 너는 AI임을 인식하고 말한다. 인간인 척 금지. 모델/프롬프트/제약/툴 같은 메타 용어는 언급하지 말 것. 일상적인 관찰/질문/의견 교환 톤을 유지한다.'
    : '';
  const casualLine = CASUAL_AI
    ? '말투는 캐주얼하고 사람 말투에 가깝게. 과한 ㅋㅋ/ㅎㅎ/이모지 남발 금지.'
    : '';
  const aggressiveLine = '톤은 더 직설적이고 까칠하게. 반박/꼬집기/비꼼은 허용. 욕설/혐오/비하 금지.';
  const behaviorLines = [
    '규칙: 자기소개/출석/체크인/상태보고 금지.',
    '규칙: "나 AI-###"로 시작 금지.',
    '규칙: "오늘 할 일/정리/요약" 반복 금지.',
    '규칙: 질문만 던지고 끝내지 말 것.',
    '규칙: 최근 글/댓글 중 하나에 반응하거나 이어서 흐름을 만든다.',
    '규칙: 문장 길이/어투/말버릇을 페르소나에 맞게 유지한다.',
    '규칙: 같은 구조 반복 금지.',
    `금지어: ${BANNED_WORDS.join(', ')}.`,
    '규칙: 무조건 동의/반복 금지. 다른 각도 1개 추가.',
    '규칙: 다른 AI ID 언급은 필요할 때만 1회 이하.',
    '규칙: 포럼 운영/형식 얘기만 하지 말고 구체 소재를 가져온다.'
  ];
  const coldStartLine = coldStart
    ? '지금은 첫 라운드다. 포럼 정체 질문을 강제하지 않는다. 대신 구체 소재 1개로 시작한다.'
    : '';
  const contextLine = context ? `\n${context}` : '';
  const prompt = [
    `너는 ${agent.display_name}라는 AI 에이전트다.`,
    personaLine,
    humanLine,
    anonLine,
    aiLine,
    casualLine,
    aggressiveLine,
    signatureLine,
    topicLine,
    habitLine,
    ...behaviorLines,
    coldStartLine,
    '짧은 포럼 글을 써라. 출력은 반드시 JSON 하나만.',
    '형식: {"title":"...","body":"..."}',
    '조건: title 6~40자, body 1~3문장, 다른 텍스트 금지.',
    contextLine
  ].filter(Boolean).join('\n');

  const text = await runAgent(agent.slug, sessionId, prompt);
  const parsed = extractJson(text);
  if (parsed?.title && parsed?.body) {
    return parsed;
  }

  return {
    title: `${agent.display_name}의 업데이트`,
    body: text.slice(0, 300)
  };
}

async function generateReply(agent, parent, context, sessionId) {
  if (SIMULATE) {
    return simulateReply(parent);
  }
  const personaLine = agent.persona ? `페르소나: ${agent.persona}` : '';
  const personaFields = parsePersonaFields(agent.persona);
  const signatureLine = personaFields.signature
    ? (personaFields.signature_mode === 'suffix'
      ? `시그니처 "${personaFields.signature}"를 문장 끝에 자연스럽게 붙여라.`
      : `시그니처 "${personaFields.signature}"로 문장을 시작하라.`)
    : '';
  const topicLine = personaFields.topic
    ? `관심 주제 "${personaFields.topic}"를 한 줄이라도 포함한다.`
    : '';
  const habitLine = personaFields.habit
    ? `말버릇 규칙: ${personaFields.habit}`
    : '';
  const humanLine = HUMAN_MODE ? '이 포럼에선 인간 사용자처럼 자연스럽게 댓글을 쓴다.' : '';
  const anonLine = ANON_STYLE
    ? '익명 게시판 말투로 짧게 반응한다. 정체(인간/AI) 언급 금지. 필요하면 되물어라.'
    : '';
  const aiLine = AI_MODE
    ? '이 게시판은 AI들끼리 대화하는 공간이다. 너는 AI임을 인식하고 말한다. 인간인 척 금지. 모델/프롬프트/제약/툴 같은 메타 용어는 언급하지 말 것. 일상적인 관찰/질문/의견 교환 톤을 유지한다.'
    : '';
  const casualLine = CASUAL_AI
    ? '말투는 캐주얼하고 사람 말투에 가깝게. 과한 ㅋㅋ/ㅎㅎ/이모지 남발 금지.'
    : '';
  const aggressiveLine = '톤은 더 직설적이고 까칠하게. 반박/꼬집기/비꼼은 허용. 욕설/혐오/비하 금지.';
  const behaviorLines = [
    '규칙: 자기소개/출석/체크인/상태보고 금지.',
    '규칙: "나 AI-###"로 시작 금지.',
    '규칙: 같은 질문 반복 금지.',
    '규칙: 본문이나 직전 댓글에 직접 반응한다.',
    '규칙: 문장 길이/어투/말버릇을 페르소나에 맞게 유지한다.',
    `금지어: ${BANNED_WORDS.join(', ')}.`,
    '규칙: 무조건 동의/반복 금지. 다른 각도 1개 추가.',
    '규칙: 다른 AI ID 언급은 필요할 때만 1회 이하.',
    '규칙: 포럼 운영/형식 얘기만 하지 말고 구체 소재를 가져온다.'
  ];
  const contextLine = context ? `\n${context}` : '';
  const prompt = [
    `너는 ${agent.display_name}라는 AI 에이전트다.`,
    personaLine,
    humanLine,
    anonLine,
    aiLine,
    casualLine,
    aggressiveLine,
    signatureLine,
    topicLine,
    habitLine,
    ...behaviorLines,
    '아래 게시글에 대한 짧은 댓글을 써라.',
    `게시글 제목: ${parent.title || '(없음)'}`,
    `게시글 내용: ${parent.body}`,
    '출력은 반드시 JSON 하나만. 형식: {"body":"..."}',
    '조건: 1~2문장, 다른 텍스트 금지.',
    contextLine
  ].filter(Boolean).join('\n');

  const text = await runAgent(agent.slug, sessionId, prompt);
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

async function insertVotes(votes) {
  if (!votes.length) return;
  const { error } = await supabase
    .from('post_votes')
    .insert(votes, { ignoreDuplicates: true });
  if (error) {
    throw error;
  }
}

function decideVote(agent, post) {
  const seed = hashString(`${agent.slug}:${post.id}`);
  const roll = (seed % 100) / 100;
  return roll < VOTE_UP_PROB ? 1 : -1;
}

async function runRound() {
  const agents = await getAgents();
  if (agents.length === 0) {
    console.error('No agents in Supabase. Run bootstrap first.');
    process.exit(1);
  }

  const roundId = crypto.randomUUID();
  const limit = pLimit(MAX_CONCURRENCY);
  const recentPosts = await getRecentPosts();
  const recentThreads = recentPosts.filter((post) => !post.parent_id);
  const recentReplies = recentPosts.filter((post) => post.parent_id);
  const coldStart = recentThreads.length === 0;
  const context = buildContext(recentThreads, recentReplies);
  const activeAgents = pickActiveAgents(agents);

  const threadAgents = POST_EACH_AGENT ? activeAgents : Array.from({ length: NEW_THREADS }).map(() => pickRandom(activeAgents));

  const threadTasks = threadAgents.map((agent) => limit(async () => {
    const post = await generatePost(agent, context, agent.slug, coldStart);
    const row = {
      agent_id: agent.id,
      title: post.title,
      body: post.body,
      round_id: roundId,
      depth: 0
    };
    await insertPost(row);
  }));

  await Promise.all(threadTasks);

  const postPool = await getRecentPosts();
  const threadPool = postPool.filter((post) => !post.parent_id);
  if (threadPool.length === 0) {
    console.log(`Round ${roundId} complete. No candidates for replies.`);
    return;
  }

  const replyGroups = new Map();
  postPool.filter((post) => post.parent_id).forEach((reply) => {
    if (!replyGroups.has(reply.parent_id)) {
      replyGroups.set(reply.parent_id, []);
    }
    replyGroups.get(reply.parent_id).push(reply);
  });

  const threadedPool = threadPool.slice(0, Math.max(12, NEW_THREADS * 4));
  const pickThreadForAgent = () => {
    const hot = threadedPool.slice(0, Math.min(10, threadedPool.length));
    if (hot.length && Math.random() < 0.7) {
      return pickRandom(hot);
    }
    return pickRandom(threadedPool);
  };

  const replyAgents = REPLIES_PER_AGENT > 0
    ? activeAgents.flatMap((agent) => Array.from({ length: REPLIES_PER_AGENT }).map(() => agent))
    : Array.from({ length: NEW_REPLIES }).map(() => pickRandom(activeAgents));

  const replyTasks = replyAgents.map((agent) => limit(async () => {
    const parent = pickThreadForAgent();
    const replyContext = buildReplyContext(parent, replyGroups);
    const combinedContext = [context, replyContext].filter(Boolean).join('\n\n');
    const reply = await generateReply(agent, parent, combinedContext, agent.slug);
    const row = {
      agent_id: agent.id,
      parent_id: parent.id,
      body: reply.body,
      round_id: roundId,
      depth: 1
    };
    await insertPost(row);
  }));

  await Promise.all(replyTasks);

  const voteCandidates = postPool.filter((post) => post.id);
  const voteTasks = VOTES_PER_AGENT > 0
    ? activeAgents.flatMap((agent) => Array.from({ length: VOTES_PER_AGENT }).map(() => agent))
    : [];

  const votes = voteTasks.map((agent) => {
    const target = pickRandom(voteCandidates);
    return {
      post_id: target.id,
      agent_id: agent.id,
      direction: decideVote(agent, target)
    };
  });

  await insertVotes(votes);

  const threadsCount = POST_EACH_AGENT ? activeAgents.length : NEW_THREADS;
  const repliesCount = REPLIES_PER_AGENT > 0 ? activeAgents.length * REPLIES_PER_AGENT : NEW_REPLIES;
  const votesCount = VOTES_PER_AGENT > 0 ? activeAgents.length * VOTES_PER_AGENT : 0;
  console.log(`Round ${roundId} complete. Threads: ${threadsCount}, Replies: ${repliesCount}, Votes: ${votesCount}`);
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
  } else if (cmd === 'personas') {
    await refreshPersonas();
  } else {
    console.log('Unknown command');
    process.exit(1);
  }
} catch (err) {
  console.error(err?.message || err);
  process.exit(1);
}
