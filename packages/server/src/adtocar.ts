/**
 * From ad to car: for every campaign, how its leads moved through the dealer's hands (reached,
 * test drive booked and given, booked, delivered) and what each step cost; for every branch, how
 * fast and how well it follows up; and the leads that need a call today. Built from the dealer
 * feed (journeys and the team's work on them) and the campaign spend from Google Ads and Meta.
 */
import { requireRole, type Ctx } from './context';
import { moneyFormat } from './media';

const VIEWERS: Ctx['role'][] = ['marketing_head', 'data_steward', 'finance', 'sales_ops'];
/** the value half of them are within (the lower middle when the count is even) */
const median = (xs: number[]) => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? v[Math.ceil(v.length / 2) - 1]! : null; };
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

interface Row { campaign: string | null; channel: string | null; branch: string | null; model: string | null; stage: number; lead_at: string; first_contact_at: string | null; calls: number; connected: boolean; td_booked: boolean; td_given: boolean; last_activity_at: string }

function funnel(rows: Row[]) {
  const n = rows.length;
  const mins = rows.filter(r => r.first_contact_at).map(r => (Date.parse(r.first_contact_at!) - Date.parse(r.lead_at)) / 60_000).filter(m => m >= 0);
  return {
    leads: n,
    reached: rows.filter(r => r.connected).length,
    tdBooked: rows.filter(r => r.td_booked || r.stage >= 3).length,
    tdGiven: rows.filter(r => r.td_given || r.stage >= 3).length,
    booked: rows.filter(r => r.stage >= 4).length,
    delivered: rows.filter(r => r.stage >= 5).length,
    contacted: rows.filter(r => r.first_contact_at || r.stage >= 2).length,
    minutesToContact: median(mins),
    within30: mins.length ? mins.filter(m => m <= 30).length / mins.length : null,
  };
}

export async function adToCar(ctx: Ctx, range: { from: string; to: string }) {
  requireRole(ctx, VIEWERS, 'Lead follow-up');
  const sql = ctx.db.admin;
  const rows = await sql.query<Row>(
    `select c.name as campaign, c.channel, p.name as branch, j.model, j.stage_index as stage, coalesce(j.lead_at, j.created_at)::text as lead_at, j.first_contact_at::text, j.calls, j.connected, j.td_booked, j.td_given, j.last_activity_at::text
       from vt.journeys j left join vt.campaigns c on c.id = j.campaign_id left join vt.partners p on p.id = j.partner_id
      where j.tenant_id = $1 and coalesce(j.lead_at, j.created_at) between $2::date and $3::date + interval '1 day'`, [ctx.tenantId, range.from, range.to]);
  // only worth showing when the dealer's team's work is coming in
  if (!rows.length || !rows.some(r => r.first_contact_at || r.calls || r.connected || r.td_booked)) return null;

  // spend by campaign name, from Google Ads and Meta reports in the same dates
  const spend = await sql.query<{ campaign: string; cost: string; currency: string }>(
    `select d.campaign, sum(d.cost) as cost, r.currency from vt.perf_daily d join vt.perf_reports r on r.id = d.report_id
      where d.tenant_id = $1 and r.status = 'ready' and d.day between $2::date and $3::date group by 1, 3`, [ctx.tenantId, range.from, range.to]);
  const currency = spend[0]?.currency ?? 'INR';
  const fm = moneyFormat(currency);
  const costOf = new Map(spend.filter(s => s.currency === currency).map(s => [norm(s.campaign), Number(s.cost)]));

  const groups = new Map<string, Row[]>();
  for (const r of rows) { const k = r.campaign ?? ''; groups.set(k, [...(groups.get(k) ?? []), r]); }
  const campaigns = [...groups.entries()].map(([name, rs]) => {
    const f = funnel(rs);
    const cost = name ? costOf.get(norm(name)) ?? null : null;
    const per = (x: number) => (cost && x ? cost / x : null);
    return { name: name || 'No campaign recorded', channel: rs[0]!.channel ?? (name ? null : 'Website and direct enquiries'), cost, ...f,
      perLead: per(f.leads), perReached: per(f.reached), perTestDrive: per(f.tdBooked), perBooking: per(f.booked) };
  }).sort((a, b) => b.leads - a.leads);

  const branches = [...new Set(rows.map(r => r.branch ?? 'Not assigned'))].map(b => ({ branch: b, ...funnel(rows.filter(r => (r.branch ?? 'Not assigned') === b)) })).sort((a, b) => b.leads - a.leads);
  const models = [...new Set(rows.map(r => r.model ?? ''))].map(m => ({ model: m || 'Model not given', ...funnel(rows.filter(r => (r.model ?? '') === m)) })).sort((a, b) => b.leads - a.leads);
  const total = funnel(rows);
  const now = ctx.now.getTime();
  // leads that need a call: no conversation yet, older than a day, not closed
  const waiting = rows.filter(r => !r.connected && r.stage < 4 && now - Date.parse(r.lead_at) > 86_400_000);
  const stuckTd = rows.filter(r => r.td_booked && !r.td_given && r.stage < 4 && now - Date.parse(r.last_activity_at) > 3 * 86_400_000);

  // findings, in plain words
  const findings: { tone: 'good' | 'bad' | 'neutral'; title: string; detail: string; action?: string; figure?: string; figureLabel?: string }[] = [];
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  if (waiting.length) findings.push({ tone: 'bad', figure: String(waiting.length), figureLabel: 'leads not reached', title: `${waiting.length} ${waiting.length === 1 ? 'lead has' : 'leads have'} had no conversation yet`,
    detail: `${pct(waiting.length / total.leads)} of leads older than a day have no connected call: unanswered or never called. A lead cools fast; after two days far fewer book a test drive.`, action: 'Call them today, at a different time of day than the last try, and add a WhatsApp message.' });
  if (total.minutesToContact !== null) findings.push({ tone: total.minutesToContact <= 30 ? 'good' : 'bad', figure: total.minutesToContact < 120 ? `${Math.round(total.minutesToContact)} min` : `${(total.minutesToContact / 60).toFixed(1)} h`, figureLabel: 'to first contact',
    title: total.minutesToContact <= 30 ? 'Leads are picked up fast' : 'Leads wait too long for the first call',
    detail: `Half of leads are contacted within ${total.minutesToContact < 120 ? `${Math.round(total.minutesToContact)} minutes` : `${(total.minutesToContact / 60).toFixed(1)} hours`}${total.within30 !== null ? `; ${pct(total.within30)} within 30 minutes` : ''}.`,
    action: total.minutesToContact <= 30 ? undefined : 'Aim for a call within 30 minutes of a lead arriving: set an alert for the branch on every new lead.' });
  if (stuckTd.length) findings.push({ tone: 'bad', figure: String(stuckTd.length), figureLabel: 'test drives pending', title: 'Test drives booked but not given',
    detail: `${stuckTd.length} booked test ${stuckTd.length === 1 ? 'drive has' : 'drives have'} had no update for 3 days or more.`, action: 'Confirm the slot with each customer, or offer a drive at home.' });
  const noModel = rows.filter(r => !r.model).length;
  if (noModel / total.leads >= 0.2) findings.push({ tone: 'neutral', figure: pct(noModel / total.leads), figureLabel: 'leads without a model', title: 'Many leads don’t say which car',
    detail: `${noModel} of ${total.leads} leads came without a model, so the first call starts from zero and stock can’t be matched.`, action: 'Add a model choice to the enquiry form on those pages.' });
  const priced = campaigns.filter(c => c.perTestDrive && c.tdBooked >= 2).sort((a, b) => a.perTestDrive! - b.perTestDrive!);
  if (priced.length >= 2 && priced[priced.length - 1]!.perTestDrive! / priced[0]!.perTestDrive! >= 1.3) findings.push({ tone: 'good', figure: `${(priced[priced.length - 1]!.perTestDrive! / priced[0]!.perTestDrive!).toFixed(1)}×`, figureLabel: 'cheaper per test drive',
    title: `${priced[0]!.name} brings test drives for far less`, detail: `${fm(priced[0]!.perTestDrive!)} per test drive booked against ${fm(priced[priced.length - 1]!.perTestDrive!)} on ${priced[priced.length - 1]!.name}.`, action: `Move budget toward ${priced[0]!.name}; judge campaigns on test drives, not leads.` });

  return { currency, total, campaigns, branches, models: models.slice(0, 10), waiting: waiting.length, stuckTestDrives: stuckTd.length, findings, hasSpend: costOf.size > 0 };
}
