/**
 * Growth and benchmarking. Pure functions over the brand's own accounts, the competitors it tracks,
 * their posts and a daily follower history.
 *
 * Competitors are compared on what every platform shows publicly: followers, posts, likes and
 * comments (plus views on YouTube). Engagement is measured per follower ("engagement rate by
 * followers"), the industry-standard way to compare accounts of different sizes, and every post is
 * also compared with its own account's typical post, so a big account doesn't drown out a small one.
 */
import type { Industry } from './modules';
import { labelOf, themesOf, timeBandOf, type Dimension } from './social';

export interface GAccount { id: string; platform: string; name: string; handle: string | null; followers: number | null; isCompetitor: boolean; profileUrl?: string | null }
export interface GPost { id: string; accountId: string; platform: string; postedAt: Date; format: string; caption: string | null; permalink?: string | null; thumbnailUrl?: string | null;
  likes?: number | null; comments?: number | null; shares?: number | null; saves?: number | null; views?: number | null; reach?: number | null; watchMinutes?: number | null }
export interface GDaily { accountId: string; day: string; followers: number | null; newFollowers?: number | null }
export type Period = 'week' | 'month' | 'quarter';
/** A date range, both ends included, as YYYY-MM-DD (IST calendar days). */
export interface DateRange { from: string; to: string }

export interface PeriodNumbers { posts: number; interactions: number; views: number | null; reach: number | null; watchHours: number | null; newFollowers: number | null; engagementPerPost: number | null }
export interface PeriodCompare { label: string; days: number; from: string; to: string; prevFrom: string; now: PeriodNumbers; before: PeriodNumbers; followersNow: number | null; followersBefore: number | null }
export interface BenchRow {
  accountId: string; name: string; handle: string | null; platform: string; isYou: boolean; followers: number | null;
  /** follower change over the tracked days (null until there are 2 snapshots at least 6 days apart) */
  growth: number | null; growthDays: number;
  postsPerWeek: number; erPerPost: number | null; interactionsPerPost: number | null; topFormat: string | null; topFormatShare: number | null;
  /** share of all public interactions in the set over the last 30 days */
  shareOfVoice: number;
  /** false when this account is over 10× bigger or smaller than the median account in the set */
  comparable: boolean;
}
export interface Trend { dimension: Dimension; key: string; label: string; platform: string; liftRecent: number | null; liftBefore: number | null; shareRecent: number; shareBefore: number; postsRecent: number; yourShare: number; yourPosts: number; status: 'rising' | 'falling' | 'steady' }
export interface Tag { tag: string; posts: number; accounts: number; lift: number | null }
export interface IndustryPost extends GPost { accountName: string; handle: string | null; isYou: boolean; lift: number | null; engagement: number }
export interface Action { title: string; why: string; evidence: string; platform?: string; impact: 'high' | 'medium' }
export interface GrowthReport {
  period: PeriodCompare;
  followerSeries: { accountId: string; points: { day: string; followers: number }[] }[];
  newFollowersWeekly: { week: string; accountId: string; newFollowers: number }[];
  benchmark: Record<string, BenchRow[]>;
  trends: Record<string, Trend[]>;
  hashtags: Record<string, Tag[]>;
  topPosts: Record<string, IndustryPost[]>;
  plan: Action[];
  competitorCount: number;
}

const DAY = 86_400_000;
const PERIOD_DAYS: Record<Period, number> = { week: 7, month: 30, quarter: 90 };
const PL: Record<string, string> = { instagram: 'Instagram', facebook: 'Facebook', youtube: 'YouTube', linkedin: 'LinkedIn' };
const n0 = (x: number | null | undefined) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
const median = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
/** Likes and comments: the interactions every platform shows publicly, so competitors compare fairly. */
export const publicEngagement = (p: GPost) => n0(p.likes) + n0(p.comments);
const allInteractions = (p: GPost) => n0(p.likes) + n0(p.comments) + n0(p.shares) + n0(p.saves);
const pctTxt = (x: number) => `${Math.round(x * 100)}%`;
const times = (x: number) => (x >= 10 ? `${Math.round(x)}×` : `${x.toFixed(1)}×`);

function periodNumbers(posts: GPost[], daily: GDaily[], ownIds: Set<string>, from: number, to: number): PeriodNumbers {
  const ps = posts.filter(p => ownIds.has(p.accountId) && p.postedAt.getTime() >= from && p.postedAt.getTime() < to);
  const withViews = ps.filter(p => typeof p.views === 'number'), withReach = ps.filter(p => typeof p.reach === 'number'), withWatch = ps.filter(p => typeof p.watchMinutes === 'number');
  const nf = daily.filter(d => ownIds.has(d.accountId) && typeof d.newFollowers === 'number' && Date.parse(d.day) >= from && Date.parse(d.day) < to);
  const interactions = ps.reduce((s, p) => s + allInteractions(p), 0);
  return {
    posts: ps.length, interactions,
    views: withViews.length ? withViews.reduce((s, p) => s + n0(p.views), 0) : null,
    reach: withReach.length ? withReach.reduce((s, p) => s + n0(p.reach), 0) : null,
    watchHours: withWatch.length ? withWatch.reduce((s, p) => s + n0(p.watchMinutes), 0) / 60 : null,
    // only when the platform reported most days of the period; a partial sum would fake a huge change
    newFollowers: new Set(nf.map(d => d.day)).size >= Math.ceil(((to - from) / DAY) * 0.7) ? nf.reduce((s, d) => s + n0(d.newFollowers), 0) : null,
    engagementPerPost: ps.length ? interactions / ps.length : null,
  };
}

/** Followers on or just before a day, from the daily history. */
function followersAt(daily: GDaily[], accountId: string, t: number): number | null {
  let best: GDaily | null = null;
  for (const d of daily) if (d.accountId === accountId && d.followers !== null && Date.parse(d.day) <= t && (!best || d.day > best.day)) best = d;
  return best?.followers ?? null;
}

/** 'month' and friends as a range ending today. */
export function rangeOf(period: Period | DateRange, now: Date): DateRange {
  if (typeof period === 'object') return period;
  const to = iso(now.getTime());
  return { from: iso(Date.parse(to) - (PERIOD_DAYS[period] - 1) * DAY), to };
}
const fmtDay = (iso: string) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

export function growthReport(industry: Industry, accounts: GAccount[], posts: GPost[], daily: GDaily[], now: Date, period: Period | DateRange = 'month', platformFilter: string | null = null): GrowthReport {
  // the selected dates: everything on the page is measured inside them, against the same length before
  const range = rangeOf(period, now);
  const start = Date.parse(range.from), T = Date.parse(range.to) + DAY;
  const days = Math.max(1, Math.round((T - start) / DAY));
  const label = `${fmtDay(range.from)} to ${fmtDay(range.to)}`;
  const isCurrent = T >= now.getTime() - DAY;
  const inScope = (pl: string) => !platformFilter || pl === platformFilter;
  const accs = accounts.filter(a => inScope(a.platform));
  const accIds = new Set(accs.map(a => a.id));
  const ps = posts.filter(p => accIds.has(p.accountId));
  const own = accs.filter(a => !a.isCompetitor), ownIds = new Set(own.map(a => a.id));
  const acc = new Map(accs.map(a => [a.id, a]));

  // ---- period against the one before
  const from = start, prevFrom = start - days * DAY;
  const followersNow = isCurrent ? own.reduce<number | null>((s, a) => (a.followers === null ? s : n0(s) + a.followers), null)
    : (() => { const xs = own.map(a => followersAt(daily, a.id, T - DAY)); return xs.every(x => x === null) ? null : xs.reduce<number>((t, x) => t + n0(x), 0); })();
  const before = own.map(a => followersAt(daily, a.id, from));
  const followersBefore = before.every(x => x === null) ? null : before.reduce<number>((s, x) => s + n0(x), 0);
  const periodCompare: PeriodCompare = {
    label, days, from: range.from, to: range.to, prevFrom: iso(prevFrom),
    now: periodNumbers(ps, daily, ownIds, from, T), before: periodNumbers(ps, daily, ownIds, prevFrom, from),
    followersNow, followersBefore,
  };

  // ---- follower history
  const followerSeries = accs.map(a => ({ accountId: a.id, points: daily.filter(d => d.accountId === a.id && d.followers !== null).sort((x, y) => x.day.localeCompare(y.day)).map(d => ({ day: d.day, followers: d.followers! })) }))
    .filter(s => s.points.length > 0);
  const nfw = new Map<string, number>();
  for (const d of daily) {
    if (!ownIds.has(d.accountId) || typeof d.newFollowers !== 'number') continue;
    const dt = new Date(Date.parse(d.day)); const dow = (dt.getUTCDay() + 6) % 7;
    const week = iso(Date.parse(d.day) - dow * DAY);
    nfw.set(`${week}|${d.accountId}`, (nfw.get(`${week}|${d.accountId}`) ?? 0) + d.newFollowers);
  }
  const newFollowersWeekly = [...nfw.entries()].map(([k, v]) => { const [week, accountId] = k.split('|'); return { week: week!, accountId: accountId!, newFollowers: v }; }).sort((a, b) => a.week.localeCompare(b.week));

  // ---- per post engagement per follower, and lift against the account's own typical post
  // (at least 120 days, so "usual" is stable even for a short range)
  const lookback = Math.max(120, days * 4);
  const recentPosts = ps.filter(p => p.postedAt.getTime() >= T - lookback * DAY && p.postedAt.getTime() < T);
  const inRange = (p: GPost) => p.postedAt.getTime() >= start && p.postedAt.getTime() < T;
  const er = (p: GPost) => { const f = acc.get(p.accountId)?.followers; return f && f >= 50 ? publicEngagement(p) / f : null; };
  const accMedian = new Map<string, number>();
  for (const a of accs) accMedian.set(a.id, median(recentPosts.filter(p => p.accountId === a.id && er(p) !== null).map(p => er(p)!)));
  const liftOf = (p: GPost) => { const e = er(p), m = accMedian.get(p.accountId) ?? 0; return e !== null && m > 0 ? e / m : null; };

  const platforms = [...new Set(accs.map(a => a.platform))];
  const benchmark: Record<string, BenchRow[]> = {}, trends: Record<string, Trend[]> = {}, hashtags: Record<string, Tag[]> = {}, topPosts: Record<string, IndustryPost[]> = {};
  for (const pl of platforms) {
    const plAccs = accs.filter(a => a.platform === pl);
    const plPosts = recentPosts.filter(p => p.platform === pl);
    const last30 = plPosts.filter(inRange);
    const voiceTotal = last30.reduce((s, p) => s + publicEngagement(p), 0);
    benchmark[pl] = plAccs.map(a => {
      const mine = plPosts.filter(p => p.accountId === a.id);
      const last28 = mine.filter(inRange);
      const ers = mine.map(er).filter((x): x is number => x !== null);
      const fmt = new Map<string, number>(); mine.forEach(p => fmt.set(p.format, (fmt.get(p.format) ?? 0) + 1));
      const top = [...fmt.entries()].sort((x, y) => y[1] - x[1])[0];
      const hist = daily.filter(d => d.accountId === a.id && d.followers !== null).sort((x, y) => x.day.localeCompare(y.day));
      const inHist = hist.filter(d => Date.parse(d.day) < T);
      const firstIn30 = inHist.find(d => Date.parse(d.day) >= start - DAY) ?? null, last = inHist[inHist.length - 1] ?? null;
      const growthDays = firstIn30 && last ? Math.round((Date.parse(last.day) - Date.parse(firstIn30.day)) / DAY) : 0;
      return {
        accountId: a.id, name: a.name, handle: a.handle, platform: pl, isYou: !a.isCompetitor, followers: a.followers,
        growth: firstIn30 && last && growthDays >= 6 && firstIn30.followers ? (last.followers! - firstIn30.followers) / firstIn30.followers : null, growthDays,
        postsPerWeek: last28.length / (days / 7), erPerPost: ers.length ? median(ers) : null,
        interactionsPerPost: mine.length ? median(mine.map(publicEngagement)) : null,
        topFormat: top ? labelOf(industry, 'format', top[0]) : null, topFormatShare: top && mine.length ? top[1] / mine.length : null,
        shareOfVoice: voiceTotal ? last30.filter(p => p.accountId === a.id).reduce((s, p) => s + publicEngagement(p), 0) / voiceTotal : 0,
        comparable: true,
      };
    }).sort((x, y) => n0(y.followers) - n0(x.followers));

    { const mf = median(benchmark[pl]!.map(r => n0(r.followers)).filter(x => x > 0));
      for (const r of benchmark[pl]!) r.comparable = !!r.followers && mf > 0 && mf / r.followers <= 10 && r.followers / mf <= 10; }

    // ---- what's rising: last 4 weeks against the 12 before, across everyone in the set
    // the selected dates against the three periods of the same length before them (at least 4 weeks)
    const recent = plPosts.filter(inRange), earlier = plPosts.filter(p => p.postedAt.getTime() < start && p.postedAt.getTime() >= start - Math.max(28, days * 3) * DAY);
    const youRecent = recent.filter(p => ownIds.has(p.accountId));
    const keysOf = (dim: Dimension, p: GPost): string[] => dim === 'theme' ? themesOf(industry, p.caption).filter(k => k !== 'other') : dim === 'format' ? [p.format] : [timeBandOf(p.postedAt)];
    const out: Trend[] = [];
    for (const dim of ['format', 'theme', 'time'] as Dimension[]) {
      const keys = new Set(plPosts.flatMap(p => keysOf(dim, p)));
      for (const key of keys) {
        const r = recent.filter(p => keysOf(dim, p).includes(key)), e = earlier.filter(p => keysOf(dim, p).includes(key));
        if (r.length + e.length < 4) continue;
        const lr = r.map(liftOf).filter((x): x is number => x !== null), le = e.map(liftOf).filter((x): x is number => x !== null);
        const liftRecent = lr.length >= 2 ? median(lr) : null, liftBefore = le.length >= 2 ? median(le) : null;
        const shareRecent = recent.length ? r.length / recent.length : 0, shareBefore = earlier.length ? e.length / earlier.length : 0;
        const y = youRecent.filter(p => keysOf(dim, p).includes(key));
        // rising: better engagement and not losing its place in what the industry posts
        const up = (liftRecent ?? 0) >= 1.1 && (shareRecent - shareBefore >= 0.05 || (liftBefore !== null && liftRecent! - liftBefore >= 0.2 && shareRecent >= shareBefore - 0.05));
        const down = (liftRecent !== null && liftRecent < 0.9 && (liftBefore === null || liftRecent < liftBefore)) || (shareBefore - shareRecent >= 0.08);
        out.push({ dimension: dim, key, label: labelOf(industry, dim, key), platform: pl, liftRecent, liftBefore, shareRecent, shareBefore, postsRecent: r.length,
          yourShare: youRecent.length ? y.length / youRecent.length : 0, yourPosts: y.length, status: up ? 'rising' : down ? 'falling' : 'steady' });
      }
    }
    trends[pl] = out.sort((a, b) => (a.status === 'rising' ? -1 : 0) - (b.status === 'rising' ? -1 : 0) || n0(b.liftRecent) - n0(a.liftRecent));

    // ---- hashtags the set used in the last 30 days
    const tags = new Map<string, { posts: GPost[]; accs: Set<string> }>();
    for (const p of last30) for (const t of new Set(((p.caption ?? '').toLowerCase().match(/#[\p{L}\p{N}_]{2,40}/gu) ?? []))) {
      const g = tags.get(t) ?? { posts: [], accs: new Set() }; g.posts.push(p); g.accs.add(p.accountId); tags.set(t, g);
    }
    hashtags[pl] = [...tags.entries()].filter(([, g]) => g.posts.length >= 2).map(([tag, g]) => {
      const ls = g.posts.map(liftOf).filter((x): x is number => x !== null);
      return { tag, posts: g.posts.length, accounts: g.accs.size, lift: ls.length ? median(ls) : null };
    }).sort((a, b) => b.accounts - a.accounts || b.posts - a.posts).slice(0, 15);

    topPosts[pl] = last30.map(p => ({ ...p, accountName: acc.get(p.accountId)!.name, handle: acc.get(p.accountId)!.handle, isYou: ownIds.has(p.accountId), lift: liftOf(p), engagement: publicEngagement(p) }))
      .filter(p => p.lift !== null).sort((a, b) => b.lift! - a.lift!).slice(0, 8);
  }

  // ---- the growth plan: concrete moves, each with the number behind it
  const plan: Action[] = [];
  for (const pl of platforms) {
    const rows = benchmark[pl]!, you = rows.find(r => r.isYou), comps = rows.filter(r => !r.isYou);
    if (!you || !comps.length) continue;
    const name = PL[pl] ?? pl;
    const compCadence = median(comps.map(c => c.postsPerWeek));
    if (compCadence >= 2 && you.postsPerWeek < compCadence * 0.6)
      plan.push({ platform: pl, impact: 'high', title: `Post more often on ${name}`, why: `Reach and new followers follow posting frequency. You post ${you.postsPerWeek.toFixed(1)} times a week; competitors post ${compCadence.toFixed(1)}.`, evidence: `${label}, ${comps.length} competitors` });
    const compGrowth = comps.map(c => c.growth).filter((x): x is number => x !== null);
    if (you.growth !== null && compGrowth.length && you.growth < median(compGrowth))
      plan.push({ platform: pl, impact: 'high', title: `${name} followers are growing slower than competitors`, why: `You grew ${pctTxt(you.growth)} over ${you.growthDays} days; competitors grew ${pctTxt(median(compGrowth))} (median).`, evidence: `Daily follower tracking` });
    const compEr = comps.map(c => c.erPerPost).filter((x): x is number => x !== null);
    // engagement per follower only compares fairly between accounts of similar size: a 200-follower
    // account whose posts reach non-followers shows a huge rate that means little
    const compF = median(comps.map(c => n0(c.followers)));
    const comparable = !!you.followers && compF > 0 && compF / you.followers <= 10 && you.followers / compF <= 10;
    if (comparable && you.erPerPost !== null && compEr.length && you.erPerPost > median(compEr) * 1.2 && you.postsPerWeek < compCadence)
      plan.push({ platform: pl, impact: 'medium', title: `Your ${name} posts land well: publish more of them`, why: `Each post gets ${(you.erPerPost * 100).toFixed(2)}% of followers engaging, against ${(median(compEr) * 100).toFixed(2)}% for competitors. More posts at that quality is the fastest route to growth.`, evidence: `Engagement per follower, ${lookback} days to ${fmtDay(range.to)}` });
    const rising = (trends[pl] ?? []).filter(t => t.status === 'rising' && t.dimension !== 'time');
    for (const t of rising.slice(0, 2)) {
      if (t.yourShare >= t.shareRecent * 0.8) continue;
      plan.push({ platform: pl, impact: 'high', title: `${t.label} are rising on ${name}: use them more`, why: `Across you and your competitors, ${t.label.toLowerCase()} went from ${pctTxt(t.shareBefore)} to ${pctTxt(t.shareRecent)} of posts (${label} against the period before), at ${times(t.liftRecent ?? 1)} the usual engagement. They are ${pctTxt(t.yourShare)} of your posts.`, evidence: `${t.postsRecent} posts, ${label}` });
    }
    const bestTime = (trends[pl] ?? []).filter(t => t.dimension === 'time' && t.liftRecent !== null && t.postsRecent >= 3).sort((a, b) => b.liftRecent! - a.liftRecent!)[0];
    if (bestTime && bestTime.liftRecent! >= 1.15)
      plan.push({ platform: pl, impact: 'medium', title: `On ${name}, post in the ${bestTime.label.toLowerCase().replace(/ \(.*\)/, '')}`, why: `Posts in the ${bestTime.label.toLowerCase()} get ${times(bestTime.liftRecent!)} the usual engagement across your industry set. ${pctTxt(bestTime.yourShare)} of your posts go out then.`, evidence: `IST, ${label}` });
    const tags = (hashtags[pl] ?? []).filter(t => t.accounts >= 2 && (t.lift ?? 0) >= 1.2).slice(0, 3);
    if (tags.length) plan.push({ platform: pl, impact: 'medium', title: `Hashtags that work on ${name}`, why: `${tags.map(t => t.tag).join(', ')}: used by ${Math.max(...tags.map(t => t.accounts))} accounts in your set, with above-usual engagement.`, evidence: label });
  }
  plan.sort((a, b) => (a.impact === 'high' ? 0 : 1) - (b.impact === 'high' ? 0 : 1));
  // a short plan gets done: the six strongest moves, at most three per platform
  const perPl = new Map<string, number>();
  const shortPlan = plan.filter(a => { const k = a.platform ?? ''; const n = perPl.get(k) ?? 0; if (n >= 3) return false; perPl.set(k, n + 1); return true; }).slice(0, 6);

  return { period: periodCompare, followerSeries, newFollowersWeekly, benchmark, trends, hashtags, topPosts, plan: shortPlan, competitorCount: accs.filter(a => a.isCompetitor).length };
}
