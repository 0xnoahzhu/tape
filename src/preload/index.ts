// Exposes the typed TapeApi to the renderer as `window.tape`.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { EVENT_CHANNEL, INVOKE_METHODS, invokeChannel, type InvokeResult, type TapeApi, type TapeEvent, type TapeInvokeMethod } from '@shared/ipc';

async function invoke(method: TapeInvokeMethod, args: unknown[]): Promise<unknown> {
  const res = (await ipcRenderer.invoke(invokeChannel(method), ...args)) as InvokeResult;
  if (!res.ok) throw new Error(res.message);
  return res.value;
}

const api = Object.fromEntries(INVOKE_METHODS.map((method) => [method, (...args: unknown[]) => invoke(method, args)])) as Omit<TapeApi, 'onEvent'>;

const tape: TapeApi = {
  ...api,
  onEvent(listener) {
    const handler = (_e: IpcRendererEvent, event: TapeEvent) => listener(event);
    ipcRenderer.on(EVENT_CHANNEL, handler);
    return () => ipcRenderer.removeListener(EVENT_CHANNEL, handler);
  },
};

contextBridge.exposeInMainWorld('tape', tape);
contextBridge.exposeInMainWorld('tapePlatform', process.platform);
