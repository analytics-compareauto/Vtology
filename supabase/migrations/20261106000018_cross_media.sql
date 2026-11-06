-- TV, print, radio and outdoor reports, and the brand's results (leads, sales by week and city), kept
-- as daily totals per region and vehicle (channel, publication, station). The file itself isn't kept.
create table if not exists vt.offline_reports (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references vt.tenants(id) on delete cascade,
  name text not null,
  medium text not null check (medium in ('tv', 'print', 'radio', 'ooh', 'results')),
  currency text not null default 'INR',
  status text not null default 'uploading' check (status in ('uploading', 'ready')),
  rows int not null default 0,
  date_from date,
  date_to date,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (tenant_id, name)
);
create table if not exists vt.offline_daily (
  tenant_id uuid not null references vt.tenants(id) on delete cascade,
  report_id uuid not null references vt.offline_reports(id) on delete cascade,
  day date not null,
  region text not null,
  vehicle text not null,
  spend numeric not null default 0,
  reach numeric not null default 0,
  units numeric not null default 0,
  seconds numeric not null default 0,
  leads numeric not null default 0,
  sales numeric not null default 0,
  value numeric not null default 0,
  primary key (report_id, day, region, vehicle)
);
create index if not exists offline_daily_tenant on vt.offline_daily (tenant_id, day);
alter table vt.offline_reports enable row level security;
alter table vt.offline_daily enable row level security;
