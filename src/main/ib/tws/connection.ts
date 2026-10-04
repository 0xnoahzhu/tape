// Transport of the TWS API: one TCP socket, the "API\0" handshake and 4-byte big-endian length
// framing of NUL-separated UTF-8 fields in both directions. Pacing, priorities and elision of
// outgoing frames live in sendQueue.ts.
//
// Incoming bytes are buffered as a list of chunks and only joined once a whole frame is
// available, so large responses (historical data) are not copied once per network chunk and
// any number of frames per chunk (or chunks per frame) is handled. Outgoing frames are encoded
// into one buffer each, and the frames written in one tick leave in one socket write (cork).
//
// Wire format follows the IB TWS API (EClient/EDecoder). Portions derived from @stoqey/ib (MIT, Copyright (c) the @stoqey/ib authors)

import { connect as netConnect, type Socket } from 'node:net';
import { frameText, type Token } from './encoder.ts';

/** Largest frame accepted (the limit of IB's clients). Larger lengths mean a corrupt stream. */
export const MAX_FRAME_LENGTH = 0xffffff;

export interface ConnectionEvents {
  /** The TCP connection is established. */
  open(): void;
  /** One complete incoming frame: its fields and its text (fields joined by NUL, with the final NUL). */
  frame(fields: string[], text: string): void;
  /** A frame was written: the tokens and their text (fields joined by NUL). */
  sent(tokens: unknown[], text: string): void;
  /** Socket error or a corrupt incoming stream (the socket is closed afterwards). */
  error(err: Error): void;
  /** The socket is closed (reported once). */
  close(): void;
}

export interface ConnectionOptions {
  host: string;
  port: number;
  events: ConnectionEvents;
}

const lengthPrefix = (n: number): Buffer => {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32BE(n, 0);
  return b;
};

/** Splits a frame's text into fields (every field is NUL-terminated). */
export function splitFields(text: string): string[] {
  const fields = text.split('\0');
  if (fields.length && fields[fields.length - 1] === '') fields.pop();
  return fields;
}

/** Encodes a frame from its text (fields joined by NUL): length prefix + text + final NUL, in one allocation. */
export function encodeFrameText(text: string): Buffer {
  const length = Buffer.byteLength(text, 'utf8') + 1;
  const buf = Buffer.allocUnsafe(4 + length);
  buf.writeUInt32BE(length, 0);
  buf.write(text, 4, 'utf8');
  buf[3 + length] = 0;
  return buf;
}

/** Encodes one outgoing frame: length prefix + fields joined by NUL + final NUL. */
export function encodeFrame(tokens: readonly Token[]): Buffer {
  return encodeFrameText(frameText(tokens));
}

export class TwsConnection {
  private readonly host: string;
  private readonly port: number;
  private readonly events: ConnectionEvents;
  private socket: Socket | null = null;
  private closed = false;
  /** The socket is corked until the end of the current tick. */
  private corked = false;

  // incoming
  private chunks: Buffer[] = [];
  private buffered = 0;

  constructor(options: ConnectionOptions) {
    this.host = options.host;
    this.port = options.port;
    this.events = options.events;
  }

  /** Opens the socket. May throw synchronously (e.g. an invalid port). */
  open(): void {
    const socket = netConnect({ host: this.host, port: this.port });
    this.socket = socket;
    socket.setNoDelay(true);
    socket.on('connect', () => {
      if (!this.closed) this.events.open();
    });
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', (err: Error) => {
      if (!this.closed) this.events.error(err);
    });
    socket.on('end', () => this.onClosed());
    socket.on('close', () => this.onClosed());
  }

  /** Closes the socket. `close` follows asynchronously. */
  close(): void {
    const socket = this.socket;
    if (!socket) {
      this.onClosed();
      return;
    }
    socket.end();
    socket.destroy();
  }

  /** Closes the socket and reports `close` right away (used when a new connection replaces this one). */
  closeNow(): void {
    this.close();
    this.onClosed();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Writes the handshake: "API\0" followed by the length-prefixed version range ("v176..193"). False when the socket is gone. */
  sendHandshake(versionRange: string): boolean {
    const version = Buffer.from(versionRange, 'utf8');
    const prefix = lengthPrefix(version.length);
    if (!this.writeRaw(Buffer.concat([Buffer.from('API\0', 'utf8'), prefix, version]))) return false;
    this.notifySent(['API\0', prefix[0], prefix[1], prefix[2], prefix[3], versionRange], versionRange);
    return true;
  }

  /** Writes one frame now and reports it as `sent`; false when the socket is gone. */
  write(tokens: Token[]): boolean {
    const text = frameText(tokens);
    if (!this.writeRaw(encodeFrameText(text))) return false;
    this.notifySent(tokens, text);
    return true;
  }

  // ---------------------------------------------------------------------------

  /** Reports a written frame; a failing listener must not stall the queue. */
  private notifySent(tokens: unknown[], text: string): void {
    try {
      this.events.sent(tokens, text);
    } catch (err) {
      queueMicrotask(() => {
        throw err;
      });
    }
  }

  private writeRaw(data: Buffer): boolean {
    const socket = this.socket;
    if (this.closed || !socket || socket.destroyed) return false;
    if (!this.corked) {
      // the frames written in this tick (a queue burst, a flush on connect) leave in one write
      this.corked = true;
      socket.cork();
      process.nextTick(() => {
        this.corked = false;
        if (!socket.destroyed) socket.uncork();
      });
    }
    socket.write(data);
    return true;
  }

  private onClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.chunks = [];
    this.buffered = 0;
    this.events.close();
  }

  private onData(chunk: Buffer): void {
    if (this.closed) return;
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    while (this.buffered >= 4 && !this.closed) {
      if (this.chunks[0].length < 4) this.join();
      const length = this.chunks[0].readUInt32BE(0);
      if (length > MAX_FRAME_LENGTH) {
        this.events.error(new Error(`Message of size ${length} exceeded max message length ${MAX_FRAME_LENGTH}`));
        this.close();
        return;
      }
      const total = 4 + length;
      if (this.buffered < total) return; // wait for the rest of the frame
      if (this.chunks[0].length < total) this.join();
      const first = this.chunks[0];
      const frame = first.subarray(4, total);
      if (first.length === total) this.chunks.shift();
      else this.chunks[0] = first.subarray(total);
      this.buffered -= total;
      const text = frame.toString('utf8');
      try {
        this.events.frame(splitFields(text), text);
      } catch (err) {
        // The buffer is already consistent; keep processing the following frames and let
        // the exception surface as an uncaught error (as a throwing listener would).
        queueMicrotask(() => {
          throw err;
        });
      }
    }
  }

  /** Joins the buffered chunks into one. */
  private join(): void {
    if (this.chunks.length > 1) this.chunks = [Buffer.concat(this.chunks, this.buffered)];
  }
}
