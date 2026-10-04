// Settings › Market data › Local cache: what tape.db holds (size, series, bars) and a button that
// clears the cached market data after a confirmation. Executions and the NAV history are kept.

import { useCallback, useEffect, useState } from 'react';
import { compact, f0, ymd } from '@shared/format';
import type { CacheStats } from '@shared/types';
import { errorText } from '../../state/orderActions';
import { useStore } from '../../state/store';
import { Chip } from '../../ui/primitives';
import { formatBytes } from './logic';
import { useSettingsMessages } from './messages';
import { SubHeader } from './parts';

/** Stats are read again this often while the block is shown. */
const REFRESH_MS = 15_000;

export function LocalCacheBlock() {
  const m = useSettingsMessages();
  const ask = useStore((s) => s.ask);
  const showToast = useStore((s) => s.showToast);
  /** null while loading, 'error' when the main process could not tell. */
  const [stats, setStats] = useState<CacheStats | 'error' | null>(null);
  const [clearing, setClearing] = useState(false);

  const refresh = useCallback(
    () =>
      window.tape.getCacheStats().then(
        (s) => setStats(s),
        () => setStats('error'),
      ),
    [],
  );
  // Charts keep filling the cache while this page is open.
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const known = stats && stats !== 'error' ? stats : null;
  const busy = clearing || stats === null;
  const line = known ? m.cacheLine(formatBytes(known.bytes), known.series, known.bars) : stats === 'error' ? m.cacheUnavailable : m.cacheLoading;

  const clear = () =>
    ask({
      title: m.cacheClearTitle,
      rows: known
        ? [
            { label: m.cacheSize, value: formatBytes(known.bytes) },
            { label: m.cacheSeries, value: f0(known.series) },
            { label: m.cacheBars, value: compact(known.bars) },
          ]
        : [],
      note: m.cacheClearNote,
      label: m.cacheClear,
      danger: true,
      run: async () => {
        setClearing(true);
        try {
          await window.tape.clearMarketDataCache();
          showToast(m.cacheCleared);
        } catch (err) {
          showToast(errorText(err), 'error');
        } finally {
          await refresh();
          setClearing(false);
        }
      },
    });

  return (
    <>
      <SubHeader title={m.cacheTitle} desc={m.cacheDesc} />
      <div data-cache="row" style={{ minHeight: 60, display: 'flex', alignItems: 'center', gap: 16, marginTop: -14, boxShadow: 'inset 0 -1px 0 var(--ln2)' }}>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4, padding: '10px 0' }}>
          <div data-cache="stats" className="ellipsis" style={{ font: '13px/1.3 var(--num)', fontVariantNumeric: 'tabular-nums', color: known ? 'var(--tx)' : 'var(--mu)' }}>
            {line}
          </div>
          {known?.oldestAccess != null && <div style={{ fontSize: 12, color: 'var(--dm)' }}>{m.cacheOldest(ymd(known.oldestAccess))}</div>}
        </div>
        <Chip active={false} onClick={busy ? undefined : clear} style={{ fontSize: 13, padding: '8px 12px', opacity: busy ? 0.5 : 1 }}>
          <span data-cache="clear">{clearing ? m.cacheClearing : m.cacheClear}</span>
        </Chip>
      </div>
    </>
  );
}
