-- Reach reports (DV360 "Unique Reach"): people reached per insertion order per day, for frequency.
-- Reach can't be added across days or lines, so it is kept apart from delivery rows.
alter table vt.media_reports add column if not exists kind text not null default 'delivery';
create table if not exists vt.media_reach (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references vt.tenants(id) on delete cascade,
  report_id uuid not null references vt.media_reports(id) on delete cascade,
  day date not null,
  campaign text not null default '',
  impressions numeric not null default 0,
  reach numeric not null default 0,
  cost numeric not null default 0
);
create index if not exists media_reach_tenant_day on vt.media_reach (tenant_id, day);
alter table vt.media_reach enable row level security;
create policy media_reach_read on vt.media_reach for select to authenticated using (vt.member_role(tenant_id) in ('data_steward', 'marketing_head', 'finance'));
grant select on vt.media_reach to authenticated;
