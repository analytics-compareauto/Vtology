-- Growth and benchmarking: the competitors a brand tracks, and daily follower history.
-- Competitor data is what each platform shows publicly (followers, posts, likes, comments, views).
create table if not exists vt.social_competitors (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references vt.tenants(id) on delete cascade,
  platform text not null check (platform in ('instagram', 'youtube', 'facebook')),
  handle text not null,
  account_id uuid references vt.social_accounts(id) on delete set null,
  added_by uuid,
  added_at timestamptz not null default now(),
  last_error text,
  unique (tenant_id, platform, handle)
);
alter table vt.social_competitors enable row level security;
create policy social_competitors_read on vt.social_competitors for select to authenticated using (vt.sees_social(tenant_id));
grant select on vt.social_competitors to authenticated;

-- new followers per day (when the platform reports it) next to the follower total
alter table vt.social_account_daily add column if not exists new_followers int;
alter table vt.social_account_daily add column if not exists posts_count int;
