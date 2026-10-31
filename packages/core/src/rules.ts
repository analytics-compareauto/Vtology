/**
 * Journey rules and lying-data detectors. Pure functions over plain records, so the same logic runs
 * in the pipeline, in tests and (later) in streaming jobs.
 */
import { STAGES, stageCountsAsLeakage, type Industry } from './modules';

const DAY = 86_400_000;

export interface JourneyRow {
  id: string;
  externalRef: string;
  partyId: string | null;
  campaignId: string | null;
  partnerId: string | null;
  stageIndex: number;
  stageEnteredAt: Date;
  lastActivityAt: Date;
  crmConverted: boolean;
}
export interface TransactionRow { id: string; externalRef: string; journeyId: string | null; partnerId: string | null; occurredAt: Date; valueInr: number }
export interface CampaignRow { id: string; externalCode: string; name: string; spendInr: number }
export interface PartnerRow { id: string; name: string }

export interface JourneyStatus { journeyId: string; stage: string; converted: boolean; daysIdle: number; slaDays: number; stalled: boolean }

export function journeyStatus(industry: Industry, j: JourneyRow, now: Date): JourneyStatus {
  const stage = STAGES[industry][j.stageIndex] ?? STAGES[industry][0]!;
  const daysIdle = Math.max(0, Math.floor((now.getTime() - j.lastActivityAt.getTime()) / DAY));
  const stalled = !stage.converted && stage.slaDays > 0 && daysIdle > stage.slaDays && stageCountsAsLeakage(industry, j.stageIndex);
  return { journeyId: j.id, stage: stage.name, converted: stage.converted, daysIdle, slaDays: stage.slaDays, stalled };
}

export interface PartnerScore { partnerId: string; name: string; journeys: number; stalled: number; stalledShare: number }

export function partnerScorecard(industry: Industry, journeys: JourneyRow[], partners: PartnerRow[], now: Date): PartnerScore[] {
  return partners.map(p => {
    const js = journeys.filter(j => j.partnerId === p.id && j.stageIndex >= 1);
    const stalled = js.filter(j => journeyStatus(industry, j, now).stalled).length;
    return { partnerId: p.id, name: p.name, journeys: js.length, stalled, stalledShare: js.length ? stalled / js.length : 0 };
  }).sort((a, b) => b.stalledShare - a.stalledShare);
}

export type Severity = 'high' | 'medium' | 'info';
export interface Finding { rule: string; severity: Severity; entityKind: string; entityRef: string; partnerId?: string | null; detail: string; valueInr: number }

export interface DetectInput {
  industry: Industry;
  now: Date;
  journeys: JourneyRow[];
  transactions: TransactionRow[];
  campaigns: CampaignRow[];
  partners: PartnerRow[];
  sharedIdentifiers?: { identifier: string; names: number; records: number }[];
  /** Average value of one conversion, used to put a rupee figure on phantom conversions. */
  avgConversionValueInr?: number;
  phantomWindowDays?: number;
  partnerStalledThreshold?: number;
  partnerMinJourneys?: number;
}

export function detectViolations(input: DetectInput): Finding[] {
  const { industry, now, journeys, transactions, campaigns, partners } = input;
  const out: Finding[] = [];
  const window = (input.phantomWindowDays ?? 30) * DAY;
  const avg = input.avgConversionValueInr ?? 0;

  // phantom conversion: CRM says converted, no matching transaction within the window
  const txByJourney = new Map<string, TransactionRow[]>();
  transactions.forEach(t => { if (t.journeyId) (txByJourney.get(t.journeyId) ?? txByJourney.set(t.journeyId, []).get(t.journeyId)!).push(t); });
  const phantoms = journeys.filter(j => j.crmConverted && now.getTime() - j.stageEnteredAt.getTime() > window &&
    !(txByJourney.get(j.id) ?? []).some(t => Math.abs(t.occurredAt.getTime() - j.stageEnteredAt.getTime()) <= window));
  phantoms.forEach(j => out.push({ rule: 'phantom_conversion', severity: 'high', entityKind: 'journey', entityRef: j.externalRef, partnerId: j.partnerId, detail: 'Marked converted in the CRM, but no matching sale in partner systems', valueInr: avg }));

  // orphan transaction: a sale with no originating inquiry
  transactions.filter(t => !t.journeyId).forEach(t => out.push({ rule: 'orphan_transaction', severity: 'medium', entityKind: 'transaction', entityRef: t.externalRef, partnerId: t.partnerId, detail: 'Sale with no originating inquiry, so its campaign credit is lost', valueInr: t.valueInr }));

  // unattributed spend: a campaign with spend but no journey traced to it
  const usedCampaigns = new Set(journeys.map(j => j.campaignId).filter(Boolean));
  campaigns.filter(c => c.spendInr > 0 && !usedCampaigns.has(c.id)).forEach(c => out.push({ rule: 'unattributed_spend', severity: 'medium', entityKind: 'campaign', entityRef: c.externalCode, detail: `“${c.name}” has spend but no journey traced to it`, valueInr: c.spendInr }));

  // stalled at partner
  const threshold = input.partnerStalledThreshold ?? 0.38, minJ = input.partnerMinJourneys ?? 10;
  partnerScorecard(industry, journeys, partners, now)
    .filter(p => p.journeys >= minJ && p.stalledShare > threshold)
    .forEach(p => out.push({ rule: 'idle_opportunity', severity: p.stalledShare > 0.5 ? 'high' : 'medium', entityKind: 'partner', entityRef: p.name, partnerId: p.partnerId, detail: `${p.stalled} of ${p.journeys} journeys idle beyond their stage time limit`, valueInr: Math.round(p.stalled * avg * 0.25) }));

  // shared identifiers from identity resolution
  (input.sharedIdentifiers ?? []).forEach(s => out.push({ rule: 'shared_identifier', severity: s.names > 5 ? 'high' : 'medium', entityKind: 'identifier', entityRef: s.identifier, detail: `One identifier appears on ${s.records} records under ${s.names} different names`, valueInr: 0 }));

  return out;
}
