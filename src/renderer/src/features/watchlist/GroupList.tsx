// Scrollable body of the watchlist: collapsible groups, quote rows and "+ New group".

import { memo, useCallback, useRef, useState, type MouseEvent } from 'react';
import { contractKey, contractLabel, isTradable } from '@shared/contract';
import { pct, px, signColor } from '@shared/format';
import type { Lang, WatchItem, Watchlist } from '@shared/types';
import { changePct, lastPrice } from '../../hooks/useQuotes';
import { useCommon } from '../../i18n/common';
import { nameOf, useLang } from '../../i18n';
import { useStore } from '../../state/store';
import { TextInput } from '../../ui/primitives';
import { updateList } from './actions';
import { useWatchlistMessages } from './messages';
import { createGroup, itemKey, newId } from './model';
import { groupPrefKey, loadClosedGroups, saveClosedGroups } from './prefs';

/** IB error "requires additional subscription"; delayed data, when enabled, follows it. */
const NO_LIVE_SUBSCRIPTION = 10089;

export function GroupList({
  list,
  onRowMenu,
  onGroupCreated,
}: {
  list: Watchlist;
  onRowMenu: (e: MouseEvent, groupId: string, item: WatchItem) => void;
  onGroupCreated: (groupId: string) => void;
}) {
  const m = useWatchlistMessages();
  const lang = useLang();
  const selectedKey = useStore((s) => contractKey(s.symbol));
  const [closed, setClosed] = useState(loadClosedGroups);
  const [naming, setNaming] = useState(false);
  const [groupName, setGroupName] = useState('');

  const toggleGroup = (groupId: string) => {
    const k = groupPrefKey(list.id, groupId);
    setClosed((prev) => {
      const next = { ...prev };
      if (next[k]) delete next[k];
      else next[k] = true;
      saveClosedGroups(next);
      return next;
    });
  };

  const pick = useCallback((item: WatchItem) => {
    const s = useStore.getState();
    if (!isTradable(item.contract)) {
      s.showToast(useCommon.now().indexNotTradable(contractLabel(item.contract)));
      return;
    }
    s.selectSymbol(item.contract, item.name);
  }, []);

  const createNamedGroup = () => {
    const name = groupName.trim();
    setNaming(false);
    setGroupName('');
    if (!name) return;
    const id = newId('g');
    updateList(list.id, (l) => createGroup(l, name, id));
    onGroupCreated(id);
  };

  return (
    <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 'var(--rowGap)', padding: '4px 8px 8px' }}>
      {list.groups.map((g) => {
        const open = !closed[groupPrefKey(list.id, g.id)];
        return (
          <GroupSection key={g.id} name={nameOf(g.name, lang)} count={g.items.length} open={open} onToggle={() => toggleGroup(g.id)}>
            {g.items.map((item) => {
              const k = itemKey(item);
              return <WatchRow key={k} item={item} groupId={g.id} lang={lang} selected={k === selectedKey} onPick={pick} onMenu={onRowMenu} />;
            })}
          </GroupSection>
        );
      })}
      {naming ? (
        <NewGroupInput
          value={groupName}
          placeholder={m.groupPh}
          onChange={setGroupName}
          onCommit={createNamedGroup}
          onCancel={() => {
            setNaming(false);
            setGroupName('');
          }}
        />
      ) : (
        <div
          onClick={() => setNaming(true)}
          className="hover-tx"
          style={{ height: 34, flexShrink: 0, display: 'flex', alignItems: 'center', padding: '0 8px 0 26px', fontSize: 12, color: 'var(--dm)', cursor: 'pointer' }}
        >
          {m.newGroup}
        </div>
      )}
    </div>
  );
}

function GroupSection({ name, count, open, onToggle, children }: { name: string; count: number; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <>
      <div
        onClick={onToggle}
        style={{ height: 34, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '0 8px', cursor: 'pointer', fontSize: 12, color: 'var(--mu)' }}
      >
        <div style={{ width: 10, flexShrink: 0, fontSize: 8, color: 'var(--dm)' }}>{open ? '▼' : '▶'}</div>
        <div className="ellipsis" title={name} style={{ minWidth: 0, fontWeight: 600 }}>
          {name}
        </div>
        <div style={{ flexShrink: 0, font: '11px/1 var(--num)', color: 'var(--dm)' }}>{count}</div>
      </div>
      {open && children}
    </>
  );
}

/** One instrument: symbol and name on the left, last price and change on the right. */
const WatchRow = memo(function WatchRow({
  item,
  groupId,
  lang,
  selected,
  onPick,
  onMenu,
}: {
  item: WatchItem;
  groupId: string;
  lang: Lang;
  selected: boolean;
  onPick: (item: WatchItem) => void;
  onMenu: (e: MouseEvent, groupId: string, item: WatchItem) => void;
}) {
  const m = useWatchlistMessages.for(lang);
  const key = contractKey(item.contract);
  const q = useStore((s) => s.quotes[key]);
  const last = lastPrice(q);
  const chg = changePct(q);
  const name = nameOf(item.name, lang);
  // IB refused the subscription (e.g. 354 not subscribed) and nothing arrived: say so instead of
  // a bare "—". 10089 (no live subscription) is followed by delayed data when that is enabled.
  const noData = q?.error != null && q.error.code !== NO_LIVE_SUBSCRIPTION && last == null;
  const currency = item.contract.currency;
  return (
    <div
      onClick={() => onPick(item)}
      onContextMenu={(e) => onMenu(e, groupId, item)}
      style={{
        height: 52,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 12px 0 24px',
        cursor: 'pointer',
        background: selected ? 'var(--sel)' : 'transparent',
        boxShadow: selected ? 'inset 2px 0 0 var(--ac)' : 'none',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <div style={{ fontWeight: 600 }}>{contractLabel(item.contract)}</div>
          {/* Non-USD listings look like the US one otherwise ("IBM" on IBIS is quoted in EUR). */}
          {currency && currency !== 'USD' && <div style={{ font: '10.5px/1 var(--mono)', color: 'var(--dm)' }}>{currency}</div>}
        </div>
        <div className="ellipsis" title={name || undefined} style={{ fontSize: 12, color: 'var(--dm)' }}>
          {name || ' '}
        </div>
      </div>
      <div
        className="num"
        title={q?.error ? `${q.error.code} · ${q.error.message}` : undefined}
        style={{ display: 'flex', flexDirection: 'column', gap: 5, alignItems: 'flex-end', flexShrink: 0, paddingLeft: 8 }}
      >
        <div>{px(last)}</div>
        {noData ? <div style={{ fontSize: 12, color: 'var(--dm)' }}>{m.noData}</div> : <div style={{ fontSize: 12, color: signColor(chg) }}>{pct(chg)}</div>}
      </div>
    </div>
  );
});

function NewGroupInput({
  value,
  placeholder,
  onChange,
  onCommit,
  onCancel,
}: {
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  // Enter / Escape unmount the input, which can fire a trailing blur; ignore it.
  const done = useRef(false);
  return (
    <div style={{ padding: '6px 8px' }}>
      <TextInput
        autoFocus
        accent
        value={value}
        placeholder={placeholder}
        onChange={onChange}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Enter') {
            done.current = true;
            onCommit();
          } else if (e.key === 'Escape') {
            done.current = true;
            onCancel();
          }
        }}
        onBlur={() => {
          // As in the design: leaving an empty input cancels, a typed name stays.
          if (!done.current && !value.trim()) onCancel();
        }}
      />
    </div>
  );
}
