/** Industry modules and roles. Mirrors supabase/migrations/*_reference_data.sql. */

export type Industry = 'FMCG' | 'Automotive' | 'BFSI';

export type RoleCode =
  | 'marketing_head'
  | 'sales_ops'
  | 'data_steward'
  | 'finance'
  | 'relationship_manager'
  | 'partner_user';

export interface RoleDef {
  code: RoleCode;
  label: string;
  seesPii: boolean;
  seesMoney: boolean;
  scope: 'all' | 'book' | 'partner';
}

export const ROLES: Record<RoleCode, RoleDef> = {
  marketing_head: { code: 'marketing_head', label: 'Marketing head', seesPii: false, seesMoney: true, scope: 'all' },
  sales_ops: { code: 'sales_ops', label: 'Sales ops', seesPii: true, seesMoney: false, scope: 'all' },
  data_steward: { code: 'data_steward', label: 'Data steward', seesPii: true, seesMoney: false, scope: 'all' },
  finance: { code: 'finance', label: 'Finance', seesPii: false, seesMoney: true, scope: 'all' },
  relationship_manager: { code: 'relationship_manager', label: 'Relationship manager', seesPii: true, seesMoney: false, scope: 'book' },
  partner_user: { code: 'partner_user', label: 'Partner user', seesPii: true, seesMoney: false, scope: 'partner' },
};

export interface StageDef {
  idx: number;
  name: string;
  /** Days a journey may sit in this stage before it counts as stalled; 0 = no limit (final stage). */
  slaDays: number;
  /** Reaching this stage counts as a conversion. */
  converted: boolean;
}

export const STAGES: Record<Industry, StageDef[]> = {
  FMCG: [
    { idx: 0, name: 'Engaged', slaDays: 30, converted: false },
    { idx: 1, name: 'Participant', slaDays: 21, converted: false },
    { idx: 2, name: 'Identified', slaDays: 30, converted: false },
    { idx: 3, name: 'Trial', slaDays: 45, converted: true },
    { idx: 4, name: 'Repeat', slaDays: 60, converted: true },
    { idx: 5, name: 'Loyal', slaDays: 0, converted: true },
  ],
  Automotive: [
    { idx: 0, name: 'Inquiry', slaDays: 2, converted: false },
    { idx: 1, name: 'Lead allocated', slaDays: 3, converted: false },
    { idx: 2, name: 'Dealer contacted', slaDays: 7, converted: false },
    { idx: 3, name: 'Test drive', slaDays: 10, converted: false },
    { idx: 4, name: 'Booking', slaDays: 30, converted: true },
    { idx: 5, name: 'Retail', slaDays: 0, converted: true },
  ],
  BFSI: [
    { idx: 0, name: 'Lead', slaDays: 3, converted: false },
    { idx: 1, name: 'KYC', slaDays: 5, converted: false },
    { idx: 2, name: 'Application', slaDays: 7, converted: false },
    { idx: 3, name: 'Underwriting', slaDays: 10, converted: false },
    { idx: 4, name: 'Sanction', slaDays: 7, converted: true },
    { idx: 5, name: 'Disbursal', slaDays: 0, converted: true },
  ],
};

/** FMCG awareness-only engagement is natural drop-off, not leakage. */
export function stageCountsAsLeakage(industry: Industry, stageIdx: number): boolean {
  return !(industry === 'FMCG' && stageIdx === 0);
}

export function stageIndexByName(industry: Industry, nameOrIndex: string | number): number | null {
  if (typeof nameOrIndex === 'number') return STAGES[industry][nameOrIndex] ? nameOrIndex : null;
  const n = nameOrIndex.trim().toLowerCase();
  if (/^\d+$/.test(n)) return stageIndexByName(industry, Number(n));
  const hit = STAGES[industry].find(s => s.name.toLowerCase() === n);
  return hit ? hit.idx : null;
}
