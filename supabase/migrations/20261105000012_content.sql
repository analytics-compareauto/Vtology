-- Content intelligence: topics a brand tracks on YouTube search (what people look for, who ranks),
-- and per-video retention curves fetched from YouTube Analytics on demand.
create table if not exists vt.content_topics (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references vt.tenants(id) on delete cascade,
  phrase text not null,
  added_by uuid,
  added_at timestamptz not null default now(),
  last_scan_at timestamptz,
  result jsonb,
  last_error text
);
create unique index if not exists content_topics_phrase on vt.content_topics (tenant_id, lower(phrase));
alter table vt.content_topics enable row level security;
create policy content_topics_read on vt.content_topics for select to authenticated using (vt.sees_social(tenant_id));
grant select on vt.content_topics to authenticated;

alter table vt.social_posts add column if not exists retention jsonb;
alter table vt.social_posts add column if not exists retention_at timestamptz;
