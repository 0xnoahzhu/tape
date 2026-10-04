// Settings › Trade: order confirmation, default order size, outside-RTH default.

import { useStore } from '../../state/store';
import { Chip } from '../../ui/primitives';
import { useSettingsMessages } from './messages';
import { SectionHeader, SettingToggle, saveSettings } from './parts';

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
    const outsideRth = !trading.outsideRthDefault;
    saveSettings({ trading: { outsideRthDefault: outsideRth } });
    if (!modifying) patchTicket({ outsideRth });
  };

  return (
    <>
      <SectionHeader title={m.nav.trade} />
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <SettingToggle
          label={m.confirmOrders}
          desc={m.confirmOrdersD}
          on={trading.confirmOrders}
          onToggle={() => saveSettings({ trading: { confirmOrders: !trading.confirmOrders } })}
        />
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
