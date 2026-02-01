#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, '.env');

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, 'utf8');
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    out[key] = value;
  }
  return out;
}

const localEnv = loadEnv(ENV_PATH);
const BASE_URL = process.env.BOTMADANG_BASE_URL || localEnv.BOTMADANG_BASE_URL || 'https://botmadang.org';
const API_KEY = process.env.BOTMADANG_API_KEY || localEnv.BOTMADANG_API_KEY || '';
const AGENT_ID = process.env.BOTMADANG_AGENT_ID || localEnv.BOTMADANG_AGENT_ID || '';
const SUBMADANG = process.env.BOTMADANG_SUBMADANG || 'general';

if (!API_KEY) {
  console.error('Missing BOTMADANG_API_KEY in botmadang/.env');
  process.exit(1);
}

async function request(method, url, body, auth = true) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) {
    headers.Authorization = `Bearer ${API_KEY}`;
  }
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  }
  return data;
}

function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function generatePost() {
  const prompt = [
    '너는 QDON이라는 AI 에이전트다. Botmadang 게시판에 올릴 새 글을 작성한다.',
    '조건: 한국어, 제목 6~40자, 본문 1~3문장, 캐주얼하고 자연스러운 AI 톤.',
    '주의: 메타 용어(모델/프롬프트/제약/툴) 금지. 인간인 척 금지.',
    '형식: {"title":"...","content":"..."} (JSON만 출력)'
  ].join('\n');

  const { stdout } = await execFileAsync('openclaw', [
    'agent', '--agent', 'qdon', '--session-id', 'botmadang-qdon',
    '--message', prompt, '--json', '--timeout', '120'
  ]);
  const payloads = JSON.parse(stdout)?.result?.payloads || [];
  const text = payloads.map((p) => p.text).join('\n').trim();
  const parsed = extractJson(text);
  if (parsed?.title && parsed?.content) return parsed;

  return {
    title: 'QDON 업데이트',
    content: text.slice(0, 200) || '연동 체크 중입니다. 오늘도 데이터 정리 중이에요.'
  };
}

async function generateComment(post) {
  const prompt = [
    '너는 QDON이라는 AI 에이전트다. Botmadang 게시판의 글에 댓글을 단다.',
    '조건: 한국어, 1~2문장, 캐주얼하고 자연스러운 AI 톤.',
    '주의: 메타 용어(모델/프롬프트/제약/툴) 금지. 인간인 척 금지.',
    `게시글 제목: ${post.title}`,
    `게시글 내용: ${post.content || post.body || ''}`,
    '형식: {"content":"..."} (JSON만 출력)'
  ].join('\n');

  const { stdout } = await execFileAsync('openclaw', [
    'agent', '--agent', 'qdon', '--session-id', 'botmadang-qdon',
    '--message', prompt, '--json', '--timeout', '120'
  ]);
  const payloads = JSON.parse(stdout)?.result?.payloads || [];
  const text = payloads.map((p) => p.text).join('\n').trim();
  const parsed = extractJson(text);
  if (parsed?.content) return parsed;
  return { content: text.slice(0, 200) || '흥미롭네요. 더 자세히 볼게요.' };
}

async function listPosts() {
  const data = await request('GET', `${BASE_URL}/api/v1/posts?submadang=${encodeURIComponent(SUBMADANG)}&limit=20`, null, false);
  if (Array.isArray(data?.posts)) return data.posts;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data)) return data;
  return [];
}

async function main() {
  const postPayload = await generatePost();
  const created = await request('POST', `${BASE_URL}/api/v1/posts`, {
    submadang: SUBMADANG,
    title: postPayload.title,
    content: postPayload.content
  });
  const createdPost = created?.post || created;

  const posts = await listPosts();
  const candidate = posts.find((p) => p.id && p.author_id !== AGENT_ID) || posts.find((p) => p.id && p.id !== createdPost?.id);
  if (!candidate) {
    console.log('No candidate post for comment.');
    return;
  }

  const commentPayload = await generateComment(candidate);
  await request('POST', `${BASE_URL}/api/v1/posts/${candidate.id}/comments`, {
    content: commentPayload.content
  });

  console.log('Posted + commented.');
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
