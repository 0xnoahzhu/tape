import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stock } from '@shared/contract';
import type { LockState } from '@shared/types';
import { requestLock } from '../features/lock/actions';
import { usePanels } from '../features/panels/panelStore';
import { applyLockState } from './lockActions';
import { isCovered, useStore } from './store';

const state = (patch: Partial<LockState>): LockState => ({ hasPin: true, locked: false, biometrics: { kind: null, available: false }, failures: 0, retryAt: null, ...patch });

describe('lock state in the renderer', () => {
  const initial = useStore.getState();
  const lock = vi.fn(() => Promise.resolve());
  beforeEach(() => {
    useStore.setState(initial, true);
    lock.mockClear();
    vi.stubGlobal('window', { tape: { lock } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('closes dialogs and drops a pending order review when locking', () => {
    const request = { contract: stock('AAPL'), action: 'BUY', orderType: 'LMT', quantity: 1, limitPrice: 1, tif: 'DAY', outsideRth: false } as const;
    useStore.setState({
      bellOpen: true,
      pendingOrder: { request, rows: [], label: 'Buy', summary: 'Buy 1 AAPL' },
      confirm: { title: 'x', rows: [], label: 'y', run: () => undefined },
      alertForm: { contract: stock('AAPL'), condition: 'above', price: '1', repeat: false },
      pinDialog: { mode: 'change' },
    });
    applyLockState(state({ locked: true }));
    const s = useStore.getState();
    expect(s).toMatchObject({ bellOpen: false, pendingOrder: null, confirm: null, alertForm: null, pinDialog: null });
    expect(isCovered(s)).toBe(true);
  });

  it('collapses floating panels to their bars, and they stay so after the unlock', () => {
    const panels = usePanels.getState();
    panels.setFloating('ticket', true);
    panels.setFloating('strategy', false);
    applyLockState(state({ locked: true }));
    expect(usePanels.getState().panels.ticket).toMatchObject({ floating: true, collapsed: true });
    expect(usePanels.getState().panels.strategy).toMatchObject({ floating: false, collapsed: false });
    applyLockState(state({ locked: false }));
    expect(usePanels.getState().panels.ticket.collapsed).toBe(true);
    panels.setFloating('ticket', false);
  });

  it('stays covered while the unlock animation plays', () => {
    useStore.setState({ lock: state({ locked: true }), unlocking: true });
    applyLockState(state({ locked: false }));
    expect(isCovered(useStore.getState())).toBe(true);
    useStore.getState().setUnlocking(false);
    expect(isCovered(useStore.getState())).toBe(false);
  });

  it('starts a fresh lock screen when Tape locks again during the unlock animation', () => {
    useStore.setState({ lock: state({ locked: true }), unlocking: true });
    const seq = useStore.getState().lockSeq;
    applyLockState(state({ locked: false }));
    applyLockState(state({ locked: true }));
    const s = useStore.getState();
    expect(s.unlocking).toBe(false);
    expect(s.lockSeq).toBe(seq + 1);
    expect(isCovered(s)).toBe(true);
  });

  it('remembers that biometrics were available this session', () => {
    expect(useStore.getState().biometricsSeen).toBe(false);
    applyLockState(state({ biometrics: { kind: 'touchId', available: false, reason: 'checking' } }));
    expect(useStore.getState().biometricsSeen).toBe(false);
    applyLockState(state({ biometrics: { kind: 'touchId', available: true } }));
    applyLockState(state({ locked: true, biometrics: { kind: 'touchId', available: false, reason: 'noHardware' } }));
    expect(useStore.getState().biometricsSeen).toBe(true);
  });

  it('asks for a PIN before the first lock', () => {
    useStore.setState({ lock: state({ hasPin: false }) });
    requestLock();
    expect(useStore.getState().pinDialog).toEqual({ mode: 'set', lockAfter: true });
    expect(lock).not.toHaveBeenCalled();
  });

  it('locks through main when a PIN exists, and does nothing when already locked', () => {
    useStore.setState({ lock: state({}) });
    requestLock();
    expect(lock).toHaveBeenCalledTimes(1);
    useStore.setState({ lock: state({ locked: true }) });
    requestLock();
    expect(lock).toHaveBeenCalledTimes(1);
  });
});
