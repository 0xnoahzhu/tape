// "+ Add symbol": IB symbol search with suggestions and the target group chips.

import { useEffect, useMemo, useRef, useState } from 'react';
import { contractKey, contractLabel, stock } from '@shared/contract';
import type { WatchItem, Watchlist } from '@shared/types';
import { nameOf, useLang } from '../../i18n';
import { useCommon } from '../../i18n/common';
import { useStore } from '../../state/store';
import { TextInput } from '../../ui/primitives';
import { listingTag } from '../search/listing';
import { ListingName } from '../search/ListingName';
import { fillMissingName, updateList } from './actions';
import { DEFAULT_GROUP_NAME, useWatchlistMessages } from './messages';
import { addItem, listKeys, looksLikeTicker, normalizeTicker, suggestionsFrom, targetGroupOf, type Suggestion } from './model';
import { useSymbolSearch, type SearchResult } from './useSymbolSearch';

interface Row extends Suggestion {
  /** Typed ticker offered as a US stock because IB search is unavailable. */
  fallback?: boolean;
}

function rowsFor(search: SearchResult, exclude: Set<string>): Row[] {
  if (search.status === 'unavailable') {
    if (!looksLikeTicker(search.query)) return [];
    const contract = stock(normalizeTicker(search.query));
    return exclude.has(contractKey(contract)) ? [] : [{ contract, fallback: true }];
  }
  return suggestionsFrom(search.matches, search.query, exclude);
}

export function AddSymbol({ list, targetGroupId, onTarget, onClose }: { list: Watchlist; targetGroupId: string | undefined; onTarget: (groupId: string) => void; onClose: () => void }) {
  const m = useWatchlistMessages();
  const common = useCommon();
  const lang = useLang();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const enterPending = useRef(false);
  const search = useSymbolSearch(q);
  const exclude = useMemo(() => listKeys(list), [list]);
  const rows = useMemo(() => rowsFor(search, exclude), [search.query, search.status, search.matches, exclude]); // eslint-disable-line react-hooks/exhaustive-deps
  const target = targetGroupOf(list, targetGroupId);

  const add = (row: Row) => {
    const item: WatchItem = { contract: row.contract, ...(row.name ? { name: row.name } : {}) };
    updateList(list.id, (l) => addItem(l, target?.id, item, DEFAULT_GROUP_NAME));
    useStore.getState().showToast(m.addedTo(contractLabel(row.contract), nameOf(target?.name ?? DEFAULT_GROUP_NAME, lang)));
    if (!row.name) fillMissingName(list.id, row.contract);
    setQ('');
    setActive(-1);
    inputRef.current?.focus();
  };

  // Enter pressed before the results for the typed text arrived: add the first one when they do.
  useEffect(() => {
    if (!enterPending.current || search.status === 'loading') return;
    enterPending.current = false;
    if (rows[0]) add(rows[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.status, rows]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      if (search.status === 'loading') {
        enterPending.current = true;
        search.flush();
        return;
      }
      const row = rows[active >= 0 && active < rows.length ? active : 0];
      if (row) add(row);
    } else if (e.key === 'Escape') {
      onClose();
    } else if (e.key === 'ArrowDown' && rows.length) {
      e.preventDefault();
      setActive((i) => Math.min(rows.length - 1, i + 1));
    } else if (e.key === 'ArrowUp' && rows.length) {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    }
  };

  // Under the rows: why the list is empty, or that the typed ticker is offered without IB search.
  let status: string | null = null;
  if (search.status === 'unavailable') status = m.searchUnavailable;
  else if (!rows.length && search.status === 'loading') status = m.searching;
  else if (!rows.length && search.status === 'done') status = m.noMatches;

  return (
    <div style={{ padding: '10px 12px 12px', boxShadow: 'inset 0 -1px 0 var(--ln2)', display: 'flex', flexDirection: 'column', gap: 4, flexShrink: 0 }}>
      <TextInput
        inputRef={inputRef}
        autoFocus
        accent
        value={q}
        placeholder={m.addPh}
        onChange={(v) => {
          enterPending.current = false;
          setQ(v);
          setActive(-1);
        }}
        onKeyDown={onKeyDown}
      />
      {rows.map((row, i) => (
        <div
          key={contractKey(row.contract)}
          onClick={() => add(row)}
          onMouseDown={(e) => e.preventDefault()}
          className="hover-p2"
          style={{ height: 34, display: 'flex', alignItems: 'center', gap: 10, padding: '0 8px', cursor: 'pointer', background: i === active ? 'var(--p2)' : undefined }}
        >
          {/* At least the design's 52px, wider for long symbols ("BRK B", "RDS.A") so rows stay distinct. */}
          <div className="ellipsis" title={contractLabel(row.contract)} style={{ minWidth: 52, maxWidth: 112, flexShrink: 0, font: '600 13px/1 var(--mono)' }}>
            {contractLabel(row.contract)}
          </div>
          {/* Where it is listed ("NASDAQ", "MEXI · MXN", "Index") tells listings of one name apart. */}
          <ListingName name={row.fallback ? m.usStock : (row.name ?? '')} tag={listingTag(row.contract, common.index)} tagAtEnd style={{ flex: 1 }} />
        </div>
      ))}
      {status && <div style={{ height: 34, display: 'flex', alignItems: 'center', padding: '0 8px', fontSize: 12, color: 'var(--dm)' }}>{status}</div>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 6, fontSize: 12, color: 'var(--dm)' }}>
        <div>{m.addTo}</div>
        {list.groups.map((g) => {
          const on = g.id === target?.id;
          return (
            <div
              key={g.id}
              onClick={() => onTarget(g.id)}
              onMouseDown={(e) => e.preventDefault()}
              style={{ padding: '4px 8px', cursor: 'pointer', boxShadow: `inset 0 0 0 1px ${on ? 'var(--ac)' : 'var(--ln)'}`, color: on ? 'var(--tx)' : 'var(--mu)' }}
            >
              {nameOf(g.name, lang)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
