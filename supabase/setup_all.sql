-- Vtology: full database setup. Paste all of this into Supabase → SQL Editor → New query → Run.
-- (Deployed versions of Vtology also apply new migrations automatically on start.)

-- ===== 20261031000001_core.sql =====
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

-- ===== 20261031000002_security.sql =====
-- Vtology v0.1 — row-level security, role scoping, masking and audit.
-- Users read through RLS (role "authenticated"); all writes go through the API's server connection,
-- which runs the governed-action checks in TypeScript first.

-- helpers -----------------------------------------------------------------------
create or replace function vt.member_role(t uuid) returns text
language sql stable security definer set search_path = vt, public as $$
  select role from vt.memberships where tenant_id = t and user_id = auth.uid()
$$;

create or replace function vt.is_member(t uuid) returns boolean
language sql stable security definer set search_path = vt, public as $$
  select exists (select 1 from vt.memberships where tenant_id = t and user_id = auth.uid())
$$;

create or replace function vt.member_partner(t uuid) returns uuid
language sql stable security definer set search_path = vt, public as $$
  select partner_id from vt.memberships where tenant_id = t and user_id = auth.uid()
$$;

create or replace function vt.member_book(t uuid) returns text
language sql stable security definer set search_path = vt, public as $$
  select book_code from vt.memberships where tenant_id = t and user_id = auth.uid()
$$;

create or replace function vt.sees(t uuid, what text) returns boolean
language sql stable security definer set search_path = vt, public as $$
  select coalesce((select case what when 'pii' then r.sees_pii when 'money' then r.sees_money end
                   from vt.memberships m join vt.roles r on r.code = m.role
                   where m.tenant_id = t and m.user_id = auth.uid()), false)
$$;

create or replace function vt.mask_name(n text) returns text
language sql immutable as $$
  select string_agg(left(w, 1) || '•••', ' ') from regexp_split_to_table(coalesce(n, ''), '\s+') as w where w <> ''
$$;

-- can the current user see this party? (partner users: only parties with a journey at their partner)
create or replace function vt.can_see_party(t uuid, p uuid, book text) returns boolean
language sql stable security definer set search_path = vt, public as $$
  select case (select r.scope from vt.memberships m join vt.roles r on r.code = m.role where m.tenant_id = t and m.user_id = auth.uid())
    when 'all' then true
    when 'book' then book is not null and book = vt.member_book(t)
    when 'partner' then exists (select 1 from vt.journeys_current j where j.tenant_id = t and j.party_id = p and j.current_partner_id = vt.member_partner(t))
    else false end
$$;

-- enable RLS --------------------------------------------------------------------
alter table vt.tenants enable row level security;
alter table vt.memberships enable row level security;
alter table vt.partners enable row level security;
alter table vt.parties enable row level security;
alter table vt.source_records enable row level security;
alter table vt.identifiers enable row level security;
alter table vt.consents enable row level security;
alter table vt.campaigns enable row level security;
alter table vt.journeys enable row level security;
alter table vt.transactions enable row level security;
alter table vt.import_batches enable row level security;
alter table vt.pipeline_runs enable row level security;
alter table vt.violations enable row level security;
alter table vt.action_runs enable row level security;
alter table vt.edits enable row level security;
alter table vt.outbox enable row level security;
alter table vt.value_ledger enable row level security;
alter table vt.audit_log enable row level security;

-- read policies (no insert/update/delete policies for "authenticated": writes go through the API)
create policy tenants_read on vt.tenants for select to authenticated using (vt.is_member(id));
create policy memberships_read on vt.memberships for select to authenticated using (user_id = auth.uid());
create policy partners_read on vt.partners for select to authenticated
  using (vt.is_member(tenant_id) and (vt.member_role(tenant_id) <> 'partner_user' or id = vt.member_partner(tenant_id)));
create policy parties_read on vt.parties for select to authenticated
  using (vt.is_member(tenant_id) and vt.can_see_party(tenant_id, id, book_code));
create policy source_records_read on vt.source_records for select to authenticated
  using (vt.member_role(tenant_id) in ('data_steward', 'marketing_head'));
create policy identifiers_read on vt.identifiers for select to authenticated
  using (vt.member_role(tenant_id) = 'data_steward');
create policy consents_read on vt.consents for select to authenticated using (vt.is_member(tenant_id));
create policy campaigns_read on vt.campaigns for select to authenticated
  using (vt.member_role(tenant_id) in ('marketing_head', 'finance', 'sales_ops'));
create policy journeys_read on vt.journeys for select to authenticated
  using (vt.is_member(tenant_id) and case vt.member_role(tenant_id)
    when 'partner_user' then exists (select 1 from vt.journeys_current c where c.id = journeys.id and c.current_partner_id = vt.member_partner(tenant_id))
    when 'relationship_manager' then exists (select 1 from vt.parties p where p.id = journeys.party_id and p.book_code = vt.member_book(tenant_id))
    when 'finance' then false
    else true end);
create policy transactions_read on vt.transactions for select to authenticated
  using (vt.is_member(tenant_id) and vt.member_role(tenant_id) <> 'partner_user');
create policy import_batches_read on vt.import_batches for select to authenticated
  using (vt.member_role(tenant_id) in ('data_steward', 'marketing_head'));
create policy pipeline_runs_read on vt.pipeline_runs for select to authenticated using (vt.is_member(tenant_id));
create policy violations_read on vt.violations for select to authenticated
  using (vt.is_member(tenant_id) and vt.member_role(tenant_id) not in ('partner_user', 'relationship_manager'));
create policy action_runs_read on vt.action_runs for select to authenticated
  using (vt.is_member(tenant_id) and (
    (select r.scope from vt.memberships m join vt.roles r on r.code = m.role where m.tenant_id = action_runs.tenant_id and m.user_id = auth.uid()) = 'all'
    or requested_by = auth.uid() or decided_by = auth.uid()));
create policy edits_read on vt.edits for select to authenticated using (vt.member_role(tenant_id) in ('data_steward', 'marketing_head', 'sales_ops'));
create policy value_ledger_read on vt.value_ledger for select to authenticated using (vt.sees(tenant_id, 'money'));
create policy audit_read on vt.audit_log for select to authenticated using (vt.member_role(tenant_id) in ('data_steward', 'finance'));

grant usage on schema vt to authenticated;
grant select on all tables in schema vt to authenticated;
grant execute on all functions in schema vt to authenticated;

-- masked, role-aware views the API reads ------------------------------------------
create view vt.parties_v with (security_invoker = true) as
select p.id, p.tenant_id,
  case when vt.sees(p.tenant_id, 'pii') then p.display_name else vt.mask_name(p.display_name) end as display_name,
  p.city, p.pincode, p.book_code, p.is_existing_customer, p.created_at
from vt.parties p;

create view vt.violations_v with (security_invoker = true) as
select v.id, v.tenant_id, v.run_id, v.rule, v.severity, v.entity_kind, v.entity_ref, v.partner_id, v.detail,
  case when vt.sees(v.tenant_id, 'money') then v.value_inr else null end as value_inr,
  v.status, v.detected_at
from vt.violations v;

grant select on vt.parties_v, vt.violations_v, vt.journeys_current to authenticated;

-- audit trail ------------------------------------------------------------------------
create or replace function vt.audit() returns trigger
language plpgsql security definer set search_path = vt, public as $$
declare r record;
begin
  r := coalesce(new, old);
  insert into vt.audit_log (tenant_id, actor, table_name, op, row_id, diff)
  values (r.tenant_id, auth.uid(), tg_table_name, tg_op, coalesce(to_jsonb(r) ->> 'id', to_jsonb(r) ->> 'user_id'),
          case when tg_op = 'UPDATE' then jsonb_build_object('old', to_jsonb(old), 'new', to_jsonb(new)) else to_jsonb(r) end);
  return r;
end $$;

create trigger audit_action_runs after insert or update on vt.action_runs for each row execute function vt.audit();
create trigger audit_edits after insert on vt.edits for each row execute function vt.audit();
create trigger audit_memberships after insert or update or delete on vt.memberships for each row execute function vt.audit();
create trigger audit_value_ledger after insert or update on vt.value_ledger for each row execute function vt.audit();

-- ===== 20261031000003_reference_data.sql =====
-- Vtology v0.1 — reference data: roles, industry stage definitions, action types.

insert into vt.roles (code, label, sees_pii, sees_money, scope) values
  ('marketing_head',       'Marketing head',       false, true,  'all'),
  ('sales_ops',            'Sales ops',            true,  false, 'all'),
  ('data_steward',         'Data steward',         true,  false, 'all'),
  ('finance',              'Finance',              false, true,  'all'),
  ('relationship_manager', 'Relationship manager', true,  false, 'book'),
  ('partner_user',         'Partner user',         true,  false, 'partner');

insert into vt.stage_defs (industry, idx, name, sla_days, converted) values
  ('FMCG', 0, 'Engaged', 30, false), ('FMCG', 1, 'Participant', 21, false), ('FMCG', 2, 'Identified', 30, false),
  ('FMCG', 3, 'Trial', 45, true), ('FMCG', 4, 'Repeat', 60, true), ('FMCG', 5, 'Loyal', 0, true),
  ('Automotive', 0, 'Inquiry', 2, false), ('Automotive', 1, 'Lead allocated', 3, false), ('Automotive', 2, 'Dealer contacted', 7, false),
  ('Automotive', 3, 'Test drive', 10, false), ('Automotive', 4, 'Booking', 30, true), ('Automotive', 5, 'Retail', 0, true),
  ('BFSI', 0, 'Lead', 3, false), ('BFSI', 1, 'KYC', 5, false), ('BFSI', 2, 'Application', 7, false),
  ('BFSI', 3, 'Underwriting', 10, false), ('BFSI', 4, 'Sanction', 7, true), ('BFSI', 5, 'Disbursal', 0, true);

insert into vt.action_types (code, label, object_kind, roles, writeback) values
  ('reassign_journey', 'Reassign stalled journey', 'journey', array['sales_ops'], 'Partner system and CRM'),
  ('escalate_partner', 'Escalate partner', 'partner', array['sales_ops', 'marketing_head'], 'Email to area manager'),
  ('merge_records', 'Merge records', 'identity_cluster', array['data_steward'], 'Re-score affected profiles'),
  ('keep_separate', 'Keep records separate', 'identity_cluster', array['data_steward'], 'Flag identifier as shared'),
  ('hold_payout', 'Hold scheme payout', 'scheme_claim', array['finance'], 'Payout block in ERP'),
  ('withdraw_consent', 'Withdraw consent', 'party', array['marketing_head', 'sales_ops', 'data_steward', 'finance', 'relationship_manager', 'partner_user'], 'Removed from audiences; delete request to platforms');

-- ===== 20261031000004_person_links.sql =====
-- Vtology v0.1 — keep the person reference on imported journeys, sales and consents,
-- so they can be linked to resolved parties when identity resolution runs (in any import order).

alter table vt.journeys add column person_ref text, add column person_phone_hash text;
alter table vt.transactions add column person_ref text, add column person_phone_hash text, add column journey_ref text;
alter table vt.consents alter column party_id drop not null, add column person_ref text, add column person_phone_hash text;

create index on vt.journeys (tenant_id, person_ref);
create index on vt.source_records (tenant_id, external_id);

-- the partner a journey belongs to now: the latest human edit wins over the imported value.
-- security definer, because partner users must not read the edits table itself.
create or replace function vt.journey_partner(jid uuid, original uuid) returns uuid
language sql stable security definer set search_path = vt, public as $$
  select coalesce((select (e.new_value #>> '{}')::uuid from vt.edits e
                   where e.entity = 'journey' and e.entity_id = jid and e.field = 'partner_id'
                   order by e.created_at desc limit 1), original)
$$;
create or replace function vt.journey_edited(jid uuid) returns boolean
language sql stable security definer set search_path = vt, public as $$
  select exists (select 1 from vt.edits e where e.entity = 'journey' and e.entity_id = jid)
$$;

-- journeys_current must expose the new columns too
drop view vt.journeys_current cascade;
create view vt.journeys_current with (security_invoker = true) as
select j.*, vt.journey_partner(j.id, j.partner_id) as current_partner_id, vt.journey_edited(j.id) as edited
from vt.journeys j;
grant select on vt.journeys_current to authenticated;
grant execute on function vt.journey_partner(uuid, uuid), vt.journey_edited(uuid) to authenticated;

-- recreate functions/policies that depended on the view
create or replace function vt.can_see_party(t uuid, p uuid, book text) returns boolean
language sql stable security definer set search_path = vt, public as $$
  select case (select r.scope from vt.memberships m join vt.roles r on r.code = m.role where m.tenant_id = t and m.user_id = auth.uid())
    when 'all' then true
    when 'book' then book is not null and book = vt.member_book(t)
    when 'partner' then exists (select 1 from vt.journeys j where j.tenant_id = t and j.party_id = p and vt.journey_partner(j.id, j.partner_id) = vt.member_partner(t))
    else false end
$$;

drop policy if exists journeys_read on vt.journeys;
create policy journeys_read on vt.journeys for select to authenticated
  using (vt.is_member(tenant_id) and case vt.member_role(tenant_id)
    when 'partner_user' then vt.journey_partner(journeys.id, journeys.partner_id) = vt.member_partner(tenant_id)
    when 'relationship_manager' then exists (select 1 from vt.parties p where p.id = journeys.party_id and p.book_code = vt.member_book(tenant_id))
    when 'finance' then false
    else true end);

-- ===== 20261031000005_workspaces.sql =====
-- v0.2: workspaces created from the app, and sample (demo) workspaces where a member may switch
-- their own role to see each role's view. Demo workspaces hold generated data only.
alter table vt.tenants add column if not exists is_demo boolean not null default false;
alter table vt.tenants add column if not exists created_by uuid;
alter table vt.tenants add column if not exists created_at timestamptz not null default now();

-- ===== 20261102000006_social.sql =====
-- v0.3: brand social footprint. Brand-level data only (the brand's own accounts and posts, and
-- aggregate metrics); no individual people are stored. Pulled through each platform's official API
-- after the brand approves access on the platform's own consent screen.

create table vt.social_connections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references vt.tenants(id) on delete cascade,
  provider text not null check (provider in ('meta', 'youtube', 'linkedin', 'sample')),
  label text not null,                       -- e.g. the Facebook or Google account that approved access
  scopes text[] not null default '{}',
  status text not null default 'active' check (status in ('active', 'expired', 'revoked', 'error')),
  connected_by uuid,
  connected_at timestamptz not null default now(),
  last_sync_at timestamptz,
  last_error text,
  unique (tenant_id, provider)
);

-- Access keys live apart from everything else, encrypted by the server (AES-256-GCM).
-- No policy and no grant: only the server role can read this table.
create table vt.social_tokens (
  connection_id uuid primary key references vt.social_connections(id) on delete cascade,
  tenant_id uuid not null references vt.tenants(id) on delete cascade,
  access_token_enc text not null,
  refresh_token_enc text,
  expires_at timestamptz,
  extra_enc text,                            -- e.g. per-page tokens for Facebook Pages
  updated_at timestamptz not null default now()
);

create table vt.social_accounts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references vt.tenants(id) on delete cascade,
  connection_id uuid references vt.social_connections(id) on delete cascade,
  platform text not null check (platform in ('instagram', 'facebook', 'youtube', 'linkedin')),
  external_id text not null,
  handle text,
  name text not null,
  is_competitor boolean not null default false,
  followers int,
  posts_count int,
  profile_url text,
  updated_at timestamptz not null default now(),
  unique (tenant_id, platform, external_id)
);

create table vt.social_posts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references vt.tenants(id) on delete cascade,
  account_id uuid not null references vt.social_accounts(id) on delete cascade,
  external_id text not null,
  posted_at timestamptz not null,
  format text not null,                      -- reel, video, short, image, carousel, text, link, live
  caption text,
  permalink text,
  duration_s int,
  -- latest metrics (null when the platform does not report one)
  views bigint, reach bigint, likes bigint, comments bigint, shares bigint, saves bigint,
  watch_minutes numeric, avg_view_pct numeric,
  metrics_at timestamptz,
  campaign_id uuid references vt.campaigns(id) on delete set null,
  unique (tenant_id, account_id, external_id)
);
create index social_posts_tenant_time on vt.social_posts (tenant_id, posted_at desc);

create table vt.social_account_daily (
  account_id uuid not null references vt.social_accounts(id) on delete cascade,
  tenant_id uuid not null references vt.tenants(id) on delete cascade,
  day date not null,
  followers int,
  primary key (account_id, day)
);

-- who sees social: everyone except partner users and relationship managers
create or replace function vt.sees_social(t uuid) returns boolean
  language sql stable security definer set search_path = vt, public as $$
  select vt.member_role(t) in ('marketing_head', 'sales_ops', 'data_steward', 'finance')
$$;

alter table vt.social_connections enable row level security;
alter table vt.social_tokens enable row level security;
alter table vt.social_accounts enable row level security;
alter table vt.social_posts enable row level security;
alter table vt.social_account_daily enable row level security;

create policy social_connections_read on vt.social_connections for select to authenticated using (vt.sees_social(tenant_id));
create policy social_accounts_read on vt.social_accounts for select to authenticated using (vt.sees_social(tenant_id));
create policy social_posts_read on vt.social_posts for select to authenticated using (vt.sees_social(tenant_id));
create policy social_daily_read on vt.social_account_daily for select to authenticated using (vt.sees_social(tenant_id));

grant select on vt.social_connections, vt.social_accounts, vt.social_posts, vt.social_account_daily to authenticated;
grant execute on function vt.sees_social(uuid) to authenticated;
revoke all on vt.social_tokens from authenticated;

-- ===== 20261103000007_social_thumbnails.sql =====
-- Post thumbnails for the social dashboard (a picture link from the platform, refreshed on each sync)
alter table vt.social_posts add column if not exists thumbnail_url text;

create schema if not exists vt_meta;
create table if not exists vt_meta.schema_migrations (id text primary key, applied_at timestamptz not null default now());
insert into vt_meta.schema_migrations (id) values ('20261031000001_core'), ('20261031000002_security'), ('20261031000003_reference_data'), ('20261031000004_person_links'), ('20261031000005_workspaces'), ('20261102000006_social'), ('20261103000007_social_thumbnails') on conflict do nothing;
