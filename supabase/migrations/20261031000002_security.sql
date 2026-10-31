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
