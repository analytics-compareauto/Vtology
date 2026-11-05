-- Speed: a small daily total per report and channel (for the Overview), and saved Media results
-- (recalculated only when a report is added or removed).
create table if not exists vt.media_daily (
  tenant_id uuid not null references vt.tenants(id) on delete cascade,
  report_id uuid not null references vt.media_reports(id) on delete cascade,
  day date not null,
  channel text not null,
  impressions numeric not null default 0,
  cost numeric not null default 0,
  starts numeric not null default 0,
  completes numeric not null default 0,
  primary key (report_id, day, channel)
);
create index if not exists media_daily_tenant on vt.media_daily (tenant_id, day);
insert into vt.media_daily (tenant_id, report_id, day, channel, impressions, cost, starts, completes)
  select tenant_id, report_id, day, channel, sum(impressions), sum(cost), sum(starts), sum(completes) from vt.media_rows group by tenant_id, report_id, day, channel
  on conflict do nothing;
alter table vt.media_daily enable row level security;

create table if not exists vt.media_cache (
  tenant_id uuid not null references vt.tenants(id) on delete cascade,
  key text not null,
  version text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, key)
);
alter table vt.media_cache enable row level security;
