-- A source can be limited to some dealers (and their branches): a dealer group's workspace takes only
-- its own leads from a feed that carries every dealer's.
alter table vt.data_sources add column if not exists dealer_scope text[] not null default '{}';
