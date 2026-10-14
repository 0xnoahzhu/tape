// Settings › Connection: host/port (a live trading port marked in red), connect/disconnect, status
// (with paper or live and, for a login with several accounts, each of them and the one orders go
// to), farms, recent API traffic, auto-reconnect, and the client id under Advanced. Changing host,
// port or client id while connected asks first (applyConnection), and so does turning auto-reconnect
// off (a dropped connection then stays down; a reconnect under way stops at once).

import { useApiLogStream } from '../../hooks/useApiLogStream';
import { useEffect, useRef, useState } from 'react';
import { hmsMs } from '@shared/format';
import type { ConnectionState, Settings } from '@shared/types';
import { accountRow, maskAccounts } from '../../lib/account';
import { errorText } from '../../state/orderActions';
import { useStore, type ConfirmRequest } from '../../state/store';
import { Segmented, TextInput } from '../../ui/primitives';
import { connectionChangeAsk, enteredPort, farmList, hostAppName, isLivePort, logBody, parseClientId, parseHost, parsePort, portForMode, statusDotColor } from './logic';
import { useSettingsMessages, type SettingsMessages } from './messages';
import { Disclosure, SectionHeader, SettingToggle, saveSettings } from './parts';

const MAX_RECONNECT_ATTEMPTS = 10;

export function ConnectionSection() {
  const m = useSettingsMessages();
  const cfg = useStore((s) => s.settings.connection);
  // IB refused the client id (326): show the field right away.
  const cidInUse = useStore((s) => s.connection.status !== 'connected' && s.connection.lastError?.code === 326);
  const apply = (patch: ConnectionPatch) => applyConnection(patch, m);
  const ask = useStore((s) => s.ask);
  const retrying = useStore((s) => s.connection.status === 'reconnecting');
  const toggleReconnect = () => {
    const save = () => saveSettings({ connection: { autoReconnect: !cfg.autoReconnect } });
    if (!cfg.autoReconnect) return void save();
    ask({
      title: m.reconnectOffTitle,
      rows: [{ label: m.host, value: `${cfg.host}:${cfg.port}` }],
      note: m.reconnectOffNote,
      warnings: retrying ? [m.reconnectOffNow] : undefined,
      label: m.ruleOffLabel,
      danger: true,
      run: save,
    });
  };
  // The Port field's text while it is being edited: the live port hint follows what is typed.
  const [portDraft, setPortDraft] = useState<string | null>(null);
  const port = enteredPort(portDraft, cfg.port);

  return (
    <>
      <SectionHeader title={m.nav.conn} desc={m.connDesc} />
      <Segmented
        options={[
          { key: 'tws', label: 'TWS' },
          { key: 'gateway', label: 'IB Gateway' },
        ]}
        value={cfg.mode}
        onChange={(mode) => {
          if (mode !== cfg.mode) void apply({ mode, port: portForMode(mode, cfg.port) });
        }}
        style={{ alignSelf: 'flex-start' }}
        itemStyle={{ padding: '8px 16px', fontSize: 14 }}
      />
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
        <DraftField label={m.host} value={cfg.host} parse={parseHost} invalidText={m.hostInvalid} commit={(host) => apply({ host })} />
        <DraftField label={m.port} value={String(cfg.port)} parse={parsePort} invalidText={m.portInvalid} commit={(port) => apply({ port })} onDraft={setPortDraft} />
      </div>
      {/* Also while disconnected (no reconnect dialog then): the next Connect trades real money. */}
      {isLivePort(port) && <div style={{ marginTop: -16, fontSize: 12, fontWeight: 600, color: 'var(--r)' }}>{m.livePortHint(hostAppName(port, cfg.mode))}</div>}
      <ConnectionStatus />
      <RecentTraffic />
      <SettingToggle
        label={m.autoReconnect}
        desc={m.autoReconnectD}
        on={cfg.autoReconnect}
        onToggle={toggleReconnect}
      />
      <Disclosure label={m.advanced} forceOpen={cidInUse}>
        <div style={{ width: CLIENT_ID_WIDTH }}>
          <DraftField label={m.clientId} value={String(cfg.clientId)} parse={parseClientId} invalidText={m.cidInvalid} commit={(clientId) => apply({ clientId })} />
        </div>
        <div style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--dm)', textWrap: 'pretty' }}>{m.cidHelp}</div>
      </Disclosure>
    </>
  );
}

/** Width of the Client ID field: the Port field's (1fr of Host / Port in the 720px section). */
const CLIENT_ID_WIDTH = 236;

type ConnectionPatch = Partial<Pick<Settings['connection'], 'mode' | 'host' | 'port' | 'clientId'>>;

/**
 * Saves connection parameters. Main reconnects as soon as host, port or client id change, so
 * while a session is live, or being (re)established, this asks first, like the Disconnect button:
 * editing the fields must not switch the session silently. The dialog names the account being
 * left, says that working orders stay at IB and which orders Tape can no longer cancel afterwards
 * (those of another client id), and in red when the new port is IB's live trading port. While
 * disconnected only a switch to a live port asks (the next Connect, or the next launch, trades
 * real money). Resolves once saved or dismissed.
 */
async function applyConnection(patch: ConnectionPatch, m: SettingsMessages): Promise<void> {
  const { connection: conn, settings } = useStore.getState();
  const cfg = settings.connection;
  const next = { ...cfg, ...patch };
  const addrChanged = next.host !== cfg.host || next.port !== cfg.port;
  const cidChanged = next.clientId !== cfg.clientId;
  const toLive = isLivePort(next.port);
  const asks = connectionChangeAsk(conn.status, cfg, next);
  if (asks === 'reconnect') {
    // Rows start from the session's values, as in the Disconnect dialog.
    const addr = `${conn.host}:${conn.port}`;
    const cid = String(conn.clientId);
    const showId = settings.appearance.showAccountId;
    const ok = await confirmAsync({
      // A move to a live port says so in the title and the address row, not only in the warning.
      title: toLive ? m.reconnectLiveTitle : m.reconnectTitle,
      rows: [
        ...(conn.account ? [accountRow(conn.isPaper, conn.account, showId)] : []),
        { label: m.host, value: addrChanged ? `${addr} → ${next.host}:${next.port}` : addr, ...(toLive ? { color: 'var(--r)' } : {}) },
        { label: m.clientId, value: cidChanged ? `${cid} → ${next.clientId}` : cid },
      ],
      warnings: toLive ? [m.livePort] : undefined,
      note: `${m.reconnectNote} ${cidChanged ? m.reconnectCid(conn.clientId) : m.reconnectOwn(conn.clientId)}`,
      label: m.reconnectLabel,
      danger: true,
    });
    if (!ok) return;
  } else if (asks === 'livePort') {
    const ok = await confirmAsync({
      title: m.livePortTitle,
      rows: [{ label: m.host, value: `${cfg.host}:${cfg.port} → ${next.host}:${next.port}` }],
      warnings: [m.livePort],
      note: m.livePortNote,
      label: m.livePortLabel,
      danger: true,
    });
    if (!ok) return;
  }
  await saveSettings({ connection: patch });
}

/** Shows the shared confirmation dialog; resolves true when confirmed, false when dismissed. */
function confirmAsync(req: Omit<ConfirmRequest, 'run'>): Promise<boolean> {
  return new Promise((resolve) => {
    const request: ConfirmRequest = { ...req, run: () => resolve(true) };
    const unsubscribe = useStore.subscribe((s) => {
      if (s.confirm === request) return;
      unsubscribe();
      // The dialog closes itself right before it calls run(), so let run() settle it first.
      queueMicrotask(() => resolve(false));
    });
    useStore.getState().ask(request);
  });
}

/**
 * Text input that keeps a local draft and commits a valid value on blur or Enter.
 * Escape reverts. Invalid drafts stay visible with a red ring and a hint. Once a commit
 * settles (saved, refused or dismissed) the field shows the persisted value again.
 */
function DraftField<T extends string | number>({
  label,
  value,
  parse,
  commit,
  invalidText,
  onDraft,
}: {
  label: string;
  value: string;
  parse: (s: string) => T | null;
  commit: (v: T) => Promise<void>;
  invalidText: string;
  /** Told the text being edited, and null once the field shows the persisted value again. */
  onDraft?: (draft: string | null) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  /** Text being committed; a second blur or Enter meanwhile does not commit it again. */
  const committing = useRef<string | null>(null);
  /** Set by Escape so the blur it causes does not commit the abandoned draft. */
  const reverting = useRef(false);
  const invalid = draft != null && parse(draft) == null;

  // A new persisted value (broadcast from main) replaces the draft unless the user is typing.
  useEffect(() => {
    if (document.activeElement !== ref.current) setDraft(null);
  }, [value]);

  useEffect(() => onDraft?.(draft), [draft, onDraft]);

  const finish = () => {
    if (draft == null) return;
    const v = parse(draft);
    if (v == null) return;
    const text = String(v);
    if (text === value) {
      setDraft(null);
      return;
    }
    if (committing.current === text) return;
    committing.current = text;
    setDraft(text);
    void commit(v).finally(() => {
      committing.current = null;
      // Show what main actually stored (it may differ), unless the user typed something else.
      setDraft((d) => (d === text ? null : d));
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {/* Fixed line height keeps CJK and Latin labels the same height, so fields side by side align. */}
      <div style={{ fontSize: 12, lineHeight: '14px', color: 'var(--dm)' }}>{label}</div>
      <TextInput
        inputRef={ref}
        value={draft ?? value}
        onChange={setDraft}
        onBlur={() => {
          if (!reverting.current) finish();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') finish();
          else if (e.key === 'Escape') {
            setDraft(null);
            reverting.current = true;
            ref.current?.blur();
            reverting.current = false;
          }
        }}
        height={40}
        // width auto (not 100%): the input's intrinsic width then counts as the grid column's
        // minimum, which keeps the design's Host / Port proportions.
        style={{ width: 'auto', padding: '0 12px', font: '14px/1 var(--num)', ...(invalid ? { boxShadow: 'inset 0 0 0 1px var(--r)' } : {}) }}
      />
      {invalid && <div style={{ fontSize: 12, color: 'var(--r)' }}>{invalidText}</div>}
    </div>
  );
}

function statusText(conn: ConnectionState, mode: 'tws' | 'gateway', showAccount: boolean, m: SettingsMessages): string {
  const addr = `${conn.host}:${conn.port}`;
  switch (conn.status) {
    case 'connected': {
      const accounts = conn.account ? [conn.account] : conn.accounts;
      const acct = showAccount && accounts.length ? ` ${accounts.join(', ')}` : '';
      const app = hostAppName(conn.port, mode);
      const parts = [m.connectedTo(app, addr), (conn.isPaper ? m.paperAccount : m.liveAccount) + acct];
      if (conn.serverVersion) parts.push(m.serverVersion(conn.serverVersion));
      // Connected, but orders cannot reach IB (see logic.ts → statusDotColor).
      if (conn.ibLinkLost) parts.push(m.ibLinkLost(app));
      else if (conn.unresponsive) parts.push(m.notResponding(app));
      return parts.join(' · ');
    }
    case 'connecting':
      return m.connecting(addr);
    case 'reconnecting': {
      const base = m.reconnecting(conn.reconnectAttempt ?? 1, MAX_RECONNECT_ATTEMPTS);
      return conn.lastError ? `${base} · ${errorLabel(conn.lastError)}` : base;
    }
    default:
      return conn.lastError ? `${m.notConnected} · ${errorLabel(conn.lastError)}` : m.notConnectedHelp;
  }
}

function errorLabel(e: { code: number; message: string }): string {
  return e.code > 0 ? `${e.code} ${e.message}` : e.message;
}

function ConnectionStatus() {
  const m = useSettingsMessages();
  const conn = useStore((s) => s.connection);
  const mode = useStore((s) => s.settings.connection.mode);
  const showAccount = useStore((s) => s.settings.appearance.showAccountId);
  const ask = useStore((s) => s.ask);
  const showToast = useStore((s) => s.showToast);

  const connected = conn.status === 'connected';
  const busy = conn.status === 'connecting' || conn.status === 'reconnecting';
  const farms = connected ? farmList(conn.farms) : [];
  const issue = connected ? conn.marketDataIssue : undefined;

  const disconnect = () => window.tape.disconnect().catch((err: unknown) => showToast(errorText(err), 'error'));
  const onClick = () => {
    if (connected) {
      ask({
        title: m.disconnect,
        rows: [
          { label: m.host, value: `${conn.host}:${conn.port}` },
          { label: m.clientId, value: String(conn.clientId) },
        ],
        note: m.disconnectNote,
        label: m.disconnectLabel,
        danger: true,
        run: disconnect,
      });
    } else if (busy) {
      void disconnect();
    } else {
      window.tape.connect().catch((err: unknown) => showToast(m.connectFailed(errorText(err)), 'error'));
    }
  };

  const primary = !connected && !busy;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <button
          onClick={onClick}
          style={{
            height: 40,
            padding: '0 20px',
            border: 'none',
            background: primary ? 'var(--ac)' : 'var(--p2)',
            color: primary ? 'var(--acI)' : 'var(--tx)',
            font: '600 14px/1 var(--sans)',
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          {connected ? m.disconnect : busy ? m.stop : m.connect}
        </button>
        <div className="selectable" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--mu)', lineHeight: 1.5, minWidth: 0 }}>
          <div style={{ width: 7, height: 7, flexShrink: 0, background: statusDotColor(conn) }} />
          <div>{maskAccounts(statusText(conn, mode, showAccount, m), showAccount)}</div>
        </div>
      </div>
      {connected && conn.accounts.length > 1 && <ManagedAccounts conn={conn} showId={showAccount} />}
      {farms.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 12, color: 'var(--dm)', marginRight: 4 }}>{m.farms}</div>
          {farms.map((f) => {
            const c = f.state === 'ok' ? 'var(--ac)' : f.state === 'broken' ? 'var(--r)' : 'var(--mu)';
            return (
              <div
                key={f.name}
                style={{
                  padding: '3px 7px',
                  font: '600 11px/1 var(--mono)',
                  color: c,
                  boxShadow: `inset 0 0 0 1px ${f.state === 'inactive' ? 'var(--ln)' : c}`,
                  whiteSpace: 'nowrap',
                }}
              >
                {f.name} · {f.state.toUpperCase()}
              </div>
            );
          })}
        </div>
      )}
      {issue && <IssueNote code={issue.code} message={issue.message} />}
    </div>
  );
}

/**
 * Every account of a login that manages several (an advisor or linked accounts): the one Tape's
 * orders go to is marked (red on a live login). Tape has no account picker: IB's first one is used.
 */
function ManagedAccounts({ conn, showId }: { conn: ConnectionState; showId: boolean }) {
  const m = useSettingsMessages();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div data-testid="managed-accounts" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 12, color: 'var(--dm)', marginRight: 4 }}>{m.accounts}</div>
        {conn.accounts.map((a) => {
          const active = a === conn.account;
          const c = active ? (conn.isPaper ? 'var(--ac)' : 'var(--r)') : 'var(--mu)';
          return (
            <div
              key={a}
              title={active ? m.ordersGoHereTip : undefined}
              style={{ padding: '3px 7px', font: '600 11px/1 var(--mono)', color: c, boxShadow: `inset 0 0 0 1px ${active ? c : 'var(--ln)'}`, whiteSpace: 'nowrap' }}
            >
              {maskAccounts(a, showId)}
              {active ? ` · ${m.ordersGoHere}` : ''}
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--dm)', textWrap: 'pretty' }}>{m.accountsNote}</div>
    </div>
  );
}

/** Muted explanation of a market-wide data problem such as 10197. */
export function IssueNote({ code, message }: { code: number; message: string }) {
  const m = useSettingsMessages();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, lineHeight: 1.6, color: 'var(--dm)' }}>
      <div className="selectable" style={{ fontFamily: 'var(--mono)', color: 'var(--mu)' }}>
        {code} · {message}
      </div>
      {m.issue[code] && <div style={{ textWrap: 'pretty' }}>{m.issue[code]}</div>}
    </div>
  );
}

/** The last five API log entries and a link to the full log. */
function RecentTraffic() {
  const m = useSettingsMessages();
  useApiLogStream();
  const log = useStore((s) => s.apiLog);
  const showAccount = useStore((s) => s.settings.appearance.showAccountId);
  const openSettings = useStore((s) => s.openSettings);
  const recent = log.slice(-5);
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '14px 16px',
        background: 'var(--p2)',
        font: '12px/1.7 var(--mono)',
        color: 'var(--mu)',
      }}
    >
      {recent.length === 0 && <div style={{ color: 'var(--dm)', fontFamily: 'var(--sans)' }}>{m.noMessages}</div>}
      {recent.map((e) => (
        <div key={e.seq} style={{ display: 'flex', gap: 12, whiteSpace: 'nowrap', overflow: 'hidden' }}>
          <div style={{ color: 'var(--dm)' }}>{hmsMs(e.t)}</div>
          <div style={{ width: 64, flexShrink: 0, color: e.dir === 'out' ? 'var(--ac)' : 'var(--mu)' }}>{e.dir === 'out' ? '→ SEND' : '← RECV'}</div>
          <div style={{ color: e.err ? 'var(--r)' : 'var(--tx)' }}>{e.name}</div>
          <div style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{maskAccounts(logBody(e), showAccount)}</div>
        </div>
      ))}
      <div
        onClick={() => openSettings('log')}
        style={{ marginTop: 4, fontFamily: 'var(--sans)', color: 'var(--ac)', cursor: 'pointer', alignSelf: 'flex-start' }}
      >
        {m.viewAll}
      </div>
    </div>
  );
}
