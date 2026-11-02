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
