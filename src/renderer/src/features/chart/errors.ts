// Readable messages from failed IPC calls. Electron wraps main-process errors as
// "Error invoking remote method 'tape:getHistory': IbRequestError: <IB message> (IB 162)".

export function ipcErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg
    .replace(/^Error invoking remote method '[^']+':\s*/, '')
    .replace(/^[A-Za-z]*Error:\s*/, '')
    .trim();
}

/** IB prefixes HMDS errors with a long service name; the chart already says "Historical data unavailable". */
export function historyErrorMessage(err: unknown): string {
  return ipcErrorMessage(err)
    .replace(/^Historical Market Data Service error message:\s*/i, '')
    .trim();
}
