/**
 * Sample workspaces. Generates a realistic, fully fictional dataset for an industry and loads it
 * through the real import and pipeline, exactly as a client's exports would be. Nothing here is
 * hard-coded into the dashboards: every number they show comes out of the engine.
 *
 * What the data contains on purpose:
 *  - the same person entered twice by different systems, with the phone written differently
 *    (identity resolution merges them)
 *  - a phone number typed in for several different customers (held for review, not merged)
 *  - a few unusable phone numbers (import warnings)
 *  - one partner that lets many journeys go idle, and one borderline partner
 *  - journeys the CRM marks as converted with no sale behind them (phantom conversions)
 *  - sales with no originating inquiry (orphan transactions)
 *  - a campaign that spent money but produced no journey (unattributed spend)
 */
import { STAGES, type Industry } from '@vtology/core';
import { importCsv } from './imports';
import { runPipeline, type PipelineStats } from './pipeline';
import type { Ctx } from './context';

const DAY = 86_400_000;

function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T,>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!,
    chance: (p: number) => next() < p,
    weighted: <T,>(items: readonly (readonly [T, number])[]): T => {
      const total = items.reduce((s, [, w]) => s + w, 0);
      let r = next() * total;
      for (const [v, w] of items) { if ((r -= w) < 0) return v; }
      return items[items.length - 1]![0];
    },
  };
}

const FIRST = ['Aarav', 'Vivaan', 'Aditya', 'Arjun', 'Rohan', 'Kabir', 'Ishaan', 'Rahul', 'Sanjay', 'Vikram', 'Amit', 'Karthik', 'Nikhil', 'Pranav', 'Siddharth', 'Harish', 'Manoj', 'Imran', 'Farhan', 'Gurpreet',
  'Ananya', 'Diya', 'Meera', 'Priya', 'Kavya', 'Sneha', 'Pooja', 'Neha', 'Riya', 'Aisha', 'Lakshmi', 'Divya', 'Swati', 'Nandini', 'Shreya', 'Tanvi', 'Zara', 'Simran', 'Fatima', 'Deepa'];
const LAST = ['Sharma', 'Verma', 'Iyer', 'Nair', 'Reddy', 'Patel', 'Shah', 'Mehta', 'Kulkarni', 'Deshpande', 'Gupta', 'Agarwal', 'Bose', 'Banerjee', 'Das', 'Khan', 'Singh', 'Gill', 'Menon', 'Pillai',
  'Rao', 'Joshi', 'Chopra', 'Malhotra', 'Kapoor', 'Mishra', 'Pandey', 'Naidu', 'Hegde', 'Fernandes'];

const CITIES: Record<string, string[]> = {
  Mumbai: ['400053', '400058', '400076', '400601'], Pune: ['411001', '411014', '411038'], Bengaluru: ['560001', '560066', '560095'],
  Delhi: ['110017', '110025', '122002'], Hyderabad: ['500034', '500081'], Chennai: ['600040', '600017'], Ahmedabad: ['380015', '380054'], Kolkata: ['700091', '700019'],
};

interface Config {
  partnerType: (i: number) => string;
  partners: [string, string, string][]; // code, name, city
  campaigns: [string, string, string, number][]; // code, name, channel, spend
  ghost: [string, string, string, number];
  people: number;
  value: [number, number];
  finalStage: [number, number][]; // [stage index, weight]
  sources: { lead: string; dupes: string; journeys: string; sales: string; consent: string };
  saleRef: string;
}

const CONFIG: Record<Industry, Config> = {
  Automotive: {
    partnerType: () => 'Dealer',
    partners: [['D01', 'Andheri Motors', 'Mumbai'], ['D02', 'Thane Auto Hub', 'Mumbai'], ['D03', 'Pune City Motors', 'Pune'], ['D04', 'Whitefield Wheels', 'Bengaluru'], ['D05', 'Koramangala Cars', 'Bengaluru'],
      ['D06', 'Gurugram Autoworld', 'Delhi'], ['D07', 'Banjara Hills Motors', 'Hyderabad'], ['D08', 'Anna Nagar Autos', 'Chennai'], ['D09', 'SG Highway Motors', 'Ahmedabad'], ['D10', 'Salt Lake Cars', 'Kolkata']],
    campaigns: [['C01', 'Festive Drive Search', 'Google Search', 850000], ['C02', 'New SUV Launch Reels', 'Meta', 620000], ['C03', 'Test Drive Week', 'YouTube', 480000],
      ['C04', 'Marketplace Leads', 'CarDekho', 390000], ['C05', 'Exchange Mela', 'Offline events', 300000], ['C06', 'Retargeting Always-on', 'Programmatic', 260000]],
    ghost: ['C07', 'Monsoon Display Burst', 'Programmatic', 450000],
    people: 230, value: [650000, 1800000],
    finalStage: [[0, 5], [1, 8], [2, 19], [3, 22], [4, 16], [5, 30]],
    sources: { lead: 'Website configurator', dupes: 'Dealer DMS walk-ins', journeys: 'Dealer DMS', sales: 'Dealer DMS invoices', consent: 'Consent manager' },
    saleRef: 'INV',
  },
  BFSI: {
    partnerType: i => (i % 3 === 2 ? 'DSA' : 'Branch'),
    partners: [['B01', 'Andheri Branch', 'Mumbai'], ['B02', 'Powai Branch', 'Mumbai'], ['B03', 'FinEdge DSA', 'Pune'], ['B04', 'Whitefield Branch', 'Bengaluru'], ['B05', 'Jayanagar Branch', 'Bengaluru'],
      ['B06', 'LoanKart DSA', 'Delhi'], ['B07', 'Gachibowli Branch', 'Hyderabad'], ['B08', 'T Nagar Branch', 'Chennai'], ['B09', 'EasyCredit DSA', 'Ahmedabad'], ['B10', 'Park Street Branch', 'Kolkata']],
    campaigns: [['C01', 'Home Loan Rate Cut', 'Google Search', 780000], ['C02', 'Personal Loan in 10 Minutes', 'Meta', 560000], ['C03', 'Credit Card Lifetime Free', 'Programmatic', 420000],
      ['C04', 'Aggregator Leads', 'Paisabazaar', 510000], ['C05', 'Salary Account Upgrade', 'Email', 120000], ['C06', 'Pre-approved Offers', 'SMS', 90000]],
    ghost: ['C07', 'Gold Loan Radio Spots', 'Radio', 350000],
    people: 230, value: [200000, 2500000],
    finalStage: [[0, 6], [1, 12], [2, 18], [3, 20], [4, 14], [5, 30]],
    sources: { lead: 'Digital lending journey', dupes: 'Branch walk-in register', journeys: 'Loan origination system', sales: 'Core banking disbursals', consent: 'Consent manager' },
    saleRef: 'LAN',
  },
  FMCG: {
    partnerType: i => (i % 2 ? 'Retail chain' : 'Distributor'),
    partners: [['R01', 'Mumbai West Distributors', 'Mumbai'], ['R02', 'FreshMart Thane', 'Mumbai'], ['R03', 'Pune Consumer Supply', 'Pune'], ['R04', 'DailyBasket Bengaluru', 'Bengaluru'], ['R05', 'South Bengaluru Distributors', 'Bengaluru'],
      ['R06', 'NCR Trade Links', 'Delhi'], ['R07', 'Hyderabad Retail Co', 'Hyderabad'], ['R08', 'Chennai Fresh Stores', 'Chennai'], ['R09', 'Gujarat FMCG Partners', 'Ahmedabad'], ['R10', 'Kolkata Kirana Network', 'Kolkata']],
    campaigns: [['C01', 'Scan & Win Contest', 'QR on pack', 420000], ['C02', 'Sampling at Societies', 'Offline events', 380000], ['C03', 'Recipe Reels', 'Meta', 510000],
      ['C04', 'Quick Commerce Boost', 'Blinkit/Zepto ads', 460000], ['C05', 'WhatsApp Loyalty Club', 'WhatsApp', 150000], ['C06', 'Search Always-on', 'Google Search', 240000]],
    ghost: ['C07', 'Cricket Season Display', 'Programmatic', 520000],
    people: 260, value: [180, 2400],
    finalStage: [[0, 18], [1, 16], [2, 16], [3, 22], [4, 16], [5, 12]],
    sources: { lead: 'Contest & loyalty sign-ups', dupes: 'Retailer bill uploads', journeys: 'Engagement platform', sales: 'Retailer bills', consent: 'Consent manager' },
    saleRef: 'BILL',
  },
};

const csvCell = (v: unknown) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const toCsv = (header: string[], rows: unknown[][]) => [header.join(','), ...rows.map(r => r.map(csvCell).join(','))].join('\n');
const iso = (d: Date) => d.toISOString().slice(0, 10);

export interface DemoData { csv: Record<'partner' | 'campaign' | 'lead' | 'journey_event' | 'transaction' | 'consent', string> }

/** Build the sample dataset for an industry. Deterministic for a given industry and date. */
export function generateDemo(industry: Industry, now: Date): DemoData {
  const cfg = CONFIG[industry];
  const r = rng({ Automotive: 11, BFSI: 23, FMCG: 37 }[industry]);
  const stages = STAGES[industry];
  const ago = (days: number) => new Date(now.getTime() - days * DAY);
  const usedPhones = new Set<string>();
  const phone = () => { let p: string; do p = `${r.pick(['9', '8', '7', '6'])}${String(r.int(100000000, 999999999))}`; while (usedPhones.has(p)); usedPhones.add(p); return p; };

  // partners: one that lets many journeys idle, one borderline
  const problem = cfg.partners[2]![0], borderline = cfg.partners[5]![0];
  const partnerWeight = (code: string) => (code === problem ? 2.0 : code === borderline ? 1.5 : 1);
  const partnersCsv = toCsv(['Code', 'Name', 'Type', 'City'], cfg.partners.map(([c, n, city], i) => [c, n, cfg.partnerType(i), city]));
  const campaignsCsv = toCsv(['Campaign ID', 'Campaign', 'Channel', 'Start', 'End', 'Spend (₹)', 'Platform conversions'],
    [...cfg.campaigns, cfg.ghost].map(([c, n, ch, spend]) => [c, n, ch, iso(ago(110)), iso(ago(5)), spend.toLocaleString('en-IN'), r.int(40, 180)]));

  const leads: unknown[][] = [];
  const events: unknown[][] = [];
  const sales: unknown[][] = [];
  const consents: unknown[][] = [];
  const books = ['B1', 'B2', 'B3', 'B4'];
  let leadNo = 0, journeyNo = 0, saleNo = 0;
  const leadId = () => `L${String(++leadNo).padStart(4, '0')}`;

  // two numbers typed in for several different customers (e.g. a salesperson's own phone)
  const sharedPhones = [phone(), phone()];
  const sharedLeft = new Map([[sharedPhones[0]!, 6], [sharedPhones[1]!, 4]]);

  for (let i = 0; i < cfg.people; i++) {
    const first = r.pick(FIRST), last = r.pick(LAST);
    const name = `${first} ${last}`;
    const [pCode, , city] = r.weighted(cfg.partners.map(p => [p, partnerWeight(p[0])] as const));
    const pin = r.pick(CITIES[city]!);
    let mobile = phone();
    const shared = [...sharedLeft.entries()].find(([, left]) => left > 0 && r.chance(0.06));
    if (shared) { mobile = shared[0]; sharedLeft.set(shared[0], shared[1] - 1); }
    const badPhone = !shared && r.chance(0.015);
    const email = r.chance(0.55) ? `${first}.${last}${r.int(1, 99)}@example.com`.toLowerCase() : '';
    const created = ago(r.int(20, 115));
    const id = leadId();
    const book = r.pick(books);
    leads.push([id, name, badPhone ? String(r.int(10000, 99999)) : `+91 ${mobile.slice(0, 5)} ${mobile.slice(5)}`, email, pin, city, iso(created), book, r.chance(0.2) ? 'Y' : 'N']);
    // the same person entered again by another system, phone written differently
    if (!shared && !badPhone && r.chance(0.12)) {
      leads.push([leadId(), r.chance(0.5) ? first : `${first[0]}. ${last}`, `0${mobile}`, '', pin, city, iso(new Date(created.getTime() + r.int(1, 9) * DAY)), book, 'N']);
    }
    if (r.chance(0.7)) consents.push([id, 'marketing', r.pick(['WhatsApp', 'SMS', 'Email']), r.chance(0.94) ? 'Y' : 'N', iso(created)]);
    if (r.chance(0.13)) continue; // no journey for this person

    // the journey: final stage, then whether it is moving or has gone quiet
    const ref = `J${String(++journeyNo).padStart(4, '0')}`;
    const camp = r.weighted(cfg.campaigns.map(c => [c[0], c[3]] as const));
    // a partner that lets leads go cold also converts fewer of them
    const convertFactor = pCode === problem ? 0.35 : pCode === borderline ? 0.75 : 1;
    const final = r.weighted(cfg.finalStage.map(([s, w]) => [s, stages[s]!.converted ? w * convertFactor : w] as const));
    const idleRisk = pCode === problem ? 0.85 : pCode === borderline ? 0.55 : 0.2;
    const converted = stages[final]!.converted;
    const last_stage = stages[final]!;
    let lastActivity: number;
    let phantom = false;
    if (!converted && final > 0 || industry === 'FMCG' && final === 0) {
      const stalled = r.chance(idleRisk);
      lastActivity = stalled ? last_stage.slaDays + r.int(2, 30) : r.int(0, Math.max(0, last_stage.slaDays - 1));
      if (stalled && final >= 2 && r.chance(industry === 'FMCG' ? 0.25 : 0.08)) phantom = true; // CRM says won, nothing behind it
    } else if (final === 0) {
      lastActivity = r.chance(0.5) ? r.int(0, 1) : r.int(3, 12);
    } else if (final === stages.length - 1) {
      lastActivity = r.int(1, 60);
    } else {
      // converted but not completed (booking / sanction / trial): mostly recent, some old
      lastActivity = r.chance(0.78) ? r.int(1, 25) : r.int(35, 70);
    }
    // events walk backwards from the last activity
    const dates: Date[] = [];
    let t = lastActivity;
    for (let s = final; s >= 0; s--) { dates[s] = ago(t); t += r.int(1, 6); }
    for (let s = 0; s <= final; s++) {
      const isLast = s === final;
      events.push([ref, id, pCode, camp, stages[s]!.name, iso(dates[s]!), (stages[s]!.converted || isLast && phantom) ? 'yes' : 'no', '']);
    }
    // a sale for completed journeys (retail / disbursal / repeat purchases)
    const value = Math.round(r.int(cfg.value[0], cfg.value[1]) / 100) * 100;
    if (final === stages.length - 1 || industry === 'FMCG' && final >= 3) {
      sales.push([`${cfg.saleRef}-${String(++saleNo).padStart(5, '0')}`, ref, id, pCode, iso(new Date(dates[final]!.getTime() + r.int(0, 3) * DAY)), value]);
    }
  }
  // sales that arrive with no inquiry behind them
  for (let k = 0; k < 7; k++) {
    sales.push([`${cfg.saleRef}-${String(++saleNo).padStart(5, '0')}`, '', '', r.pick(cfg.partners)[0], iso(ago(r.int(3, 50))), Math.round(r.int(cfg.value[0], cfg.value[1]) / 100) * 100]);
  }

  return {
    csv: {
      partner: partnersCsv,
      campaign: campaignsCsv,
      lead: toCsv(['Lead ID', 'Name', 'Mobile', 'Email', 'PIN', 'City', 'Created', 'Book', 'Existing customer'], leads),
      journey_event: toCsv(['Enquiry', 'Lead', 'Partner', 'Campaign', 'Status', 'Date', 'CRM won', 'Value'], events),
      transaction: toCsv(['Ref', 'Enquiry', 'Lead', 'Partner', 'Date', 'Amount'], sales),
      consent: toCsv(['Lead', 'Purpose', 'Channel', 'Granted', 'Recorded'], consents),
    },
  };
}

export const DEMO_MAPPINGS = (industry: Industry) => {
  const s = CONFIG[industry].sources;
  return {
    partner: { entity: 'partner' as const, sourceSystem: 'Partner master', fields: { external_code: 'Code', name: 'Name', partner_type: 'Type', city: 'City' } },
    campaign: { entity: 'campaign' as const, sourceSystem: 'Ad platforms', fields: { external_code: 'Campaign ID', name: 'Campaign', channel: 'Channel', start_date: { column: 'Start', transform: 'date' as const }, end_date: { column: 'End', transform: 'date' as const }, spend_inr: { column: 'Spend (₹)', transform: 'number' as const }, platform_reported_conversions: { column: 'Platform conversions', transform: 'number' as const } } },
    lead: { entity: 'lead' as const, sourceSystem: s.lead, fields: { external_id: 'Lead ID', name: 'Name', phone: 'Mobile', email: 'Email', pincode: 'PIN', city: 'City', created_at: { column: 'Created', transform: 'date' as const }, book_code: 'Book', is_existing_customer: { column: 'Existing customer', transform: 'bool' as const } } },
    journey_event: { entity: 'journey_event' as const, sourceSystem: s.journeys, fields: { journey_ref: 'Enquiry', person_ref: 'Lead', partner_code: 'Partner', campaign_code: 'Campaign', stage: 'Status', occurred_at: { column: 'Date', transform: 'date' as const }, crm_converted: { column: 'CRM won', transform: 'bool' as const } } },
    transaction: { entity: 'transaction' as const, sourceSystem: s.sales, fields: { external_ref: 'Ref', journey_ref: 'Enquiry', person_ref: 'Lead', partner_code: 'Partner', occurred_at: { column: 'Date', transform: 'date' as const }, value_inr: { column: 'Amount', transform: 'number' as const } } },
    consent: { entity: 'consent' as const, sourceSystem: s.consent, fields: { person_ref: 'Lead', purpose: 'Purpose', channel: 'Channel', granted: { column: 'Granted', transform: 'bool' as const }, recorded_at: { column: 'Recorded', transform: 'date' as const } } },
  };
};

export interface DemoLoadResult { imports: { entity: string; imported: number; warnings: number }[]; pipeline: PipelineStats }

/** Load the sample dataset into a workspace through the normal import and pipeline. */
export async function loadDemo(ctx: Ctx): Promise<DemoLoadResult> {
  const data = generateDemo(ctx.industry, ctx.now);
  const maps = DEMO_MAPPINGS(ctx.industry);
  const imports: DemoLoadResult['imports'] = [];
  for (const entity of ['partner', 'campaign', 'lead', 'journey_event', 'transaction', 'consent'] as const) {
    const res = await importCsv(ctx, { mapping: maps[entity], csv: data.csv[entity], fileName: `sample-${entity}.csv` });
    imports.push({ entity, imported: res.imported, warnings: res.errors.length });
  }
  const { stats } = await runPipeline(ctx);
  await loadSampleSocial(ctx);
  return { imports, pipeline: stats };
}

// ===================================================================== sample social footprint
type Tpl = [theme: string, weight: number, lift: number, captions: string[]];
const SOCIAL_TPL: Record<Industry, { brand: string; handle: string; tpl: Tpl[]; hindi: string[] }> = {
  Automotive: {
    brand: 'Vegaa Motors', handle: 'vegaamotors',
    tpl: [
      ['comparison', 12, 1.9, ['Strada vs Terra: which one fits your family?', 'Terra vs the segment leader: a fair comparison', 'Petrol vs CNG Strada: which is better for city driving?']],
      ['price', 30, 0.6, ['Festive offer: Strada from ₹6.99 lakh on-road. Book now!', 'EMI starting ₹9,999. Limited period deal on Terra', 'Exchange bonus up to ₹50,000 this month']],
      ['launch', 10, 1.3, ['First look: the new Terra facelift', 'Coming soon. Something big is on its way', 'Launched: Metro, the compact for every lane']],
      ['review', 12, 1.4, ['Owner review: 30,000 km with the Strada', 'Road test: Terra on the Mumbai-Pune expressway', 'Test drive impressions from Pune']],
      ['ev', 6, 1.7, ['Volt EV: real-world range on a Bengaluru commute', 'Charging at home explained in 60 seconds', 'Is an electric car right for you?']],
      ['safety', 8, 1.0, ['5-star safety: what the NCAP rating means for you', 'Six airbags, standard across the range']],
      ['tips', 10, 1.2, ['5 monsoon driving tips', 'How to read your service schedule', 'Things to know before your first highway trip']],
      ['festive', 12, 1.05, ['Happy Diwali from all of us at Vegaa', 'Navratri special: drive home happiness']],
    ],
    hindi: ['Strada vs Terra: आपके परिवार के लिए कौन सी कार सही है?', 'Volt EV: एक बार चार्ज, पूरा हफ्ता शहर में', 'मानसून में गाड़ी चलाने के 5 tips', 'नई Terra की पहली झलक'],
  },
  BFSI: {
    brand: 'Northstar Finance', handle: 'northstarfinance',
    tpl: [
      ['tips', 14, 1.6, ['5 mistakes to avoid before taking a home loan', 'How to read your loan statement, explained', 'Things to know about prepaying your loan']],
      ['rates', 28, 0.6, ['Home loan interest rate now from 8.35% p.a.', 'Lifetime free credit card. Apply today', 'Pre-approved personal loan offer inside the app']],
      ['fraud', 10, 1.5, ['Never share your OTP. Stay safe from fraud', 'Spot a phishing SMS in 3 seconds', 'Scam alert: fake loan apps to watch for']],
      ['credit', 10, 1.4, ['What is a good credit score? CIBIL explained', 'How to improve your credit score in 6 months']],
      ['tax', 10, 1.2, ['Save tax under 80C: a simple checklist', 'ITR filing deadline approaching']],
      ['stories', 8, 1.3, ['Meet Priya: her dream home story', 'From first salary to first home: a customer journey']],
      ['product', 12, 0.85, ['Introducing instant FD in our app', 'Credit card features you might be missing']],
      ['festive', 8, 1.0, ['Happy Dhanteras. Start a SIP today', 'Wishing you a prosperous Diwali']],
    ],
    hindi: ['होम लोन लेने से पहले ये 5 गलतियाँ न करें', 'OTP किसी के साथ share न करें, fraud से बचें', 'अच्छा credit score क्या होता है?', 'टैक्स बचाने के आसान तरीके'],
  },
  FMCG: {
    brand: 'Gharelu Foods', handle: 'gharelufoods',
    tpl: [
      ['recipe', 16, 1.7, ['3-minute breakfast recipe with Gharelu poha mix', 'Try this monsoon snack hack', 'Make this tiffin favourite in 10 minutes']],
      ['offer', 26, 0.6, ['Flat 20% off on Blinkit this weekend', 'Buy now on Zepto: combo offer', 'Instamart deal: 2 for 1']],
      ['creator', 10, 1.5, ['Collab with @chefmeera: our masala chai cookies', 'Featuring @fitwithrohan: high-protein snack ideas']],
      ['launch', 10, 1.2, ['Introducing our new millet crunch flavour', 'New: no added sugar range now available']],
      ['health', 10, 1.3, ['What is in your snack? Our ingredients, explained', 'Protein-packed and natural: the new range']],
      ['giveaway', 10, 1.1, ['Giveaway! Comment your favourite recipe to win a hamper', 'Contest: share your tiffin photo and win']],
      ['festive', 18, 0.95, ['Happy Diwali! Sweets made at home', 'Festive gift packs are here']],
    ],
    hindi: ['सिर्फ 3 मिनट में बनाएं पोहा, आसान recipe', 'नया millet crunch, बिना चीनी के', 'घर की बनी मिठाई, Diwali special recipe'],
  },
};

export function generateSocial(industry: Industry, now: Date) {
  const cfg = SOCIAL_TPL[industry];
  const r = rng({ Automotive: 101, BFSI: 202, FMCG: 303 }[industry]);
  const accounts = [
    { platform: 'instagram' as const, externalId: `ig-${cfg.handle}`, handle: cfg.handle, name: cfg.brand, followers: r.int(180000, 420000), posts: 72 },
    { platform: 'facebook' as const, externalId: `fb-${cfg.handle}`, handle: cfg.handle, name: cfg.brand, followers: r.int(300000, 900000), posts: 40 },
    { platform: 'youtube' as const, externalId: `yt-${cfg.handle}`, handle: `@${cfg.handle}`, name: cfg.brand, followers: r.int(60000, 250000), posts: 28 },
  ];
  const formats: Record<string, [string, number, number][]> = {
    instagram: [['reel', 45, 1.6], ['carousel', 20, 1.1], ['image', 35, 0.65]],
    facebook: [['video', 30, 1.15], ['image', 45, 0.85], ['link', 15, 0.6], ['text', 10, 0.5]],
    youtube: [['video', 55, 1.0], ['short', 45, 1.35]],
  };
  const timeLift: [number, number][] = [[8, 0.8], [10, 0.85], [13, 0.95], [15, 0.9], [18, 1.3], [20, 1.35], [22, 1.0]];
  const posts: { accountExternalId: string; platform: 'instagram' | 'facebook' | 'youtube'; externalId: string; postedAt: Date; format: string; caption: string; views: number | null; reach: number | null; likes: number; comments: number; shares: number | null; saves: number | null; watchMinutes: number | null; avgViewPct: number | null }[] = [];
  for (const a of accounts) {
    for (let i = 0; i < a.posts; i++) {
      const [, , themeLift, caps] = r.weighted(cfg.tpl.map(t => [t, t[1]] as const));
      const hindi = r.chance(0.14);
      const caption = hindi ? r.pick(cfg.hindi) : r.pick(caps);
      const [format, , fLift] = r.weighted(formats[a.platform]!.map(f => [f, f[1]] as const));
      const [hour, tLift] = r.pick(timeLift);
      const day = r.int(1, 170);
      const postedAt = new Date(now.getTime() - day * 86_400_000);
      postedAt.setUTCHours(hour, 0, 0, 0);
      postedAt.setTime(postedAt.getTime() - 330 * 60_000); // that hour in IST
      const noise = Math.exp((r.next() - 0.5) * 0.7);
      const lift = themeLift * fLift * tLift * (hindi ? 1.45 : 1) * noise;
      const reachBase = a.followers * (a.platform === 'youtube' ? 0.35 : a.platform === 'instagram' ? 0.22 : 0.06);
      const reach = Math.round(reachBase * Math.min(lift, 3) * (0.8 + r.next() * 0.4));
      const er = 0.032 * lift;
      const inter = Math.round(reach * er);
      const yt = a.platform === 'youtube';
      posts.push({
        accountExternalId: a.externalId, platform: a.platform, externalId: `${a.externalId}-p${i}`, postedAt, format, caption,
        views: yt || format === 'reel' || format === 'video' ? Math.round(reach * (yt ? 1 : 1.3)) : null,
        reach: yt ? null : reach, likes: Math.round(inter * 0.72), comments: Math.round(inter * 0.07),
        shares: Math.round(inter * 0.09), saves: a.platform === 'instagram' ? Math.round(inter * 0.12) : null,
        watchMinutes: yt ? Math.round(reach * (format === 'short' ? 0.4 : 3.2) * Math.min(lift, 2)) : format === 'reel' ? Math.round(reach * 0.3 * Math.min(lift, 2)) : format === 'video' ? Math.round(reach * 0.5) : null,
        avgViewPct: yt ? Math.min(95, Math.round((format === 'short' ? 62 : 38) * Math.min(lift, 1.6))) : null,
      });
    }
  }
  // fictional competitors: public numbers only (likes, comments; views on YouTube). They post more
  // often, lean on reels and shorts, and the first theme is rising across the industry recently.
  const COMP: Record<Industry, [string, string][]> = {
    Automotive: [['Gaadi Guru', 'gaadiguru'], ['Torque Talk India', 'torquetalkindia'], ['Motorwala', 'motorwala.in']],
    BFSI: [['PaisaPlus', 'paisaplus'], ['Kosh Bank', 'koshbank'], ['Arthik Money', 'arthikmoney']],
    FMCG: [['Swad Kitchen', 'swadkitchen'], ['Nashta Co', 'nashtaco'], ['Tiffin Tales', 'tiffintales']],
  };
  const competitors: typeof accounts = [];
  for (const [name, handle] of COMP[industry]) {
    competitors.push({ platform: 'instagram', externalId: `ig-${handle}`, handle, name, followers: r.int(250000, 1400000), posts: r.int(110, 190) });
    competitors.push({ platform: 'youtube', externalId: `yt-${handle}`, handle: `@${handle}`, name, followers: r.int(90000, 900000), posts: r.int(35, 70) });
  }
  const compFormats: Record<string, [string, number, number][]> = { instagram: [['reel', 62, 1.5], ['carousel', 23, 1.15], ['image', 15, 0.7]], youtube: [['video', 40, 1.0], ['short', 60, 1.3]] };
  for (const a of competitors) {
    for (let i = 0; i < a.posts; i++) {
      const day = r.int(1, 170);
      const recent = day <= 28;
      const [, , themeLift0, caps] = r.weighted(cfg.tpl.map((t, k) => [t, t[1] * (recent && k === 0 ? 2.5 : 1)] as const));
      const themeLift = themeLift0 * (recent && caps === cfg.tpl[0]![3] ? 1.3 : 1);
      const [format, , fLift] = r.weighted(compFormats[a.platform]!.map(f => [f, f[1]] as const));
      const [hour, tLift] = r.pick(timeLift);
      const postedAt = new Date(now.getTime() - day * 86_400_000);
      postedAt.setUTCHours(hour, 0, 0, 0);
      postedAt.setTime(postedAt.getTime() - 330 * 60_000);
      const lift = themeLift * fLift * tLift * Math.exp((r.next() - 0.5) * 0.7);
      const inter = Math.round(a.followers * 0.011 * lift);
      const yt = a.platform === 'youtube';
      const tags = r.chance(0.6) ? ` #${cfg.handle.slice(0, 4)}${r.pick(['tips', 'india', 'daily', 'reels'])} #${r.pick(['trending', 'india', 'viral', 'explore'])}` : '';
      posts.push({ accountExternalId: a.externalId, platform: a.platform, externalId: `${a.externalId}-p${i}`, postedAt, format, caption: r.pick(caps) + tags,
        views: yt ? Math.round(inter * 22) : null, reach: null, likes: Math.round(inter * 0.9), comments: Math.round(inter * 0.1), shares: null, saves: null, watchMinutes: null, avgViewPct: null });
    }
  }
  // daily follower history, 120 days: competitors grow faster than the brand
  const daily: { externalId: string; day: string; followers: number; newFollowers: number | null }[] = [];
  for (const a of [...accounts, ...competitors]) {
    const own = accounts.includes(a);
    const monthly = own ? (a.platform === 'instagram' ? 0.012 : a.platform === 'youtube' ? 0.02 : 0.004) : 0.02 + r.next() * 0.03;
    let f = Math.round(a.followers / Math.pow(1 + monthly, 4));
    for (let d = 120; d >= 0; d--) {
      const gain = Math.max(0, Math.round(f * monthly / 30 * (0.5 + r.next())));
      f = d === 0 ? a.followers : Math.min(a.followers, f + gain);
      daily.push({ externalId: a.externalId, day: new Date(now.getTime() - d * 86_400_000).toISOString().slice(0, 10), followers: f, newFollowers: own && a.platform !== 'youtube' && d <= 30 ? gain : null });
    }
  }
  return { accounts, posts, competitors, daily };
}

/** Put the sample social footprint into a workspace (sample workspaces only). */
/** Sample workspaces keep a current sample footprint: created before social existed, or last
 *  generated more than a day ago, it is rebuilt around today. Returns true when it rebuilt. */
export async function refreshSampleSocial(ctx: Ctx): Promise<boolean> {
  if (!ctx.isDemo) return false;
  return loadSampleSocial(ctx, { onlyIfStale: true });
}

export async function loadSampleSocial(ctx: Ctx, opts: { onlyIfStale?: boolean } = {}): Promise<boolean> {
  const { accounts, posts, competitors, daily } = generateSocial(ctx.industry, ctx.now);
  return ctx.db.transaction(async sql => {
    if (opts.onlyIfStale) {
      // one rebuild at a time per workspace; a second request waits, then finds it fresh
      await sql.query(`select pg_advisory_xact_lock(hashtext('vt-sample-social:' || $1))`, [ctx.tenantId]);
      const [c] = await sql.query<{ fresh: boolean; competitors: number }>(
        `select coalesce(bool_or(c.last_sync_at > $2::timestamptz - interval '1 day'), false) as fresh,
                (select count(*)::int from vt.social_competitors where tenant_id = $1) as competitors
           from vt.social_connections c where c.tenant_id = $1 and c.provider = 'sample'`, [ctx.tenantId, ctx.now.toISOString()]);
      if (c?.fresh && c.competitors > 0) return false;
      if ((await sql.query(`select 1 from vt.social_connections where tenant_id = $1 and provider <> 'sample' limit 1`, [ctx.tenantId])).length) return false; // real accounts: never touch
      await sql.query(`delete from vt.social_competitors where tenant_id = $1`, [ctx.tenantId]);
      await sql.query(`delete from vt.social_connections where tenant_id = $1 and provider = 'sample'`, [ctx.tenantId]); // accounts, posts and history go with it
    }
    const [conn] = await sql.query<{ id: string }>(`insert into vt.social_connections (tenant_id, provider, label, connected_by, last_sync_at) values ($1, 'sample', 'Sample accounts (fictional)', $2, $3) returning id`, [ctx.tenantId, ctx.userId, ctx.now.toISOString()]);
    const ids = new Map<string, string>();
    for (const a of accounts) {
      const [row] = await sql.query<{ id: string }>(`insert into vt.social_accounts (tenant_id, connection_id, platform, external_id, handle, name, followers, posts_count) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [ctx.tenantId, conn!.id, a.platform, a.externalId, a.handle, a.name, a.followers, a.posts]);
      ids.set(a.externalId, row!.id);
    }
    for (const a of competitors) {
      const [row] = await sql.query<{ id: string }>(`insert into vt.social_accounts (tenant_id, connection_id, platform, external_id, handle, name, followers, posts_count, is_competitor) values ($1,$2,$3,$4,$5,$6,$7,$8,true) returning id`,
        [ctx.tenantId, conn!.id, a.platform, a.externalId, a.handle, a.name, a.followers, a.posts]);
      ids.set(a.externalId, row!.id);
      await sql.query(`insert into vt.social_competitors (tenant_id, platform, handle, account_id, added_by) values ($1,$2,$3,$4,$5)`, [ctx.tenantId, a.platform, a.handle.replace(/^@/, ''), row!.id, ctx.userId]);
    }
    // one statement for the whole history (about 1,100 rows)
    await sql.query(`insert into vt.social_account_daily (account_id, tenant_id, day, followers, new_followers)
       select a, $1, d::date, f, nf from unnest($2::uuid[], $3::text[], $4::int[], $5::int[]) as t(a, d, f, nf)`,
      [ctx.tenantId, daily.map(d => ids.get(d.externalId)), daily.map(d => d.day), daily.map(d => d.followers), daily.map(d => d.newFollowers)]);
    // every post in one statement
    const col = <T,>(f: (p: typeof posts[number]) => T) => posts.map(f);
    await sql.query(
      `insert into vt.social_posts (tenant_id, account_id, external_id, posted_at, format, caption, views, reach, likes, comments, shares, saves, watch_minutes, avg_view_pct, metrics_at)
       select $1, a, e, t::timestamptz, f, c, v, r, l, cm, sh, sv, w, ap, now()
         from unnest($2::uuid[], $3::text[], $4::text[], $5::text[], $6::text[], $7::bigint[], $8::bigint[], $9::bigint[], $10::bigint[], $11::bigint[], $12::bigint[], $13::numeric[], $14::numeric[])
           as x(a, e, t, f, c, v, r, l, cm, sh, sv, w, ap)`,
      [ctx.tenantId, col(p => ids.get(p.accountExternalId)), col(p => p.externalId), col(p => p.postedAt.toISOString()), col(p => p.format), col(p => p.caption),
       col(p => p.views), col(p => p.reach), col(p => p.likes), col(p => p.comments), col(p => p.shares), col(p => p.saves), col(p => p.watchMinutes), col(p => p.avgViewPct)]);
    return true;
  });
}
