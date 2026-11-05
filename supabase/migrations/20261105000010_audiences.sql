-- Audiences: hashed lists a brand uploads (customers, buyers, exclusions), buckets built from them with
-- a fixed holdout, and a log of every export. Match keys are standard SHA-256 of a normalised email or
-- phone, so they can be matched with outside partners (Customer Match, SSPs, clean rooms). They are
-- readable by no database role: only the server's matching and export jobs touch them.

create table if not exists vt.audience_lists (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references vt.tenants(id) on delete cascade,
  name text not null,
  -- customers: people the brand has; buyers: who converted (for measuring lift); exclude: never target
  kind text not null default 'customers' check (kind in ('customers', 'buyers', 'exclude', 'other')),
  status text not null default 'uploading' check (status in ('uploading', 'ready')),
  rows_received int not null default 0,
  rows_rejected int not null default 0,
  people int not null default 0,
  with_email int not null default 0,
  with_phone int not null default 0,
  -- per attribute: its values and counts (few values) or a numeric range, for the bucket builder
  attributes jsonb not null default '{}',
  expires_at timestamptz not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (tenant_id, name)
);

create table if not exists vt.audience_members (
  tenant_id uuid not null references vt.tenants(id) on delete cascade,
  list_id uuid not null references vt.audience_lists(id) on delete cascade,
  -- 'e:<email sha256>' when the row has an email, else 'p:<phone sha256>'
  person_key text not null,
  email_sha256 text check (email_sha256 ~ '^[0-9a-f]{64}$'),
  phone_sha256 text check (phone_sha256 ~ '^[0-9a-f]{64}$'),
  attrs jsonb not null default '{}',
  primary key (list_id, person_key)
);
create index if not exists audience_members_email on vt.audience_members (tenant_id, email_sha256) where email_sha256 is not null;
create index if not exists audience_members_phone on vt.audience_members (tenant_id, phone_sha256) where phone_sha256 is not null;

create table if not exists vt.audience_buckets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references vt.tenants(id) on delete cascade,
  name text not null,
  purpose text not null default 'target' check (purpose in ('target', 'upgrade', 'winback', 'retention', 'exclude', 'lookalike_seed')),
  include_lists uuid[] not null default '{}',
  exclude_lists uuid[] not null default '{}',
  -- [{field, op, value}], all must hold
  rules jsonb not null default '[]',
  holdout_pct numeric not null default 10 check (holdout_pct >= 0 and holdout_pct <= 50),
  -- a list of buyers to measure the bucket against (targeted vs holdout)
  measure_list uuid references vt.audience_lists(id) on delete set null,
  stats jsonb not null default '{}',
  computed_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (tenant_id, name)
);

create table if not exists vt.audience_exports (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references vt.tenants(id) on delete cascade,
  bucket_id uuid references vt.audience_buckets(id) on delete set null,
  bucket_name text not null,
  part text not null check (part in ('target', 'holdout')),
  format text not null,
  rows int not null,
  created_by uuid,
  created_at timestamptz not null default now()
);

alter table vt.audience_lists enable row level security;
alter table vt.audience_members enable row level security;
alter table vt.audience_buckets enable row level security;
alter table vt.audience_exports enable row level security;
-- members: no policy and no grant, so no signed-in role can read match keys
create policy audience_lists_read on vt.audience_lists for select to authenticated using (vt.member_role(tenant_id) in ('data_steward', 'marketing_head'));
create policy audience_buckets_read on vt.audience_buckets for select to authenticated using (vt.member_role(tenant_id) in ('data_steward', 'marketing_head'));
create policy audience_exports_read on vt.audience_exports for select to authenticated using (vt.member_role(tenant_id) in ('data_steward', 'marketing_head', 'finance'));
grant select on vt.audience_lists, vt.audience_buckets, vt.audience_exports to authenticated;

drop trigger if exists audit_audience_lists on vt.audience_lists;
create trigger audit_audience_lists after insert or delete on vt.audience_lists for each row execute function vt.audit();
drop trigger if exists audit_audience_exports on vt.audience_exports;
create trigger audit_audience_exports after insert on vt.audience_exports for each row execute function vt.audit();
