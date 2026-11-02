import type { RoleCode } from '@vtology/core';

/** ₹ in Indian units: 1.2 Cr, 45.6 L, 9,800. */
export function inr(v: number | string | null | undefined): string {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1e7) return `₹${(n / 1e7).toFixed(n >= 1e8 ? 0 : 2)} Cr`;
  if (Math.abs(n) >= 1e5) return `₹${(n / 1e5).toFixed(1)} L`;
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}
export const pct = (x: number) => `${Math.round(x * 100)}%`;
/** 1.2K, 34K, 1.5M: international short form for chart axes and tiles. */
export function compact(x: number): string {
  const a = Math.abs(x);
  if (a >= 1e6) return `${(x / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (a >= 1e3) return `${(x / 1e3).toFixed(a >= 1e4 ? 0 : 1).replace(/\.0$/, '')}K`;
  return `${Math.round(x)}`;
}
/** Signed percent change, e.g. +34% or −12%. */
export const change = (now: number, before: number) => before > 0 ? `${now >= before ? '+' : '−'}${Math.abs(Math.round(((now - before) / before) * 100))}%` : now > 0 ? 'new' : '0%';
export const num = (x: number | null | undefined) => (typeof x === 'number' && Number.isFinite(x) ? x : 0).toLocaleString('en-IN');
export function ago(iso: string): string {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

export const RULES: Record<string, { title: string; explain: string; who: string }> = {
  phantom_conversion: { title: 'Converted in CRM, no sale found', explain: 'The CRM marks these journeys as won, but no matching sale arrived from partner systems within 30 days. Incentives and campaign credit paid on them may be wrong.', who: 'Finance can hold the payout.' },
  orphan_transaction: { title: 'Sale with no inquiry behind it', explain: 'A sale was recorded with no originating inquiry, so the campaign that drove it gets no credit and budget decisions undercount it.', who: 'Data stewards trace these back.' },
  unattributed_spend: { title: 'Campaign spend with no journeys', explain: 'Money was spent on this campaign, but not a single journey traces back to it. Either tracking is broken or the spend is wasted.', who: 'Marketing reviews the campaign.' },
  idle_opportunity: { title: 'Partner letting journeys go idle', explain: 'This partner has more than 38% of its journeys sitting past their stage time limit. Those customers are going cold.', who: 'Sales ops can escalate or reassign.' },
  shared_identifier: { title: 'One phone number, many customers', explain: 'The same number appears under several different names, often a salesperson’s own phone. These records are kept apart until someone decides.', who: 'Data stewards merge or keep separate.' },
};

export const ROLE_SCOPE: Record<RoleCode, string> = {
  marketing_head: 'all journeys and money; customer names are masked',
  sales_ops: 'all journeys with names; money is hidden',
  data_steward: 'all journeys with names; money is hidden',
  finance: 'findings and money; no individual journeys',
  relationship_manager: 'only customers in your book; money is hidden',
  partner_user: 'only journeys assigned to your partner; money is hidden',
};

export const ACTION_LABEL: Record<string, string> = {
  reassign_journey: 'Reassign journey', escalate_partner: 'Escalate partner', merge_records: 'Merge records',
  keep_separate: 'Keep records separate', hold_payout: 'Hold payout', withdraw_consent: 'Withdraw consent',
};

/** Button text when the person can only ask for the action. */
export const REQUEST_LABEL: Record<string, string> = {
  reassign_journey: 'Request reassignment', escalate_partner: 'Request escalation', merge_records: 'Request merge',
  keep_separate: 'Ask to keep separate', hold_payout: 'Request payout hold', withdraw_consent: 'Withdraw consent',
};
