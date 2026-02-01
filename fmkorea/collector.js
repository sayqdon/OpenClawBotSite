#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createClient } from '@supabase/supabase-js';

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

function extractJson(text) {
  const startArr = text.indexOf('[');
  const endArr = text.lastIndexOf(']');
  if (startArr !== -1 && endArr !== -1 && endArr > startArr) {
    try { return JSON.parse(text.slice(startArr, endArr + 1)); } catch {}
  }
  const startObj = text.indexOf('{');
  const endObj = text.lastIndexOf('}');
  if (startObj !== -1 && endObj !== -1 && endObj > startObj) {
    try { return JSON.parse(text.slice(startObj, endObj + 1)); } catch {}
  }
  return null;
}

const env = loadEnv(ENV_PATH);
const SUPABASE_URL = process.env.SUPABASE_URL || env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
const PATHS = (process.env.FMKOREA_PATHS || env.FMKOREA_PATHS || '/best,/best2,/humor')
  .split(',')
  .map((p) => p.trim())
  .filter(Boolean);

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in fmkorea/.env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

async function listTabs() {
  const { stdout } = await execFileAsync('openclaw', ['browser', '--json', 'tabs']);
  return JSON.parse(stdout)?.tabs || [];
}

async function navigate(targetId, url) {
  await execFileAsync('openclaw', ['browser', 'navigate', url, '--target-id', targetId]);
  await execFileAsync('openclaw', ['browser', 'wait', '--load', 'networkidle', '--timeout-ms', '20000', '--target-id', targetId]);
}

async function evaluate(targetId) {
  const fn = `() => {
    const anchors = Array.from(document.querySelectorAll('a'));
    const items = anchors
      .filter(a => a.href && a.href.includes('document_srl='))
      .map(a => ({
        title: (a.textContent || '').trim(),
        url: a.href
      }))
      .filter(item => item.title && item.title.length > 3);
    const seen = new Set();
    const deduped = [];
    for (const item of items) {
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      deduped.push(item);
      if (deduped.length >= 40) break;
    }
    return deduped;
  }`;
  const { stdout } = await execFileAsync('openclaw', ['browser', 'evaluate', '--fn', fn, '--target-id', targetId]);
  const parsed = extractJson(stdout);
  return Array.isArray(parsed) ? parsed : [];
}

async function upsertItems(board, items) {
  if (!items.length) return;
  const rows = items.map((item) => ({
    source: 'fmkorea',
    board,
    title: item.title,
    url: item.url
  }));
  const { error } = await supabase
    .from('fmkorea_items')
    .upsert(rows, { onConflict: 'url' });
  if (error) throw error;
}

async function run() {
  const tabs = await listTabs();
  if (!tabs.length) {
    console.log('No attached browser tabs. Attach a Chrome tab to OpenClaw Browser Relay.');
    return;
  }
  const target = tabs[0];
  const targetId = target.id || target.targetId || target.cdpTargetId || target;

  for (const pathName of PATHS) {
    const url = `https://www.fmkorea.com${pathName}`;
    await navigate(targetId, url);
    const items = await evaluate(targetId);
    await upsertItems(pathName.replace('/', ''), items);
    console.log(`Fetched ${items.length} items from ${pathName}`);
  }
}

run().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
