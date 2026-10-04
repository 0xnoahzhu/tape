// Pure helpers for the IB connection: parameters, managed accounts and the texts of
// connection notifications.

import type { LocalizedText, Settings } from '@shared/types';
import { createMessages } from '../i18n';
import { cleanIbMessage } from './errorCodes';

export interface ConnectionParams {
  host: string;
  port: number;
  clientId: number;
}

/** Host, port and client id from settings; TAPE_CLIENT_ID overrides the client id. */
export function connectionParams(s: Settings['connection'], envClientId: string | undefined = process.env.TAPE_CLIENT_ID): ConnectionParams {
  const env = envClientId?.trim() ? Number(envClientId) : NaN;
  return { host: s.host, port: s.port, clientId: Number.isInteger(env) && env >= 0 ? env : s.clientId };
}

export const sameParams = (a: ConnectionParams, b: ConnectionParams): boolean =>
  a.host === b.host && a.port === b.port && a.clientId === b.clientId;

/** "DU123,DU456," -> ["DU123", "DU456"] */
export function parseAccounts(list: string | undefined): string[] {
  return (list ?? '')
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean);
}

/** Paper accounts start with "D" (DU…, DF…, DUP…). */
export const isPaperAccount = (account: string | undefined): boolean => !!account && account.startsWith('D');

const m = createMessages({
  en: {
    tws: 'TWS',
    gateway: 'IB Gateway',
    seconds: (n: number) => `${n} s`,
    minutes: (n: number) => `${n} min`,
    hours: (h: number, min: number) => (min ? `${h} h ${min} min` : `${h} h`),
    disconnectedTitle: (app: string) => `Disconnected from ${app}`,
    disconnectedBody: (addr: string, retry: boolean) =>
      retry ? `${addr} closed the connection. Retrying every 5 s, up to 10 times.` : `${addr} closed the connection.`,
    reconnectedTitle: (app: string) => `Reconnected to ${app}`,
    reconnectedBody: (duration: string) => `Reconnected after ${duration} offline. All subscriptions restored.`,
    failedTitle: (app: string) => `Could not connect to ${app}`,
    failedBody: (reason: string, app: string) => `${reason}. Make sure ${app} is running with the API port open.`,
    gaveUpTitle: (app: string) => `Could not reconnect to ${app}`,
    gaveUpBody: (reason: string, attempts: number) => `Gave up after ${attempts} attempts. ${reason}.`,
    lostTitle: (app: string) => `${app} lost its connection to IB`,
    lostBody: 'Market data and order updates pause until the connection is restored.',
    restoredTitle: (app: string) => `${app} reconnected to IB`,
    restoredKept: 'Connection restored, data maintained.',
    restoredLost: 'Connection restored. Market data subscriptions were renewed.',
    refused: (addr: string) => `Connection refused at ${addr}`,
    noResponse: (addr: string) => `No response from ${addr}`,
    clientIdInUse: (id: number) => `Client ID ${id} is already in use`,
  },
  zh: {
    tws: 'TWS',
    gateway: 'IB Gateway',
    seconds: (n: number) => `${n} 秒`,
    minutes: (n: number) => `${n} 分钟`,
    hours: (h: number, min: number) => (min ? `${h} 小时 ${min} 分钟` : `${h} 小时`),
    disconnectedTitle: (app: string) => `与 ${app} 的连接已断开`,
    disconnectedBody: (addr: string, retry: boolean) => (retry ? `${addr} 断开了连接。每 5 秒重试，最多 10 次。` : `${addr} 断开了连接。`),
    reconnectedTitle: (app: string) => `已重新连接 ${app}`,
    reconnectedBody: (duration: string) => `断开 ${duration} 后自动重连成功，所有订阅已恢复。`,
    failedTitle: (app: string) => `无法连接 ${app}`,
    failedBody: (reason: string, app: string) => `${reason}。确认 ${app} 已启动并开放 API 端口。`,
    gaveUpTitle: (app: string) => `无法重新连接 ${app}`,
    gaveUpBody: (reason: string, attempts: number) => `已重试 ${attempts} 次仍未成功。${reason}。`,
    lostTitle: (app: string) => `${app} 与 IB 服务器的连接已中断`,
    lostBody: '连接恢复前，行情和订单状态暂停更新。',
    restoredTitle: (app: string) => `${app} 已恢复与 IB 服务器的连接`,
    restoredKept: '连接已恢复，数据保持不变。',
    restoredLost: '连接已恢复，行情订阅已重新提交。',
    refused: (addr: string) => `${addr} 拒绝连接`,
    noResponse: (addr: string) => `${addr} 无响应`,
    clientIdInUse: (id: number) => `Client ID ${id} 已被占用`,
  },
});

type Texts = ReturnType<typeof m>;

/** "45 s", "3 min", "1 h 5 min" (and the Chinese equivalents). */
export function formatDuration(ms: number, t: Texts): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return t.seconds(s);
  const min = Math.round(s / 60);
  if (min < 60) return t.minutes(min);
  return t.hours(Math.floor(min / 60), min % 60);
}

export interface Failure {
  /** IB / library code; 0 for a handshake timeout. */
  code: number;
  message: string;
}

/** A short, human reason for a failed connection attempt. */
export function failureReason(f: Failure, p: ConnectionParams): LocalizedText {
  const addr = `${p.host}:${p.port}`;
  if (f.code === 326) return m.both((t) => t.clientIdInUse(p.clientId));
  if (/ECONNREFUSED/.test(f.message)) return m.both((t) => t.refused(addr));
  if (f.code === 0 || /ETIMEDOUT|EHOSTUNREACH/.test(f.message)) return m.both((t) => t.noResponse(addr));
  const text = cleanIbMessage(f.message).replace(/\.$/, '') || `IB error ${f.code}`;
  return { en: text, zh: text };
}

export interface NoticeText {
  title: LocalizedText;
  body: LocalizedText;
}

type Mode = Settings['connection']['mode'];
const appName = (t: Texts, mode: Mode) => (mode === 'tws' ? t.tws : t.gateway);

export const connectionNotices = {
  disconnected: (mode: Mode, p: ConnectionParams, retry: boolean): NoticeText => ({
    title: m.both((t) => t.disconnectedTitle(appName(t, mode))),
    body: m.both((t) => t.disconnectedBody(`${p.host}:${p.port}`, retry)),
  }),
  reconnected: (mode: Mode, downtimeMs: number): NoticeText => ({
    title: m.both((t) => t.reconnectedTitle(appName(t, mode))),
    body: m.both((t) => t.reconnectedBody(formatDuration(downtimeMs, t))),
  }),
  failed: (mode: Mode, reason: LocalizedText): NoticeText => ({
    title: m.both((t) => t.failedTitle(appName(t, mode))),
    body: { en: m('en').failedBody(reason.en, appName(m('en'), mode)), zh: m('zh').failedBody(reason.zh, appName(m('zh'), mode)) },
  }),
  gaveUp: (mode: Mode, reason: LocalizedText, attempts: number): NoticeText => ({
    title: m.both((t) => t.gaveUpTitle(appName(t, mode))),
    body: { en: m('en').gaveUpBody(reason.en, attempts), zh: m('zh').gaveUpBody(reason.zh, attempts) },
  }),
  lost: (mode: Mode): NoticeText => ({
    title: m.both((t) => t.lostTitle(appName(t, mode))),
    body: m.both((t) => t.lostBody),
  }),
  restored: (mode: Mode, dataLost: boolean): NoticeText => ({
    title: m.both((t) => t.restoredTitle(appName(t, mode))),
    body: m.both((t) => (dataLost ? t.restoredLost : t.restoredKept)),
  }),
};
