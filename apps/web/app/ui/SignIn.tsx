'use client';
import { useEffect, useState } from 'react';
import { authConfig, signIn, ApiError, type Session } from './api';

const FLOW = [[78, 6], [64, 14], [52, 30], [40, 22], [30, 9], [26, 0]];

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
        <div className="wordmark">Vtology</div>
        <div>
          <h1>See where your pipeline leaks.</h1>
          <p>Vtology joins your CRM, partner systems and ad platforms into one record of every customer journey, flags the numbers that don’t add up, and routes each fix to the person who can approve it.</p>
          <div className="mini-flow" aria-hidden="true">
            {FLOW.map(([up, down], i) => (
              <div className="mini-col" key={i}>
                <div className="up" style={{ height: `${up}px` }} />
                <div className="down" style={{ height: `${down}px` }} />
              </div>
            ))}
          </div>
        </div>
        <p className="small">Vanaya Ventures</p>
      </section>
      <section className="signin-form">
        <div>
          <h2>Sign in</h2>
          <p className="muted small" style={{ marginTop: 6 }}>Use the email and password your Vtology admin set up for you.</p>
        </div>
        {mode?.mode === 'local' && <div className="note-box">Local demo mode: use any email with the password <b>demo</b>.</div>}
        {mode && !mode.ready && <div className="error-box">Sign-in isn’t set up on this server yet: add SUPABASE_PUBLISHABLE_KEY in Vercel and redeploy.</div>}
        <form onSubmit={submit} style={{ display: 'grid', gap: 14 }}>
          <label className="field">Email
            <input className="input" type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} />
          </label>
          <label className="field">Password
            <input className="input" type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} />
          </label>
          {error && <div className="error-box" role="alert">{error}</div>}
          <button className="btn primary" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </form>
      </section>
    </main>
  );
}
