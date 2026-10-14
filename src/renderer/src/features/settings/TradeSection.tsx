// Settings › Trade: default order size, outside-RTH default (the ticket's default trading session:
// extended hours when on, regular hours when off). The order review is not a setting: every order,
// modify and cancel is confirmed in a dialog (state/orderActions.ts), and the row here only says so.

import { defaultSession, useStore } from '../../state/store';
import { Chip } from '../../ui/primitives';
import { useSettingsMessages } from './messages';
import { LabelBlock, SectionHeader, SettingToggle, saveSettings } from './parts';

const DEFAULT_QTYS = [1, 10, 100, 500];

export function TradeSection() {
  const m = useSettingsMessages();
  const trading = useStore((s) => s.settings.trading);
  const patchTicket = useStore((s) => s.patchTicket);
  const modifying = useStore((s) => s.ticket.modifyingOrderId != null);

  // Like the design, the defaults also apply to the open ticket (unless an order is being modified).
  const setDefaultQty = (qty: number) => {
    saveSettings({ trading: { defaultQty: qty } });
    if (!modifying) patchTicket({ qty });
  };
  const toggleOutsideRth = () => {
    const next = { ...trading, outsideRthDefault: !trading.outsideRthDefault };
    saveSettings({ trading: { outsideRthDefault: next.outsideRthDefault } });
    if (!modifying) patchTicket({ session: defaultSession({ trading: next }) });
  };

  return (
    <>
      <SectionHeader title={m.nav.trade} />
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <div style={{ height: 52, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, boxShadow: 'inset 0 -1px 0 var(--ln2)' }}>
          <LabelBlock label={m.orderReview} desc={m.orderReviewD} />
          <div style={{ fontSize: 12, color: 'var(--dm)', flexShrink: 0 }}>{m.alwaysOn}</div>
        </div>
        <div style={{ height: 60, display: 'flex', alignItems: 'center', justifyContent: 'space-between', boxShadow: 'inset 0 -1px 0 var(--ln2)' }}>
          <div>{m.defaultQty}</div>
          <div style={{ display: 'flex', gap: 4 }}>
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
