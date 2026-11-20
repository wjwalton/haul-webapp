/**
 * BikeLink: the ONLY way the app writes to a bike. Every write is checked against the send whitelist
 * (protocol/frames.ts checkFrame) before it is queued; a refused frame throws ForbiddenFrameError and
 * nothing reaches the transport. Every GATT operation goes through the link's single GattQueue.
 *
 * It also feeds the session's raw.jsonl: commands as `tx` (when issued), and every notification on
 * …0001 (`read`), …0004 (`power`, changes only) and …0010 (`ack`).
 */
import { assertFrame, type FrameContext } from '../protocol/frames';
import { CH_BYPASS, CH_POWER, CH_READ, CH_WRITE, DIS_SERIAL_BLOCKLISTED, SVC_EBIKE } from '../protocol/gatt';
import type { RawChannel, RawRecorder } from '../export/rawJsonl';
import { GattQueue, type QueueOptions } from './queue';
import type { BleDevice, CharProperties, GattLink, GattServiceInfo, WriteMode } from './transport';

export interface BikeLinkOptions {
  queue?: GattQueue;
  queueOptions?: QueueOptions;
  recorder?: RawRecorder;
}

const CHANNEL: Readonly<Record<string, RawChannel>> = { [CH_READ]: 'read', [CH_POWER]: 'power', [CH_WRITE]: 'ack' };

/** One frame in either direction (the firmware update's session log listens while it runs). */
export interface LinkEvent {
  dir: 'tx' | 'rx';
  /** Full characteristic UUID. */
  char: string;
  bytes: Uint8Array;
  label?: string;
}
export type LinkTap = (e: LinkEvent) => void;

export class BikeLink {
  readonly queue: GattQueue;
  private readonly recorder: RawRecorder | undefined;
  private readonly taps = new Set<LinkTap>();

  constructor(private readonly gatt: GattLink, opts: BikeLinkOptions = {}) {
    this.queue = opts.queue ?? new GattQueue(opts.queueOptions);
    this.recorder = opts.recorder;
  }

  get connected(): boolean {
    return this.gatt.connected && !this.queue.closed;
  }

  /** What the browser says about this GATT connection, whatever the app did with the queue. */
  get gattConnected(): boolean {
    return this.gatt.connected;
  }

  /** Listen to every frame sent and received (until the returned function is called). */
  addTap(tap: LinkTap): () => void {
    this.taps.add(tap);
    return () => this.taps.delete(tap);
  }

  private emit(e: LinkEvent): void {
    for (const t of this.taps) t(e);
  }

  /** A command frame to …0010, write with response. The ack arrives as an indication on …0010. */
  command(frame: Uint8Array, label: string, ctx?: FrameContext): Promise<void> {
    assertFrame('command', frame, ctx);
    const copy = frame.slice();
    return this.queue.run(label, async () => {
      this.recorder?.log('tx', copy);
      if (this.taps.size) this.emit({ dir: 'tx', char: CH_WRITE, bytes: copy, label });
      await this.gatt.write(SVC_EBIKE, CH_WRITE, copy, 'with-response');
    }, { tag: 'command' });
  }

  /**
   * One controller firmware block to …0011, in the write mode its properties allow. Blocks are not in
   * raw.jsonl (the Python's "tx" channel is …0010 commands); the update's session log has every one.
   */
  block(frame: Uint8Array, mode: WriteMode, ctx: FrameContext, label: string): Promise<void> {
    assertFrame('block', frame, ctx);
    const copy = frame.slice();
    return this.queue.run(label, () => {
      if (this.taps.size) this.emit({ dir: 'tx', char: CH_BYPASS, bytes: copy, label });
      return this.gatt.write(SVC_EBIKE, CH_BYPASS, copy, mode);
    }, { tag: 'block' });
  }

  /**
   * Flow control for blocks written without response: a read of …0004 (the status characteristic the
   * app reads at every connect) queued behind them. It comes back once the blocks before it have left
   * this computer. Not in raw.jsonl (it's not a status change); no queue timeout (the flasher's stall
   * timer decides).
   */
  barrier(label: string): Promise<void> {
    return this.queue.run(label, async () => {
      await this.gatt.read(SVC_EBIKE, CH_POWER);
    }, { tag: 'barrier', timeoutMs: 0 });
  }

  /** Drop firmware blocks that haven't been issued yet (a resend request). Issued ones can't be recalled. */
  cancelPendingBlocks(reason: string): number {
    return this.queue.cancelPending((_l, tag) => tag === 'block', reason);
  }

  read(service: string, characteristic: string, label = `read ${characteristic.slice(4, 8)}`): Promise<Uint8Array> {
    if (characteristic === DIS_SERIAL_BLOCKLISTED) {
      return Promise.reject(new Error('The DIS Serial Number (0x2A25) is on Chrome\'s GATT blocklist and is never read'));
    }
    return this.queue.run(label, async () => {
      const v = await this.gatt.read(service, characteristic);
      // cmd_capture passes its one read of …0004 through on_power, so it is a "power" line in raw.jsonl.
      if (characteristic === CH_POWER) this.recorder?.log('power', v);
      return v;
    });
  }

  subscribe(service: string, characteristic: string, onValue: (v: Uint8Array) => void, label = `subscribe ${characteristic.slice(4, 8)}`): Promise<void> {
    const ch = CHANNEL[characteristic];
    const cb = (v: Uint8Array) => {
      if (ch) this.recorder?.log(ch, v);
      if (this.taps.size) this.emit({ dir: 'rx', char: characteristic, bytes: v });
      onValue(v);
    };
    return this.queue.run(label, () => this.gatt.subscribe(service, characteristic, cb));
  }

  unsubscribe(service: string, characteristic: string): Promise<void> {
    return this.queue.run(`unsubscribe ${characteristic.slice(4, 8)}`, () => this.gatt.unsubscribe(service, characteristic));
  }

  services(): Promise<GattServiceInfo[]> {
    return this.queue.run('services', () => this.gatt.services());
  }

  properties(service: string, characteristic: string): Promise<CharProperties | null> {
    return this.queue.run('properties', () => this.gatt.properties(service, characteristic));
  }

  /** Close the queue (pending ops fail) and drop the link. */
  async disconnect(reason = 'disconnected'): Promise<void> {
    this.queue.close(reason);
    await this.gatt.disconnect();
  }

  /** The transport reported a disconnect: fail everything pending. */
  lost(reason = 'link lost'): void {
    this.queue.close(reason);
  }
}

/** Connect (or reconnect) to [device] and hand back only the whitelisted BikeLink, never the raw GattLink. */
export async function openBikeLink(device: BleDevice, opts: BikeLinkOptions = {}): Promise<BikeLink> {
  return new BikeLink(await device.connect(), opts);
}
