// Live API log only while a view shows it: the main process decodes and sends entries only
// when at least one view streams them, so the hot path stays cheap the rest of the time.
//
// Streaming starts before the recorded entries are loaded, so no frame falls between the two;
// batches that overlap the loaded entries are deduplicated by seq (withLoadedLog). The main
// process ends this renderer's stream by itself when the page reloads.

import { useEffect } from 'react';
import { withLoadedLog } from '../state/bridge';
import { useStore } from '../state/store';

let viewers = 0;

export function useApiLogStream(): void {
  useEffect(() => {
    if (viewers++ === 0) {
      window.tape
        .setApiLogStreaming(true)
        // Catch up with what was recorded while nobody was watching.
        .then(() => window.tape.getApiLog())
        .then((entries) => useStore.setState((s) => ({ apiLog: withLoadedLog(s.apiLog, entries) })))
        .catch(() => undefined);
    }
    return () => {
      if (--viewers === 0) void window.tape.setApiLogStreaming(false);
    };
  }, []);
}
