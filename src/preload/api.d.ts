import type { TapeApi } from '@shared/ipc';

declare global {
  interface Window {
    tape: TapeApi;
    tapePlatform: string;
  }
}

export {};
