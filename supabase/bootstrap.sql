-- Run once in the Supabase SQL editor after the migrations, to create your first tenant
-- and give yourself access. Replace the values in <> first.
-- Find your user id under Authentication → Users after signing up.

insert into vt.tenants (name, industry) values ('<Brand name>', '<Automotive|BFSI|FMCG>')
returning id;  -- copy this id

insert into vt.memberships (tenant_id, user_id, role)
values ('<tenant id>', '<your auth user id>', 'data_steward');

-- Add more people the same way. Roles:
--   marketing_head, sales_ops, data_steward, finance,
--   relationship_manager (also set book_code), partner_user (also set partner_id)
