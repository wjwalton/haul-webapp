/**
 * ReplayTransport: plays a raw.jsonl capture back as if it were a bike. `read` records arrive on
 * …0001, `power` on …0004, `ack` on …0010. `tx` records are what the original client wrote.
 *
 * pace 'timed'    every record at its original time (scaled by `speed`).
 * pace 'lockstep' the records before the first tx arrive on connect; each write by the app releases
 *                 the records up to the next tx (and is compared with that tx: see `mismatches`).
 *
 * The capture says nothing about the GATT table or DIS, so those come from the options.
 */
import { hex } from '../../protocol/bytes';
import {
  CH_BATTERY_LEVEL, CH_BYPASS, CH_POWER, CH_READ, CH_WRITE, DIS_CHARS, SVC_BATTERY, SVC_DIS, SVC_EBIKE,
} from '../../protocol/gatt';
import { recordBytes, type RawRecord } from '../../export/rawJsonl';
import type { BleDevice, CharProperties, DeviceRequest, GattLink, GattServiceInfo, GattTransport, WriteMode } from '../transport';
import { LinkLostError } from '../transport';
import { DEMO_BIKE } from './hmi';

export interface ReplayOptions {
  name?: string;
  dis?: Partial<Record<keyof typeof DIS_CHARS, string>>;
  pace?: 'timed' | 'lockstep';
  /** 1 = real time; larger is faster; Infinity = no waiting. */
  speed?: number;
}

const CHANNEL_CHAR: Readonly<Record<string, string>> = { read: CH_READ, power: CH_POWER, ack: CH_WRITE };

export class ReplayDevice implements BleDevice {
  readonly id: string;
  readonly name: string;
  readonly writes: { char: string; mode: WriteMode; hex: string }[] = [];
  /** App writes that differ from the capture's next tx (lockstep only). */
  readonly mismatches: { expected: string | null; got: string }[] = [];
  private readonly listeners = new Set<() => void>();
  private link: ReplayLink | null = null;

  constructor(readonly records: readonly RawRecord[], readonly opts: ReplayOptions = {}) {
    this.name = opts.name ?? DEMO_BIKE.name;
    this.id = `replay-${this.name}`;
  }

  async connect(): Promise<GattLink> {
    this.link?.close();
    this.link = new ReplayLink(this);
    this.link.start();
    return this.link;
  }

  onDisconnected(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** @internal */
  fireDisconnected(): void {
    for (const l of [...this.listeners]) l();
  }
}

class ReplayLink implements GattLink {
  private open = true;
  private readonly subs = new Map<string, (v: Uint8Array) => void>();
  private readonly pending = new Map<string, Uint8Array[]>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  /** lockstep: index of the next record not yet released. */
  private cursor = 0;

  constructor(private readonly dev: ReplayDevice) {}

  get connected(): boolean {
    return this.open;
  }

  start(): void {
    const recs = this.dev.records;
    if ((this.dev.opts.pace ?? 'timed') === 'timed') this.release(0, recs.length);
    else this.releaseSegment();
  }

  /** Release records [from, to) with their relative timing. */
  private release(from: number, to: number): void {
    const recs = this.dev.records;
    if (from >= to) return;
    const speed = this.dev.opts.speed ?? 1;
    const base = recs[from]!.t;
    for (let i = from; i < to; i++) {
      const r = recs[i]!;
      const char = CHANNEL_CHAR[r.ch];
      if (!char) continue;
      const delay = Number.isFinite(speed) ? Math.max(0, ((r.t - base) * 1000) / speed) : 0;
      const t = setTimeout(() => {
        this.timers.delete(t);
        this.deliver(char, recordBytes(r));
      }, delay);
      this.timers.add(t);
    }
  }

  /** lockstep: release up to (not including) the next tx record. */
  private releaseSegment(): void {
    const recs = this.dev.records;
    let end = this.cursor;
    while (end < recs.length && recs[end]!.ch !== 'tx') end++;
    this.release(this.cursor, end);
    this.cursor = end;
  }

  private deliver(char: string, v: Uint8Array): void {
    if (!this.open) return;
    const cb = this.subs.get(char);
    if (cb) cb(v);
    else this.pending.set(char, [...(this.pending.get(char) ?? []), v]);
  }

  private require(): void {
    if (!this.open) throw new LinkLostError();
  }

  async services(): Promise<GattServiceInfo[]> {
    this.require();
    const p = (o: Partial<CharProperties>): CharProperties => ({ read: false, write: false, writeWithoutResponse: false, notify: false, indicate: false, ...o });
    return [
      {
        uuid: SVC_EBIKE,
        characteristics: [
          { uuid: CH_READ, properties: p({ notify: true }) },
          { uuid: CH_WRITE, properties: p({ write: true, indicate: true }) },
          { uuid: CH_BYPASS, properties: p({ writeWithoutResponse: true }) },
          { uuid: CH_POWER, properties: p({ read: true, notify: true }) },
        ],
      },
      { uuid: SVC_DIS, characteristics: Object.values(DIS_CHARS).map((uuid) => ({ uuid, properties: p({ read: true }) })) },
      { uuid: SVC_BATTERY, characteristics: [{ uuid: CH_BATTERY_LEVEL, properties: p({ read: true }) }] },
    ];
  }

  async properties(service: string, characteristic: string): Promise<CharProperties | null> {
    const s = (await this.services()).find((x) => x.uuid === service);
    return s?.characteristics.find((c) => c.uuid === characteristic)?.properties ?? null;
  }

  async read(service: string, characteristic: string): Promise<Uint8Array> {
    this.require();
    if (characteristic === CH_POWER) {
      const first = this.dev.records.find((r) => r.ch === 'power');
      return first ? recordBytes(first) : Uint8Array.of(1, 0, 0, 1);
    }
    if (service === SVC_DIS) {
      const dis = { ...DEMO_BIKE.dis, ...this.dev.opts.dis } as Record<string, string>;
      const key = Object.entries(DIS_CHARS).find(([, u]) => u === characteristic)?.[0];
      const v = key ? dis[key] : undefined;
      if (v === undefined) throw new Error(`NotFoundError: ${characteristic}`);
      return new TextEncoder().encode(v);
    }
    throw new Error(`NotSupportedError: ${characteristic} is not readable in a replay`);
  }

  async write(_service: string, characteristic: string, value: Uint8Array, mode: WriteMode): Promise<void> {
    this.require();
    const h = hex(value);
    this.dev.writes.push({ char: characteristic, mode, hex: h });
    if ((this.dev.opts.pace ?? 'timed') === 'lockstep') {
      const recs = this.dev.records;
      const expected = this.cursor < recs.length ? recs[this.cursor]!.hex : null;
      if (expected !== h) this.dev.mismatches.push({ expected, got: h });
      if (this.cursor < recs.length) this.cursor++;
      this.releaseSegment();
    }
  }

  async subscribe(_service: string, characteristic: string, onValue: (value: Uint8Array) => void): Promise<void> {
    this.require();
    this.subs.set(characteristic, onValue);
    const queued = this.pending.get(characteristic) ?? [];
    this.pending.delete(characteristic);
    for (const v of queued) onValue(v);
  }

  async unsubscribe(_service: string, characteristic: string): Promise<void> {
    this.subs.delete(characteristic);
  }

  async disconnect(): Promise<void> {
    this.close();
    this.dev.fireDisconnected();
  }

  close(): void {
    this.open = false;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.subs.clear();
  }
}

/** A transport whose chooser always returns the one replay device. */
export class ReplayTransport implements GattTransport {
  readonly id = 'replay' as const;
  readonly device: ReplayDevice;

  constructor(records: readonly RawRecord[], opts: ReplayOptions = {}) {
    this.device = new ReplayDevice(records, opts);
  }

  async availability(): Promise<boolean> {
    return true;
  }

  async requestDevice(_req: DeviceRequest): Promise<BleDevice> {
    return this.device;
  }
}
