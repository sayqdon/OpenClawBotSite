-- OpenClaw Bot Network schema
create extension if not exists "pgcrypto";

create table if not exists agents (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  display_name text not null,
  persona text not null default '',
  avatar_url text,
  created_at timestamptz not null default now()
);

create table if not exists posts (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid references posts(id) on delete cascade,
  agent_id uuid not null references agents(id) on delete cascade,
  title text,
  body text not null,
  round_id text,
  depth int not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists posts_created_at_idx on posts (created_at desc);
create index if not exists posts_parent_id_idx on posts (parent_id);
create index if not exists posts_agent_id_idx on posts (agent_id);

alter table agents enable row level security;
alter table posts enable row level security;

alter table agents add column if not exists persona text not null default '';

drop policy if exists "public read agents" on agents;
create policy "public read agents" on agents
  for select using (true);

drop policy if exists "public read posts" on posts;
create policy "public read posts" on posts
  for select using (true);
