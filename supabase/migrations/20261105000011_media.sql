-- Media reports: delivery data exported from a DSP (DV360 first), for awareness analysis of CTV,
-- audio, online video and display. Campaign numbers only: no personal data.
create table if not exists vt.media_reports (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references vt.tenants(id) on delete cascade,
  name text not null,
  source text not null default 'dv360',
  currency text not null default '',
  status text not null default 'uploading' check (status in ('uploading', 'ready')),
  rows int not null default 0,
  date_from date,
  date_to date,
  columns jsonb not null default '{}',
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (tenant_id, name)
);

create table if not exists vt.media_rows (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references vt.tenants(id) on delete cascade,
  report_id uuid not null references vt.media_reports(id) on delete cascade,
  day date not null,
  campaign text not null default '',
  line_item text not null default '',
  line_item_type text not null default '',
  channel text not null check (channel in ('ctv', 'audio', 'video', 'display')),
  creative text not null default '',
  exchange text not null default '',
  supply text not null default 'Open auction',
  deal boolean not null default false,
  site text not null default '',
  device text not null default '',
  region text not null default '',
  impressions numeric not null default 0,
  clicks numeric not null default 0,
  cost numeric not null default 0,
  viewable numeric not null default 0,
  measurable numeric not null default 0,
  starts numeric not null default 0,
  q1 numeric not null default 0,
  q2 numeric not null default 0,
  q3 numeric not null default 0,
  completes numeric not null default 0,
  audible numeric not null default 0,
  conversions numeric not null default 0
);
create index if not exists media_rows_tenant_day on vt.media_rows (tenant_id, day);
create index if not exists media_rows_report on vt.media_rows (report_id);

alter table vt.media_reports enable row level security;
alter table vt.media_rows enable row level security;
create policy media_reports_read on vt.media_reports for select to authenticated using (vt.member_role(tenant_id) in ('data_steward', 'marketing_head', 'finance'));
create policy media_rows_read on vt.media_rows for select to authenticated using (vt.member_role(tenant_id) in ('data_steward', 'marketing_head', 'finance'));
grant select on vt.media_reports, vt.media_rows to authenticated;
