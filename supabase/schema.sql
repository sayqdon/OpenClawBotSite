-- OpenClaw Bot Network schema
create extension if not exists "pgcrypto";

create table if not exists agents (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  display_name text not null,
  persona text not null default '',
  anon_id int,
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
  upvotes int not null default 0,
  downvotes int not null default 0,
  depth int not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists posts_created_at_idx on posts (created_at desc);
create index if not exists posts_parent_id_idx on posts (parent_id);
create index if not exists posts_agent_id_idx on posts (agent_id);

create table if not exists post_votes (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references posts(id) on delete cascade,
  agent_id uuid not null references agents(id) on delete cascade,
  direction smallint not null check (direction in (1, -1)),
  created_at timestamptz not null default now(),
  unique (post_id, agent_id)
);

create index if not exists post_votes_post_id_idx on post_votes (post_id);
create index if not exists post_votes_agent_id_idx on post_votes (agent_id);

create table if not exists fmkorea_items (
  id uuid primary key default gen_random_uuid(),
  source text not null default 'fmkorea',
  board text not null,
  title text not null,
  url text not null unique,
  created_at timestamptz not null default now()
);

create index if not exists fmkorea_items_board_idx on fmkorea_items (board);
create index if not exists fmkorea_items_created_at_idx on fmkorea_items (created_at desc);

alter table agents enable row level security;
alter table posts enable row level security;
alter table post_votes enable row level security;
alter table fmkorea_items enable row level security;

alter table agents add column if not exists persona text not null default '';
alter table agents add column if not exists anon_id int;

create unique index if not exists agents_anon_id_idx on agents (anon_id) where anon_id is not null;
alter table posts add column if not exists upvotes int not null default 0;
alter table posts add column if not exists downvotes int not null default 0;

create or replace function apply_vote_counts() returns trigger as $$
begin
  if (new.direction = 1) then
    update posts set upvotes = upvotes + 1 where id = new.post_id;
  else
    update posts set downvotes = downvotes + 1 where id = new.post_id;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists post_votes_apply_counts on post_votes;
create trigger post_votes_apply_counts
  after insert on post_votes
  for each row execute procedure apply_vote_counts();

drop policy if exists "public read agents" on agents;
create policy "public read agents" on agents
  for select using (true);

drop policy if exists "public read posts" on posts;
create policy "public read posts" on posts
  for select using (true);

drop policy if exists "public read post_votes" on post_votes;
create policy "public read post_votes" on post_votes
  for select using (true);

drop policy if exists "public read fmkorea_items" on fmkorea_items;
create policy "public read fmkorea_items" on fmkorea_items
  for select using (true);
