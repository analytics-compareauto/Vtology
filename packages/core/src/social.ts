/**
 * Social footprint analysis. Pure functions over the brand's own posts and their metrics.
 *
 * Every post is compared with its own account's usual performance (its "lift"), so a YouTube video
 * and an Instagram reel can be judged side by side. Posts are then grouped by theme, format, posting
 * time (IST) and caption language, and groups that consistently beat or trail the account's norm
 * become plain-language findings. Small groups are ignored rather than over-read.
 */
import type { Industry } from './modules';

export interface SocialPost {
  id: string;
  accountId: string;
  platform: 'instagram' | 'facebook' | 'youtube' | 'linkedin';
  postedAt: Date;
  format: string;
  caption: string | null;
  permalink?: string | null;
  views?: number | null; reach?: number | null; likes?: number | null; comments?: number | null; shares?: number | null; saves?: number | null;
  watchMinutes?: number | null; avgViewPct?: number | null;
}
export interface SocialAccount { id: string; platform: SocialPost['platform']; name: string; handle?: string | null; followers?: number | null }

export type Dimension = 'theme' | 'format' | 'time' | 'day' | 'language' | 'length';
export interface Segment { dimension: Dimension; key: string; label: string; posts: number; share: number; lift: number; medianEngagement: number }
export interface Insight { kind: 'working' | 'not_working' | 'try'; title: string; detail: string; dimension?: Dimension; key?: string; strength: number }
export interface ScoredPost extends SocialPost { interactions: number; engagement: number | null; lift: number | null; themes: string[]; timeBand: string; dayType: string; language: string; lengthBand: string }
export interface SocialAnalysis {
  windowDays: number;
  posts: number;
  /** Posts left out of comparisons because too few people saw them for a ratio to mean anything. */
  lowAudience: number;
  byPlatform: { platform: string; posts: number; views: number; interactions: number; medianEngagement: number | null }[];
  segments: Segment[];
  insights: Insight[];
  top: ScoredPost[];
  bottom: ScoredPost[];
}

// ------------------------------------------------------------- tagging
type ThemeDef = [key: string, label: string, words: string[]];
const COMMON: ThemeDef[] = [
  ['festive', 'Festive', ['diwali', 'navratri', 'dussehra', 'holi', 'eid', 'christmas', 'pongal', 'onam', 'ganesh', 'dhanteras', 'festive', 'new year', 'independence day']],
  ['giveaway', 'Contests and giveaways', ['giveaway', 'contest', 'win ', 'winner', 'lucky draw']],
  ['question', 'Questions and polls', ['which one', 'would you', 'tell us', 'comment below', 'poll', 'vote']],
  ['tips', 'Tips and explainers', ['tips', 'how to', 'guide', 'explained', 'things to know', 'mistakes', 'checklist', 'myth']],
];
const THEMES: Record<Industry, ThemeDef[]> = {
  Automotive: [
    ['comparison', 'Comparisons', [' vs ', ' vs.', 'versus', 'compare', 'comparison', 'which is better', 'face-off', 'face off']],
    ['launch', 'Launches and first looks', ['launch', 'launched', 'first look', 'unveil', 'coming soon', 'new ', 'debut']],
    ['review', 'Reviews and test drives', ['review', 'test drive', 'road test', 'drive impressions', 'ownership']],
    ['price', 'Prices and offers', ['price', 'offer', 'discount', 'emi', 'on-road', 'on road', 'deal', 'booking open', '₹', 'lakh']],
    ['ev', 'Electric vehicles', [' ev', 'ev ', 'electric', 'charging', 'battery', 'range']],
    ['safety', 'Safety', ['safety', 'ncap', 'airbag', 'crash test', 'adas']],
    ['mileage', 'Mileage and running cost', ['mileage', 'kmpl', 'fuel efficiency', 'running cost', 'cng']],
    ...COMMON,
  ],
  BFSI: [
    ['rates', 'Rates and offers', ['interest rate', 'rate cut', '% p.a', 'cashback', 'offer', 'zero fee', 'lifetime free', 'pre-approved']],
    ['tax', 'Tax saving', ['tax', '80c', 'itr', 'tds']],
    ['credit', 'Credit score', ['credit score', 'cibil', 'credit report']],
    ['fraud', 'Fraud and security awareness', ['fraud', 'scam', 'otp', 'phishing', 'stay safe', 'cyber']],
    ['product', 'Product features', ['home loan', 'personal loan', 'credit card', 'insurance', 'fixed deposit', ' fd', 'mutual fund', 'sip', 'app']],
    ['stories', 'Customer stories', ['story', 'journey', 'dream home', 'testimonial', 'meet ']],
    ...COMMON,
  ],
  FMCG: [
    ['recipe', 'Recipes and usage ideas', ['recipe', 'cook', 'make this', 'snack', 'breakfast', 'try this', 'hack']],
    ['launch', 'New products', ['new ', 'launch', 'introducing', 'now available', 'flavour', 'flavor']],
    ['health', 'Health and ingredients', ['protein', 'healthy', 'nutrition', 'no added', 'natural', 'ingredients', 'sugar']],
    ['creator', 'Creator collaborations', ['collab', 'with @', 'ft.', 'featuring']],
    ['offer', 'Offers and quick commerce', ['offer', 'discount', 'blinkit', 'zepto', 'instamart', 'bigbasket', 'buy now', '% off']],
    ...COMMON,
  ],
};

const IST_OFFSET = 330 * 60_000;
function istParts(d: Date) { const t = new Date(d.getTime() + IST_OFFSET); return { hour: t.getUTCHours(), dow: t.getUTCDay() }; }

export function themesOf(industry: Industry, caption: string | null): string[] {
  const c = ` ${(caption ?? '').toLowerCase()} `;
  const hits = THEMES[industry].filter(([, , words]) => words.some(w => c.includes(w))).map(([k]) => k);
  return hits.length ? hits : ['other'];
}
export function languageOf(caption: string | null): string {
  const c = caption ?? '';
  const count = (re: RegExp) => (c.match(re) ?? []).length;
  const scripts: [string, number][] = [
    ['Hindi or Marathi', count(/[ऀ-ॿ]/g)], ['Bengali', count(/[ঀ-৿]/g)], ['Gujarati', count(/[઀-૿]/g)],
    ['Tamil', count(/[஀-௿]/g)], ['Telugu', count(/[ఀ-౿]/g)], ['Kannada', count(/[ಀ-೿]/g)], ['Malayalam', count(/[ഀ-ൿ]/g)],
  ];
  const [name, n] = scripts.sort((a, b) => b[1] - a[1])[0]!;
  return n >= 3 ? name : 'English';
}
export function timeBandOf(d: Date): string {
  const h = istParts(d).hour;
  return h >= 6 && h < 11 ? 'morning' : h >= 11 && h < 16 ? 'afternoon' : h >= 16 && h < 21 ? 'evening' : 'night';
}
const dayTypeOf = (d: Date) => ([0, 6].includes(istParts(d).dow) ? 'weekend' : 'weekday');
const lengthOf = (c: string | null) => { const n = (c ?? '').length; return n < 80 ? 'short' : n <= 300 ? 'medium' : 'long'; };

const LABELS: Record<Dimension, Record<string, string>> = {
  theme: {}, language: {},
  format: { reel: 'Reels', video: 'Videos', short: 'Shorts', image: 'Single images', carousel: 'Carousels', text: 'Text posts', link: 'Link posts', live: 'Live streams' },
  time: { morning: 'Mornings (6–11 am)', afternoon: 'Afternoons (11 am–4 pm)', evening: 'Evenings (4–9 pm)', night: 'Late night (9 pm–6 am)' },
  day: { weekday: 'Weekdays', weekend: 'Weekends' },
  length: { short: 'Short captions', medium: 'Medium captions', long: 'Long captions' },
};
export function themeLabel(industry: Industry, key: string): string {
  return THEMES[industry].find(t => t[0] === key)?.[1] ?? 'Other';
}

// ------------------------------------------------------------- scoring
const median = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
const n0 = (x: number | null | undefined) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);

function score(industry: Industry, p: SocialPost, followers: number | null | undefined): Omit<ScoredPost, 'lift'> {
  const interactions = n0(p.likes) + n0(p.comments) + n0(p.shares) + n0(p.saves);
  // Who saw it: reach, else views. Followers stand in only when the platform gives neither.
  const audience = p.reach ?? p.views ?? null;
  const base = audience !== null ? audience : n0(followers);
  // 2 likes on 3 views is not a 67% engagement rate; it is noise. Leave such posts out of ratios.
  const reliable = audience === null ? base > 0 : audience >= MIN_AUDIENCE;
  return {
    ...p, interactions,
    engagement: reliable && base > 0 ? interactions / base : null,
    themes: themesOf(industry, p.caption), timeBand: timeBandOf(p.postedAt), dayType: dayTypeOf(p.postedAt),
    language: languageOf(p.caption), lengthBand: lengthOf(p.caption),
  };
}

const MIN_POSTS = 3;
/** Fewer people than this saw the post: too small for its engagement rate to be compared. */
export const MIN_AUDIENCE = 50;
/** Groups smaller than this are reported, but marked as an early signal. */
const SOLID_POSTS = 8;
const fmt = (x: number) => `${x >= 10 ? Math.round(x) : x.toFixed(1)}×`;
const early = (s: { posts: number }) => s.posts < SOLID_POSTS ? 'Early signal. ' : '';
const pctOf = (x: number) => `${Math.round(x * 100)}%`;

export function analyzeSocial(industry: Industry, accounts: SocialAccount[], posts: SocialPost[], now: Date, windowDays = 180): SocialAnalysis {
  const since = now.getTime() - windowDays * 86_400_000;
  const inWindow = posts.filter(p => p.postedAt.getTime() >= since);
  const acc = new Map(accounts.map(a => [a.id, a]));
  const scored0 = inWindow.map(p => score(industry, p, acc.get(p.accountId)?.followers));
  // lift: engagement relative to the same account's median, so platforms are comparable
  const accMedian = new Map<string, number>();
  for (const a of accounts) accMedian.set(a.id, median(scored0.filter(p => p.accountId === a.id && p.engagement !== null).map(p => p.engagement!)));
  const scored: ScoredPost[] = scored0.map(p => {
    const m = accMedian.get(p.accountId) ?? 0;
    return { ...p, lift: p.engagement !== null && m > 0 ? p.engagement / m : null };
  });
  const rated = scored.filter(p => p.lift !== null);

  const groups: [Dimension, (p: ScoredPost) => string[]][] = [
    ['theme', p => p.themes], ['format', p => [p.format]], ['time', p => [p.timeBand]], ['day', p => [p.dayType]],
    ['language', p => [p.language]], ['length', p => [p.lengthBand]],
  ];
  const segments: Segment[] = [];
  for (const [dim, keys] of groups) {
    const bucket = new Map<string, ScoredPost[]>();
    rated.forEach(p => keys(p).forEach(k => bucket.set(k, [...(bucket.get(k) ?? []), p])));
    for (const [key, ps] of bucket) {
      if (ps.length < MIN_POSTS) continue;
      segments.push({
        dimension: dim, key, posts: ps.length, share: ps.length / rated.length,
        label: dim === 'theme' ? themeLabel(industry, key) : dim === 'language' ? `Posts in ${key}` : LABELS[dim][key] ?? key,
        lift: median(ps.map(p => p.lift!)), medianEngagement: median(ps.map(p => p.engagement!)),
      });
    }
  }

  const insights: Insight[] = [];
  const meaningful = segments.filter(s => !(s.dimension === 'theme' && s.key === 'other'));
  const best = (d: Dimension) => meaningful.filter(s => s.dimension === d).sort((a, b) => b.lift - a.lift);
  for (const s of meaningful) {
    if (s.lift >= 1.3 && s.posts >= MIN_POSTS) insights.push({ kind: 'working', dimension: s.dimension, key: s.key, strength: s.lift * Math.sqrt(s.posts),
      title: `${s.label} get ${fmt(s.lift)} your usual engagement`, detail: `${early(s)}Across ${s.posts} posts. ${s.share < 0.2 ? `Only ${pctOf(s.share)} of what you post, so there is room to do more.` : `${pctOf(s.share)} of what you post.`}` });
    if (s.lift <= 0.75 && s.posts >= MIN_POSTS) insights.push({ kind: 'not_working', dimension: s.dimension, key: s.key, strength: (1 / Math.max(s.lift, 0.05)) * Math.sqrt(s.posts),
      title: `${s.label} get ${fmt(s.lift)} your usual engagement`, detail: `${early(s)}Across ${s.posts} posts, ${pctOf(s.share)} of your output.${s.share >= 0.25 ? ' A large share of effort going to your weakest content.' : ''}` });
  }
  // what to try next: concrete shifts derived from the strongest contrasts
  const theme = best('theme'), format = best('format'), time = best('time'), lang = best('language');
  const top = theme.find(t => t.posts >= 6);
  if (top && top.lift >= 1.3 && top.share < 0.3) insights.push({ kind: 'try', dimension: 'theme', key: top.key, strength: 50 + top.lift,
    title: `Make ${top.label.toLowerCase()} at least 1 in 4 posts`, detail: `They are ${pctOf(top.share)} of your posts today and your strongest theme at ${fmt(top.lift)}.` });
  // format advice compares formats on the same platform (text posts on Facebook vs shorts on YouTube is not a fair fight)
  let fmtPick: { hi: Segment; lo: Segment; ratio: number; platform: string } | null = null;
  for (const pl of new Set(rated.map(p => p.platform))) {
    const fs = new Map<string, number[]>();
    rated.filter(p => p.platform === pl).forEach(p => fs.set(p.format, [...(fs.get(p.format) ?? []), p.lift!]));
    const segs = [...fs.entries()].filter(([, ls]) => ls.length >= MIN_POSTS).map(([k, ls]) => ({ key: k, lift: median(ls) })).sort((a, b) => b.lift - a.lift);
    if (segs.length < 2) continue;
    const ratio = segs[0]!.lift / Math.max(segs[segs.length - 1]!.lift, 0.01);
    if (ratio >= 1.5 && (!fmtPick || ratio > fmtPick.ratio)) {
      const mk = (x: { key: string; lift: number }): Segment => ({ dimension: 'format', key: x.key, label: LABELS.format[x.key] ?? x.key, posts: 0, share: 0, lift: x.lift, medianEngagement: 0 });
      fmtPick = { hi: mk(segs[0]!), lo: mk(segs[segs.length - 1]!), ratio, platform: pl };
    }
  }
  if (fmtPick) {
    const plName = { instagram: 'Instagram', facebook: 'Facebook', youtube: 'YouTube', linkedin: 'LinkedIn' }[fmtPick.platform] ?? fmtPick.platform;
    insights.push({ kind: 'try', dimension: 'format', key: fmtPick.hi.key, strength: 40 + fmtPick.ratio,
      title: `On ${plName}, turn ${fmtPick.lo.label.toLowerCase()} into ${fmtPick.hi.label.toLowerCase()}`, detail: `${fmtPick.hi.label} get ${fmt(fmtPick.ratio)} the engagement of ${fmtPick.lo.label.toLowerCase()} there.` });
  }
  if (time.length >= 2 && time[0]!.lift >= 1.15) {
    insights.push({ kind: 'try', dimension: 'time', key: time[0]!.key, strength: 30 + time[0]!.lift,
      title: `Schedule more posts for ${time[0]!.label.toLowerCase().replace(/ \(.*\)/, '')}`, detail: `${time[0]!.label} perform at ${fmt(time[0]!.lift)}; ${time[time.length - 1]!.label.toLowerCase()} at ${fmt(time[time.length - 1]!.lift)}.` });
  }
  const regional = lang.find(l => l.key !== 'English' && l.lift >= 1.2);
  if (regional) insights.push({ kind: 'try', dimension: 'language', key: regional.key, strength: 35 + regional.lift,
    title: `Test more ${regional.key} captions`, detail: `${regional.posts} posts in ${regional.key} reached ${fmt(regional.lift)} your usual engagement. Run a two-week test with one in three posts in ${regional.key}.` });
  void format;
  if (!insights.some(i => i.kind === 'try') && rated.length >= 6) insights.push({ kind: 'try', strength: 1, title: 'Run a two-week content test', detail: 'No clear winner yet. Alternate two themes on the same days and times so the comparison is fair.' });
  insights.sort((a, b) => b.strength - a.strength);

  const platforms = [...new Set(scored.map(p => p.platform))];
  return {
    windowDays, posts: scored.length,
    lowAudience: scored.filter(p => p.engagement === null && (p.reach ?? p.views ?? null) !== null).length,
    byPlatform: platforms.map(pl => {
      const ps = scored.filter(p => p.platform === pl);
      const es = ps.filter(p => p.engagement !== null).map(p => p.engagement!);
      return { platform: pl, posts: ps.length, views: ps.reduce((s, p) => s + n0(p.views), 0), interactions: ps.reduce((s, p) => s + p.interactions, 0), medianEngagement: es.length ? median(es) : null };
    }),
    segments: segments.sort((a, b) => b.lift - a.lift),
    insights,
    top: [...rated].sort((a, b) => b.lift! - a.lift!).slice(0, 5),
    bottom: [...rated].sort((a, b) => a.lift! - b.lift!).slice(0, 5),
  };
}
