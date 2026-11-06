'use client';
import { pct } from '../format';

interface Funnel { leads: number; contacted: number; reached: number; tdBooked: number; tdGiven: number; booked: number; delivered: number; minutesToContact: number | null; within30: number | null }
interface Camp extends Funnel { name: string; channel: string | null; cost: number | null; perLead: number | null; perReached: number | null; perTestDrive: number | null; perBooking: number | null }
interface Finding { tone: 'good' | 'bad' | 'neutral'; title: string; detail: string; action?: string; figure?: string; figureLabel?: string }
export interface AdToCarData { currency: string; total: Funnel; campaigns: Camp[]; branches: (Funnel & { branch: string })[]; models: (Funnel & { model: string })[]; waiting: number; stuckTestDrives: number; findings: Finding[]; hasSpend: boolean }

const STEPS: { k: keyof Funnel; label: string; cost?: keyof Camp }[] = [
  { k: 'leads', label: 'Leads', cost: 'perLead' }, { k: 'reached', label: 'Spoke to the customer', cost: 'perReached' },
  { k: 'tdBooked', label: 'Test drive booked', cost: 'perTestDrive' }, { k: 'tdGiven', label: 'Test drive given' },
  { k: 'booked', label: 'Car booked', cost: 'perBooking' }, { k: 'delivered', label: 'Delivered' },
];
const mins = (m: number | null) => (m === null ? '–' : m < 90 ? `${Math.round(m)} min` : m < 48 * 60 ? `${(m / 60).toFixed(1)} h` : `${Math.round(m / 1440)} days`);

/** From ad to car: every lead followed through the dealer's hands, with what each step cost. */
export function AdToCar({ a, fm }: { a: AdToCarData; fm: (v: number) => string }) {
  const t = a.total;
  // what each step cost: campaign spend over the leads those paid campaigns brought (not the free ones)
  const paid = a.campaigns.filter(c => c.cost);
  const spend = paid.reduce((s, c) => s + c.cost!, 0);
  const sum = (k: keyof Funnel) => paid.reduce((s, c) => s + (c[k] as number), 0);
  const per = (k: keyof Funnel) => (spend && sum(k) ? spend / sum(k) : null);
  const tc = { perLead: per('leads'), perReached: per('reached'), perTestDrive: per('tdBooked'), perBooking: per('booked') } as unknown as Camp;
  return (
    <section className="panel ad2car">
      <div className="panel-head"><div><h2>From ad to car</h2><p>Every lead followed through the dealer’s hands, from the dealer dashboard: who was reached, who booked a test drive, who bought{a.hasSpend ? ', and what each step cost from the campaigns’ spend' : '. Add the Google Ads or Meta reports to see what each step cost'}.</p></div></div>
      <div className="a2c-steps">{STEPS.map((s, i) => {
        const v = t[s.k] as number, prev = i ? (t[STEPS[i - 1]!.k] as number) : null;
        const cost = s.cost ? (tc[s.cost] as number | null) : null;
        return (
          <div className="a2c-step" key={s.k}>
            <span className="a2c-label">{s.label}</span>
            <b className="a2c-n">{v.toLocaleString('en-IN')}</b>
            <span className="a2c-bar"><i style={{ width: `${t.leads ? (v / t.leads) * 100 : 0}%` }} /></span>
            <span className="small muted">{prev !== null ? (prev ? `${pct(v / prev)} of the step before` : '') : `${mins(t.minutesToContact)} to first contact`}</span>
            {cost && <span className="small"><b>{fm(cost)}</b> each{paid.length < a.campaigns.length && i === 0 ? ' from paid campaigns' : ''}</span>}
          </div>
        );
      })}</div>

      {a.findings.length > 0 && <div className="insight-grid" style={{ marginTop: 16 }}>{a.findings.map((f, i) => (
        <div key={i} className={`insight ${f.tone === 'bad' ? 'leak' : f.tone === 'good' ? 'ok' : 'flow'}`}>
          <div className="fig"><b>{f.figure ?? '•'}</b>{f.figureLabel && <span>{f.figureLabel}</span>}</div>
          <div className="txt"><span className={`tag ${f.tone === 'bad' ? 'leak' : f.tone === 'good' ? 'ok' : 'plain'}`}>{f.tone === 'bad' ? 'Fix' : f.tone === 'good' ? 'Working' : 'Worth a look'}</span><b>{f.title}</b><span className="small">{f.detail}</span>{f.action && <span className="small"><b>Do:</b> {f.action}</span>}</div>
        </div>
      ))}</div>}

      <h3 className="a2c-h">By campaign</h3>
      <div className="a2c-table">
        <div className="a2c-row head"><span>Campaign</span><span className="num">Leads</span><span className="num">Spoke to</span><span className="num">Test drives</span><span className="num">Booked</span><span className="num">Per test drive</span><span className="num">Per booking</span></div>
        {a.campaigns.map(c => (
          <div className="a2c-row" key={c.name}>
            <span className="plan-name"><b className="clamp1" title={c.name}>{c.name}</b><span className="small muted">{c.channel ?? ''}{c.cost ? ` · ${fm(c.cost)} spent` : ''}</span></span>
            <span className="num">{c.leads}</span>
            <span className="num">{c.reached}<span className="muted small"> {c.leads ? pct(c.reached / c.leads) : ''}</span></span>
            <span className="num">{c.tdBooked}<span className="muted small"> {c.leads ? pct(c.tdBooked / c.leads) : ''}</span></span>
            <span className="num">{c.booked}</span>
            <span className="num"><b>{c.perTestDrive ? fm(c.perTestDrive) : '–'}</b></span>
            <span className="num"><b>{c.perBooking ? fm(c.perBooking) : '–'}</b></span>
          </div>
        ))}
      </div>

      <div className="grid-2" style={{ gap: 20, marginTop: 18 }}>
        <div>
          <h3 className="a2c-h">By branch</h3>
          <div className="a2c-table">
            <div className="a2c-row b head"><span>Branch</span><span className="num">Leads</span><span className="num">First contact</span><span className="num">Spoke to</span><span className="num">Test drives</span></div>
            {a.branches.map(b => (
              <div className="a2c-row b" key={b.branch}>
                <b className="clamp1">{b.branch}</b><span className="num">{b.leads}</span>
                <span className="num" style={{ color: b.minutesToContact !== null && b.minutesToContact > 60 ? 'var(--leak)' : undefined }}>{mins(b.minutesToContact)}</span>
                <span className="num">{b.leads ? pct(b.reached / b.leads) : '–'}</span><span className="num">{b.tdBooked}</span>
              </div>
            ))}
          </div>
        </div>
        <div>
          <h3 className="a2c-h">By model asked about</h3>
          <div className="a2c-models">{a.models.map(m => (
            <div key={m.model} className="a2c-model">
              <span className="clamp1">{m.model}</span>
              <span className="a2c-bar"><i style={{ width: `${(m.leads / (a.models[0]?.leads || 1)) * 100}%` }} /></span>
              <span className="small"><b>{m.leads}</b> leads · {m.tdBooked} test drives</span>
            </div>
          ))}</div>
        </div>
      </div>
    </section>
  );
}
