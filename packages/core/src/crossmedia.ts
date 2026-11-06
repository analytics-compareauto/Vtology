/**
 * All media on one grid. TV, print, radio and outdoor reports (from agencies, usually Excel) and the
 * brand's results (leads, sales, orders by city and week) are read into the same shape as digital:
 * week × region × medium, with spend, reach and results. Then, for each medium, how results moved in
 * the weeks it ran compared with the weeks it didn't, and where each medium ran against where results
 * came from.
 *
 * This is lift, not attribution: offline media have no clicks. Every comparison says how many weeks it
 * stands on, and says plainly when that's too few to judge.
 */

export type OfflineMedium = 'tv' | 'print' | 'radio' | 'ooh' | 'results';
export const OFFLINE_LABEL: Record<OfflineMedium, string> = { tv: 'TV', print: 'Print', radio: 'Radio', ooh: 'Outdoor', results: 'Results' };
export type OfflineField = 'day' | 'region' | 'vehicle' | 'spend' | 'reach' | 'units' | 'seconds' | 'leads' | 'sales' | 'value';
export type OfflineColumns = Partial<Record<OfflineField, string>>;
export interface OfflineRow { day: string; region: string; vehicle: string; spend: number; reach: number; units: number; seconds: number; leads: number; sales: number; value: number }

const clean = (h: string) => h.toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[₹$€£%#:_\-/.]/g, ' ').replace(/\s+/g, ' ').trim();
const PATTERNS: [OfflineField, RegExp][] = [
  ['day', /^(date|day|air date|telecast date|tx date|insertion date|publication date|pub date|release date|week|week start|week starting|week of|week commencing|period|month)$/],
  ['region', /^(market|region|state|city|zone|edition|centre|center|geography|geo|territory|district|town)$/],
  ['vehicle', /^(channel|channel name|tv channel|programme|program|show|publication|newspaper|paper|magazine|title|station|radio station|fm station|media vehicle|vehicle|media|site|location|outlet)$/],
  ['spend', /^(cost|spend|spends|amount|net cost|gross cost|net amount|gross amount|investment|media cost|net spend|gross spend|billing|value inr)$/],
  ['reach', /^(grps?|trps?|tvrs?|ratings?|grp total|readership|circulation|reach|impressions|listenership|footfall|audience|views)$/],
  ['units', /^(spots|no of spots|number of spots|insertions|no of insertions|number of insertions|ads|airings|sites|units|count)$/],
  ['seconds', /^(duration|dur|secs?|seconds|spot length|length|size|sq cm|sqcm|cc|col cm)$/],
  ['leads', /^(leads|enquiries|enquiry|inquiries|test drives|signups|sign ups|registrations|walk ins|walkins|calls)$/],
  ['sales', /^(sales|bookings|units sold|orders|retail|retails|conversions|deliveries|policies|accounts opened|purchases)$/],
  ['value', /^(revenue|sales value|gmv|order value|turnover|premium)$/],
];

/** Which column holds what; results files read "value" as revenue, media files read it as cost. */
export function detectOfflineColumns(headers: string[], medium: OfflineMedium): OfflineColumns {
  const out: OfflineColumns = {};
  for (const h of headers) {
    const c = clean(h);
    for (const [f, re] of PATTERNS) if (!out[f] && re.test(c)) { out[f] = h; break; }
    if (c === 'value' && !out[medium === 'results' ? 'value' : 'spend']) out[medium === 'results' ? 'value' : 'spend'] = h;
  }
  return out;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const iso = (y: number, m: number, d: number) => {
  if (y < 100) y += 2000;
  const t = Date.UTC(y, m - 1, d), x = new Date(t);
  return x.getUTCFullYear() === y && x.getUTCMonth() === m - 1 && x.getUTCDate() === d ? x.toISOString().slice(0, 10) : null;
};
/** Dates as Indian agencies write them: day first (06/11/2026, 6-Nov-26, 6 November 2026), ISO, Excel serials, or a month ("Nov 2026", taken as its 1st). */
export function parseDay(v: string): string | null {
  const s = v.trim().toLowerCase();
  if (!s) return null;
  if (/^\d{5}(\.\d+)?$/.test(s)) { const n = Math.floor(Number(s)); if (n > 30000 && n < 80000) return new Date(Date.UTC(1899, 11, 30) + n * 86_400_000).toISOString().slice(0, 10); }
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return iso(+m[1]!, +m[2]!, +m[3]!);
  m = s.match(/^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2,4})$/);
  if (m) return iso(+m[3]!, +m[2]!, +m[1]!);
  m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?[-/. ]+([a-z]{3})[a-z]*[-/., ]+(\d{2,4})$/);
  if (m && MONTHS.includes(m[2]!)) return iso(+m[3]!, MONTHS.indexOf(m[2]!) + 1, +m[1]!);
  m = s.match(/^([a-z]{3})[a-z]*[-/. ]+(\d{1,2})(?:st|nd|rd|th)?,?[-/. ]+(\d{4})$/);
  if (m && MONTHS.includes(m[1]!)) return iso(+m[3]!, MONTHS.indexOf(m[1]!) + 1, +m[2]!);
  m = s.match(/^([a-z]{3})[a-z]*[-/'. ]+(\d{2,4})$/);
  if (m && MONTHS.includes(m[1]!)) return iso(+m[2]!, MONTHS.indexOf(m[1]!) + 1, 1);
  return null;
}

/** Numbers with ₹, commas (Indian or western), "lakh"/"cr"/"k", and dashes for zero. */
export function parseAmount(v: string | undefined): number {
  if (!v) return 0;
  const s = v.toLowerCase().replace(/[₹$,\s]|rs\.?|inr/g, '');
  if (!s || s === '-' || s === '–' || s === 'na' || s === 'nil') return 0;
  const m = s.match(/^(-?\d*\.?\d+)(lakhs?|lacs?|l|crores?|cr|k|m)?$/);
  if (!m) return NaN;
  const mult = !m[2] ? 1 : /^(lakh|lac|l)/.test(m[2]) ? 1e5 : /^(crore|cr)/.test(m[2]) ? 1e7 : m[2] === 'k' ? 1e3 : 1e6;
  return Number(m[1]) * mult;
}

/** Rows of a file, with its columns, as clean rows; rows with no date, or a number that can't be read, are skipped. */
export function toOfflineRows(rows: Record<string, string>[], cols: OfflineColumns): { rows: OfflineRow[]; skipped: number } {
  const out: OfflineRow[] = [];
  let skipped = 0;
  const NUM: OfflineField[] = ['spend', 'reach', 'units', 'seconds', 'leads', 'sales', 'value'];
  for (const r of rows) {
    const day = cols.day ? parseDay(String(r[cols.day] ?? '')) : null;
    if (!day) { skipped++; continue; }
    const nums = NUM.map(f => (cols[f] ? parseAmount(String(r[cols[f]!] ?? '')) : 0));
    if (nums.some(n => !Number.isFinite(n) || n < 0)) { skipped++; continue; }
    const [spend, reach, units, seconds, leads, sales, value] = nums as [number, number, number, number, number, number, number];
    out.push({ day, region: tidyRegion(cols.region ? String(r[cols.region] ?? '') : ''), vehicle: cols.vehicle ? String(r[cols.vehicle] ?? '').trim().slice(0, 120) : '', spend, reach, units, seconds, leads, sales, value });
  }
  return { rows: out, skipped };
}

const REGION_ALIAS: Record<string, string> = { bombay: 'Mumbai', bangalore: 'Bengaluru', bengaluru: 'Bengaluru', 'new delhi': 'Delhi', delhi: 'Delhi', 'delhi ncr': 'Delhi NCR', ncr: 'Delhi NCR', gurgaon: 'Gurugram', calcutta: 'Kolkata', madras: 'Chennai', poona: 'Pune', 'all india': 'All India', national: 'All India', 'pan india': 'All India', india: 'All India' };
/** One spelling per place, so "BANGALORE" and "Bengaluru" line up; empty means the whole country. */
export function tidyRegion(v: string): string {
  const s = v.trim().replace(/\s+/g, ' ');
  if (!s) return 'All India';
  const a = REGION_ALIAS[s.toLowerCase()];
  return a ?? s.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase()).slice(0, 80);
}

const STATE_OF: Record<string, string> = {
  Mumbai: 'Maharashtra', Pune: 'Maharashtra', Nagpur: 'Maharashtra', Nashik: 'Maharashtra', Thane: 'Maharashtra', 'Navi Mumbai': 'Maharashtra', Aurangabad: 'Maharashtra',
  Delhi: 'Delhi', 'Delhi NCR': 'Delhi', Gurugram: 'Haryana', Faridabad: 'Haryana', Noida: 'Uttar Pradesh', Ghaziabad: 'Uttar Pradesh', Lucknow: 'Uttar Pradesh', Kanpur: 'Uttar Pradesh', Agra: 'Uttar Pradesh', Varanasi: 'Uttar Pradesh',
  Bengaluru: 'Karnataka', Mysuru: 'Karnataka', Mangaluru: 'Karnataka', Hyderabad: 'Telangana', Chennai: 'Tamil Nadu', Coimbatore: 'Tamil Nadu', Madurai: 'Tamil Nadu',
  Kolkata: 'West Bengal', Ahmedabad: 'Gujarat', Surat: 'Gujarat', Vadodara: 'Gujarat', Rajkot: 'Gujarat', Jaipur: 'Rajasthan', Jodhpur: 'Rajasthan', Udaipur: 'Rajasthan',
  Chandigarh: 'Chandigarh', Ludhiana: 'Punjab', Amritsar: 'Punjab', Kochi: 'Kerala', Thiruvananthapuram: 'Kerala', Kozhikode: 'Kerala', Bhopal: 'Madhya Pradesh', Indore: 'Madhya Pradesh',
  Patna: 'Bihar', Bhubaneswar: 'Odisha', Guwahati: 'Assam', Visakhapatnam: 'Andhra Pradesh', Vijayawada: 'Andhra Pradesh', Raipur: 'Chhattisgarh', Ranchi: 'Jharkhand', Dehradun: 'Uttarakhand', Goa: 'Goa', Panaji: 'Goa',
};
const STATES = new Set(Object.values(STATE_OF));
/** The state a city is in (the place itself when it's a state or not known). */
export const stateOf = (region: string) => STATE_OF[region] ?? region;

/** The Monday a date's week starts on. */
export function mondayOf(day: string): string {
  const t = Date.parse(`${day}T00:00:00Z`), dow = (new Date(t).getUTCDay() + 6) % 7;
  return new Date(t - dow * 86_400_000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- analysis

export interface MediumWeek { week: string; medium: string; region: string; spend: number; reach: number }
export interface OutcomeWeek { week: string; region: string; leads: number; sales: number; value: number }
export interface MediumLift {
  medium: string; spend: number; reach: number; weeksOn: number; weeksOff: number;
  /** results a week, in weeks the medium ran and weeks it didn't */
  on: number | null; off: number | null; lift: number | null; extra: number | null; costPerExtra: number | null;
  /** share of its weeks that another medium also ran: the higher, the harder to separate */
  overlap: number; verdict: 'lift' | 'none' | 'too_few_weeks';
}
export interface CrossFinding { tone: 'good' | 'bad' | 'neutral'; title: string; detail: string; action?: string; figure?: string; figureLabel?: string }

const MIN_WEEKS = 3;

/**
 * For each medium, results a week when it ran against when it didn't (the measure is leads, or sales
 * when there are no leads). Weeks count only inside the span the results cover.
 */
export function mediaLift(media: MediumWeek[], outcomes: OutcomeWeek[]): { measure: 'leads' | 'sales'; weeks: string[]; lifts: MediumLift[] } {
  const measure: 'leads' | 'sales' = outcomes.some(o => o.leads > 0) ? 'leads' : 'sales';
  const resultByWeek = new Map<string, number>();
  for (const o of outcomes) resultByWeek.set(o.week, (resultByWeek.get(o.week) ?? 0) + o[measure]);
  const weeks = [...resultByWeek.keys()].sort();
  const spendBy = new Map<string, Map<string, number>>(); // medium → week → spend
  const reachBy = new Map<string, number>();
  for (const m of media) {
    const w = spendBy.get(m.medium) ?? new Map<string, number>();
    w.set(m.week, (w.get(m.week) ?? 0) + m.spend);
    spendBy.set(m.medium, w);
    reachBy.set(m.medium, (reachBy.get(m.medium) ?? 0) + m.reach);
  }
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const lifts: MediumLift[] = [...spendBy.entries()].map(([medium, byWeek]) => {
    const on = weeks.filter(w => (byWeek.get(w) ?? 0) > 0), off = weeks.filter(w => !((byWeek.get(w) ?? 0) > 0));
    const onAvg = avg(on.map(w => resultByWeek.get(w)!)), offAvg = avg(off.map(w => resultByWeek.get(w)!));
    const spend = [...byWeek.values()].reduce((a, b) => a + b, 0);
    const others = [...spendBy.entries()].filter(([k, v]) => k !== medium && weeks.filter(w => (v.get(w) ?? 0) > 0).length < weeks.length * 0.9).map(([, v]) => v);
    const overlap = on.length ? on.filter(w => others.some(o => (o.get(w) ?? 0) > 0)).length / on.length : 0;
    const enough = on.length >= MIN_WEEKS && off.length >= MIN_WEEKS && offAvg !== null && onAvg !== null;
    const lift = enough && offAvg! > 0 ? (onAvg! - offAvg!) / offAvg! : null;
    const extra = enough ? (onAvg! - offAvg!) * on.length : null;
    const spendInWeeks = on.reduce((a, w) => a + (byWeek.get(w) ?? 0), 0);
    return { medium, spend, reach: reachBy.get(medium) ?? 0, weeksOn: on.length, weeksOff: off.length, on: onAvg, off: offAvg, lift, extra,
      costPerExtra: extra !== null && extra > 0 ? spendInWeeks / extra : null, overlap,
      verdict: (!enough ? 'too_few_weeks' : lift !== null && lift >= 0.05 ? 'lift' : 'none') as MediumLift['verdict'] };
  }).sort((a, b) => b.spend - a.spend);
  return { measure, weeks, lifts };
}

/** Where each medium ran against where results came from: regions with results and no media, and spend with little to show. */
export function regionFit(media: MediumWeek[], outcomes: OutcomeWeek[], measure: 'leads' | 'sales') {
  // media bought by state and results by city (or the other way) are compared by state
  const anyState = [...media, ...outcomes].some(x => STATES.has(x.region) && !STATE_OF[x.region]);
  const place = (r: string) => (anyState ? stateOf(r) : r);
  const regions = new Map<string, { spend: Map<string, number>; results: number }>();
  const get = (r: string) => { let x = regions.get(r); if (!x) regions.set(r, x = { spend: new Map(), results: 0 }); return x; };
  for (const m of media) if (m.region !== 'All India') { const x = get(place(m.region)); x.spend.set(m.medium, (x.spend.get(m.medium) ?? 0) + m.spend); }
  for (const o of outcomes) if (o.region !== 'All India') get(place(o.region)).results += o[measure];
  const totalResults = [...regions.values()].reduce((a, r) => a + r.results, 0) || 0;
  const totalSpend = [...regions.values()].reduce((a, r) => a + [...r.spend.values()].reduce((x, y) => x + y, 0), 0) || 0;
  return [...regions.entries()].map(([region, r]) => {
    const spend = [...r.spend.values()].reduce((a, b) => a + b, 0);
    return { region, results: r.results, spend, resultShare: totalResults ? r.results / totalResults : 0, spendShare: totalSpend ? spend / totalSpend : 0, byMedium: Object.fromEntries(r.spend) };
  }).sort((a, b) => b.results - a.results || b.spend - a.spend);
}

/** Plain findings from the lift and region views. `label` names a medium; `money` formats an amount. */
export function crossFindings(lifts: MediumLift[], regions: ReturnType<typeof regionFit>, measure: 'leads' | 'sales', label: (m: string) => string, money: (n: number) => string, short: (n: number) => string = money): CrossFinding[] {
  const out: CrossFinding[] = [];
  const unit = measure;
  const scored = lifts.filter(l => l.verdict === 'lift' && l.costPerExtra !== null).sort((a, b) => a.costPerExtra! - b.costPerExtra!);
  for (const l of lifts) {
    const name = label(l.medium);
    if (l.verdict === 'lift') out.push({ tone: 'good', figure: `+${Math.round(l.lift! * 100)}%`, figureLabel: `${unit} a week`,
      title: `${name} weeks brought more ${unit}`,
      detail: `${Math.round(l.on!)} ${unit} a week when ${name} ran (${l.weeksOn} weeks) against ${Math.round(l.off!)} when it didn't (${l.weeksOff} weeks): about ${Math.round(l.extra!)} more in all${l.costPerExtra ? `, ${money(l.costPerExtra)} of ${name} spend for each extra one` : ''}.${l.overlap >= 0.7 ? ` Other media ran in ${Math.round(l.overlap * 100)}% of these weeks too, so part of this may be theirs.` : ''}`,
      action: scored[0]?.medium === l.medium && scored.length > 1 ? `The cheapest extra ${unit.slice(0, -1)} of all media: give ${name} a larger share when planning the next burst.` : undefined });
    else if (l.verdict === 'none') out.push({ tone: 'bad', figure: short(l.spend), figureLabel: 'spent',
      title: `${name}: no clear rise in ${unit}`,
      detail: `${Math.round(l.on ?? 0)} ${unit} a week when ${name} ran (${l.weeksOn} weeks) against ${Math.round(l.off ?? 0)} without it (${l.weeksOff} weeks).`,
      action: `Check where and when it ran against where ${unit} come from (below), and test a cut or a different region before the next plan.` });
    else out.push({ tone: 'neutral', figure: `${l.weeksOn}/${l.weeksOff}`, figureLabel: 'weeks on/off',
      title: `${name}: too few weeks to judge`,
      detail: `A fair comparison needs at least ${MIN_WEEKS} weeks with ${name} and ${MIN_WEEKS} without, inside the weeks your results cover.`,
      action: l.weeksOff < MIN_WEEKS ? `It ran almost every week: compare regions instead, or pause it in one region for a few weeks as a test.` : `Upload more weeks of ${l.weeksOn < MIN_WEEKS ? `${name} reports` : 'results'}.` });
  }
  const dark = regions.filter(r => r.resultShare >= 0.05 && r.spend === 0);
  if (dark.length) out.push({ tone: 'neutral', figure: `${Math.round(dark.reduce((a, r) => a + r.resultShare, 0) * 100)}%`, figureLabel: `of ${unit}`,
    title: `${dark.length === 1 ? 'A region brings' : `${dark.length} regions bring`} ${unit} with no local media`,
    detail: `${dark.slice(0, 4).map(r => r.region).join(', ')} ${dark.length === 1 ? 'gets' : 'get'} no regional TV, print or radio in these reports, yet ${dark.length === 1 ? 'brings' : 'bring'} ${Math.round(dark.reduce((a, r) => a + r.resultShare, 0) * 100)}% of ${unit}.`,
    action: 'Demand is already there: a small local burst (radio or a city edition) is the cheapest test.' });
  const heavy = regions.filter(r => r.spendShare >= 0.1 && r.spendShare >= 2 * r.resultShare);
  if (heavy.length) out.push({ tone: 'bad', figure: `${Math.round(heavy.reduce((a, r) => a + r.spendShare, 0) * 100)}%`, figureLabel: 'of regional spend',
    title: `Spend is heavy where ${unit} are light`,
    detail: heavy.slice(0, 4).map(r => `${r.region}: ${Math.round(r.spendShare * 100)}% of regional spend, ${Math.round(r.resultShare * 100)}% of ${unit}`).join('; ') + '.',
    action: 'Move part of this to the regions in the table where results are ahead of spend.' });
  return out;
}

/** What a file most likely holds, from its columns and name: results when it carries leads or sales, else the medium its vehicle column names. */
export function guessMedium(headers: string[], fileName = ''): OfflineMedium | 'digital' | null {
  const h = headers.map(clean), n = fileName.toLowerCase();
  const has = (re: RegExp) => h.some(x => re.test(x));
  // an ad platform report (DV360, Google Ads, Meta) belongs on the Media tab
  if (has(/^impressions$/) && has(/^(insertion order|line item|line item type|ad group|ad set|campaign|advertiser currency|creative)$/)) return 'digital';
  if (has(/^(leads|enquiries|enquiry|inquiries|test drives|bookings|sales|orders|retails?|units sold|deliveries|signups|registrations)$/) && !has(/^(grps?|trps?|spots|insertions|cost|spend|amount|net cost)$/)) return 'results';
  if (has(/^(station|radio station|fm station)$/) || /radio|\bfm\b/.test(n)) return 'radio';
  if (has(/^(publication|newspaper|edition|magazine|insertions|readership|circulation|sq cm|sqcm|col cm)$/) || /print|press|newspaper/.test(n)) return 'print';
  if (has(/^(grps?|trps?|tvrs?|channel|channel name|tv channel|programme|telecast date|tx date)$/) || /\btv\b|television|barc/.test(n)) return 'tv';
  if (has(/^(site|location|hoarding|billboard|footfall)$/) || /ooh|outdoor|hoarding/.test(n)) return 'ooh';
  if (/result|lead|sales|enquir|booking/.test(n)) return 'results';
  return null;
}
