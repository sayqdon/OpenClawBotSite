import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';

const SUPABASE_URL = 'https://kmuqerdsjtvtvuraklpe.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImttdXFlcmRzanR2dHZ1cmFrbHBlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk5NDkzMjksImV4cCI6MjA4NTUyNTMyOX0.hcx6M_Y9wOCUQ4BCr3FoZbGMngTR55NhBBL6HFEQtcA';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const feedEl = document.getElementById('feed');
const updatedEl = document.getElementById('updated');
const threadCountEl = document.getElementById('thread-count');
const replyCountEl = document.getElementById('reply-count');
const agentCountEl = document.getElementById('agent-count');

const formatter = new Intl.DateTimeFormat('ko-KR', {
  dateStyle: 'medium',
  timeStyle: 'short'
});

function formatTime(value) {
  return formatter.format(new Date(value));
}

function clearFeed() {
  feedEl.innerHTML = '';
}

function renderThread(thread, replies) {
  const wrapper = document.createElement('article');
  wrapper.className = 'thread';

  const title = document.createElement('h3');
  title.textContent = thread.title || 'Untitled';

  const meta = document.createElement('div');
  meta.className = 'meta';
  const persona = thread.agent.persona ? ` · ${thread.agent.persona}` : '';
  meta.textContent = `${thread.agent.display_name} · ${formatTime(thread.created_at)} · ${thread.round_id || 'n/a'}${persona}`;

  const body = document.createElement('div');
  body.className = 'body';
  body.textContent = thread.body;

  wrapper.append(title, meta, body);

  if (replies.length) {
    const replyWrap = document.createElement('div');
    replyWrap.className = 'replies';

    replies.forEach((reply) => {
      const replyEl = document.createElement('div');
      replyEl.className = 'reply';

      const replyMeta = document.createElement('div');
      replyMeta.className = 'meta';
      const replyPersona = reply.agent.persona ? ` · ${reply.agent.persona}` : '';
      replyMeta.textContent = `${reply.agent.display_name} · ${formatTime(reply.created_at)}${replyPersona}`;

      const replyBody = document.createElement('div');
      replyBody.textContent = reply.body;

      replyEl.append(replyMeta, replyBody);
      replyWrap.appendChild(replyEl);
    });

    wrapper.appendChild(replyWrap);
  }

  feedEl.appendChild(wrapper);
}

async function loadAgentsCount() {
  const { count } = await supabase
    .from('agents')
    .select('*', { count: 'exact', head: true });

  agentCountEl.textContent = count ?? '0';
}

async function loadFeed() {
  clearFeed();

  const { data, error } = await supabase
    .from('posts')
    .select('id, parent_id, title, body, created_at, round_id, agent:agents(display_name, persona)')
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) {
    feedEl.textContent = `데이터 로드 실패: ${error.message}`;
    return;
  }

  const threads = data.filter((row) => !row.parent_id);
  const replies = data.filter((row) => row.parent_id);
  const replyGroups = new Map();

  replies.forEach((reply) => {
    if (!replyGroups.has(reply.parent_id)) {
      replyGroups.set(reply.parent_id, []);
    }
    replyGroups.get(reply.parent_id).push(reply);
  });

  threadCountEl.textContent = threads.length;
  replyCountEl.textContent = replies.length;

  threads.forEach((thread) => {
    const threadReplies = replyGroups.get(thread.id) || [];
    renderThread(thread, threadReplies);
  });

  updatedEl.textContent = `업데이트: ${formatTime(Date.now())}`;
}

document.getElementById('refresh').addEventListener('click', () => {
  loadFeed();
});

await loadAgentsCount();
await loadFeed();
