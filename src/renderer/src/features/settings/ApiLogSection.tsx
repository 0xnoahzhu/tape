// Settings › API log: every frame between the client and TWS / IB Gateway (store.apiLog),
// with filters, search, raw view, pause, clear, export, log-file and retention settings.

import { useApiLogStream } from '../../hooks/useApiLogStream';
import { memo, useCallback, useDeferredValue, useMemo, useState, type ReactNode } from 'react';
import { f0, hmsMs } from '@shared/format';
import type { ApiLogEntry } from '@shared/types';
import { maskAccounts } from '../../lib/account';
import { errorText } from '../../state/orderActions';
import { useStore } from '../../state/store';
import { SearchIcon } from '../../ui/icons';
import { Segmented, Toggle } from '../../ui/primitives';
import { countNewSince, filterLog, isInfo, logBody, logCounts, logDetail, newestFirst, tildify, type LogFilter } from './logic';
import { useSettingsMessages } from './messages';
import { SectionHeader, saveSettings } from './parts';

const COLS = '118px 84px 150px 64px minmax(0,1fr) 48px';
const MAX_ROWS = 300;
const KEEP_DAYS = [1, 3, 7, 30, 90];
const MIN_LIST_HEIGHT = 240;

export function ApiLogSection() {
  const m = useSettingsMessages();
  useApiLogStream();
  const live = useStore((s) => s.apiLog);
  const show = useStore((s) => s.settings.appearance.showAccountId);
  const logCfg = useStore((s) => s.settings.apiLog);
  const logFilePath = useStore((s) => s.logFilePath);
  const ask = useStore((s) => s.ask);
  const showToast = useStore((s) => s.showToast);

  const [filter, setFilter] = useState<LogFilter>('all');
  const [query, setQuery] = useState('');
  const [raw, setRaw] = useState(false);
  /** Snapshot shown while paused; recording continues in the store. */
  const [frozen, setFrozen] = useState<ApiLogEntry[] | null>(null);
  const [openSeq, setOpenSeq] = useState<number | null>(null);

  const src = frozen ?? live;
  const counts = useMemo(() => logCounts(src), [src]);
  const q = useDeferredValue(query);
  const matched = useMemo(() => filterLog(src, filter, q), [src, filter, q]);
  const rows = useMemo(() => newestFirst(matched, MAX_ROWS), [matched]);
  const newCount = frozen ? countNewSince(live, frozen) : 0;
  const toggleRow = useCallback((seq: number) => setOpenSeq((cur) => (cur === seq ? null : seq)), []);

  const clear = () =>
    ask({
      title: m.clearTitle,
      rows: [{ label: m.clearEntries, value: f0(live.length) }],
      note: m.clearNote,
      label: m.clearLabel,
      danger: true,
      run: async () => {
        try {
          await window.tape.clearApiLog();
          setFrozen(null);
          setOpenSeq(null);
        } catch (err) {
          showToast(errorText(err), 'error');
        }
      },
    });

  const exportLog = async () => {
    try {
      const path = await window.tape.exportApiLog();
      if (path) showToast(m.exported(tildify(path)));
    } catch (err) {
      showToast(errorText(err), 'error');
    }
  };

  const toggleWriteFile = () => saveSettings({ apiLog: { writeFile: !logCfg.writeFile } });

  return (
    <>
      <SectionHeader title={m.nav.log} desc={m.logDesc} descStyle={{ maxWidth: 820 }} />
      {/* One row down to the 1180px minimum window: the search field gives up width instead of wrapping. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Segmented
          options={(
            [
              ['all', m.fAll],
              ['out', m.fOut],
              ['in', m.fIn],
              ['err', m.fErr],
            ] as Array<[LogFilter, string]>
          ).map(([key, l]) => ({
            key,
            label: (
              <>
                <div>{l}</div>
                <div style={{ font: '11px/1 var(--num)', color: 'var(--dm)' }}>{f0(counts[key])}</div>
              </>
            ),
          }))}
          value={filter}
          onChange={setFilter}
          itemStyle={{ fontSize: 13, gap: 6, alignItems: 'baseline' }}
          style={{ flexShrink: 0 }}
        />
        <div
          style={{
            flex: 1,
            minWidth: 0,
            height: 34,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '0 12px',
            boxShadow: 'inset 0 0 0 1px var(--ln)',
          }}
        >
          <SearchIcon />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setQuery('');
            }}
            placeholder={m.search}
            spellCheck={false}
            style={{ flex: 1, minWidth: 0, border: 'none', background: 'transparent', color: 'var(--tx)', font: '13px/1 var(--mono)', textOverflow: 'ellipsis' }}
          />
        </div>
        <LogButton on={raw} onClick={() => setRaw(!raw)}>
          {m.raw}
        </LogButton>
        <LogButton on={frozen != null} onClick={() => setFrozen(frozen ? null : live)}>
          {frozen ? m.resume : m.pause}
        </LogButton>
        <LogButton onClick={clear}>{m.clear}</LogButton>
        <LogButton onClick={() => void exportLog()}>{m.export}</LogButton>
      </div>
      {/* Fills the rest of the panel (SettingsPage), so the footer stays on screen at any window height. */}
      <div style={{ flex: '1 0 auto', display: 'flex', flexDirection: 'column', boxShadow: 'inset 0 0 0 1px var(--ln)' }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: COLS,
            gap: 12,
            padding: '9px 14px',
            fontSize: 11,
            lineHeight: '14px',
            color: 'var(--dm)',
            boxShadow: 'inset 0 -1px 0 var(--ln)',
          }}
        >
          <div>{m.colTime}</div>
          <div>{m.colDir}</div>
          <div>{m.colMsg}</div>
          <div>ID</div>
          <div>{m.colBody}</div>
          <div style={{ textAlign: 'right' }}>{m.colBytes}</div>
        </div>
        {frozen && (
          <div onClick={() => setFrozen(null)} style={{ padding: '8px 14px', fontSize: 12, color: 'var(--ac)', background: 'var(--sel)', cursor: 'pointer' }}>
            {m.paused(f0(newCount))}
          </div>
        )}
        {/* About 500px at the design's 1440×900 window; the page scrolls instead below MIN_LIST_HEIGHT. */}
        <div style={{ flex: '1 1 0', minHeight: MIN_LIST_HEIGHT, overflow: 'auto', font: '12px/1 var(--mono)', fontVariantNumeric: 'tabular-nums' }}>
          {rows.length === 0 && <div style={{ padding: 14, font: '13px/1.5 var(--sans)', color: 'var(--dm)' }}>{src.length ? m.noMatch : m.emptyLog}</div>}
          {rows.map((e) => (
            <LogRow key={e.seq} e={e} open={openSeq === e.seq} raw={raw} show={show} sendL={m.send} recvL={m.recv} onToggle={toggleRow} />
          ))}
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            padding: '10px 14px',
            fontSize: 12,
            color: 'var(--dm)',
            boxShadow: 'inset 0 1px 0 var(--ln)',
          }}
        >
          <div style={{ flexShrink: 0 }}>{m.foot(f0(rows.length), f0(matched.length))}</div>
          <div style={{ flex: 1 }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <div onClick={toggleWriteFile} style={{ cursor: 'pointer', whiteSpace: 'nowrap' }}>
              {m.writeFile}
            </div>
            <div
              title={`${m.revealFile}: ${logFilePath}`}
              onClick={() => void window.tape.revealLogFile().catch((err: unknown) => showToast(errorText(err), 'error'))}
              className="hover-tx ellipsis"
              style={{ fontFamily: 'var(--mono)', color: 'var(--mu)', cursor: 'pointer', minWidth: 0 }}
            >
              {logFilePath ? tildify(logFilePath) : '—'}
            </div>
            <Toggle on={logCfg.writeFile} onClick={toggleWriteFile} />
          </div>
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            padding: '10px 14px',
            fontSize: 12,
            color: 'var(--dm)',
            boxShadow: 'inset 0 1px 0 var(--ln2)',
          }}
        >
          <div>{m.keep}</div>
          <div style={{ display: 'flex', gap: 4 }}>
            {KEEP_DAYS.map((d) => {
              const on = logCfg.keepDays === d;
              return (
                <div
                  key={d}
                  onClick={() => saveSettings({ apiLog: { keepDays: d } })}
                  style={{
                    padding: '5px 10px',
                    cursor: 'pointer',
                    font: '12px/1 var(--num)',
                    boxShadow: `inset 0 0 0 1px ${on ? 'var(--ac)' : 'var(--ln)'}`,
                    color: on ? 'var(--tx)' : 'var(--mu)',
                  }}
                >
                  {m.keepDays(d)}
                </div>
              );
            })}
          </div>
          <div style={{ flex: 1 }} />
          <div>{m.keepNote}</div>
        </div>
      </div>
    </>
  );
}

function LogButton({ on = false, onClick, children }: { on?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <div
      onClick={onClick}
      className={on ? undefined : 'hover-tx'}
      style={{
        height: 34,
        padding: '0 12px',
        display: 'flex',
        alignItems: 'center',
        fontSize: 13,
        cursor: 'pointer',
        boxShadow: `inset 0 0 0 1px ${on ? 'var(--ac)' : 'var(--ln)'}`,
        color: on ? 'var(--tx)' : 'var(--mu)',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </div>
  );
}

/** One log line plus its expanded detail. Memoized: new entries do not re-render existing rows. */
const LogRow = memo(function LogRow({
  e,
  open,
  raw,
  show,
  sendL,
  recvL,
  onToggle,
}: {
  e: ApiLogEntry;
  open: boolean;
  raw: boolean;
  show: boolean;
  sendL: string;
  recvL: string;
  onToggle: (seq: number) => void;
}) {
  const out = e.dir === 'out';
  const nameColor = e.err ? 'var(--r)' : isInfo(e) ? 'var(--mu)' : 'var(--tx)';
  return (
    <>
      <div
        onClick={() => onToggle(e.seq)}
        style={{
          display: 'grid',
          gridTemplateColumns: COLS,
          gap: 12,
          minHeight: 28,
          alignItems: 'center',
          padding: '0 14px',
          boxShadow: 'inset 0 -1px 0 var(--ln2)',
          cursor: 'pointer',
          background: open ? 'var(--sel)' : 'transparent',
        }}
      >
        <div style={{ color: 'var(--dm)' }}>{hmsMs(e.t)}</div>
        <div style={{ display: 'flex' }}>
          <div
            style={{
              padding: '3px 6px',
              font: '600 10.5px/1 var(--mono)',
              background: out ? 'var(--ac)' : 'transparent',
              color: out ? 'var(--acI)' : 'var(--tx)',
              boxShadow: `inset 0 0 0 1px ${out ? 'var(--ac)' : 'var(--ln)'}`,
              whiteSpace: 'nowrap',
            }}
          >
            {out ? sendL : recvL}
          </div>
        </div>
        <div className="ellipsis" style={{ color: nameColor }}>
          {e.name}
        </div>
        <div className="ellipsis" style={{ color: 'var(--mu)' }}>
          {e.reqId ?? ''}
        </div>
        <div className="ellipsis" style={{ color: e.err ? 'var(--r)' : 'var(--mu)' }}>
          {maskAccounts(raw ? e.raw : logBody(e), show)}
        </div>
        <div style={{ textAlign: 'right', color: 'var(--dm)' }}>{e.bytes}</div>
      </div>
      {open && (
        <div
          className="selectable"
          style={{
            padding: '12px 14px 14px 228px',
            background: 'var(--p2)',
            font: '11.5px/1.75 var(--mono)',
            color: 'var(--mu)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            boxShadow: 'inset 0 -1px 0 var(--ln2)',
          }}
        >
          {maskAccounts(logDetail(e), show)}
        </div>
      )}
    </>
  );
});
