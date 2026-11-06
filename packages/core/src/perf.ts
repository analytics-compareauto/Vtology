/**
 * Performance campaigns (Google Ads, Meta): what each rupee bought, where it was wasted, the real cost
 * of a lead once brand searches are set aside, how mainline media changed search costs, and a plan
 * for next month that keeps the budget the same and moves it to what converts.
 *
 * Read from the platforms' own exports (campaign, ad group or ad set by day, and search terms).
 */
import { parseAmount, parseDay } from './crossmedia';

export type PerfField = 'day' | 'campaign' | 'campaignType' | 'adGroup' | 'term' | 'cost' | 'impressions' | 'clicks' | 'conversions' | 'value' | 'lostBudget' | 'currency';
export type PerfColumns = Partial<Record<PerfField, string>>;
export type PerfPlatform = 'google' | 'meta' | 'other';
export interface PerfRow { day: string | null; platform: PerfPlatform; campaignType: string; campaign: string; adGroup: string; term: string; cost: number; impressions: number; clicks: number; conversions: number; value: number; lostBudget: number | null }

const clean = (h: string) => h.toLowerCase().replace(/\s+/g, ' ').trim();
const PATTERNS: [PerfField, RegExp][] = [
  ['day', /^(day|date|reporting starts|week|month)$/],
  ['campaignType', /^(campaign type|advertising channel|channel type|objective)$/],
  ['campaign', /^(campaign|campaign name)$/],
  ['adGroup', /^(ad group|ad group name|ad set|ad set name|asset group)$/],
  ['term', /^(search term|search query|query|keyword|search keyword)$/],
  ['cost', /^(cost|spend|amount spent|amount spent \(.*\)|cost \(.*\))$/],
  ['impressions', /^(impr\.?|impressions)$/],
  ['clicks', /^(clicks|link clicks|clicks \(all\))$/],
  ['conversions', /^(conversions|all conv\.?|results|leads|purchases|conv\.)$/],
  ['value', /^(conv\.? value|conversion value|all conv\.? value|purchases conversion value|purchase conversion value|revenue)$/],
  ['lostBudget', /^(search lost is \(budget\)|lost is \(budget\)|search budget lost is)$/],
  ['currency', /^(currency|currency code)$/],
];

export function detectPerfColumns(headers: string[]): PerfColumns {
  const out: PerfColumns = {};
  for (const h of headers) { const c = clean(h); for (const [f, re] of PATTERNS) if (!out[f] && re.test(c)) { out[f] = h; break; } }
  return out;
}
export function perfPlatform(headers: string[]): PerfPlatform {
  const h = headers.map(clean);
  if (h.some(x => /^(amount spent|reporting starts|ad set name|link clicks|result type)/.test(x))) return 'meta';
  if (h.some(x => /^(impr\.|conv\. value|campaign type|search lost is|all conv\.|search term)/.test(x))) return 'google';
  return 'other';
}
/** Google Ads exports start with a title and a date line above the header; this finds the header line. */
export function headerLineIndex(lines: string[]): number {
  const i = lines.slice(0, 15).findIndex(l => /(^|,|")\s*(cost|amount spent[^,]*|spend)\s*("|,|$)/i.test(l) && /(campaign|search term|ad group|ad set)/i.test(l));
  return Math.max(0, i);
}

/** Campaign type from the export, or from the campaign's name when the export doesn't carry it. */
export function campaignKind(platform: PerfPlatform, type: string, name: string): string {
  const t = `${type} ${name}`.toLowerCase().replace(/[_|~\-]+/g, ' ');
  if (platform === 'meta') return 'Meta';
  if (/performance max|pmax|p-max/.test(t)) return 'Performance Max';
  if (/demand gen|dgen|discovery/.test(t)) return 'Demand Gen';
  if (/video|youtube|\byt\b|vac|bumper/.test(t)) return 'YouTube';
  if (/display|gdn|remarketing|rmkt|retarget/.test(t)) return 'Display';
  if (/shopping|pla\b/.test(t)) return 'Shopping';
  if (/search|srch|sem|keyword/.test(t) || platform === 'google') return 'Search';
  return type.trim() || 'Other';
}

export function toPerfRows(rows: Record<string, string>[], cols: PerfColumns, platform: PerfPlatform): { rows: PerfRow[]; skipped: number } {
  const out: PerfRow[] = [];
  let skipped = 0;
  const num = (r: Record<string, string>, f: PerfField) => (cols[f] ? parseAmount(String(r[cols[f]!] ?? '').replace(/^--$/, '0').replace(/%$/, '')) : 0);
  for (const r of rows) {
    const first = String(Object.values(r)[0] ?? '');
    if (/^total/i.test(first) || (cols.campaign && /^total/i.test(String(r[cols.campaign] ?? '')))) { skipped++; continue; }
    const day = cols.day ? parseDay(String(r[cols.day] ?? '')) : null;
    if (cols.day && !day) { skipped++; continue; }
    const n = { cost: num(r, 'cost'), impressions: num(r, 'impressions'), clicks: num(r, 'clicks'), conversions: num(r, 'conversions'), value: num(r, 'value') };
    if (Object.values(n).some(x => !Number.isFinite(x) || x < 0)) { skipped++; continue; }
    const lb = cols.lostBudget ? String(r[cols.lostBudget] ?? '').trim() : '';
    const lostBudget = !lb || lb === '--' ? null : /^</.test(lb) ? 0.05 : Number(lb.replace(/[%>\s]/g, '')) / (lb.includes('%') ? 100 : 1);
    const campaign = cols.campaign ? String(r[cols.campaign] ?? '').trim().slice(0, 200) : '';
    out.push({ day, platform, campaignType: campaignKind(platform, cols.campaignType ? String(r[cols.campaignType] ?? '') : '', campaign), campaign, adGroup: cols.adGroup ? String(r[cols.adGroup] ?? '').trim().slice(0, 200) : '',
      term: cols.term ? String(r[cols.term] ?? '').trim().toLowerCase().slice(0, 200) : '', ...n, lostBudget: lostBudget !== null && Number.isFinite(lostBudget) ? Math.min(1, Math.max(0, lostBudget)) : null });
  }
  return { rows: out, skipped };
}

// ---------------------------------------------------------------- analysis

export interface PerfLine { name: string; type: string; platform: string; cost: number; clicks: number; impressions: number; conversions: number; value: number; lostBudget: number | null; brand: boolean }
export interface PerfWeek { week: string; cost: number; conversions: number; brandClicks: number; clicks: number }
export interface PlanLine { name: string; type: string; now: number; next: number; change: 'raise' | 'cut' | 'pause' | 'keep'; why: string; convNow: number; convNext: number }
export interface PerfFinding { tone: 'good' | 'bad' | 'neutral'; title: string; detail: string; action?: string; figure?: string; figureLabel?: string; names?: string[] }

const cpaOf = (x: { cost: number; conversions: number }) => (x.conversions > 0 ? x.cost / x.conversions : null);
export const isBrand = (text: string, brandWords: string[]) => !/non.?brand/i.test(text) && (/\bbrand(ed)?\b/i.test(text) || brandWords.some(w => w.length >= 3 && text.toLowerCase().includes(w.toLowerCase())));
/** A brand campaign: says so in its name, or is a search campaign on the brand's name that isn't generic or competitor. Many campaigns carry the brand's name as a prefix, so the name alone isn't enough. */
export function campaignIsBrand(name: string, type: string, brandWords: string[]): boolean {
  if (/non.?brand/i.test(name)) return false;
  if (/\bbrand(ed)?\b/i.test(name)) return true;
  return type === 'Search' && isBrand(name, brandWords) && !/generic|competitor|conquest|category|catg|dsa|dynamic/i.test(name);
}

/**
 * Next month with the same budget: pause what spent with nothing to show, cut what costs far more per
 * conversion than usual, and give the money to what converts cheaply (first to campaigns held back by
 * budget). Extra spend is assumed to convert 25% less well than today's average for that campaign, and
 * spend taken away to have converted at that campaign's own rate: estimates, said so on screen.
 */
export function perfPlan(lines: PerfLine[], monthFactor: number): { plan: PlanLine[]; convNow: number; convNext: number; budget: number; freed: number } {
  const real = lines.filter(l => l.cost > 0);
  const total = real.reduce((a, l) => a + l.cost, 0);
  const conv = real.reduce((a, l) => a + l.conversions, 0);
  const avg = conv ? total / conv : null;
  const plan: PlanLine[] = real.map(l => {
    const cpa = cpaOf(l), now = l.cost * monthFactor, c = l.conversions * monthFactor;
    if (avg && l.conversions === 0 && l.cost >= Math.max(1.5 * avg, total * 0.005)) return { name: l.name, type: l.type, now, next: 0, change: 'pause' as const, why: `Spent with no conversions`, convNow: 0, convNext: 0 };
    if (avg && cpa && cpa >= 1.6 * avg && l.conversions >= 2 && !l.brand) return { name: l.name, type: l.type, now, next: now * 0.6, change: 'cut' as const, why: `Costs ${(cpa / avg).toFixed(1)}× the usual per conversion${/YouTube|Display|Demand Gen/.test(l.type) ? ' (if it runs for awareness, judge it on the Media tab instead)' : ''}`, convNow: c, convNext: c * 0.6 };
    if (avg && cpa && cpa <= 0.8 * avg && l.conversions >= 3) return { name: l.name, type: l.type, now, next: now, change: 'raise' as const, why: l.lostBudget && l.lostBudget >= 0.1 ? `Cheap conversions, and ${Math.round(l.lostBudget * 100)}% of searches missed for budget` : `Converts at ${Math.round((1 - cpa / avg) * 100)}% below the usual cost`, convNow: c, convNext: c };
    return { name: l.name, type: l.type, now, next: now, change: 'keep' as const, why: '', convNow: c, convNext: c };
  });
  const freed = plan.reduce((a, p) => a + (p.now - p.next), 0);
  // the freed money goes to the cheap converters, held-back-by-budget first (double weight), capped at +60% each
  const takers = plan.filter(p => p.change === 'raise');
  const weight = (p: PlanLine) => p.now * (1 + (lines.find(l => l.name === p.name)?.lostBudget ?? 0) * 2);
  let left = freed;
  for (let round = 0; round < 3 && left > 1 && takers.length; round++) {
    const open = takers.filter(p => p.next < p.now * 1.6);
    const w = open.reduce((a, p) => a + weight(p), 0);
    if (!w) break;
    let given = 0;
    for (const p of open) { const add = Math.min(left * weight(p) / w, p.now * 1.6 - p.next); p.next += add; given += add; }
    left -= given;
  }
  for (const p of takers) { const line = lines.find(l => l.name === p.name)!; const cpa = cpaOf(line)!; p.convNext = p.convNow + (p.next - p.now) / (cpa * 1.25); }
  // whatever couldn't be placed stays with the campaigns kept as they are
  if (left > 1) { const keep = plan.filter(p => p.change === 'keep' && p.convNow > 0); const w = keep.reduce((a, p) => a + p.now, 0); for (const p of keep) { const add = left * p.now / w; const line = lines.find(l => l.name === p.name)!; p.convNext += add / (cpaOf(line)! * 1.25); p.next += add; if (add > 1) { p.change = 'raise'; p.why = 'Converts steadily; takes the rest of the freed budget'; } } }
  return { plan: plan.filter(p => p.change !== 'keep').sort((a, b) => Math.abs(b.next - b.now) - Math.abs(a.next - a.now)), convNow: plan.reduce((a, p) => a + p.convNow, 0), convNext: plan.reduce((a, p) => a + p.convNext, 0), budget: total * monthFactor, freed };
}

export function perfFindings(lines: PerfLine[], terms: { term: string; cost: number; conversions: number; clicks: number; brand: boolean }[], weeks: PerfWeek[], mainline: { label: string; weeks: Set<string> } | null, money: (n: number) => string, short: (n: number) => string = money): PerfFinding[] {
  const out: PerfFinding[] = [];
  const total = lines.reduce((a, l) => a + l.cost, 0), conv = lines.reduce((a, l) => a + l.conversions, 0);
  const avg = conv ? total / conv : null;
  if (!total) return out;
  // brand searches make the average look cheaper than buying new customers is
  const brand = lines.filter(l => l.brand), bc = brand.reduce((a, l) => a + l.cost, 0), bv = brand.reduce((a, l) => a + l.conversions, 0);
  if (avg && bv >= 0.1 * conv && conv - bv > 0) {
    const real = (total - bc) / (conv - bv);
    out.push({ tone: 'neutral', figure: short(real), figureLabel: 'real cost per conversion',
      title: 'Brand searches make leads look cheaper than they are',
      detail: `Brand campaigns bring ${Math.round((bv / conv) * 100)}% of conversions for ${Math.round((bc / total) * 100)}% of spend: people who were already looking for you. Without them a conversion costs ${money(real)}, not ${money(avg)}.`,
      action: 'Judge every other campaign against the real figure, and keep brand spend to what protects your name from competitors.' });
  }
  // spend with nothing to show
  const dead = lines.filter(l => l.conversions === 0 && avg && l.cost >= Math.max(1.5 * avg, total * 0.005)).sort((a, b) => b.cost - a.cost);
  if (dead.length) out.push({ tone: 'bad', figure: short(dead.reduce((a, l) => a + l.cost, 0)), figureLabel: 'with no conversions',
    title: `${dead.length} ${dead.length === 1 ? 'campaign' : 'campaigns'} spent with nothing to show`,
    detail: `${dead.slice(0, 3).map(l => `${l.name} (${money(l.cost)})`).join(', ')}${dead.length > 3 ? ` and ${dead.length - 3} more` : ''}: ${Math.round((dead.reduce((a, l) => a + l.cost, 0) / total) * 100)}% of spend.`,
    action: 'Pause them, or fix the landing page and conversion tracking first if they should be converting.', names: dead.map(l => l.name) });
  // search terms to block
  const badTerms = terms.filter(t => !t.brand && t.conversions === 0 && avg && t.cost >= avg * 0.5).sort((a, b) => b.cost - a.cost);
  if (badTerms.length) out.push({ tone: 'bad', figure: short(badTerms.reduce((a, t) => a + t.cost, 0)), figureLabel: `on ${badTerms.length} searches`,
    title: 'Searches that cost money and never convert',
    detail: `${badTerms.slice(0, 5).map(t => `“${t.term}”`).join(', ')}${badTerms.length > 5 ? ` and ${badTerms.length - 5} more` : ''}.`,
    action: 'Add them as negative keywords (copy the list).', names: badTerms.map(t => t.term) });
  // the cheapest kind of campaign
  const types = new Map<string, { cost: number; conversions: number }>();
  for (const l of lines) { const t = types.get(l.type) ?? { cost: 0, conversions: 0 }; t.cost += l.cost; t.conversions += l.conversions; types.set(l.type, t); }
  const ranked = [...types.entries()].filter(([, t]) => t.conversions >= 5).map(([k, t]) => ({ k, cpa: t.cost / t.conversions, share: t.cost / total })).sort((a, b) => a.cpa - b.cpa);
  if (ranked.length >= 2) {
    const best = ranked[0]!, worst = ranked[ranked.length - 1]!;
    out.push({ tone: 'good', figure: `${(worst.cpa / best.cpa).toFixed(1)}×`, figureLabel: 'cheaper',
      title: `${best.k} converts at a fraction of ${worst.k}`,
      detail: `${money(best.cpa)} per conversion on ${best.k} (${Math.round(best.share * 100)}% of spend) against ${money(worst.cpa)} on ${worst.k} (${Math.round(worst.share * 100)}% of spend).`,
      action: `The plan below moves money toward ${best.k}.` });
  }
  // mainline media and search: the halo
  if (mainline && weeks.length >= 6) {
    const on = weeks.filter(w => mainline.weeks.has(w.week)), off = weeks.filter(w => !mainline.weeks.has(w.week));
    if (on.length >= 3 && off.length >= 3) {
      const sum = (xs: PerfWeek[], k: keyof Omit<PerfWeek, 'week'>) => xs.reduce((a, w) => a + w[k], 0);
      const cpaOn = sum(on, 'conversions') ? sum(on, 'cost') / sum(on, 'conversions') : null, cpaOff = sum(off, 'conversions') ? sum(off, 'cost') / sum(off, 'conversions') : null;
      const brandOn = sum(on, 'brandClicks') / on.length, brandOff = sum(off, 'brandClicks') / off.length;
      if (cpaOn && cpaOff && Math.abs(cpaOn / cpaOff - 1) >= 0.08) out.push({ tone: cpaOn < cpaOff ? 'good' : 'neutral', figure: `${cpaOn < cpaOff ? '−' : '+'}${Math.round(Math.abs(1 - cpaOn / cpaOff) * 100)}%`, figureLabel: 'cost per conversion',
        title: cpaOn < cpaOff ? `Online leads get cheaper in ${mainline.label} weeks` : `Online leads cost more in ${mainline.label} weeks`,
        detail: `${money(cpaOn)} per conversion in the ${on.length} weeks ${mainline.label} ran, ${money(cpaOff)} in the ${off.length} weeks it didn't${brandOff > 0 ? `; brand searches clicked ${brandOn >= brandOff ? 'rose' : 'fell'} ${Math.round(Math.abs(brandOn / brandOff - 1) * 100)}% a week` : ''}.`,
        action: cpaOn < cpaOff ? `${mainline.label} makes people search for you: raise search budgets during ${mainline.label} bursts so the extra demand isn't lost, and lower them between bursts.` : 'Check whether search budgets ran out during the burst (lost impression share) before the next one.' });
    }
  }
  return out;
}
