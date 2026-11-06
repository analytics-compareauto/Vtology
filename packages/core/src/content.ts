/**
 * Content intelligence, the parts of a creator tool that help a brand grow:
 * - outliers: posts that did several times their own account's usual (brand and competitors alike)
 * - category patterns: which themes and formats produce those outliers more often than they're posted
 * - topic demand: what people search on YouTube, how much the top videos get watched, who ranks
 * - video checks: the basics of a findable, watchable YouTube video, each with its fix
 *
 * Every comparison is against the account's own history or the search results themselves; no
 * outside benchmarks.
 */
import { themesOf, labelOf, type SocialPost } from './social';
import type { Industry } from './modules';

const DAY = 86_400_000;
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2) : 0; };

export interface ContentAccount { id: string; platform: string; name: string; handle?: string | null; followers?: number | null; isCompetitor: boolean }

/** The number a post is judged on: what the platform shows publicly, so brand and competitors compare fairly. */
export function outlierMetric(p: SocialPost): { value: number; name: string } | null {
  if (p.platform === 'youtube') return p.views ? { value: p.views, name: 'views' } : null;
  const inter = (p.likes ?? 0) + (p.comments ?? 0) + (p.platform === 'facebook' ? p.shares ?? 0 : 0);
  return inter > 0 ? { value: inter, name: 'likes and comments' } : null;
}

export interface Outlier { post: SocialPost; account: ContentAccount; score: number; value: number; metric: string; usual: number; ageDays: number; themes: string[] }

/**
 * Posts that did at least `min`× the median of their own account's posts (from the last 180 days,
 * at least 3 days old so they've had time). Accounts with under 8 such posts are skipped.
 */
export function findOutliers(posts: SocialPost[], accounts: ContentAccount[], industry: Industry, now: Date, opts: { from: Date; to: Date; min?: number }): Outlier[] {
  const min = opts.min ?? 2.5;
  const byAcc = new Map<string, SocialPost[]>();
  for (const p of posts) (byAcc.get(p.accountId) ?? byAcc.set(p.accountId, []).get(p.accountId)!).push(p);
  const out: Outlier[] = [];
  for (const a of accounts) {
    const ps = byAcc.get(a.id) ?? [];
    const settled = ps.filter(p => now.getTime() - p.postedAt.getTime() >= 3 * DAY && now.getTime() - p.postedAt.getTime() <= 180 * DAY).map(p => outlierMetric(p)?.value).filter((v): v is number => !!v);
    if (settled.length < 8) continue;
    const usual = median(settled);
    if (usual <= 0) continue;
    for (const p of ps) {
      if (p.postedAt < opts.from || p.postedAt > opts.to) continue;
      const m = outlierMetric(p);
      const age = (now.getTime() - p.postedAt.getTime()) / DAY;
      if (!m || age < 2) continue;
      const score = m.value / usual;
      if (score >= min) out.push({ post: p, account: a, score, value: m.value, metric: m.name, usual, ageDays: Math.floor(age), themes: themesOf(industry, p.caption) });
    }
  }
  return out.sort((x, y) => y.score - x.score);
}

export interface Pattern { kind: 'theme' | 'format'; key: string; label: string; outliers: number; posts: number; outlierShare: number; postShare: number; ratio: number; byCompetitors: number }

/** Themes and formats that turn up among outliers more often than they're posted, across every tracked account. */
export function outlierPatterns(posts: SocialPost[], outliers: Outlier[], industry: Industry, opts: { from: Date; to: Date }): Pattern[] {
  const inRange = posts.filter(p => p.postedAt >= opts.from && p.postedAt <= opts.to && outlierMetric(p));
  if (outliers.length < 4 || inRange.length < 20) return [];
  const tally = (get: (p: SocialPost) => string[]) => {
    const all = new Map<string, number>(), hit = new Map<string, number>(), comp = new Map<string, number>();
    for (const p of inRange) for (const k of get(p)) all.set(k, (all.get(k) ?? 0) + 1);
    for (const o of outliers) for (const k of get(o.post)) { hit.set(k, (hit.get(k) ?? 0) + 1); if (o.account.isCompetitor) comp.set(k, (comp.get(k) ?? 0) + 1); }
    return { all, hit, comp };
  };
  const out: Pattern[] = [];
  for (const kind of ['theme', 'format'] as const) {
    const { all, hit, comp } = tally(kind === 'theme' ? p => themesOf(industry, p.caption) : p => [p.format]);
    for (const [key, n] of all) {
      const h = hit.get(key) ?? 0;
      if (h < 2 || n < 5) continue;
      const outlierShare = h / outliers.length, postShare = n / inRange.length;
      out.push({ kind, key, label: kind === 'theme' ? labelOf(industry, 'theme', key) : formatLabel(key), outliers: h, posts: n, outlierShare, postShare, ratio: outlierShare / postShare, byCompetitors: comp.get(key) ?? 0 });
    }
  }
  return out.filter(p => p.ratio >= 1.2).sort((a, b) => b.ratio - a.ratio).slice(0, 8);
}
const formatLabel = (f: string) => ({ reel: 'Reels', video: 'Long videos', short: 'Shorts', image: 'Single images', carousel: 'Carousels', text: 'Text posts', link: 'Link posts', live: 'Live' }[f] ?? f);

// ---------------------------------------------------------------- topics (YouTube search)
export interface TopicVideo { id: string; title: string; channelId: string; channel: string; publishedAt: string; views: number; channelSubscribers: number | null }
export interface TopicResult {
  scannedAt: string; videos: TopicVideo[];
  /** views a day the top 10 results get together: how much people watch this topic */
  demand: number;
  /** median age of the top 10, in days: old results leave room for something new */
  medianAgeDays: number;
  /** share of the top 10 from channels bigger than the brand's */
  biggerChannels: number | null;
  /** share of the top 10 from channels near the brand's size (up to 5× its subscribers, or 50K): proof that a channel like it can rank */
  nearSize: number | null;
  ownRank: number | null;
  competitorRanks: { name: string; rank: number }[];
  opportunity: number;
}

/** Score one search: demand, how stale the top results are, and how much bigger the channels ranking are. */
export function scoreTopic(videos: TopicVideo[], now: Date, own: { channelIds: string[]; subscribers: number | null }, competitors: { channelId: string; name: string }[]): TopicResult {
  const top = videos.slice(0, 10);
  const age = (v: TopicVideo) => Math.max(1, (now.getTime() - Date.parse(v.publishedAt)) / DAY);
  const demand = top.reduce((a, v) => a + v.views / age(v), 0);
  const medianAgeDays = Math.round(median(top.map(age)));
  const known = top.filter(v => v.channelSubscribers !== null && !own.channelIds.includes(v.channelId));
  const biggerChannels = own.subscribers && known.length ? known.filter(v => v.channelSubscribers! > own.subscribers!).length / known.length : null;
  const near = own.subscribers !== null ? Math.max(own.subscribers * 5, 50_000) : null;
  const nearSize = near !== null && known.length ? known.filter(v => v.channelSubscribers! <= near).length / known.length : null;
  const rankOf = (id: string) => { const i = videos.findIndex(v => v.channelId === id); return i >= 0 ? i + 1 : null; };
  const ownRanks = own.channelIds.map(rankOf).filter((r): r is number => r !== null);
  const competitorRanks = competitors.map(c => ({ name: c.name, rank: rankOf(c.channelId) })).filter((c): c is { name: string; rank: number } => c.rank !== null).sort((a, b) => a.rank - b.rank);
  // 0-100: demand on a log scale, more when the top results are old, and more when channels near the brand's size already rank
  const d = Math.min(1, Math.log10(1 + demand) / 5); // 100,000 views a day = full marks
  const stale = Math.min(1, medianAgeDays / 365);
  const room = nearSize ?? (biggerChannels !== null ? 1 - biggerChannels : 0.3);
  const opportunity = Math.round(100 * d * (0.5 + 0.25 * stale + 0.25 * Math.min(1, room * 2.5)));
  return { scannedAt: now.toISOString(), videos: videos.slice(0, 20), demand, medianAgeDays, biggerChannels, nearSize, ownRank: ownRanks.length ? Math.min(...ownRanks) : null, competitorRanks, opportunity };
}

/** Starting topics per industry, for a brand to keep, edit or drop. */
export const DEFAULT_TOPICS: Record<Industry, string[]> = {
  Automotive: ['best suv under 15 lakh', 'best car under 10 lakh', 'ev range test india', 'car on road price', 'best mileage car india', 'compact suv comparison', 'car loan emi', 'new car launch 2026'],
  BFSI: ['best credit card india', 'home loan interest rate', 'how to improve cibil score', 'term insurance explained', 'personal loan emi', 'mutual fund sip for beginners'],
  FMCG: ['healthy breakfast ideas', 'skincare routine india', 'best shampoo for hair fall', 'easy dinner recipes', 'protein snacks india', 'diwali gift ideas'],
};

/** The words of a search phrase that carry its meaning (generic ones like "best" and "india" dropped). */
export function topicWords(phrase: string): string[] {
  const stop = new Set(['best', 'india', 'indian', 'under', 'the', 'and', 'for', 'top', 'with', 'how', 'what', 'which', 'vs', 'new', 'all', 'you', 'your']);
  return [...new Set(phrase.toLowerCase().split(/[^a-z0-9₹]+/).filter(w => w.length > 2 && !stop.has(w)))];
}
/** A caption is about a topic when it carries most of the topic's words (two, or all when there are fewer). */
export function aboutTopic(phrase: string, caption: string | null): boolean {
  const w = topicWords(phrase);
  if (!w.length || !caption) return false;
  const text = ` ${caption.toLowerCase().replace(/#/g, ' ').replace(/[^a-z0-9₹]+/g, ' ')} `;
  return w.filter(x => text.includes(` ${x} `) || text.includes(` ${x}s `)).length >= Math.min(2, w.length);
}

// ---------------------------------------------------------------- video checks
export interface VideoCheck { id: string; label: string; pass: boolean; fix: string }

/** The basics a YouTube video needs to be found and watched, read from its title, description and numbers. */
export function videoChecks(v: { title: string; description: string; durationS: number | null; avgViewPct: number | null; format: string; views?: number | null }, ctx: { topics: string[]; usualViewPct: number | null; brandDomains: string[] }): VideoCheck[] {
  const d = v.description ?? '';
  // hashtags in a title (usual on Shorts) don't count towards what reads in search
  const t = v.title.replace(/#[\p{L}\d_]+/gu, '').replace(/\s+/g, ' ').trim();
  const words = (s: string) => s.toLowerCase().split(/[^a-z0-9₹]+/).filter(w => w.length > 2);
  const titleWords = new Set(words(t));
  const topicHit = ctx.topics.find(tp => { const w = words(tp).filter(x => !['best', 'india', 'under', 'the', 'and', 'for'].includes(x)); return w.length && w.filter(x => titleWords.has(x)).length >= Math.min(2, w.length); });
  const links = d.match(/https?:\/\/\S+/g) ?? [];
  const brandLinks = ctx.brandDomains.length ? links.filter(l => ctx.brandDomains.some(dm => l.includes(dm))) : links;
  const stamps = (d.match(/(^|\n)\s*\(?\d{1,2}:\d{2}(:\d{2})?\)?\s/g) ?? []).length;
  const hashtags = (`${v.title} ${d}`.match(/#[\p{L}\d_]+/gu) ?? []).length;
  const long = (v.durationS ?? 0) > 180;
  const checks: VideoCheck[] = [
    { id: 'title_length', label: 'Title fits in search results', pass: t.length >= 20 && t.length <= 70, fix: t.length > 70 ? `Shorten the title to under 70 characters (it is ${t.length}, hashtags aside); the end gets cut off in search and suggestions.` : `Make the title say what the viewer gets, in 20 to 70 characters (it is ${t.length}, hashtags aside).` },
    { id: 'topic', label: 'Title uses words people search', pass: !ctx.topics.length || !!topicHit, fix: ctx.topics.length ? `Work a tracked search phrase into the title, for example "${ctx.topics[0]}".` : '' },
    { id: 'link', label: 'Description links to the brand site', pass: brandLinks.length > 0, fix: 'Add a link to the relevant page in the first two lines of the description.' },
    { id: 'utm', label: 'That link is tagged for tracking', pass: brandLinks.some(l => /[?&]utm_/.test(l)), fix: 'Add utm_source=youtube&utm_medium=organic&utm_campaign=<video> to the link, so leads from this video can be counted.' },
    { id: 'hashtags', label: 'A few relevant hashtags', pass: hashtags >= 1 && hashtags <= 5, fix: hashtags > 5 ? `Use three to five specific hashtags (the model, the brand, the topic) instead of ${hashtags}; generic ones such as #viral or #fyp don't help people find the video.` : 'Add three to five specific hashtags: the model, the brand, the topic.' },
  ];
  if (long) checks.push({ id: 'chapters', label: 'Chapters for a long video', pass: stamps >= 3, fix: 'Add chapters: timestamps in the description starting at 0:00, at least three. They help viewers jump to what they came for and appear in search.' });
  if (v.avgViewPct !== null && ctx.usualViewPct && (v.views ?? 0) >= 100) checks.push({ id: 'retention', label: 'Viewers stay as long as usual', pass: v.avgViewPct >= ctx.usualViewPct * 0.8, fix: `Viewers watch ${Math.round(v.avgViewPct)}% on average against your usual ${Math.round(ctx.usualViewPct)}%. Open the retention curve to see where they leave, and tighten the opening.` });
  return checks.filter(c => c.fix || c.pass);
}

// ---------------------------------------------------------------- trending searches

/** Words a category's searches start from; each is expanded through YouTube's own suggestions. */
export const TREND_SEEDS: Record<Industry, string[]> = {
  Automotive: ['new car', 'best car', 'best suv', 'electric car', 'ev', 'car price', 'on road price', 'upcoming cars', 'car review', 'car comparison', 'mileage car', 'car vs', 'bike', 'scooter', 'electric scooter', 'car loan', 'cng car', 'hybrid car', 'automatic car', 'family car'],
  BFSI: ['credit card', 'home loan', 'personal loan', 'cibil score', 'term insurance', 'health insurance', 'mutual fund', 'sip', 'fd interest rate', 'stock market', 'gold loan', 'upi', 'income tax', 'car insurance'],
  FMCG: ['skincare', 'hair fall', 'shampoo', 'face wash', 'breakfast recipe', 'healthy snacks', 'protein', 'diwali gift', 'perfume', 'sunscreen', 'dinner recipe', 'weight loss drink'],
};
export const TREND_SUFFIXES = ['', ' 2026', ' vs', ' price', ' under', ' best', ' new'];

const THEMES: [string, RegExp][] = [
  ['Comparison', /\bvs\b|versus|compar/],
  ['Electric', /\bev\b|electric|charging|range|battery/],
  ['Mileage', /mileage|kmpl|fuel|cng|hybrid/],
  ['Finance', /loan|insurance|interest|credit|finance|emi\b/],
  ['Launch', /launch|upcoming|coming|new (car|suv|bike|model)/],
  ['Review', /review|test|drive|experience|problem/],
  ['Price', /price|lakh|cost|₹|cheap|budget|under \d|showroom/],
];
export function trendTheme(phrase: string): string { return THEMES.find(([, re]) => re.test(phrase))?.[0] ?? 'Other'; }

export interface TrendItem { phrase: string; score: number; theme: string; rank: number; previousRank: number | null; seeds: number }

/**
 * Rank phrases from many suggestion lists: YouTube orders its suggestions by how much people search them,
 * so a phrase scores higher the nearer the top it shows and the more lists it shows in. Phrases with a
 * single word, or another brand's channel name only, are left out. Compared with the last run to show
 * what's new or climbing.
 */
export function rankTrends(lists: { seed: string; suggestions: string[] }[], previous: { phrase: string; rank: number }[] = [], limit = 100): TrendItem[] {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const acc = new Map<string, { score: number; seeds: Set<string> }>();
  for (const l of lists) l.suggestions.forEach((s, i) => {
    const p = norm(s);
    if (p.split(' ').length < 2 || p.length > 80) return;
    const e = acc.get(p) ?? { score: 0, seeds: new Set<string>() };
    e.score += 1 - i / Math.max(10, l.suggestions.length);
    e.seeds.add(norm(l.seed));
    acc.set(p, e);
  });
  const prev = new Map(previous.map(p => [p.phrase, p.rank]));
  const all = [...acc.entries()].map(([phrase, e]) => ({ phrase, raw: e.score * (1 + 0.15 * (e.seeds.size - 1)), seeds: e.seeds.size }))
    .sort((a, b) => b.raw - a.raw || a.phrase.localeCompare(b.phrase)).slice(0, limit);
  const top = all[0]?.raw || 1;
  return all.map((x, i) => ({ phrase: x.phrase, score: Math.max(1, Math.round((x.raw / top) * 100)), theme: trendTheme(x.phrase), rank: i + 1, previousRank: prev.get(x.phrase) ?? null, seeds: x.seeds }));
}
