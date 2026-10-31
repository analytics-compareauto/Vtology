-- v0.2: workspaces created from the app, and sample (demo) workspaces where a member may switch
-- their own role to see each role's view. Demo workspaces hold generated data only.
alter table vt.tenants add column if not exists is_demo boolean not null default false;
alter table vt.tenants add column if not exists created_by uuid;
alter table vt.tenants add column if not exists created_at timestamptz not null default now();
