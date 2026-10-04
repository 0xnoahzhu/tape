// Strings of the lock screen, the Forgot-PIN reset and the PIN dialogs (from the design's "lk" object).

import type { BiometricKind } from '@shared/types';
import { createMessages } from '../../i18n';

const BIO: Record<BiometricKind, string> = { touchId: 'Touch ID', windowsHello: 'Windows Hello' };

const en = {
  lockTitle: (keys: string) => `Lock (${keys})`,
  enterPin: 'Enter 6-character PIN',
  incorrect: 'Incorrect PIN',
  charHint: 'Spaces and control characters can’t be used',
  capsLock: 'Caps Lock is on',
  pinUnreadable: 'Tape can’t read its saved PIN. Try again, or use Forgot PIN to reset Tape.',
  /** "Too many attempts. Try again in 0:30" */
  throttled: (wait: string) => `Too many attempts. Try again in ${wait}`,
  unlockWith: (kind: BiometricKind) => `Unlock with ${BIO[kind]}`,
  bioUnavailable: (kind: BiometricKind) => `${BIO[kind]} is not available. Enter your PIN.`,
  bioNotVerified: (kind: BiometricKind) => `${BIO[kind]} did not unlock Tape. Enter your PIN.`,
  forgot: 'Forgot PIN?',

  // Forgot PIN → Reset Tape
  resetTitle: 'Reset Tape',
  resetDesc: 'Your PIN can’t be recovered. Resetting returns Tape to a fresh install: you’ll reconnect to IB Gateway and set a new PIN.',
  clearsLabel: 'Clears',
  clears: 'All settings, watchlists, price alerts, notification history, trade and net liquidation history, API logs and your PIN',
  keepsLabel: 'Keeps',
  keeps: 'Your IBKR account, positions, and orders already on IB servers',
  typeToConfirm: 'Type RESET to confirm',
  cancel: 'Cancel',
  reset: 'Reset Tape',
  resetting: 'Resetting…',
  resetFailed: (msg: string) => `Reset failed: ${msg}`,

  // PIN dialogs
  setTitle: 'Set lock PIN',
  changeTitle: 'Change lock PIN',
  removeTitle: 'Remove lock PIN',
  pinDesc: '6 characters (letters, digits or symbols). Only unlocks Tape; separate from your IBKR login',
  removeDesc: 'The lock screen turns off and Tape no longer locks when idle.',
  stepCurrent: 'Enter your current PIN',
  stepNew: 'Enter a new 6-character PIN',
  stepConfirm: 'Enter it again to confirm',
  mismatch: 'The PINs didn’t match. Enter a new PIN again.',
  useBio: (kind: BiometricKind) => `Use ${BIO[kind]} instead`,
  pinSet: 'Lock PIN set',
  pinChanged: 'Lock PIN changed',
  pinRemoved: 'Lock PIN removed',
  failed: (msg: string) => `Could not save the PIN: ${msg}`,
};

const zh: typeof en = {
  lockTitle: (keys: string) => `锁定 (${keys})`,
  enterPin: '输入 6 位 PIN',
  incorrect: 'PIN 不正确',
  charHint: '不能使用空格或控制字符',
  capsLock: '大写锁定已打开',
  pinUnreadable: 'Tape 无法读取已保存的 PIN。请重试，或通过“忘记 PIN”重置 Tape。',
  throttled: (wait: string) => `尝试次数过多，请 ${wait} 后再试`,
  unlockWith: (kind: BiometricKind) => `使用 ${BIO[kind]} 解锁`,
  bioUnavailable: (kind: BiometricKind) => `${BIO[kind]} 当前不可用，请输入 PIN`,
  bioNotVerified: (kind: BiometricKind) => `${BIO[kind]} 未能解锁，请输入 PIN`,
  forgot: '忘记 PIN？',

  resetTitle: '重置 Tape',
  resetDesc: 'PIN 无法找回。重置后 Tape 会回到刚安装时的状态，需要重新连接 IB Gateway 并设置新的 PIN。',
  clearsLabel: '会清除',
  clears: '所有设置、自选列表、价格提醒、通知记录、成交与净值历史、API 日志和 PIN',
  keepsLabel: '不影响',
  keeps: 'IBKR 账户、持仓，以及已提交到 IB 服务器的订单',
  typeToConfirm: '输入“重置”以确认',
  cancel: '取消',
  reset: '重置 Tape',
  resetting: '正在重置…',
  resetFailed: (msg: string) => `重置失败：${msg}`,

  setTitle: '设置锁屏 PIN',
  changeTitle: '修改锁屏 PIN',
  removeTitle: '移除锁屏 PIN',
  pinDesc: '6 位字符（字母、数字、符号均可），只用于解锁 Tape，与 IBKR 登录密码无关',
  removeDesc: '锁屏将关闭，Tape 不再在无操作时自动锁定。',
  stepCurrent: '输入当前 PIN',
  stepNew: '输入新的 6 位 PIN',
  stepConfirm: '再输入一次以确认',
  mismatch: '两次输入的 PIN 不一致，请重新输入新 PIN',
  useBio: (kind: BiometricKind) => `改用 ${BIO[kind]}`,
  pinSet: '锁屏 PIN 已设置',
  pinChanged: '锁屏 PIN 已修改',
  pinRemoved: '锁屏 PIN 已移除',
  failed: (msg: string) => `PIN 未能保存：${msg}`,
};

export const useLockMessages = createMessages({ en, zh });
