'use client';
import { useCallback, useEffect, useState } from 'react';
import { loadSession, saveSession, setSignedOutHandler, type Session } from './api';
import { SignIn } from './SignIn';
import { Workspaces } from './Workspaces';
import { Dashboard } from './Dashboard';

const WS_KEY = 'vtology.workspace';

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);

  useEffect(() => {
    const s = loadSession();
    if (s) saveSession(s);
    setSession(s);
    try { setWorkspaceId(localStorage.getItem(WS_KEY)); } catch { /* ignore */ }
    setSignedOutHandler(() => setSession(null));
  }, []);

  const openWorkspace = useCallback((id: string | null) => {
    setWorkspaceId(id);
    try { if (id) localStorage.setItem(WS_KEY, id); else localStorage.removeItem(WS_KEY); } catch { /* ignore */ }
  }, []);

  const signOut = useCallback(() => { saveSession(null); setSession(null); openWorkspace(null); }, [openWorkspace]);

  if (session === undefined) return <div className="loading">Loading…</div>;
  if (!session) return <SignIn onSignedIn={s => setSession(s)} />;
  if (!workspaceId) return <Workspaces email={session.user.email} onOpen={openWorkspace} onSignOut={signOut} />;
  return <Dashboard key={workspaceId} workspaceId={workspaceId} email={session.user.email} onSwitch={openWorkspace} onSignOut={signOut} />;
}
