// Test helper: a minimal TWS / IB Gateway stand-in on a local TCP port. It reads the "API\0"
// handshake, answers with a server version, parses the client's length-prefixed frames and
// lets tests send frames (or arbitrary bytes) back.

import { createServer, type Server, type Socket } from 'node:net';

export interface FakeTwsOptions {
  /** Version sent back after the handshake (default 193). */
  serverVersion?: number | string;
  connTime?: string;
  /** After START_API: send managedAccounts + nextValidId (default true). */
  autoReady?: boolean;
  account?: string;
  nextValidId?: number;
}

/** Encodes one frame: 4-byte big-endian length + NUL-terminated fields. */
export function frame(fields: ReadonlyArray<string | number>): Buffer {
  const payload = Buffer.from(fields.map(String).join('\0') + '\0', 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32BE(payload.length, 0);
  return Buffer.concat([head, payload]);
}

export class FakeTwsSession {
  readonly socket: Socket;
  /** Version range of the handshake ("v176..193"). */
  versionRange: string | undefined;
  /** Client frames after the handshake (fields), with their arrival times. */
  readonly frames: string[][] = [];
  readonly times: number[] = [];
  closed = false;
  private buf = Buffer.alloc(0);
  private waiters: Array<() => void> = [];
  private readonly options: FakeTwsOptions;

  constructor(socket: Socket, options: FakeTwsOptions) {
    this.socket = socket;
    this.options = options;
    socket.on('data', (d) => this.onData(Buffer.isBuffer(d) ? d : Buffer.from(d)));
    socket.on('close', () => {
      this.closed = true;
      this.wake();
    });
    socket.on('error', () => undefined);
  }

  send(fields: ReadonlyArray<string | number>): void {
    this.socket.write(frame(fields));
  }

  sendRaw(data: Buffer): void {
    this.socket.write(data);
  }

  end(): void {
    this.socket.end();
  }

  /** Waits until `n` client frames (after the handshake) have arrived. */
  async waitFrames(n: number, timeoutMs = 5000): Promise<string[][]> {
    await this.until(() => this.frames.length >= n, timeoutMs, `${n} frames (have ${this.frames.length})`);
    return this.frames;
  }

  async waitClosed(timeoutMs = 5000): Promise<void> {
    await this.until(() => this.closed, timeoutMs, 'close');
  }

  private until(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
    if (cond()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`fake TWS: timeout waiting for ${what}`)), timeoutMs);
      const check = () => {
        if (cond()) {
          clearTimeout(timer);
          resolve();
        } else this.waiters.push(check);
      };
      this.waiters.push(check);
    });
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }

  private onData(data: Buffer): void {
    this.buf = Buffer.concat([this.buf, data]);
    if (this.versionRange === undefined) {
      if (this.buf.length < 8) return;
      if (this.buf.subarray(0, 4).toString() !== 'API\0') throw new Error('fake TWS: bad handshake');
      const len = this.buf.readUInt32BE(4);
      if (this.buf.length < 8 + len) return;
      this.versionRange = this.buf.subarray(8, 8 + len).toString();
      this.buf = this.buf.subarray(8 + len);
      this.send([this.options.serverVersion ?? 193, this.options.connTime ?? '20261004 12:00:00 China Standard Time']);
    }
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (this.buf.length < 4 + len) break;
      const fields = this.buf.subarray(4, 4 + len).toString('utf8').split('\0');
      if (fields[fields.length - 1] === '') fields.pop();
      this.buf = this.buf.subarray(4 + len);
      this.frames.push(fields);
      this.times.push(Date.now());
      if (fields[0] === '71' && this.options.autoReady !== false) {
        this.send([15, 1, this.options.account ?? 'DU123']);
        this.send([9, 1, this.options.nextValidId ?? 1]);
      }
    }
    this.wake();
  }
}

export class FakeTws {
  readonly server: Server;
  readonly sessions: FakeTwsSession[] = [];
  options: FakeTwsOptions;
  private waiters: Array<() => void> = [];

  private constructor(options: FakeTwsOptions) {
    this.options = options;
    this.server = createServer((socket) => {
      this.sessions.push(new FakeTwsSession(socket, this.options));
      const waiters = this.waiters;
      this.waiters = [];
      for (const w of waiters) w();
    });
  }

  static async start(options: FakeTwsOptions = {}): Promise<FakeTws> {
    const fake = new FakeTws(options);
    await new Promise<void>((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
    return fake;
  }

  get port(): number {
    const addr = this.server.address();
    return typeof addr === 'object' && addr ? addr.port : 0;
  }

  /** Waits for the n-th accepted connection (1-based). */
  async session(n = 1, timeoutMs = 5000): Promise<FakeTwsSession> {
    if (this.sessions.length >= n) return this.sessions[n - 1];
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('fake TWS: no connection')), timeoutMs);
      const check = () => {
        if (this.sessions.length >= n) {
          clearTimeout(timer);
          resolve();
        } else this.waiters.push(check);
      };
      this.waiters.push(check);
    });
    return this.sessions[n - 1];
  }

  async close(): Promise<void> {
    for (const s of this.sessions) s.socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

/** Resolves on the next `event` of an emitter (with its arguments). */
export function nextEvent(emitter: { once(event: string, l: (...args: any[]) => void): unknown }, event: string, timeoutMs = 5000): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
    emitter.once(event, (...args: unknown[]) => {
      clearTimeout(timer);
      resolve(args);
    });
  });
}
