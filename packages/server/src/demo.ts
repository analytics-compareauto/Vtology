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
  return { imports, pipeline: stats };
}
