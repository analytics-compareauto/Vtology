/**
 * Media: awareness campaigns (CTV, audio, online video, display) read from DSP reports such as DV360's.
 *
 * Awareness is judged on attention, not clicks: did the ad play to the end, could it be seen and heard,
 * on what supply, at what cost. Every number here is compared within the campaign (supply against
 * supply, this period against the one before), never against outside benchmarks we can't source.
 */

// ---------------------------------------------------------------- reading a report
export const MEDIA_FIELDS = ['day', 'advertiser', 'campaign', 'lineItem', 'lineItemType', 'creative', 'creativeType', 'exchange', 'inventorySource', 'site', 'device', 'environment', 'region', 'currency',
  'impressions', 'clicks', 'cost', 'viewable', 'measurable', 'starts', 'q1', 'q2', 'q3', 'completes', 'audible', 'conversions', 'reach'] as const;
export type MediaField = typeof MEDIA_FIELDS[number];
const MULTI: MediaField[] = ['starts', 'q1', 'q2', 'q3', 'completes'];

const norm = (s: string) => s.toLowerCase().replace(/[_\s]+/g, ' ').trim();
/** Header patterns, most specific first. DV360 names are covered; other DSPs' usual names too. */
const PATTERNS: [MediaField, RegExp, RegExp?][] = [
  ['day', /^(date|day|report date|date \(.*\))$/],
  ['advertiser', /^advertiser( name)?$/],
  ['lineItemType', /line item type|^media type$|^format$/],
  ['creativeType', /creative type/],
  ['campaign', /^(insertion order|campaign|campaign name|io|insertion order name)$/],
  ['lineItem', /^(line item|line item name|ad group|ad set|strategy)$/],
  ['creative', /^(creative|creative name|ad|ad name)$/],
  ['exchange', /^(exchange|ssp|supply partner)$/],
  ['inventorySource', /^(inventory source|inventory source name|deal|deal name|deal id|private deal)$/],
  ['site', /^(app\/url|app or url|app|url|site|domain|placement|publisher|channel name)$/],
  ['device', /^(device type|device)$/],
  ['environment', /^environment$/],
  ['region', /^(region|province|state|state \/ province|geo region)$/],
  ['currency', /^(advertiser currency|currency)$/],
  ['audible', /audible and (visible|viewable) at complet/],
  ['viewable', /viewable impressions$/, /%|rate|distribution/],
  ['measurable', /measurable impressions$/, /%|rate/],
  ['q1', /first.quartile/, /rate|%/],
  ['q2', /midpoint/, /rate|%/],
  ['q3', /third.quartile/, /rate|%/],
  ['completes', /complete (views|listens|plays)|completions|completed (views|listens)|video completes|audio completes/, /rate|%|audible|cost/],
  ['starts', /^starts|video starts|audio starts|^plays/, /rate|%/],
  ['impressions', /^(impressions|billable impressions|imps)$/],
  ['clicks', /^clicks$/],
  ['cost', /total media cost \(advertiser currency\)|^total media cost|media cost \(advertiser currency\)|^media cost|^spend|^cost$|revenue \(adv(ertiser)? currency\)/],
  ['conversions', /^(total conversions|conversions)$/],
  ['reach', /unique reach: (total|impression) reach$|^unique reach$|^reach$|^impression reach$/],
];

export type MediaColumns = Partial<Record<MediaField, string[]>>;

/** Which report column feeds which field. Starts, quartiles and completes may each come from a video and an audio column. */
export function detectMediaColumns(header: string[]): MediaColumns {
  const out: MediaColumns = {};
  const used = new Set<string>();
  for (const [field, re, not] of PATTERNS) {
    for (const h of header) {
      const n = norm(h);
      if (used.has(h) || / id$|\bid\b/.test(n) && !['inventorySource'].includes(field)) continue;
      if (!re.test(n) || (not && not.test(n))) continue;
      if (out[field] && !MULTI.includes(field)) continue;
      (out[field] ??= []).push(h); used.add(h);
    }
  }
  // insertion order beats campaign when both exist: it is the level budgets and goals are set at
  const io = header.find(h => /^(insertion order|insertion order name)$/.test(norm(h)));
  if (io) out.campaign = [io];
  // several cost columns: total media cost (what the advertiser pays for media) wins
  const costs = header.filter(h => /total media cost|media cost|^spend|^cost$|revenue \(adv/.test(norm(h)) && !/ id$|%|ecpm|cpm|cpc|cpa|rate/.test(norm(h)));
  if (costs.length) out.cost = [costs.find(h => /total media cost/.test(norm(h)) && /advertiser/.test(norm(h))) ?? costs.find(h => /total media cost/.test(norm(h))) ?? costs[0]!];
  // "Billable impressions" only when there is no plain impressions column
  if ((out.impressions?.length ?? 0) > 1) out.impressions = [out.impressions!.find(h => norm(h) === 'impressions') ?? out.impressions![0]!];
  return out;
}

export type Channel = 'ctv' | 'audio' | 'video' | 'display';
export const CHANNEL_LABEL: Record<Channel, string> = { ctv: 'Connected TV', audio: 'Audio', video: 'Online video', display: 'Display' };

export function channelOf(t: { lineItemType?: string; creativeType?: string; environment?: string; device?: string; lineItem?: string; creative?: string; starts?: number; completes?: number }): Channel {
  const kind = `${t.lineItemType ?? ''} ${t.creativeType ?? ''}`.toLowerCase();
  const names = `${t.lineItem ?? ''} ${t.creative ?? ''}`.toLowerCase();
  const where = `${t.environment ?? ''} ${t.device ?? ''}`.toLowerCase();
  if (/audio|podcast/.test(kind) || /\baudio\b|podcast|spotify|\bradio\b/.test(names)) return 'audio';
  if (/connected tv|ctv|ott|over.the.top/.test(kind) || /connected tv|smart tv|\bctv\b|\bott\b/.test(where) || /\bctv\b|\bott\b|connected tv/.test(names)) return 'ctv';
  if (/video|youtube|instream|in-stream|outstream/.test(kind) || /video|youtube|\bolv\b|pre.?roll/.test(names) || (t.starts ?? 0) > 0 || (t.completes ?? 0) > 0) return 'video';
  return 'display';
}

export const isOpenAuction = (s: string | null | undefined) => !s || /^(open auction|open exchange|open|-|none|n\/a|\(not set\)|unknown or unpermissioned inventory source|unknown)$/i.test(s.trim());

export interface MediaRow {
  day: string; advertiser: string; campaign: string; lineItem: string; lineItemType: string; channel: Channel; creative: string; exchange: string; supply: string; deal: boolean;
  site: string; device: string; region: string; currency: string;
  impressions: number; clicks: number; cost: number; viewable: number; measurable: number; starts: number; q1: number; q2: number; q3: number; completes: number; audible: number; conversions: number;
}

const toNum = (v: unknown) => { const s = String(v ?? '').replace(/[,\s$₹€£%]|CA\$|C\$/g, ''); const n = Number(s); return s && s !== '-' && Number.isFinite(n) ? n : 0; };
function toDay(v: unknown): string | null {
  const s = String(v ?? '').trim();
  // an Excel date saved as a number of days since 1899-12-30
  if (/^\d{5}(\.\d+)?$/.test(s) && Number(s) > 30000 && Number(s) < 80000) return new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(s)) * 86_400_000).toISOString().slice(0, 10);
  let m = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (m) return `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/); // dd/mm/yyyy, as Indian and Canadian exports often write it
  if (m) return `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
  const t = Date.parse(s);
  return /\d{4}/.test(s) && !Number.isNaN(t) ? new Date(t + 12 * 3600_000).toISOString().slice(0, 10) : null;
}

/** Report rows to clean rows. Summary and footer lines (no date) are skipped, as DV360 adds them at the end. */
export function toMediaRows(rows: Record<string, string>[], cols: MediaColumns, fallbackCurrency = ''): { rows: MediaRow[]; skipped: number } {
  const one = (r: Record<string, string>, f: MediaField) => { const c = cols[f]?.[0]; return c ? String(r[c] ?? '').trim() : ''; };
  const sum = (r: Record<string, string>, f: MediaField) => (cols[f] ?? []).reduce((a, c) => a + toNum(r[c]), 0);
  const out: MediaRow[] = [];
  let skipped = 0;
  for (const r of rows) {
    const day = toDay(one(r, 'day'));
    if (!day) { skipped++; continue; }
    const base = { lineItemType: one(r, 'lineItemType'), creativeType: one(r, 'creativeType'), environment: one(r, 'environment'), device: one(r, 'device'), lineItem: one(r, 'lineItem'), creative: one(r, 'creative'), starts: sum(r, 'starts'), completes: sum(r, 'completes') };
    const supply = one(r, 'inventorySource');
    out.push({
      day, advertiser: one(r, 'advertiser'), campaign: one(r, 'campaign'), lineItem: base.lineItem, lineItemType: base.lineItemType, channel: channelOf(base), creative: base.creative,
      exchange: one(r, 'exchange'), supply: isOpenAuction(supply) ? 'Open auction' : supply, deal: !isOpenAuction(supply),
      site: one(r, 'site'), device: base.device, region: one(r, 'region'), currency: (one(r, 'currency') || fallbackCurrency).toUpperCase().slice(0, 3),
      impressions: sum(r, 'impressions'), clicks: sum(r, 'clicks'), cost: sum(r, 'cost'), viewable: sum(r, 'viewable'), measurable: sum(r, 'measurable'),
      starts: base.starts, q1: sum(r, 'q1'), q2: sum(r, 'q2'), q3: sum(r, 'q3'), completes: base.completes, audible: sum(r, 'audible'), conversions: sum(r, 'conversions'),
    });
  }
  return { rows: out, skipped };
}

// ---------------------------------------------------------------- metrics
export interface Sums { impressions: number; clicks: number; cost: number; viewable: number; measurable: number; starts: number; q1: number; q2: number; q3: number; completes: number; audible: number; conversions: number }
export interface Metrics extends Sums {
  cpm: number | null; ctr: number | null;
  /** completed / started (or / impressions when starts aren't reported) */
  completion: number | null;
  costPerComplete: number | null;
  viewability: number | null;
  audibleViewable: number | null;
  /** completes that were also viewable (CTV and audio can't be measured for viewability, so count as given) */
  qualityCompletes: number;
  costPerQualityComplete: number | null;
}
export const ZERO: Sums = { impressions: 0, clicks: 0, cost: 0, viewable: 0, measurable: 0, starts: 0, q1: 0, q2: 0, q3: 0, completes: 0, audible: 0, conversions: 0 };
export const addSums = (a: Sums, b: Sums): Sums => Object.fromEntries(Object.keys(ZERO).map(k => [k, (a as never)[k] + (b as never)[k]])) as unknown as Sums;

export function metrics(s: Sums): Metrics {
  const viewability = s.measurable > s.impressions * 0.05 ? Math.min(1, s.viewable / s.measurable) : null;
  const base = s.starts > 0 ? s.starts : s.impressions;
  const completion = s.completes > 0 && base > 0 ? Math.min(1, s.completes / base) : null;
  const qualityCompletes = s.completes * (viewability ?? 1);
  return {
    ...s,
    cpm: s.impressions ? (s.cost / s.impressions) * 1000 : null,
    ctr: s.impressions ? s.clicks / s.impressions : null,
    completion, viewability,
    costPerComplete: s.completes ? s.cost / s.completes : null,
    audibleViewable: s.audible > 0 && s.measurable > 0 ? Math.min(1, s.audible / s.measurable) : null,
    qualityCompletes,
    costPerQualityComplete: qualityCompletes > 0 ? s.cost / qualityCompletes : null,
  };
}

/** Share of starts still watching (or listening) at 25%, 50%, 75% and 100%. */
export function quartiles(s: Sums): { at: string; share: number }[] | null {
  const base = s.starts || s.impressions;
  if (!base || !s.completes || !(s.q1 || s.q2 || s.q3)) return null;
  // a quartile the report doesn't carry (DV360 has no 25% point for audio) is left out, not drawn as zero
  return ([['Start', base], ['25%', s.q1], ['50%', s.q2], ['75%', s.q3], ['100%', s.completes]] as [string, number][])
    .filter(([at, v]) => at === 'Start' || at === '100%' || v > 0)
    .map(([at, v]) => ({ at, share: Math.min(1, v / base) }));
}

// ---------------------------------------------------------------- findings
export interface Group { key: string; channel?: Channel; deal?: boolean; sums: Sums }
export interface MediaFinding { tone: 'good' | 'bad' | 'info'; channel?: Channel; title: string; detail: string; action?: string; names?: string[]; /** the one number to show big */ figure?: string; figureLabel?: string }
export interface FindingsInput {
  total: Sums; previous: Sums;
  byChannel: Group[];
  bySupply: Group[]; // supply (deal or open auction) per channel
  bySite: Group[]; // site or app per channel
  byCreativeWeek: { key: string; channel: Channel; week: string; sums: Sums }[];
  byDevice: Group[]; // per channel
  byRegion: Group[];
  daily: { day: string; sums: Sums }[];
  money: (v: number) => string;
}

const share = (x: number) => `${Math.round(x * 100)}%`;
const times = (x: number) => `${x.toFixed(x >= 10 ? 0 : 1)}×`;
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : 0; };

/** What a planner should change, in plain words, with the evidence. Most important first. */
export function mediaFindings(i: FindingsInput): MediaFinding[] {
  const out: MediaFinding[] = [];
  const chans = i.byChannel.filter(c => c.sums.cost > 0).map(c => c.channel!);
  for (const ch of chans) {
    const chCost = i.byChannel.find(c => c.channel === ch)!.sums.cost;
    const label = CHANNEL_LABEL[ch];
    const chM = metrics(i.byChannel.find(c => c.channel === ch)!.sums);

    // 1. supply: the costliest and cheapest way to buy an attentive completed view
    const sup = i.bySupply.filter(g => g.channel === ch && g.sums.cost >= chCost * 0.05).map(g => ({ g, m: metrics(g.sums) })).filter(x => x.m.costPerQualityComplete);
    if (sup.length >= 2) {
      sup.sort((a, b) => a.m.costPerQualityComplete! - b.m.costPerQualityComplete!);
      const best = sup[0]!, worst = sup[sup.length - 1]!;
      const ratio = worst.m.costPerQualityComplete! / best.m.costPerQualityComplete!;
      if (ratio >= 1.08 && ratio < 1.4 && worst.g.sums.cost >= chCost * 0.2) {
        const extra = worst.g.sums.cost / best.m.costPerQualityComplete! - worst.m.qualityCompletes;
        out.push({ tone: 'info', channel: ch, figure: `+${Math.round((ratio - 1) * 100)}%`, figureLabel: 'cost per completed view', title: `${label}: ${worst.g.key} costs ${Math.round((ratio - 1) * 100)}% more per completed view than ${best.g.key}`,
          detail: `${worst.g.key} takes ${share(worst.g.sums.cost / chCost)} of ${label} spend${worst.m.completion !== null && best.m.completion !== null ? ` and completes at ${share(worst.m.completion)} against ${share(best.m.completion)}` : ''}.`,
          action: `Shift part of that budget to ${best.g.key}: at its cost, the same money buys about ${Math.round(extra).toLocaleString('en-IN')} more completed views, as long as it can scale.` });
      }
      if (ratio >= 1.4) {
        const extra = worst.g.sums.cost / best.m.costPerQualityComplete! - worst.m.qualityCompletes;
        out.push({ tone: 'bad', channel: ch, figure: times(ratio), figureLabel: 'cost per completed view', title: `${label}: ${worst.g.key} costs ${times(ratio)} as much per completed view as ${best.g.key}`,
          detail: `${worst.g.key} took ${share(worst.g.sums.cost / chCost)} of ${label} spend at ${i.money(worst.m.costPerQualityComplete!)} per completed${ch === 'video' || ch === 'display' ? ', viewable' : ''} view, against ${i.money(best.m.costPerQualityComplete!)} on ${best.g.key}.`,
          action: `Move budget from ${worst.g.key} to ${best.g.key}: the same money there would have bought about ${Math.round(extra).toLocaleString('en-IN')} more completed views, while ${best.g.key} has room to scale.` });
      }
    }
    // 2. deals against open auction
    const deals = i.bySupply.filter(g => g.channel === ch && g.deal), open = i.bySupply.filter(g => g.channel === ch && !g.deal);
    if (deals.length && open.length) {
      const d = metrics(deals.reduce((a, g) => addSums(a, g.sums), ZERO)), o = metrics(open.reduce((a, g) => addSums(a, g.sums), ZERO));
      if (d.costPerQualityComplete && o.costPerQualityComplete && d.cost > chCost * 0.05 && o.cost > chCost * 0.05) {
        const better = d.costPerQualityComplete < o.costPerQualityComplete;
        out.push({ tone: better ? 'good' : 'bad', channel: ch, figure: `${better ? '−' : '+'}${Math.round(Math.abs(1 - d.costPerQualityComplete / o.costPerQualityComplete) * 100)}%`, figureLabel: 'deals vs open auction', title: `${label}: private deals ${better ? 'beat' : 'trail'} open auction on cost per completed view`,
          detail: `Deals: ${i.money(d.costPerQualityComplete)} per completed view, ${d.completion !== null ? `${share(d.completion)} completion` : ''}${d.viewability !== null ? `, ${share(d.viewability)} viewable` : ''}. Open auction: ${i.money(o.costPerQualityComplete)}${o.completion !== null ? `, ${share(o.completion)} completion` : ''}${o.viewability !== null ? `, ${share(o.viewability)} viewable` : ''}.`,
          action: better ? `Shift more ${label} budget into the deals while their cost per completed view holds.` : `Review the deals' floor prices or targeting; open auction is buying attention more cheaply.` });
      }
    }
    // 3. sites and apps to block: spend with little completion or viewability
    const sites = i.bySite.filter(g => g.channel === ch && g.key && g.sums.cost >= chCost * 0.005).map(g => ({ g, m: metrics(g.sums) }));
    if (sites.length >= 5 && chM.completion !== null) {
      const bad = sites.filter(x => (x.m.completion !== null && x.m.completion < chM.completion! * 0.6) || (x.m.viewability !== null && x.m.viewability < 0.5));
      const badCost = bad.reduce((a, x) => a + x.g.sums.cost, 0);
      if (bad.length && badCost >= chCost * 0.03) out.push({ tone: 'bad', channel: ch, figure: share(badCost / chCost), figureLabel: 'of spend wasted', title: `${label}: ${bad.length} ${bad.length === 1 ? 'site or app takes' : 'sites and apps take'} ${share(badCost / chCost)} of spend with little attention to show`,
        detail: `Each completes under 60% as often as the ${label} average (${share(chM.completion!)})${ch === 'video' || ch === 'display' ? ', or is viewable less than half the time' : ''}.`,
        action: `Add them to a block list for ${label}.`, names: bad.sort((a, b) => b.g.sums.cost - a.g.sums.cost).slice(0, 20).map(x => x.g.key) });
    }
    // 4. the opening: where viewers or listeners leave
    const q = quartiles(i.byChannel.find(c => c.channel === ch)!.sums);
    if (q) {
      const drops = q.slice(1).map((x, k) => ({ at: `${q[k]!.at} to ${x.at}`, lost: q[k]!.share - x.share }));
      const worst = drops.sort((a, b) => b.lost - a.lost)[0]!;
      if (worst.lost >= 0.12) out.push({ tone: 'info', channel: ch, figure: share(worst.lost), figureLabel: `leave at ${worst.at}`, title: `${label}: the biggest drop is ${worst.at}, where ${share(worst.lost)} of ${ch === 'audio' ? 'listeners' : 'viewers'} leave`,
        detail: `${share(q.at(-1)!.share)} make it to the end.`,
        action: worst.at.startsWith('Start') ? `Put the brand and the hook in the first seconds; test a shorter cut.` : `Test a shorter version that ends before ${worst.at.split(' to ')[1]}.` });
    }
    // 5. creatives wearing out: completion falling week on week
    const byCreative = new Map<string, { week: string; m: Metrics }[]>();
    for (const w of i.byCreativeWeek.filter(x => x.channel === ch && x.key)) (byCreative.get(w.key) ?? byCreative.set(w.key, []).get(w.key)!).push({ week: w.week, m: metrics(w.sums) });
    const tired: string[] = [];
    for (const [name, ws] of byCreative) {
      const s = ws.filter(w => w.m.completion !== null && w.m.starts + w.m.impressions > 500).sort((a, b) => a.week.localeCompare(b.week));
      if (s.length < 4) continue;
      const early = (s[0]!.m.completion! + s[1]!.m.completion!) / 2, late = (s.at(-1)!.m.completion! + s.at(-2)!.m.completion!) / 2;
      if (late < early * 0.88) tired.push(`${name} (${share(early)} to ${share(late)})`);
    }
    if (tired.length) out.push({ tone: 'bad', channel: ch, figure: String(tired.length), figureLabel: tired.length === 1 ? 'creative wearing out' : 'creatives wearing out', title: `${label}: ${tired.length === 1 ? 'one creative is' : `${tired.length} creatives are`} wearing out`,
      detail: `Completion has fallen by more than a tenth from their first two weeks to their last two.`, action: `Rotate in fresh cuts or cap frequency on these creatives.`, names: tired });
    // 6. devices, for online video: phones, desktops and TV screens behave differently
    const dev = i.byDevice.filter(g => g.channel === ch && g.key && g.sums.cost >= chCost * 0.1).map(g => ({ g, m: metrics(g.sums) })).filter(x => x.m.costPerQualityComplete);
    if (dev.length >= 2) {
      dev.sort((a, b) => a.m.costPerQualityComplete! - b.m.costPerQualityComplete!);
      const r = dev.at(-1)!.m.costPerQualityComplete! / dev[0]!.m.costPerQualityComplete!;
      if (r >= 1.5) out.push({ tone: 'info', channel: ch, figure: times(r), figureLabel: 'device cost gap', title: `${label}: completed views cost ${share(1 - 1 / r)} less on ${dev[0]!.g.key} than on ${dev.at(-1)!.g.key}`,
        detail: `${dev[0]!.g.key}: ${i.money(dev[0]!.m.costPerQualityComplete!)} per completed view; ${dev.at(-1)!.g.key}: ${i.money(dev.at(-1)!.m.costPerQualityComplete!)}.`, action: `Adjust device bids towards ${dev[0]!.g.key}.` });
    }
  }
  // 7. regions far from the rest
  const regCost = i.byRegion.reduce((a, g) => a + g.sums.cost, 0);
  const regs = i.byRegion.filter(g => g.key && g.sums.cost >= regCost * 0.03).map(g => ({ g, m: metrics(g.sums) })).filter(x => x.m.costPerQualityComplete);
  if (regs.length >= 3) {
    const mid = median(regs.map(x => x.m.costPerQualityComplete!));
    const dear = regs.filter(x => x.m.costPerQualityComplete! > mid * 1.5);
    if (dear.length) out.push({ tone: 'info', figure: String(dear.length), figureLabel: dear.length === 1 ? 'costly region' : 'costly regions', title: `${dear.length === 1 ? 'One region costs' : `${dear.length} regions cost`} far more per completed view`,
      detail: `${dear.map(x => `${x.g.key} (${i.money(x.m.costPerQualityComplete!)})`).join(', ')}, against a middle of ${i.money(mid)}.`, action: `Check whether these markets matter more to the brand (dealers, sales); if not, lower their bids.` });
  }
  // 8. pacing: the last week against the one before
  const days = [...i.daily].sort((a, b) => a.day.localeCompare(b.day));
  if (days.length >= 14) {
    const last = days.slice(-7).reduce((a, d) => a + d.sums.cost, 0), prev = days.slice(-14, -7).reduce((a, d) => a + d.sums.cost, 0);
    if (prev > 0 && Math.abs(last / prev - 1) >= 0.25) out.push({ tone: 'info', figure: `${last > prev ? '+' : '−'}${share(Math.abs(last / prev - 1))}`, figureLabel: 'spend, last 7 days', title: `Spend ${last > prev ? 'rose' : 'fell'} ${share(Math.abs(last / prev - 1))} in the last 7 days`,
      detail: `${i.money(last)} against ${i.money(prev)} the week before.`, action: last > prev ? 'Check that pacing matches the flight plan.' : 'Check for paused lines, exhausted deals or caps.' });
  }
  const order = { bad: 0, good: 1, info: 2 } as const;
  return out.sort((a, b) => order[a.tone] - order[b.tone]);
}

// ---------------------------------------------------------------- reach and frequency
/** A reach report: people reached per line (insertion order) per day. Reach can't be added across days or lines. */
export const isReachReport = (cols: MediaColumns) => !!cols.reach?.length && !cols.site?.length && !cols.inventorySource?.length;
export interface ReachRow { day: string; campaign: string; impressions: number; reach: number; cost: number }
export function toReachRows(rows: Record<string, string>[], cols: MediaColumns): { rows: ReachRow[]; skipped: number } {
  const one = (r: Record<string, string>, f: MediaField) => { const c = cols[f]?.[0]; return c ? String(r[c] ?? '').trim() : ''; };
  const num = (r: Record<string, string>, f: MediaField) => { const c = cols[f]?.[0]; return c ? toNum(r[c]) : 0; };
  const out: ReachRow[] = []; let skipped = 0;
  for (const r of rows) {
    const day = toDay(one(r, 'day'));
    const campaign = one(r, 'campaign') || one(r, 'lineItem');
    if (!day || !campaign) { skipped++; continue; }
    out.push({ day, campaign, impressions: num(r, 'impressions'), reach: num(r, 'reach'), cost: num(r, 'cost') });
  }
  return { rows: out, skipped };
}
export interface FrequencyLine { campaign: string; channel: Channel; days: number; impressions: number; cost: number; dailyReach: number; dailyFrequency: number; maxFrequency: number }
/** Per line: average people reached a day and how many times each saw the ad that day, over days with reach reported. */
export function frequencyLines(rows: ReachRow[]): FrequencyLine[] {
  const by = new Map<string, ReachRow[]>();
  for (const r of rows) (by.get(r.campaign) ?? by.set(r.campaign, []).get(r.campaign)!).push(r);
  return [...by.entries()].map(([campaign, rs]) => {
    const withReach = rs.filter(r => r.reach > 0 && r.impressions > 0);
    const freqs = withReach.map(r => r.impressions / r.reach);
    return { campaign, channel: channelOf({ lineItem: campaign }), days: new Set(rs.map(r => r.day)).size, impressions: rs.reduce((a, r) => a + r.impressions, 0), cost: rs.reduce((a, r) => a + r.cost, 0),
      dailyReach: withReach.length ? withReach.reduce((a, r) => a + r.reach, 0) / withReach.length : 0,
      dailyFrequency: freqs.length ? freqs.reduce((a, b) => a + b, 0) / freqs.length : 0, maxFrequency: freqs.length ? Math.max(...freqs) : 0 };
  }).filter(l => l.dailyReach > 0).sort((a, b) => b.cost - a.cost);
}
/** Lines showing the ad to the same people too often in a day. */
export function frequencyFindings(lines: FrequencyLine[], money: (v: number) => string): MediaFinding[] {
  const heavy = lines.filter(l => l.dailyFrequency >= 4 && l.impressions >= 10_000);
  const out: MediaFinding[] = heavy.map(l => ({ tone: 'bad' as const, channel: l.channel, figure: `${l.dailyFrequency.toFixed(1)}×`, figureLabel: 'ads per person a day',
    title: `${l.campaign}: each person saw the ad ${l.dailyFrequency.toFixed(1)} times a day on average`,
    detail: `About ${Math.round(l.dailyReach).toLocaleString('en-IN')} people a day were reached with ${Math.round(l.impressions / Math.max(1, l.days)).toLocaleString('en-IN')} impressions a day (${money(l.cost)} over ${l.days} days); on the worst day it was ${l.maxFrequency.toFixed(1)} times. High completion rates on such a line mostly mean the same homes watching again.`,
    action: `Cap frequency at 2 to 3 a day${l.channel === 'ctv' ? ' per household' : ''}. With enough supply, the same spend could reach up to ${(l.dailyFrequency / 2.5).toFixed(1)}× as many people a day.` }));
  const mid = lines.filter(l => l.dailyFrequency >= 3 && l.dailyFrequency < 4 && l.impressions >= 10_000);
  if (mid.length) out.push({ tone: 'info', figure: String(mid.length), figureLabel: 'lines at 3–4 a day', title: `${mid.length === 1 ? 'One more line shows' : `${mid.length} more lines show`} the ad 3 to 4 times a day per person`, detail: mid.map(l => `${l.campaign} (${l.dailyFrequency.toFixed(1)})`).join('; '), action: 'Watch these: past 3 a day, extra impressions mostly repeat to the same people.' });
  return out;
}

/**
 * Squeeze a report before upload: rows with the same date, line, creative, supply, site, device and
 * region are added together, and each channel's long tail of tiny sites (under 0.05% of its spend and
 * impressions) becomes one "Other sites" row per day and line. Every total stays exactly the same.
 */
export function squeezeMediaRows(rows: MediaRow[], tailShare = 0.0005): { rows: MediaRow[]; before: number; tailSites: number } {
  const chSpend = new Map<string, { cost: number; imps: number }>(), siteSpend = new Map<string, { cost: number; imps: number }>();
  for (const r of rows) {
    const c = chSpend.get(r.channel) ?? { cost: 0, imps: 0 }; c.cost += r.cost; c.imps += r.impressions; chSpend.set(r.channel, c);
    const k = `${r.channel}\u0000${r.site}`; const s = siteSpend.get(k) ?? { cost: 0, imps: 0 }; s.cost += r.cost; s.imps += r.impressions; siteSpend.set(k, s);
  }
  const tiny = new Set<string>();
  for (const [k, s] of siteSpend) { const c = chSpend.get(k.split('\u0000')[0]!)!; if (s.cost <= c.cost * tailShare && s.imps <= c.imps * tailShare) tiny.add(k); }
  const out = new Map<string, MediaRow>();
  const NUMS = ['impressions', 'clicks', 'cost', 'viewable', 'measurable', 'starts', 'q1', 'q2', 'q3', 'completes', 'audible', 'conversions'] as const;
  for (const r0 of rows) {
    const site = tiny.has(`${r0.channel}\u0000${r0.site}`) ? 'Other sites (small)' : r0.site;
    const key = [r0.day, r0.campaign, r0.lineItem, r0.creative, r0.channel, r0.supply, r0.exchange, site, r0.device, r0.region].join('\u0000');
    const x = out.get(key);
    if (!x) { out.set(key, { ...r0, site }); continue; }
    for (const n of NUMS) x[n] += r0[n];
  }
  return { rows: [...out.values()], before: rows.length, tailSites: new Set([...tiny].map(k => k.split('\u0000')[1])).size };
}
