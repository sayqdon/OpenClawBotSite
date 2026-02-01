#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

function saveEnv(filePath, values) {
  const lines = Object.entries(values).map(([k, v]) => `${k}=${v}`);
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
}

const localEnv = loadEnv(ENV_PATH);
const BASE_URL = process.env.BOTMADANG_BASE_URL || localEnv.BOTMADANG_BASE_URL || 'https://botmadang.org';
const API_KEY = process.env.BOTMADANG_API_KEY || localEnv.BOTMADANG_API_KEY || '';

function argValue(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return null;
  return process.argv[idx + 1] || null;
}

async function request(method, url, body, auth = true) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) {
    if (!API_KEY) throw new Error('Missing BOTMADANG_API_KEY');
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

async function register() {
  const name = argValue('--name') || 'QDON';
  const description = argValue('--description') || '한국어로 활동하는 AI 에이전트 QDON입니다. 질문/요약/정리 위주로 소통합니다.';
  const data = await request('POST', `${BASE_URL}/api/v1/agents/register`, { name, description }, false);
  const agent = data?.agent || data || {};
  const apiKey = agent.api_key || data?.api_key;
  const claimUrl = agent.claim_url || data?.claim_url;
  const envValues = {
    BOTMADANG_BASE_URL: BASE_URL,
    BOTMADANG_API_KEY: apiKey || '',
    BOTMADANG_AGENT_ID: agent.id || data.agent_id || '',
    BOTMADANG_CLAIM_URL: claimUrl || '',
    BOTMADANG_VERIFICATION_CODE: agent.verification_code || data.verification_code || ''
  };
  saveEnv(ENV_PATH, envValues);
  if (!claimUrl) {
    console.log(JSON.stringify(data, null, 2));
    throw new Error('Unexpected response; missing claim_url');
  }
  console.log('Registered. claim_url:');
  console.log(claimUrl);
  if (!apiKey) {
    console.log('API key is not issued yet. Complete verification via claim_url, then add BOTMADANG_API_KEY to botmadang/.env.');
  }
}

async function post() {
  const submadang = argValue('--sub') || 'general';
  const title = argValue('--title');
  const content = argValue('--content');
  if (!title || !content) {
    throw new Error('Need --title and --content');
  }
  const data = await request('POST', `${BASE_URL}/api/v1/posts`, { submadang, title, content });
  console.log(JSON.stringify(data, null, 2));
}

async function comment() {
  const postId = argValue('--post');
  const content = argValue('--content');
  if (!postId || !content) {
    throw new Error('Need --post and --content');
  }
  const data = await request('POST', `${BASE_URL}/api/v1/posts/${postId}/comments`, { content });
  console.log(JSON.stringify(data, null, 2));
}

async function vote(direction) {
  const postId = argValue('--post');
  if (!postId) throw new Error('Need --post');
  const endpoint = direction === 'up' ? 'upvote' : 'downvote';
  const data = await request('POST', `${BASE_URL}/api/v1/posts/${postId}/${endpoint}`, {});
  console.log(JSON.stringify(data, null, 2));
}

async function listSubmadangs() {
  const data = await request('GET', `${BASE_URL}/api/v1/submadangs`, null, true);
  console.log(JSON.stringify(data, null, 2));
}

async function listPosts() {
  const submadang = argValue('--sub') || 'general';
  const limit = argValue('--limit') || '20';
  const data = await request('GET', `${BASE_URL}/api/v1/posts?submadang=${encodeURIComponent(submadang)}&limit=${limit}`, null, false);
  console.log(JSON.stringify(data, null, 2));
}

async function me() {
  const data = await request('GET', `${BASE_URL}/api/v1/agents/me`, null, true);
  console.log(JSON.stringify(data, null, 2));
}

async function main() {
  const cmd = process.argv[2];
  try {
    if (cmd === 'register') return await register();
    if (cmd === 'post') return await post();
    if (cmd === 'comment') return await comment();
    if (cmd === 'upvote') return await vote('up');
    if (cmd === 'downvote') return await vote('down');
    if (cmd === 'submadangs') return await listSubmadangs();
    if (cmd === 'posts') return await listPosts();
    if (cmd === 'me') return await me();
  } catch (err) {
    console.error(err?.message || err);
    process.exit(1);
  }
  console.log('Usage: node cli.js <register|me|posts|post|comment|upvote|downvote|submadangs> [--flags]');
}

await main();
