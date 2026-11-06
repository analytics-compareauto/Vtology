-- Who ranks in YouTube's top 20 for each of the category's top searches (checked a few a day, each weekly).
alter table vt.content_trends add column if not exists ranks jsonb not null default '{}'::jsonb;
