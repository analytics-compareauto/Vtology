-- Vtology v0.1 — core ontology schema.
-- Runs on Supabase Postgres (auth.uid(), roles "authenticated" and "service_role" exist there).
-- Facts, inferences and decisions are kept in separate tables; human edits never overwrite source data.

create schema if not exists vt;

-- ---------------------------------------------------------------- tenants and people
create table vt.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  industry text not null check (industry in ('FMCG', 'Automotive', 'BFSI')),
  phone_salt text not null default md5(random()::text || clock_timestamp()::text),
  created_at timestamptz not null default now()
);

create table vt.roles (
  code text primary key,
  label text not null,
  sees_pii boolean not null,
  sees_money boolean not null,
  scope text not null check (scope in ('all', 'book', 'partner'))
);

create table vt.partners (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references vt.tenants(id) on delete cascade,
  external_code text not null,
  name text not null,
  partner_type text not null,
  city text,
  active boolean not null default true,
  unique (tenant_id, external_code)
);

create table vt.memberships (
  tenant_id uuid not null references vt.tenants(id) on delete cascade,
  user_id uuid not null,
  role text not null references vt.roles(code),
  partner_id uuid references vt.partners(id),
  book_code text,
  primary key (tenant_id, user_id),
  check (role <> 'partner_user' or partner_id is not null),
  check (role <> 'relationship_manager' or book_code is not null)
);

-- ---------------------------------------------------------------- industry modules
create table vt.stage_defs (
  industry text not null,
  idx int not null,
  name text not null,
  sla_days int not null,
  converted boolean not null default false,
  primary key (industry, idx)
);

-- ---------------------------------------------------------------- facts: imports and source records
create table vt.import_batches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references vt.tenants(id) on delete cascade,
  source_system text not null,
  entity text not null check (entity in ('lead', 'journey_event', 'transaction', 'campaign', 'partner', 'consent')),
  file_name text,
  row_count int not null default 0,
  error_count int not null default 0,
  errors jsonb not null default '[]',
  created_by uuid,
  created_at timestamptz not null default now()
);

create table vt.parties (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references vt.tenants(id) on delete cascade,
  display_name text not null,
  city text,
  pincode text,
  book_code text,
  is_existing_customer boolean not null default false,
  created_at timestamptz not null default now()
);

create table vt.source_records (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references vt.tenants(id) on delete cascade,
  batch_id uuid references vt.import_batches(id) on delete set null,
  source_system text not null,
  external_id text,
  raw_name text,
  phone_hash text,
  email_hash text,
  gov_id_hash text,
  pincode text,
  city text,
  payload jsonb not null default '{}',
  party_id uuid references vt.parties(id) on delete set null,
  match_method text check (match_method in ('anchor', 'deterministic', 'probabilistic', 'held_for_review')),
  match_confidence numeric(4, 3),
  loaded_at timestamptz not null default now()
);
create index on vt.source_records (tenant_id, phone_hash);
create index on vt.source_records (tenant_id, party_id);

create table vt.identifiers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references vt.tenants(id) on delete cascade,
  party_id uuid not null references vt.parties(id) on delete cascade,
  kind text not null check (kind in ('phone', 'email', 'gov_id', 'account', 'device', 'qr')),
  value_hash text not null,
  unique (tenant_id, party_id, kind, value_hash)
);
create index on vt.identifiers (tenant_id, kind, value_hash);

create table vt.consents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references vt.tenants(id) on delete cascade,
  party_id uuid not null references vt.parties(id) on delete cascade,
  purpose text not null,
  channel text not null,
  granted boolean not null,
  source text,
  recorded_at timestamptz not null default now(),
  expires_at timestamptz
);
create index on vt.consents (tenant_id, party_id);

create table vt.campaigns (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references vt.tenants(id) on delete cascade,
  external_code text not null,
  name text not null,
  channel text not null,
  start_date date,
  end_date date,
  spend_inr numeric not null default 0,
  platform_reported_conversions int not null default 0,
  unique (tenant_id, external_code)
);

create table vt.journeys (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references vt.tenants(id) on delete cascade,
  external_ref text not null,
  party_id uuid references vt.parties(id) on delete set null,
  campaign_id uuid references vt.campaigns(id) on delete set null,
  partner_id uuid references vt.partners(id) on delete set null,
  stage_index int not null default 0,
  stage_entered_at timestamptz not null,
  last_activity_at timestamptz not null,
  crm_converted boolean not null default false,
  value_inr numeric,
  created_at timestamptz not null default now(),
  unique (tenant_id, external_ref)
);
create index on vt.journeys (tenant_id, partner_id);

create table vt.transactions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references vt.tenants(id) on delete cascade,
  external_ref text not null,
  party_id uuid references vt.parties(id) on delete set null,
  journey_id uuid references vt.journeys(id) on delete set null,
  partner_id uuid references vt.partners(id) on delete set null,
  occurred_at timestamptz not null,
  value_inr numeric not null,
  evidence text not null default 'observed' check (evidence in ('observed', 'linked', 'inferred')),
  unique (tenant_id, external_ref)
);

-- ---------------------------------------------------------------- inferences
create table vt.pipeline_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references vt.tenants(id) on delete cascade,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  stats jsonb not null default '{}'
);

create table vt.violations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references vt.tenants(id) on delete cascade,
  run_id uuid references vt.pipeline_runs(id) on delete cascade,
  rule text not null,
  severity text not null check (severity in ('high', 'medium', 'info')),
  entity_kind text not null,
  entity_ref text not null,
  partner_id uuid references vt.partners(id) on delete set null,
  detail text not null,
  value_inr numeric not null default 0,
  status text not null default 'open' check (status in ('open', 'resolved')),
  detected_at timestamptz not null default now()
);
create index on vt.violations (tenant_id, run_id);

-- ---------------------------------------------------------------- decisions: governed actions
create table vt.action_types (
  code text primary key,
  label text not null,
  object_kind text not null,
  roles text[] not null,
  writeback text not null
);

create table vt.action_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references vt.tenants(id) on delete cascade,
  type_code text not null references vt.action_types(code),
  object_kind text not null,
  object_id text not null,
  object_label text not null,
  requested_by uuid not null,
  requested_role text not null references vt.roles(code),
  reason text,
  rules jsonb not null,
  effects jsonb not null,
  payload jsonb not null default '{}',
  status text not null check (status in ('done', 'awaiting_approval', 'rejected', 'blocked')),
  approver_role text references vt.roles(code),
  decided_by uuid,
  decided_role text references vt.roles(code),
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create index on vt.action_runs (tenant_id, created_at desc);

-- human edits, kept apart from source data and merged into the current view
create table vt.edits (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references vt.tenants(id) on delete cascade,
  action_run_id uuid not null references vt.action_runs(id) on delete cascade,
  entity text not null,
  entity_id uuid not null,
  field text not null,
  old_value jsonb,
  new_value jsonb,
  created_at timestamptz not null default now()
);
create index on vt.edits (tenant_id, entity, entity_id, field, created_at desc);

-- side effects to outside systems, sent by a worker (writeback)
create table vt.outbox (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references vt.tenants(id) on delete cascade,
  action_run_id uuid not null references vt.action_runs(id) on delete cascade,
  target text not null,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  attempts int not null default 0,
  created_at timestamptz not null default now()
);

create table vt.value_ledger (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references vt.tenants(id) on delete cascade,
  lever text not null,
  period text not null,
  method text not null,
  amount_inr numeric not null,
  status text not null check (status in ('proven', 'indicative')),
  evidence jsonb not null default '{}',
  signed_off_by uuid,
  created_at timestamptz not null default now()
);

create table vt.audit_log (
  id bigint generated always as identity primary key,
  tenant_id uuid,
  actor uuid,
  table_name text not null,
  op text not null,
  row_id text,
  at timestamptz not null default now(),
  diff jsonb
);

-- ---------------------------------------------------------------- current view: journeys with edits merged
create view vt.journeys_current with (security_invoker = true) as
select j.*,
  coalesce((select (e.new_value #>> '{}')::uuid from vt.edits e
            where e.entity = 'journey' and e.entity_id = j.id and e.field = 'partner_id'
            order by e.created_at desc limit 1), j.partner_id) as current_partner_id,
  exists (select 1 from vt.edits e where e.entity = 'journey' and e.entity_id = j.id) as edited
from vt.journeys j;
