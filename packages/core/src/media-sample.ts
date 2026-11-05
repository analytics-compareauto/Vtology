/**
 * A made-up DV360 Standard report for an awareness flight (CTV, audio and online video in Canada), with
 * the column names DV360 uses and the footer lines it appends. For trying the Media tab and for tests.
 * The brand is fictional; the numbers are generated, with a few deliberate problems to find.
 */
let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };

const LINES = [
  { io: 'Northline Q4 Awareness', li: 'CTV | Premium deal | A25-54', type: 'Over-the-top', ct: 'Video', supply: 'TC-CTV-PREMIUM-CA', ex: 'Magnite', device: 'Connected TV', env: 'App', cost: 34, vcr: 0.95, view: 0, sites: ['Roku Channel', 'Samsung TV Plus', 'Tubi', 'Pluto TV'] },
  { io: 'Northline Q4 Awareness', li: 'CTV | Open auction', type: 'Over-the-top', ct: 'Video', supply: '', ex: 'Google Ad Manager', device: 'Connected TV', env: 'App', cost: 22, vcr: 0.78, view: 0, sites: ['Tubi', 'Pluto TV', 'Free Movies Now TV', 'Classic Cartoons 24'] },
  { io: 'Northline Q4 Awareness', li: 'OLV | Curated deal | Auto intenders', type: 'Video', ct: 'Video', supply: 'TC-OLV-AUTO-CA', ex: 'PubMatic', device: 'Smart Phone', env: 'Web', cost: 14, vcr: 0.72, view: 0.76, sites: ['globalnews.ca', 'theweathernetwork.com', 'autotrader.ca', 'driving.ca'] },
  { io: 'Northline Q4 Awareness', li: 'OLV | Open auction', type: 'Video', ct: 'Video', supply: '', ex: 'OpenX', device: 'Desktop', env: 'Web', cost: 8, vcr: 0.58, view: 0.55, sites: ['globalnews.ca', 'quickrecipes-daily.info', 'top10-slideshow.net', 'driving.ca'] },
  { io: 'Northline Q4 Awareness', li: 'Audio | Streaming deal', type: 'Audio', ct: 'Audio', supply: 'TC-AUDIO-CA', ex: 'Equativ', device: 'Smart Phone', env: 'App', cost: 11, vcr: 0.9, view: 0, sites: ['Spotify', 'iHeartRadio', 'Podcast network CA', 'SiriusXM'] },
];
const CREATIVES: Record<string, string[]> = { Video: ['Nautica 30s Hero', 'Nautica 15s Cutdown'], Audio: ['Northline 30s Audio'] };
const REGIONS: [string, number][] = [['Ontario', 0.39], ['Quebec', 0.22], ['British Columbia', 0.14], ['Alberta', 0.12], ['Manitoba', 0.04], ['Nova Scotia', 0.03]];

export const SAMPLE_MEDIA_HEADER = ['Date', 'Insertion Order', 'Line Item', 'Line Item Type', 'Creative', 'Creative Type', 'Exchange', 'Inventory Source', 'App/URL', 'Device Type', 'Environment', 'Region', 'Advertiser Currency',
  'Impressions', 'Clicks', 'Total Media Cost (Advertiser Currency)', 'Active View: Viewable Impressions', 'Active View: Measurable Impressions', 'Active View: Audible and Visible at Completion',
  'Starts (Video)', 'First-Quartile Views (Video)', 'Midpoint Views (Video)', 'Third-Quartile Views (Video)', 'Complete Views (Video)'];

/** Days ending at `end`, inclusive (ISO dates). */
export function sampleMediaCsv(end: string, days = 49): string {
  seed = 7;
  const rows: string[] = [SAMPLE_MEDIA_HEADER.join(',')];
  const start = Date.parse(end) - (days - 1) * 86_400_000;
  for (let d = 0; d < days; d++) {
    const day = new Date(start + d * 86_400_000).toISOString().slice(0, 10).replace(/-/g, '/');
    for (const l of LINES) for (const [si, site] of l.sites.entries()) {
      const creatives = CREATIVES[l.ct]!;
      const creative = creatives[(d + si) % creatives.length]!;
      // the 30s hero wears out over the flight; two long-tail apps and two made-for-ads sites barely complete
      const fatigue = creative === 'Nautica 30s Hero' ? 1 - 0.32 * (d / days) : 1;
      const junk = /Free Movies|Classic Cartoons|quickrecipes|slideshow/.test(site) ? 0.45 : 1;
      for (const [region, share] of REGIONS) {
        const imps = Math.round((900 + rnd() * 900) * share * (l.ct === 'Audio' ? 0.8 : 1) * (junk < 1 ? 1.4 : 1));
        if (imps < 5) continue;
        const regionCost = region === 'Manitoba' ? 1.9 : 1;
        const cost = (imps / 1000) * l.cost * (0.9 + rnd() * 0.2) * regionCost * (junk < 1 ? 0.8 : 1);
        const starts = Math.round(imps * 0.98);
        const vcr = Math.min(0.99, l.vcr * fatigue * junk * (0.95 + rnd() * 0.1));
        const completes = Math.round(starts * vcr);
        const q1 = Math.round(starts * (vcr + (1 - vcr) * 0.55)), q2 = Math.round(starts * (vcr + (1 - vcr) * 0.32)), q3 = Math.round(starts * (vcr + (1 - vcr) * 0.14));
        const measurable = l.view ? Math.round(imps * 0.92) : 0;
        const viewable = Math.round(measurable * l.view * (junk < 1 ? 0.6 : 1));
        const audible = l.view ? Math.round(completes * l.view * 0.8) : 0;
        rows.push([day, l.io, `"${l.li}"`, l.type, creative, l.ct, l.ex, l.supply, site, l.device, l.env, region, 'CAD',
          imps, Math.round(imps * 0.002), cost.toFixed(2), viewable, measurable, audible, starts, q1, q2, q3, completes].join(','));
      }
    }
  }
  rows.push('', 'Report Time:,2026/11/05 09:00 GMT', 'Date Range:,Custom', 'Group By:,Date,Insertion Order,Line Item');
  return rows.join('\n');
}
