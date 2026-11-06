'use client';
import { useEffect, useState } from 'react';
import type { WorkspaceData } from '../Dashboard';
import type { Range } from '../DateRange';
import { Growth } from './Growth';
import { Social } from './Social';
import { Content } from './Content';

export type SocialView = 'growth' | 'posts' | 'content';
const VIEWS: { id: SocialView; label: string; lead: string }[] = [
  { id: 'growth', label: 'Growth and competitors', lead: 'Followers, reach and engagement against the previous period and your competitors, with a plan to grow.' },
  { id: 'posts', label: 'Your posts and ads', lead: 'What your posts and paid social campaigns achieve, and what to change.' },
  { id: 'content', label: 'Content and YouTube search', lead: 'Standout posts (yours and competitors’), the top searches in your category and who ranks, and fixes for your videos.' },
];

/** Social: one tab for growth against competitors, your posts and ads, and content. */
export function SocialHub({ data, workspaceId, notify, range, onRange, initialView }: { data: WorkspaceData; workspaceId: string; notify: (m: string) => void; range: Range; onRange: (r: Range) => void; initialView?: SocialView }) {
  const [view, setView] = useState<SocialView>(initialView ?? 'growth');
  useEffect(() => { try { const u = new URL(window.location.href); u.searchParams.set('tab', 'social'); if (view === 'growth') u.searchParams.delete('view'); else u.searchParams.set('view', view); window.history.replaceState(null, '', u); } catch { /* ignore */ } }, [view]);
  const cur = VIEWS.find(v => v.id === view)!;
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div className="toolbar no-print media-nav">
        <div className="seg" role="tablist" aria-label="Social views">
          {VIEWS.map(v => <button key={v.id} role="tab" aria-selected={view === v.id} aria-pressed={view === v.id} onClick={() => { setView(v.id); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>{v.label}</button>)}
        </div>
      </div>
      <p className="small muted" style={{ margin: '-6px 0 0' }}>{cur.lead}</p>
      {view === 'growth' && <Growth data={data} workspaceId={workspaceId} notify={notify} range={range} onRange={onRange} />}
      {view === 'posts' && <Social data={data} workspaceId={workspaceId} notify={notify} range={range} onRange={onRange} />}
      {view === 'content' && <Content workspaceId={workspaceId} notify={notify} range={range} onRange={onRange} />}
    </div>
  );
}
