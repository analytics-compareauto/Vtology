'use client';
import { useEffect, useState } from 'react';
import { authConfig, signIn, ApiError, type Session } from './api';
import { BrandMark } from './icons';

// moving (above the line) and idle (below it) at each stage of a journey
const FLOW = [[118, 8], [96, 22], [78, 44], [60, 30], [44, 14], [36, 4], [30, 0]];

export function SignIn({ onSignedIn }: { onSignedIn: (s: Session) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<{ mode: 'local' | 'supabase'; ready: boolean } | null>(null);

  useEffect(() => { authConfig().then(setMode).catch(() => setMode(null)); }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { onSignedIn(await signIn(email, password)); }
    catch (err) { setError(err instanceof ApiError ? err.message : 'Could not reach Vtology. Check your connection and try again.'); }
    finally { setBusy(false); }
  }

  return (
    <main className="signin">
      <section className="signin-story">
        <div className="brand"><BrandMark />Vtology</div>
        <div>
          <h1>See where your pipeline leaks.</h1>
          <p>One record of every customer journey, from first ad click to final sale, across your CRM, partners and ad platforms. Vtology shows what is moving, what has gone cold, and which numbers don’t add up.</p>
          <div className="waterline" aria-hidden="true">
            {FLOW.map(([up, down], i) => (
              <div className="col" key={i}>
                <div className="up" style={{ height: `${up}px` }} />
                <div className="line" />
                <div className="down" style={{ height: `${down}px` }} />
              </div>
            ))}
          </div>
          <div className="waterline-legend" aria-hidden="true"><span><i style={{ background: '#6d8ff0' }} />Moving forward</span><span><i style={{ background: '#f06b7a' }} />Idle, going cold</span></div>
        </div>
        <p className="small" style={{ color: 'var(--night-muted)' }}>Vanaya Ventures</p>
      </section>
      <section className="signin-form">
        <div>
          <h2>Sign in</h2>
          <p className="muted small" style={{ marginTop: 6 }}>Use the email and password your Vtology admin set up for you.</p>
        </div>
        {mode?.mode === 'local' && <div className="note-box">Local demo mode: use any email with the password <b>demo</b>.</div>}
        {mode && !mode.ready && <div className="error-box">Sign-in isn’t set up on this server yet: add SUPABASE_PUBLISHABLE_KEY in Vercel and redeploy.</div>}
        <form onSubmit={submit} style={{ display: 'grid', gap: 16 }}>
          <label className="field">Email
            <input className="input" type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} />
          </label>
          <label className="field">Password
            <input className="input" type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} />
          </label>
          {error && <div className="error-box" role="alert">{error}</div>}
          <button className="btn primary" type="submit" disabled={busy} style={{ padding: '11px 14px' }}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </form>
      </section>
    </main>
  );
}
