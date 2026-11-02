'use client';
import { Component, type ReactNode } from 'react';

/** Keeps one broken section from blanking the whole app; shows what happened and a way back. */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey: string }, { error: Error | null; key: string }> {
  state = { error: null as Error | null, key: this.props.resetKey };
  static getDerivedStateFromError(error: Error) { return { error }; }
  static getDerivedStateFromProps(p: { resetKey: string }, s: { key: string }) { return p.resetKey !== s.key ? { error: null, key: p.resetKey } : null; }
  componentDidCatch(error: Error) { console.error('[Vtology] section failed', error); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="error-box" role="alert" style={{ display: 'grid', gap: 10 }}>
        <b>This section couldn’t be shown.</b>
        <span>{this.state.error.message}</span>
        <div><button className="btn small" onClick={() => this.setState({ error: null })}>Try again</button></div>
      </div>
    );
  }
}
