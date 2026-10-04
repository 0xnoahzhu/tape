// Symbol search in the top bar (⌘K), design lines 39-44: type a ticker or name, pick a result,
// and the instrument opens on the Trade page. Orders are entered in the order ticket.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { contractKey, isTradable, sameContract } from '@shared/contract';
import { pct, px, signColor } from '@shared/format';
import type { ContractRef, LocalizedName, SymbolMatch, Watchlist } from '@shared/types';
import { createMessages, nameOf, useLang } from '../../i18n';
import { useCommon } from '../../i18n/common';
import { changePct, lastPrice, useQuote, useQuoteSubscriptions } from '../../hooks/useQuotes';
import { useStore } from '../../state/store';
import { resolveSymbol } from './resolveSymbol';
import { useSymbolSearch } from './useSymbolSearch';

const useM = createMessages({
  en: { placeholder: 'Search symbol or name' },
  zh: { placeholder: '搜索代码或名称' },
});

const MAX_ROWS = 8;
/** Quotes for the result rows are requested only after typing pauses (market data lines are scarce). */
const QUOTE_DELAY_MS = 400;
/** What a plain ticker looks like (used when Enter is pressed without any result). */
const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;

/** Watchlist entries matching the term: used when IB search is unavailable. */
function localMatches(term: string, watchlists: Watchlist[], lang: 'en' | 'zh'): SymbolMatch[] {
  const seen = new Set<string>();
  const out: SymbolMatch[] = [];
  for (const list of watchlists)
    for (const g of list.groups)
      for (const i of g.items) {
        const k = contractKey(i.contract);
        const name = nameOf(i.name, lang);
        if (seen.has(k) || !(i.contract.symbol.toUpperCase().startsWith(term) || name.toUpperCase().includes(term))) continue;
        seen.add(k);
        out.push({ contract: i.contract, description: name, derivativeSecTypes: [] });
      }
  return out;
}

/** Design order: symbols starting with the term first, then shorter symbols. */
function rank(rows: SymbolMatch[], term: string): SymbolMatch[] {
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const pa = a.r.contract.symbol.toUpperCase().startsWith(term) ? 0 : 1;
      const pb = b.r.contract.symbol.toUpperCase().startsWith(term) ? 0 : 1;
      return pa - pb || a.r.contract.symbol.length - b.r.contract.symbol.length || a.i - b.i;
    })
    .map((x) => x.r);
}

function ResultRow({ match, selected, onPick }: { match: SymbolMatch; selected: boolean; onPick: () => void }) {
  const q = useQuote(match.contract);
  const last = lastPrice(q);
  const chg = changePct(q);
  return (
    <div
      onMouseDown={(e) => {
        e.preventDefault();
        onPick();
      }}
      className="hover-p2"
      style={{
        height: 40,
        display: 'grid',
        gridTemplateColumns: '64px minmax(0,1fr) auto 64px',
        gap: 12,
        alignItems: 'center',
        padding: '0 12px',
        cursor: 'pointer',
        background: selected ? 'var(--sel)' : 'transparent',
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      <div style={{ font: '600 13px/1 var(--mono)', whiteSpace: 'nowrap', overflow: 'hidden' }}>{match.contract.symbol}</div>
      <div className="ellipsis" style={{ fontSize: 12, color: 'var(--mu)' }}>
        {match.description}
      </div>
      <div style={{ font: '13px/1 var(--num)' }}>{px(last)}</div>
      <div style={{ font: '12px/1 var(--num)', color: signColor(chg), textAlign: 'right' }}>{pct(chg)}</div>
    </div>
  );
}

export function SymbolSearch() {
  const m = useM();
  const common = useCommon();
  const lang = useLang();
  const mac = useStore((s) => s.platform === 'darwin');
  const searchFocus = useStore((s) => s.searchFocus);
  const watchlists = useStore((s) => s.watchlists);

  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  // ⌘K / the "Search" menu item bump the counter.
  const initialFocus = useRef(searchFocus);
  useEffect(() => {
    if (searchFocus === initialFocus.current) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [searchFocus]);

  const term = text.trim().toUpperCase();
  const search = useSymbolSearch(term);
  const fresh = search.term === term;
  const rows = useMemo(() => {
    // While a newer term is loading, keep the previous results that still fit it.
    const ib = fresh ? search.matches : search.matches.filter((r) => r.contract.symbol.toUpperCase().startsWith(term));
    const src = fresh && search.error ? localMatches(term, watchlists, lang) : ib;
    return term ? rank(src, term).slice(0, MAX_ROWS) : [];
  }, [fresh, search.matches, search.error, term, watchlists, lang]);

  useEffect(() => setSel(0), [term]);

  // Live price and change for the rows, requested once the list has settled.
  const [quoted, setQuoted] = useState<ContractRef[]>([]);
  useEffect(() => {
    const t = setTimeout(() => setQuoted(rows.map((r) => r.contract)), rows.length ? QUOTE_DELAY_MS : 0);
    return () => clearTimeout(t);
  }, [rows]);
  useQuoteSubscriptions('search', focused ? quoted : [], 'basic');

  const clear = () => {
    setText('');
    inputRef.current?.blur();
  };

  /** Fills the display name later when the result had none. */
  const fillName = (contract: ContractRef) => {
    window.tape
      .getContractInfo(contract)
      .then((info) => {
        const s = useStore.getState();
        if (info?.longName && sameContract(s.symbol, contract) && !s.symbolName) useStore.setState({ symbolName: info.longName });
      })
      .catch(() => {});
  };

  const open = (contract: ContractRef, name: LocalizedName | undefined) => {
    const s = useStore.getState();
    clear();
    if (!isTradable(contract)) {
      s.showToast(common.indexNotTradable(contract.symbol));
      return;
    }
    // The order ticket is not shown on the options view.
    s.openSymbol(contract, s.view === 'opt' ? 'chart' : undefined, name || '');
    if (!name) fillName(contract);
  };

  const onEnter = () => {
    const row = rows[sel] ?? rows[0];
    if (row) return open(row.contract, row.description);
    // No result (e.g. IB search unavailable): open a plain ticker as a known instrument or US stock.
    if (!TICKER_RE.test(term)) return;
    const s = useStore.getState();
    const resolved = resolveSymbol(term, { matches: fresh ? search.matches : [], watchlists: s.watchlists, positions: s.positions });
    open(resolved.contract, resolved.name);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    const n = rows.length;
    switch (e.key) {
      case 'ArrowDown':
        if (!n) return;
        e.preventDefault();
        setSel((i) => (i + 1) % n);
        break;
      case 'ArrowUp':
        if (!n) return;
        e.preventDefault();
        setSel((i) => (i - 1 + n) % n);
        break;
      case 'Enter':
        e.preventDefault();
        onEnter();
        break;
      case 'Escape':
        e.preventDefault();
        clear();
        break;
    }
  };

  const showMenu = focused && rows.length > 0;
  const [rect, setRect] = useState<DOMRect | null>(null);
  useLayoutEffect(() => {
    if (!showMenu) return;
    const update = () => setRect(boxRef.current?.getBoundingClientRect() ?? null);
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [showMenu]);

  return (
    <div
      ref={boxRef}
      className="no-drag"
      onMouseDown={(e) => {
        if (e.target !== inputRef.current) {
          e.preventDefault();
          inputRef.current?.focus();
        }
      }}
      // The design's box is content-box: 420px plus 2 × 12px padding.
      style={{ flex: 1, maxWidth: 444, height: 36, display: 'flex', alignItems: 'center', gap: 10, padding: '0 12px', background: 'var(--p2)', marginLeft: 12, cursor: 'text' }}
    >
      <div style={{ color: 'var(--dm)' }}>⌕</div>
      <input
        ref={inputRef}
        value={text}
        placeholder={m.placeholder}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{ flex: 1, minWidth: 0, border: 'none', padding: 0, background: 'transparent', color: 'var(--tx)', font: '14px/1 var(--sans)', textOverflow: 'ellipsis' }}
      />
      <div style={{ font: '11px/1 var(--mono)', color: 'var(--dm)', boxShadow: 'inset 0 0 0 1px var(--ln)', padding: '3px 5px', whiteSpace: 'nowrap' }}>{mac ? '⌘K' : 'Ctrl+K'}</div>
      {showMenu &&
        rect &&
        createPortal(
          <div
            className="no-drag"
            onMouseDown={(e) => e.preventDefault()}
            style={{
              position: 'fixed',
              left: rect.left,
              top: rect.top + 40,
              width: rect.width,
              zIndex: 30,
              background: 'var(--p)',
              boxShadow: '0 0 0 1px var(--ln), 0 12px 32px rgba(0,0,0,.2)',
              padding: '4px 0',
              display: 'flex',
              flexDirection: 'column',
              color: 'var(--tx)',
              animation: 'tape-fade-in .1s ease-out',
            }}
          >
            {rows.map((r, i) => (
              <ResultRow key={contractKey(r.contract) + (r.contract.conId ?? '') + i} match={r} selected={i === sel} onPick={() => open(r.contract, r.description)} />
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
