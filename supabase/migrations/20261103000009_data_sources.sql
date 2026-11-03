-- Connected data sources: a brand's own systems (dealer dashboards, DMS, CRM, ...) that Vtology pulls
-- from on a schedule. One row per source; the access key is encrypted by the server and readable by
-- no database role.
create table if not exists vt.data_sources (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references vt.tenants(id) on delete cascade,
  name text not null,
  -- the shape of what the source returns; 'lead_feed_v1' is the Vtology lead feed
  template text not null check (template in ('lead_feed_v1')),
  base_url text not null,
  key_enc text,
  -- how the source's own words map onto this workspace's stages, e.g. {"Car Booked": "Booking"}
  status_map jsonb not null default '{}',
  -- values seen in the last pulls, so the mapping screen can list them
  seen_statuses jsonb not null default '{}',
  status text not null default 'active' check (status in ('active', 'error', 'paused')),
  last_sync_at timestamptz,
  last_error text,
  -- incremental pulls: everything changed since this moment is fetched next time
  synced_until timestamptz,
  stats jsonb not null default '{}',
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (tenant_id, name)
);
alter table vt.data_sources enable row level security;
-- readable (without the key column) by people who manage data; the key stays server-only
create policy data_sources_read on vt.data_sources for select to authenticated using (vt.member_role(tenant_id) in ('data_steward', 'marketing_head', 'sales_ops'));
grant select (id, tenant_id, name, template, base_url, status_map, seen_statuses, status, last_sync_at, last_error, synced_until, stats, created_by, created_at) on vt.data_sources to authenticated;
