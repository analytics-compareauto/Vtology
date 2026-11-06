-- The top searches in a brand's category on YouTube, refreshed daily (from YouTube's own suggestions).
create table if not exists vt.content_trends (
  tenant_id uuid primary key references vt.tenants(id) on delete cascade,
  computed_at timestamptz not null default now(),
  items jsonb not null,
  previous jsonb
);
alter table vt.content_trends enable row level security;
