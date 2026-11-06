-- Vanaya's side: each client's plan, which parts are switched on, and the activation margin (never
-- shown to the client); and a record of every change made from the admin panel.
alter table vt.tenants add column if not exists plan text not null default 'enterprise';
alter table vt.tenants add column if not exists features jsonb not null default '{"social": true, "media": true, "audiences": true, "journeys": true}'::jsonb;
alter table vt.tenants add column if not exists margin_pct numeric;
alter table vt.tenants add column if not exists admin_note text;
create table if not exists vt.admin_audit (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  admin_email text not null,
  tenant_id uuid references vt.tenants(id) on delete set null,
  tenant_name text,
  action text not null,
  detail jsonb not null default '{}'::jsonb
);
alter table vt.admin_audit enable row level security;
