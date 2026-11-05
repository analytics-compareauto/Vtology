-- Repair: before this release, the production driver stored JSON values that the server had already
-- serialised as JSON *strings* (for example "{\"a\":1}" instead of {"a":1}). Turn every such string
-- back into the value it holds, in every jsonb column of the vt schema. Values that aren't JSON text
-- are left as they are.
create or replace function vt_meta_try_jsonb(t text) returns jsonb language plpgsql immutable as $$
begin return t::jsonb; exception when others then return null; end $$;

do $$
declare c record;
begin
  for c in select table_name, column_name from information_schema.columns
            where table_schema = 'vt' and data_type = 'jsonb'
              and table_name in (select table_name from information_schema.tables where table_schema = 'vt' and table_type = 'BASE TABLE')
  loop
    execute format(
      'update vt.%I set %I = vt_meta_try_jsonb(%I #>> ''{}'') where jsonb_typeof(%I) = ''string'' and vt_meta_try_jsonb(%I #>> ''{}'') is not null and (%I #>> ''{}'') ~ ''^\s*[\[{"]''',
      c.table_name, c.column_name, c.column_name, c.column_name, c.column_name, c.column_name);
  end loop;
end $$;

drop function vt_meta_try_jsonb(text);
