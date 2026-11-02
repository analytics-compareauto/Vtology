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
  thumbnailUrl?: string | null;
  views?: number | null; reach?: number | null; likes?: number | null; comments?: number | null; shares?: number | null; saves?: number | null;
  watchMinutes?: number | null; avgViewPct?: number | null;
}
export interface SocialAccount { id: string; platform: SocialPost['platform']; name: string; handle?: string | null; followers?: number | null }

export type Dimension = 'theme' | 'format' | 'time' | 'day' | 'language' | 'length';
export interface Segment { dimension: Dimension; key: string; label: string; posts: number; share: number; lift: number; medianEngagement: number }
export interface Insight { kind: 'working' | 'not_working' | 'try'; title: string; detail: string; dimension?: Dimension; key?: string; strength: number; platform?: string; lift?: number; posts?: number; early?: boolean }
export interface ScoredPost extends SocialPost { interactions: number; engagement: number | null; lift: number | null; themes: string[]; timeBand: string; dayType: string; language: string; lengthBand: string }
export interface PlatformSummary {
  platform: string; posts: number; interactions: number;
  /** Totals only over posts where the platform reports the number; null when it reports none. */
  views: number | null; reach: number | null; viewsPosts: number; reachPosts: number;
  medianEngagement: number | null;
}
/** What the posts of one platform (or all together) say: groups compared with the account's typical post, and what to do. */
export interface SocialView { platform: string | null; rated: number; segments: Segment[]; insights: Insight[]; top: ScoredPost[]; bottom: ScoredPost[] }
export interface SocialAnalysis {
  windowDays: number;
  posts: number;
  /** Week by week, per platform. Weeks start Monday, IST. */
  weekly: { week: string; platform: string; posts: number; interactions: number; views: number; reach: number }[];
  /** Posts left out of comparisons because too few people saw them for a ratio to mean anything. */
  lowAudience: number;
  byPlatform: PlatformSummary[];
  /** All platforms together (insights are each platform's own, labelled with the platform). */
  segments: Segment[];
  insights: Insight[];
  top: ScoredPost[];
  bottom: ScoredPost[];
  /** The same, one platform at a time. */
  perPlatform: Record<string, SocialView>;
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
  // the follower count is only a fair stand-in when it is big enough not to turn a few likes into a huge rate
  const reliable = base >= MIN_AUDIENCE;
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
const pctOf = (x: number) => `${Math.round(x * 100)}%`;

const PLATFORM_NAME: Record<string, string> = { instagram: 'Instagram', facebook: 'Facebook', youtube: 'YouTube', linkedin: 'LinkedIn' };

/** "60% more engagement than your typical Instagram post", "2.3× the engagement of…", "40% less engagement than…" */
export function liftPhrase(lift: number, platform: string | null): string {
  const typical = platform ? `your typical ${PLATFORM_NAME[platform] ?? platform} post` : 'your typical post';
  if (lift >= 2) return `${fmt(lift)} the engagement of ${typical}`;
  const d = Math.round(Math.abs(lift - 1) * 100);
  if (d < 5) return `about the same engagement as ${typical}`;
  return `${d}% ${lift >= 1 ? 'more' : 'less'} engagement than ${typical}`;
}

function viewOf(industry: Industry, rated: ScoredPost[], platform: string | null): SocialView {
  const pl = platform ? PLATFORM_NAME[platform] ?? platform : null;
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
  const of = pl ? ` ${pl}` : '';
  const meaningful = segments.filter(s => !(s.dimension === 'theme' && s.key === 'other'));
  const best = (d: Dimension) => meaningful.filter(s => s.dimension === d).sort((a, b) => b.lift - a.lift);
  for (const s of meaningful) {
    const base = { dimension: s.dimension, key: s.key, platform: platform ?? undefined, lift: s.lift, posts: s.posts, early: s.posts < SOLID_POSTS };
    if (s.lift >= 1.3) insights.push({ ...base, kind: 'working', strength: s.lift * Math.sqrt(s.posts),
      title: `${s.label} get ${liftPhrase(s.lift, platform)}`,
      detail: `Based on ${s.posts}${of} posts, ${pctOf(s.share)} of what you post${pl ? ` there` : ''}.${s.share < 0.2 ? ' There is room to do more.' : ''}` });
    if (s.lift <= 0.75) insights.push({ ...base, kind: 'not_working', strength: (1 / Math.max(s.lift, 0.05)) * Math.sqrt(s.posts),
      title: `${s.label} get ${liftPhrase(s.lift, platform)}`,
      detail: `Based on ${s.posts}${of} posts, ${pctOf(s.share)} of what you post${pl ? ' there' : ''}.${s.share >= 0.25 ? ' A large share of your effort is going here.' : ''}` });
  }
  const theme = best('theme'), time = best('time'), lang = best('language');
  const top = theme.find(t => t.posts >= 6);
  if (top && top.lift >= 1.3 && top.share < 0.3) insights.push({ kind: 'try', dimension: 'theme', key: top.key, platform: platform ?? undefined, lift: top.lift, posts: top.posts, strength: 50 + top.lift,
    title: `${pl ? `On ${pl}, make` : 'Make'} ${top.label.toLowerCase()} at least 1 in 4 posts`,
    detail: `They are ${pctOf(top.share)} of your${of} posts today and get ${liftPhrase(top.lift, platform)}.` });
  // format advice only within one platform (a text post on Facebook and a short on YouTube are not a fair fight)
  if (platform) {
    const fs = best('format');
    if (fs.length >= 2) {
      const hi = fs[0]!, lo = fs[fs.length - 1]!, ratio = hi.lift / Math.max(lo.lift, 0.01);
      if (ratio >= 1.5) insights.push({ kind: 'try', dimension: 'format', key: hi.key, platform, lift: hi.lift, posts: hi.posts, strength: 40 + ratio,
        title: `On ${pl}, post more ${hi.label.toLowerCase()} and fewer ${lo.label.toLowerCase()}`,
        detail: `${hi.label} get ${fmt(ratio)} the engagement of ${lo.label.toLowerCase()} on ${pl} (${hi.posts} and ${lo.posts} posts).` });
    }
  }
  if (time.length >= 2 && time[0]!.lift >= 1.15) insights.push({ kind: 'try', dimension: 'time', key: time[0]!.key, platform: platform ?? undefined, lift: time[0]!.lift, posts: time[0]!.posts, strength: 30 + time[0]!.lift,
    title: `${pl ? `On ${pl}, schedule` : 'Schedule'} more posts for ${time[0]!.label.toLowerCase().replace(/ \(.*\)/, '')}`,
    detail: `${time[0]!.label}: ${liftPhrase(time[0]!.lift, platform)}. ${time[time.length - 1]!.label}: ${liftPhrase(time[time.length - 1]!.lift, platform)}.` });
  const regional = lang.find(l => l.key !== 'English' && l.lift >= 1.2);
  if (regional) insights.push({ kind: 'try', dimension: 'language', key: regional.key, platform: platform ?? undefined, lift: regional.lift, posts: regional.posts, strength: 35 + regional.lift,
    title: `${pl ? `On ${pl}, test` : 'Test'} more ${regional.key} captions`,
    detail: `${regional.posts} posts in ${regional.key} got ${liftPhrase(regional.lift, platform)}. Try one in three posts in ${regional.key} for two weeks.` });
  insights.sort((a, b) => b.strength - a.strength);
  return {
    platform, rated: rated.length, segments: segments.sort((a, b) => b.lift - a.lift), insights,
    top: [...rated].sort((a, b) => b.lift! - a.lift!).slice(0, 6),
    bottom: [...rated].sort((a, b) => a.lift! - b.lift!).slice(0, 6),
  };
}

export function analyzeSocial(industry: Industry, accounts: SocialAccount[], posts: SocialPost[], now: Date, windowDays = 180): SocialAnalysis {
  const since = now.getTime() - windowDays * 86_400_000;
  const inWindow = posts.filter(p => p.postedAt.getTime() >= since);
  const acc = new Map(accounts.map(a => [a.id, a]));
  const scored0 = inWindow.map(p => score(industry, p, acc.get(p.accountId)?.followers));
  // lift: engagement relative to the same account's median, so platforms and account sizes are comparable
  const accMedian = new Map<string, number>();
  for (const a of accounts) accMedian.set(a.id, median(scored0.filter(p => p.accountId === a.id && p.engagement !== null).map(p => p.engagement!)));
  const scored: ScoredPost[] = scored0.map(p => {
    const m = accMedian.get(p.accountId) ?? 0;
    return { ...p, lift: p.engagement !== null && m > 0 ? p.engagement / m : null };
  });
  const rated = scored.filter(p => p.lift !== null);
  const platforms = [...new Set(scored.map(p => p.platform))];

  const perPlatform: Record<string, SocialView> = {};
  for (const pl of platforms) perPlatform[pl] = viewOf(industry, rated.filter(p => p.platform === pl), pl);
  const all = viewOf(industry, rated, null);
  // across platforms, the advice is each platform's own (labelled), strongest first
  const insights = Object.values(perPlatform).flatMap(v => v.insights).sort((a, b) => b.strength - a.strength);
  if (!insights.some(i => i.kind === 'try') && rated.length >= 6) insights.push({ kind: 'try', strength: 1, title: 'Run a two-week content test', detail: 'No clear winner yet. Alternate two themes on the same days and times so the comparison is fair.' });

  return {
    windowDays, posts: scored.length,
    lowAudience: scored.filter(p => p.engagement === null).length,
    weekly: weeklyOf(scored),
    byPlatform: platforms.map(pl => {
      const ps = scored.filter(p => p.platform === pl);
      const es = ps.filter(p => p.engagement !== null).map(p => p.engagement!);
      const withViews = ps.filter(p => typeof p.views === 'number'), withReach = ps.filter(p => typeof p.reach === 'number');
      return { platform: pl, posts: ps.length, interactions: ps.reduce((s, p) => s + p.interactions, 0),
        views: withViews.length ? withViews.reduce((s, p) => s + n0(p.views), 0) : null, reach: withReach.length ? withReach.reduce((s, p) => s + n0(p.reach), 0) : null,
        viewsPosts: withViews.length, reachPosts: withReach.length, medianEngagement: es.length ? median(es) : null };
    }),
    segments: all.segments, insights, top: all.top, bottom: all.bottom, perPlatform,
  };
}

/** Monday (IST) of the week a post went out, as YYYY-MM-DD. */
export function weekOf(d: Date): string {
  const ist = new Date(d.getTime() + 330 * 60_000);
  const dow = (ist.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() - dow)).toISOString().slice(0, 10);
}

function weeklyOf(posts: ScoredPost[]): SocialAnalysis['weekly'] {
  const m = new Map<string, SocialAnalysis['weekly'][number]>();
  for (const p of posts) {
    const week = weekOf(p.postedAt), k = `${week}|${p.platform}`;
    const w = m.get(k) ?? { week, platform: p.platform, posts: 0, interactions: 0, views: 0, reach: 0 };
    w.posts++; w.interactions += p.interactions; w.views += n0(p.views); w.reach += n0(p.reach);
    m.set(k, w);
  }
  return [...m.values()].sort((a, b) => a.week.localeCompare(b.week) || a.platform.localeCompare(b.platform));
}
