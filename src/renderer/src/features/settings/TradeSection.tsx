// Settings › Trade: default order size, outside-RTH default (the ticket's default trading session:
// extended hours when on, regular hours when off). The order review is not a setting and has no row
// here: every order, modify and cancel is confirmed in a dialog (state/orderActions.ts).

import { tradeDefaultsPatch, useStore } from '../../state/store';
import { Chip } from '../../ui/primitives';
import { useSettingsMessages } from './messages';
import { LabelBlock, SectionHeader, SettingToggle, saveSettings } from './parts';

const DEFAULT_QTYS = [1, 10, 100, 500];

export function TradeSection() {
  const m = useSettingsMessages();
  const trading = useStore((s) => s.settings.trading);

  // The open ticket follows a new default only where it still has the old one: a size typed or a
  // session chosen there stays, and so does an order being modified (store.ts → tradeDefaultsPatch).
  const apply = (next: typeof trading) => {
    const s = useStore.getState();
    const patch = tradeDefaultsPatch(s, { trading }, { trading: next });
    if (Object.keys(patch).length) s.patchTicket(patch);
  };
  const setDefaultQty = (qty: number) => {
    saveSettings({ trading: { defaultQty: qty } });
    apply({ ...trading, defaultQty: qty });
  };
  const toggleOutsideRth = () => {
    const next = { ...trading, outsideRthDefault: !trading.outsideRthDefault };
    saveSettings({ trading: { outsideRthDefault: next.outsideRthDefault } });
    apply(next);
  };

  return (
    <>
      <SectionHeader title={m.nav.trade} />
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <div style={{ height: 60, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, boxShadow: 'inset 0 -1px 0 var(--ln2)' }}>
          <LabelBlock label={m.defaultQty} desc={m.defaultQtyD} />
          <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
            {DEFAULT_QTYS.map((n) => (
              <Chip
                key={n}
                active={trading.defaultQty === n}
                onClick={() => setDefaultQty(n)}
                style={{ minWidth: 44, textAlign: 'center', font: '12px/1 var(--num)' }}
              >
                {n}
              </Chip>
            ))}
          </div>
        </div>
        <SettingToggle label={m.outsideRth} desc={m.outsideRthD} on={trading.outsideRthDefault} onToggle={toggleOutsideRth} />
      </div>
    </>
  );
}
