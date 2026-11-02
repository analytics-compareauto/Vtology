'use client';
import { useState } from 'react';
import { canDecide, type ActionCode } from '@vtology/core';
import type { WorkspaceData } from '../Dashboard';
import type { ActionDraft } from '../ActionDialog';
import { RULES, REQUEST_LABEL, inr, ago } from '../format';
import type { Finding } from '../api';

const ORDER = ['phantom_conversion', 'idle_opportunity', 'unattributed_spend', 'orphan_transaction', 'shared_identifier'];

export function Findings({ data, act }: { data: WorkspaceData; act: (d: ActionDraft) => void }) {
  const { findings, me } = data;
  const [open, setOpen] = useState<Record<string, boolean>>({});
  if (findings.length === 0) return <div className="empty">{me.lastRun ? 'Nothing in your view needs attention.' : 'No findings yet. Run matching on the Data tab.'}</div>;
  const seesMoney = findings.some(f => f.value_inr !== null);
  const rules = [...new Set(findings.map(f => f.rule))].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  const label = (code: ActionCode, verb: string) => (canDecide(code, me.role) ? verb : REQUEST_LABEL[code] ?? verb);

  const subject = (f: Finding) => f.rule === 'shared_identifier' ? f.detail : `${f.entity_ref}: ${f.detail}`;
  const actions = (f: Finding) => {
    const btn = (type: ActionCode, verb: string, objectId: string) => (
      <button key={type} className="btn small" onClick={() => act({ type, objectId, title: verb, subject: subject(f) })}>{label(type, verb)}</button>
    );
    if (f.rule === 'phantom_conversion') return [btn('hold_payout', 'Hold payout', f.id)];
    if (f.rule === 'idle_opportunity') return [f.partner_id && btn('escalate_partner', 'Escalate', f.partner_id), btn('hold_payout', 'Hold payout', f.id)];
    if (f.rule === 'shared_identifier') return [btn('keep_separate', 'Keep separate', f.entity_ref), btn('merge_records', 'Merge', f.entity_ref)];
    return [];
  };

  return (
    <section style={{ display: 'grid', gap: 18 }}>
      <div className="kpis">
        <div className="kpi"><span className="label">Findings</span><span className="value">{findings.length}</span><span className="sub">across {rules.length} kinds of problem</span></div>
        <div className="kpi leak"><span className="label">High severity</span><span className="value">{findings.filter(f => f.severity === 'high').length}</span><span className="sub">handle these first</span></div>
        <div className={`kpi${seesMoney ? ' leak' : ''}`}><span className="label">Money involved</span><span className="value">{seesMoney ? inr(findings.reduce((s, f) => s + Number(f.value_inr ?? 0), 0)) : 'Hidden'}</span><span className="sub">{seesMoney ? 'payouts, sales and spend in question' : 'money isn’t shown to your role'}</span></div>
        <div className="kpi"><span className="label">Biggest group</span><span className="value" style={{ fontSize: 20, lineHeight: 1.25, paddingTop: 6 }}>{RULES[[...rules].sort((a, b) => findings.filter(f => f.rule === b).length - findings.filter(f => f.rule === a).length)[0]!]?.title}</span></div>
      </div>
      <p className="muted small">From the matching run {me.lastRun ? ago(me.lastRun.finishedAt) : ''}. Each finding is checked again before any action changes data.</p>
      {rules.map(rule => {
        const items = findings.filter(f => f.rule === rule);
        const total = items.reduce((s, f) => s + Number(f.value_inr ?? 0), 0);
        const shown = open[rule] ? items : items.slice(0, 6);
        const meta = RULES[rule] ?? { title: rule, explain: '', who: '' };
        return (
          <article className="finding-group" key={rule}>
            <header>
              <div className="row-main">
                <h2><span className={`sev ${items.some(i => i.severity === 'high') ? 'high' : 'medium'}`} />{meta.title}</h2>
                <span className="nowrap"><b>{items.length}</b>{seesMoney && total > 0 ? <span className="muted">, {inr(total)}</span> : null}</span>
              </div>
              <p className="muted small" style={{ maxWidth: '72ch' }}>{meta.explain} {meta.who}</p>
            </header>
            <ul>
              {shown.map(f => (
                <li key={f.id}>
                  <span style={{ minWidth: 0 }}>
                    <b>{f.rule === 'shared_identifier' ? 'A phone number' : f.entity_ref}</b>
                    <span className="muted small" style={{ display: 'block' }}>{f.detail}</span>
                  </span>
                  <span className="toolbar">
                    {seesMoney && Number(f.value_inr) > 0 && <span className="small nowrap">{inr(f.value_inr)}</span>}
                    {actions(f)}
                  </span>
                </li>
              ))}
            </ul>
            {items.length > 6 && <div className="more"><button className="btn link" onClick={() => setOpen(o => ({ ...o, [rule]: !o[rule] }))}>{open[rule] ? 'Show fewer' : `Show all ${items.length}`}</button></div>}
          </article>
        );
      })}
    </section>
  );
}
