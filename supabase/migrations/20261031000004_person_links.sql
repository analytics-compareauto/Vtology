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
