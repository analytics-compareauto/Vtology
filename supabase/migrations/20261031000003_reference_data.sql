-- Vtology v0.1 — reference data: roles, industry stage definitions, action types.

insert into vt.roles (code, label, sees_pii, sees_money, scope) values
  ('marketing_head',       'Marketing head',       false, true,  'all'),
  ('sales_ops',            'Sales ops',            true,  false, 'all'),
  ('data_steward',         'Data steward',         true,  false, 'all'),
  ('finance',              'Finance',              false, true,  'all'),
  ('relationship_manager', 'Relationship manager', true,  false, 'book'),
  ('partner_user',         'Partner user',         true,  false, 'partner');

insert into vt.stage_defs (industry, idx, name, sla_days, converted) values
  ('FMCG', 0, 'Engaged', 30, false), ('FMCG', 1, 'Participant', 21, false), ('FMCG', 2, 'Identified', 30, false),
  ('FMCG', 3, 'Trial', 45, true), ('FMCG', 4, 'Repeat', 60, true), ('FMCG', 5, 'Loyal', 0, true),
  ('Automotive', 0, 'Inquiry', 2, false), ('Automotive', 1, 'Lead allocated', 3, false), ('Automotive', 2, 'Dealer contacted', 7, false),
  ('Automotive', 3, 'Test drive', 10, false), ('Automotive', 4, 'Booking', 30, true), ('Automotive', 5, 'Retail', 0, true),
  ('BFSI', 0, 'Lead', 3, false), ('BFSI', 1, 'KYC', 5, false), ('BFSI', 2, 'Application', 7, false),
  ('BFSI', 3, 'Underwriting', 10, false), ('BFSI', 4, 'Sanction', 7, true), ('BFSI', 5, 'Disbursal', 0, true);

insert into vt.action_types (code, label, object_kind, roles, writeback) values
  ('reassign_journey', 'Reassign stalled journey', 'journey', array['sales_ops'], 'Partner system and CRM'),
  ('escalate_partner', 'Escalate partner', 'partner', array['sales_ops', 'marketing_head'], 'Email to area manager'),
  ('merge_records', 'Merge records', 'identity_cluster', array['data_steward'], 'Re-score affected profiles'),
  ('keep_separate', 'Keep records separate', 'identity_cluster', array['data_steward'], 'Flag identifier as shared'),
  ('hold_payout', 'Hold scheme payout', 'scheme_claim', array['finance'], 'Payout block in ERP'),
  ('withdraw_consent', 'Withdraw consent', 'party', array['marketing_head', 'sales_ops', 'data_steward', 'finance', 'relationship_manager', 'partner_user'], 'Removed from audiences; delete request to platforms');
