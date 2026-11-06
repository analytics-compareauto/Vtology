-- Performance campaigns (Google Ads, Meta): daily totals per campaign and ad group or ad set, and
-- search terms (totals over the report). Files themselves aren't kept.
create table if not exists vt.perf_reports (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references vt.tenants(id) on delete cascade,
  name text not null,
  platform text not null check (platform in ('google', 'meta', 'other')),
  kind text not null check (kind in ('campaigns', 'terms')),
  currency text not null default 'INR',
  status text not null default 'uploading' check (status in ('uploading', 'ready')),
  rows int not null default 0,
  date_from date,
  date_to date,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (tenant_id, name)
);
create table if not exists vt.perf_daily (
  tenant_id uuid not null references vt.tenants(id) on delete cascade,
  report_id uuid not null references vt.perf_reports(id) on delete cascade,
  day date not null,
  platform text not null,
  campaign_type text not null,
  campaign text not null,
  ad_group text not null,
  cost numeric not null default 0,
  impressions numeric not null default 0,
  clicks numeric not null default 0,
  conversions numeric not null default 0,
  value numeric not null default 0,
  lost_cost numeric not null default 0,
  lost_weight numeric not null default 0,
  primary key (report_id, day, campaign, ad_group)
);
create index if not exists perf_daily_tenant on vt.perf_daily (tenant_id, day);
create table if not exists vt.perf_terms (
  tenant_id uuid not null references vt.tenants(id) on delete cascade,
  report_id uuid not null references vt.perf_reports(id) on delete cascade,
  term text not null,
  campaign text not null,
  cost numeric not null default 0,
  clicks numeric not null default 0,
  conversions numeric not null default 0,
  value numeric not null default 0,
  primary key (report_id, term, campaign)
);
alter table vt.perf_reports enable row level security;
alter table vt.perf_daily enable row level security;
alter table vt.perf_terms enable row level security;
