// Keeps a failing feature from blanking the whole window.

import { Component, type CSSProperties, type ReactNode } from 'react';
import { useCommon } from '../i18n/common';

interface Props {
  /** Area name for the console; not shown to the user. */
  name: string;
  children: ReactNode;
  /** Grid/flex placement of the fallback, so the layout stays intact. */
  style?: CSSProperties;
  /** Replaces the default fallback (it can keep controls around ErrorFallback). */
  fallback?: (error: Error, retry: () => void) => ReactNode;
}

export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error) {
    console.error(`[${this.props.name}]`, error);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    const retry = () => this.setState({ error: null });
    if (this.props.fallback) return this.props.fallback(this.state.error, retry);
    return <ErrorFallback error={this.state.error} style={this.props.style} onRetry={retry} />;
  }
}

export function ErrorFallback({ error, style, onRetry }: { error: Error; style?: CSSProperties; onRetry: () => void }) {
  const m = useCommon();
  return (
    <div
      style={{
        background: 'var(--p)',
        padding: '16px 20px',
        fontSize: 12,
        color: 'var(--r)',
        fontFamily: 'var(--mono)',
        whiteSpace: 'pre-wrap',
        overflow: 'auto',
        ...style,
      }}
    >
      {m.renderFailed}: {error.message}
      <button
        onClick={onRetry}
        style={{ display: 'block', marginTop: 8, padding: 0, border: 'none', background: 'transparent', color: 'var(--ac)', font: '12px/1.4 var(--sans)' }}
      >
        {m.retry}
      </button>
    </div>
  );
}
