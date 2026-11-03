/**
 * The Vtology lead feed (version 1): one simple shape any brand's lead system can return (a dealer
 * dashboard, a DMS, a CRM export service), and how a lead in it becomes a journey in Vtology.
 *
 * The brand's own status words ("Contacted", "Car Booked", "Disbursed", ...) are mapped onto the
 * workspace's stages by a per-source table the brand can edit; sensible defaults per industry.
 */
import { STAGES, stageIndexByName, type Industry } from './modules';

export interface FeedLead {
  id: string;
  ref?: string;
  createdAt: string | null;
  updatedAt: string | null;
  customer?: { name?: string; mobile?: string; email?: string; city?: string; state?: string; pincode?: string };
  interest?: { brand?: string; model?: string; variant?: string; fuelType?: string };
  origin?: { source?: string; platform?: string; campaignId?: string; adId?: string; metaLeadId?: string; metaCampaignName?: string; utmSource?: string; utmMedium?: string; utmCampaign?: string };
  dealer?: { id?: string; name?: string; city?: string; parentDealerId?: string; connectedAt?: string | null };
  progress?: { status?: string; testDriveStatus?: string; callOutcome?: string; followUpSettled?: boolean | null; retailAmount?: string | number };
  history?: { at: string | null; status?: string; by?: string; note?: string }[];
}
export interface FeedDealer { id: string; legacyId?: string; code?: string; name: string; city?: string; state?: string; parentDealerId?: string; status?: string }

/** Starting mappings; the brand adjusts them on the mapping screen. Matching ignores case. */
export const DEFAULT_STATUS_MAP: Record<Industry, Record<string, string>> = {
  Automotive: {
    'New': 'Inquiry', 'Assigned': 'Lead allocated', 'Contacted': 'Dealer contacted', 'Follow-up': 'Dealer contacted', 'Follow up': 'Dealer contacted',
    'Interested': 'Dealer contacted', 'Test Drive Booked': 'Dealer contacted', 'Test Drive Given': 'Test drive', 'Test Drive Done': 'Test drive',
    'Car Booked': 'Booking', 'Booked': 'Booking', 'Booking': 'Booking', 'Car Delivered': 'Retail', 'Delivered': 'Retail', 'Retail': 'Retail', 'Sold': 'Retail',
  },
  BFSI: { 'New': STAGES.BFSI[0]!.name },
  FMCG: { 'New': STAGES.FMCG[0]!.name },
};

export interface JourneyUpdate {
  journeyRef: string;
  personRef: string;
  stageIndex: number;
  stageEnteredAt: string;
  lastActivityAt: string;
  /** the brand's system counts this stage as won (booking, retail) */
  converted: boolean;
  /** reached the final stage (a sale) */
  sold: boolean;
  valueInr: number | null;
  partnerCode: string | null;
  campaign: { code: string; name: string; channel: string } | null;
  /** status words this lead used that the map doesn't cover yet */
  unmapped: string[];
}

const lc = (s: string) => s.trim().toLowerCase();
function stageOf(industry: Industry, map: Record<string, string>, status: string | undefined): number | null {
  if (!status) return null;
  const hit = Object.entries(map).find(([k]) => lc(k) === lc(status));
  return hit ? stageIndexByName(industry, hit[1]) : null;
}
const later = (a: string | null | undefined, b: string | null | undefined) => (!a ? b ?? null : !b ? a : a > b ? a : b);

/** Where a lead stands, as a journey: the furthest stage it reached, and when it got there. */
export function feedLeadToJourney(industry: Industry, lead: FeedLead, statusMap: Record<string, string>, sourceKey: string): JourneyUpdate {
  const stages = STAGES[industry];
  const last = stages.length - 1;
  const created = lead.createdAt ?? lead.updatedAt ?? new Date(0).toISOString();
  const history = [...(lead.history ?? [])].filter(h => h.at).sort((a, b) => a.at!.localeCompare(b.at!));
  const unmapped = new Set<string>();

  // every moment the lead was seen at a stage: its creation, being given to a dealer, each status
  // in its history, and the current status, test drive and sale
  const reached: { stage: number; at: string }[] = [{ stage: 0, at: created }];
  const allocated = stageIndexByName(industry, 'Lead allocated');
  if (lead.dealer?.id && allocated !== null) reached.push({ stage: allocated, at: lead.dealer.connectedAt ?? created });
  for (const h of history) {
    const s = stageOf(industry, statusMap, h.status);
    if (s !== null) reached.push({ stage: s, at: h.at! });
    else if (h.status) unmapped.add(h.status);
    if (/test ?drive (given|done|completed)|completed drive/i.test(h.note ?? '')) {
      const td = stageIndexByName(industry, 'Test drive');
      if (td !== null) reached.push({ stage: td, at: h.at! });
    }
  }
  const nowAt = lead.updatedAt ?? created;
  const current = stageOf(industry, statusMap, lead.progress?.status);
  if (current !== null) reached.push({ stage: current, at: history.find(h => stageOf(industry, statusMap, h.status) === current)?.at ?? nowAt });
  else if (lead.progress?.status) unmapped.add(lead.progress.status);
  if (/^(given|done|completed)$/i.test(lead.progress?.testDriveStatus ?? '')) {
    const td = stageIndexByName(industry, 'Test drive');
    if (td !== null) reached.push({ stage: td, at: history.find(h => /test ?drive/i.test(h.note ?? ''))?.at ?? nowAt });
  }
  const value = Number(String(lead.progress?.retailAmount ?? '').replace(/[^\d.]/g, '')) || null;
  if (value) reached.push({ stage: last, at: nowAt });

  // furthest stage; the first time it was reached is when it was entered
  const top = Math.max(...reached.map(r => r.stage));
  const enteredAt = reached.filter(r => r.stage === top).map(r => r.at).sort()[0]!;
  const lastActivityAt = [nowAt, ...history.map(h => h.at!)].reduce((a, b) => later(a, b)!, created);

  const o = lead.origin ?? {};
  const cid = (o.campaignId ?? '').trim();
  const campaign = /^\d{6,}$/.test(cid) ? { code: `meta:${cid}`, name: o.metaCampaignName || `Meta campaign ${cid}`, channel: 'Meta ads' }
    : cid ? { code: `${sourceKey}:campaign:${cid}`, name: cid, channel: 'Dealer campaign' }
    : o.utmCampaign ? { code: `utm:${o.utmCampaign}`, name: o.utmCampaign, channel: o.utmSource ? `Website (${o.utmSource})` : 'Website' }
    : null;
  // a lead that came through a Meta lead form is the same journey as the one Meta's own sync created
  const journeyRef = o.metaLeadId ? `metalead:${o.metaLeadId}` : `${sourceKey}:${lead.id}`;
  return {
    journeyRef, personRef: `${sourceKey}:${lead.id}`, stageIndex: top, stageEnteredAt: enteredAt, lastActivityAt,
    converted: stages[top]!.converted, sold: top === last, valueInr: value, partnerCode: lead.dealer?.id ? `${sourceKey}:${lead.dealer.id}` : null, campaign, unmapped: [...unmapped],
  };
}
