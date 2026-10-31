/**
 * Governed actions: the only way anything in the ontology or an outside system changes.
 * Each action type declares who may run it, the rules that must pass, its side effects,
 * the human edits it records (kept apart from source data) and the outbox messages it sends.
 *
 * Outcome of a request:
 *  - any rule fails            -> blocked (nothing changes)
 *  - rules pass, role allowed  -> done (edits and outbox written)
 *  - rules pass, role not      -> awaiting_approval by the first allowed role
 */
import type { RoleCode } from './modules';

export interface Rule { label: string; pass: boolean }
export interface EditIntent { entity: string; entityId: string; field: string; oldValue: unknown; newValue: unknown }
export interface OutboxIntent { target: string; payload: Record<string, unknown> }

export interface ActionTypeDef<C> {
  code: string;
  label: string;
  objectKind: string;
  roles: RoleCode[];
  writeback: string;
  rules(ctx: C): Rule[];
  effects(ctx: C): string[];
  edits(ctx: C): EditIntent[];
  outbox(ctx: C): OutboxIntent[];
  objectId(ctx: C): string;
  objectLabel(ctx: C): string;
}

// ------------------------------------------------------------- contexts
export interface ReassignCtx {
  journey: { id: string; externalRef: string; stage: string; converted: boolean; daysIdle: number; slaDays: number; currentPartnerId: string | null; partyLabel: string };
  newPartner: { id: string; name: string; active: boolean; stalledShare: number } | null;
}
export interface EscalateCtx { partner: { id: string; name: string; stalledShare: number; journeys: number }; alreadyEscalated: boolean }
export interface MergeCtx { identifier: string; recordIds: string[]; distinctNames: number; govIdConflict: boolean; alreadyDecided: boolean }
export interface HoldPayoutCtx { violation: { id: string; rule: string; entityRef: string; valueInr: number }; alreadyHeld: boolean }
export interface WithdrawConsentCtx { party: { id: string; label: string } }

const reassign: ActionTypeDef<ReassignCtx> = {
  code: 'reassign_journey', label: 'Reassign stalled journey', objectKind: 'journey', roles: ['sales_ops'], writeback: 'Partner system and CRM',
  rules: c => [
    { label: 'Journey has not converted', pass: !c.journey.converted },
    { label: 'Journey is idle beyond its stage limit', pass: c.journey.slaDays > 0 && c.journey.daysIdle > c.journey.slaDays },
    { label: 'New partner is different from the current one', pass: !!c.newPartner && c.newPartner.id !== c.journey.currentPartnerId },
    { label: 'New partner is active', pass: !!c.newPartner && c.newPartner.active },
    { label: 'New partner stalls fewer than 40% of journeys', pass: !!c.newPartner && c.newPartner.stalledShare < 0.4 },
  ],
  effects: c => [`Journey moved to ${c.newPartner?.name ?? '—'}`, `${c.newPartner?.name ?? 'Partner'} notified through the partner system`, 'CRM owner updated'],
  edits: c => [{ entity: 'journey', entityId: c.journey.id, field: 'partner_id', oldValue: c.journey.currentPartnerId, newValue: c.newPartner!.id }],
  outbox: c => [
    { target: 'partner_system', payload: { event: 'journey_reassigned', journey: c.journey.externalRef, partner_id: c.newPartner!.id } },
    { target: 'crm', payload: { event: 'owner_changed', journey: c.journey.externalRef, partner_id: c.newPartner!.id } },
  ],
  objectId: c => c.journey.id,
  objectLabel: c => `${c.journey.partyLabel} · ${c.journey.stage}`,
};

const escalate: ActionTypeDef<EscalateCtx> = {
  code: 'escalate_partner', label: 'Escalate partner', objectKind: 'partner', roles: ['sales_ops', 'marketing_head'], writeback: 'Email to area manager',
  rules: c => [
    { label: 'Stalled share above 38%', pass: c.partner.stalledShare > 0.38 },
    { label: 'At least 10 journeys handled', pass: c.partner.journeys >= 10 },
    { label: 'Not already escalated', pass: !c.alreadyEscalated },
  ],
  effects: c => [`${c.partner.name} flagged on the scorecard`, 'Area manager emailed with the stalled list'],
  edits: c => [{ entity: 'partner', entityId: c.partner.id, field: 'escalated', oldValue: false, newValue: true }],
  outbox: c => [{ target: 'email', payload: { template: 'partner_escalation', partner_id: c.partner.id } }],
  objectId: c => c.partner.id,
  objectLabel: c => c.partner.name,
};

const merge: ActionTypeDef<MergeCtx> = {
  code: 'merge_records', label: 'Merge records', objectKind: 'identity_cluster', roles: ['data_steward'], writeback: 'Re-score affected profiles',
  rules: c => [
    { label: 'No conflicting government ID in the cluster', pass: !c.govIdConflict },
    { label: 'Names in the cluster are plausibly one person', pass: c.distinctNames <= 1 },
    { label: 'Not already decided', pass: !c.alreadyDecided },
  ],
  effects: c => [`${c.recordIds.length} records merged into one profile`, 'Scores recalculated'],
  edits: c => [{ entity: 'identity_cluster', entityId: c.recordIds[0]!, field: 'decision', oldValue: null, newValue: { decision: 'merge', identifier: c.identifier, records: c.recordIds } }],
  outbox: () => [],
  objectId: c => c.recordIds[0]!,
  objectLabel: c => c.identifier,
};

const keepSeparate: ActionTypeDef<MergeCtx> = {
  ...merge,
  code: 'keep_separate', label: 'Keep records separate', writeback: 'Flag identifier as shared',
  rules: c => [{ label: 'Cluster is held for review', pass: true }, { label: 'Not already decided', pass: !c.alreadyDecided }],
  effects: c => ['Records kept as separate people', `${c.identifier} marked as a shared identifier`],
  edits: c => [{ entity: 'identity_cluster', entityId: c.recordIds[0]!, field: 'decision', oldValue: null, newValue: { decision: 'keep_separate', identifier: c.identifier, records: c.recordIds } }],
};

const holdPayout: ActionTypeDef<HoldPayoutCtx> = {
  code: 'hold_payout', label: 'Hold scheme payout', objectKind: 'scheme_claim', roles: ['finance'], writeback: 'Payout block in ERP',
  rules: c => [
    { label: 'A leakage or phantom-conversion rule fired', pass: ['scheme_leakage', 'phantom_conversion', 'idle_opportunity'].includes(c.violation.rule) },
    { label: 'Not already on hold', pass: !c.alreadyHeld },
  ],
  effects: c => [`Payout linked to ${c.violation.entityRef} blocked in ERP`, 'Audit request opened'],
  edits: c => [{ entity: 'violation', entityId: c.violation.id, field: 'payout_hold', oldValue: false, newValue: true }],
  outbox: c => [{ target: 'erp', payload: { event: 'payout_hold', ref: c.violation.entityRef } }],
  objectId: c => c.violation.id,
  objectLabel: c => c.violation.entityRef,
};

const withdrawConsent: ActionTypeDef<WithdrawConsentCtx> = {
  code: 'withdraw_consent', label: 'Withdraw consent', objectKind: 'party',
  roles: ['marketing_head', 'sales_ops', 'data_steward', 'finance', 'relationship_manager', 'partner_user'],
  writeback: 'Removed from audiences; delete request to platforms',
  rules: () => [{ label: 'Always allowed: takes effect immediately', pass: true }],
  effects: c => [`${c.party.label} removed from every audience`, 'Delete requests sent to ad platforms'],
  edits: c => [{ entity: 'party', entityId: c.party.id, field: 'consent_marketing', oldValue: true, newValue: false }],
  outbox: c => [{ target: 'ad_platforms', payload: { event: 'delete_request', party_id: c.party.id } }],
  objectId: c => c.party.id,
  objectLabel: c => c.party.label,
};

export const ACTION_TYPES = {
  reassign_journey: reassign,
  escalate_partner: escalate,
  merge_records: merge,
  keep_separate: keepSeparate,
  hold_payout: holdPayout,
  withdraw_consent: withdrawConsent,
} as const;
export type ActionCode = keyof typeof ACTION_TYPES;
export type CtxOf<K extends ActionCode> = Parameters<(typeof ACTION_TYPES)[K]['rules']>[0];

export type ActionStatus = 'done' | 'awaiting_approval' | 'blocked';
export interface Evaluation {
  code: ActionCode;
  status: ActionStatus;
  rules: Rule[];
  effects: string[];
  edits: EditIntent[];
  outbox: OutboxIntent[];
  approverRole: RoleCode | null;
  objectKind: string;
  objectId: string;
  objectLabel: string;
}

export function evaluateAction<K extends ActionCode>(code: K, ctx: CtxOf<K>, role: RoleCode): Evaluation {
  const def = ACTION_TYPES[code] as unknown as ActionTypeDef<CtxOf<K>>;
  const rules = def.rules(ctx);
  const ok = rules.every(r => r.pass);
  const allowed = def.roles.includes(role);
  const status: ActionStatus = !ok ? 'blocked' : allowed ? 'done' : 'awaiting_approval';
  return {
    code, status, rules,
    effects: def.effects(ctx),
    edits: ok ? def.edits(ctx) : [],
    outbox: ok ? def.outbox(ctx) : [],
    approverRole: status === 'awaiting_approval' ? def.roles[0]! : status === 'done' ? role : null,
    objectKind: def.objectKind,
    objectId: def.objectId(ctx),
    objectLabel: def.objectLabel(ctx),
  };
}

/** Can this role approve or reject a pending run of this action type? */
export function canDecide(code: ActionCode, role: RoleCode): boolean {
  return (ACTION_TYPES[code].roles as readonly RoleCode[]).includes(role);
}
