/**
 * MockHmi: a scriptable, in-memory Globe Haul display (EH02) behind the GattTransport interfaces.
 * Used by the unit tests (with fake timers) and by the app's dev mock mode.
 *
 * Behaviour follows PROTOCOL.md; where PROTOCOL.md doesn't say, the choice is marked MOCK ASSUMPTION
 * and is a knob, not a fact. Timings default to the stock update trace (2026-11-10):
 * 46 ack after ~150 ms, `3C 02 01 00` 4.57 s after the start frame, `3C 00 00 00` 148 ms after the
 * last block.
 *
 * The mock keeps its OWN list of what this app may send (independent of protocol/frames.ts) and records
 * anything else as a violation, so a bug in checkFrame can't hide itself in tests.
 *
 * Battery update (PROTOCOL.md "Battery (BMS) firmware update over BLE"): `50 01` turns bus access on
 * (data pages stop, every bus frame is mirrored on …0001 as `51 <id> <len> <8 data> <src> <ts>`), `52`
 * puts one frame on the bus (echoed with src 1; the BMS in mock/bms.ts answers with src 0), `09` sets
 * the auto-off timer (page 5). After a successful battery update the whole bike restarts.
 */
import { hex } from '../../protocol/bytes';
import {
  CH_BATTERY_LEVEL, CH_BYPASS, CH_POWER, CH_READ, CH_WRITE, DIS_CHARS, DIS_SERIAL_BLOCKLISTED,
  SCAN_UUID, SVC_BATTERY, SVC_DIS, SVC_EBIKE, SVC_SECURE_DFU,
} from '../../protocol/gatt';
import { STRING_PAGES } from '../../protocol/pages';
import { MockBms, page24Form, type BmsBus, type MockBmsOptions } from './bms';
import type { BleDevice, CharProperties, GattLink, GattServiceInfo, WriteMode } from '../transport';
import { LinkLostError } from '../transport';
import {
  configPage, identityPage, livePage, productionPage, settings5Page, settingsPage, type MockConfig, type MockLive,
} from './pages';

export interface MockTiming {
  /** A write with response completes after this. */
  writeMs: number;
  /** A …0011 block write completes after this (the "slow host" variant sets 50). */
  blockWriteMs: number;
  /** Ack indication `10 op status` after a command arrives (captures: 60-120 ms). */
  ackMs: number;
  /** One-shot pages after a 3D. */
  pagesMs: number;
  /** Live loop period: ~10 Hz on the real bike. */
  liveIntervalMs: number;
  /** …0004 repeat period; 0 = only on change. The real HMI repeats ~55x/s. */
  statusIntervalMs: number;
  /** 46 → `10 46 01` (stock trace: 153 ms). */
  fwAckMs: number;
  /** 46 → `3C 02 01 00` (stock trace: 4,566 ms; the controller erases its application meanwhile). */
  eraseMs: number;
  /** Last block → `3C 00 00 00` (stock trace: 148 ms). */
  finishMs: number;
  /** Between log-dump notifications. */
  dumpChunkMs: number;
  /**
   * The radio: 0 = every write reaches the display at once (the default). > 0 = every write and read
   * travels through one first-in-first-out air queue, one packet per this many ms (the 2026-11-19
   * Windows capture: the display received 44 blocks/s, ~22.7 ms per block).
   */
  airMsPerPacket: number;
  /**
   * With a radio: a write WITHOUT response completes once queued (after blockWriteMs), not when it
   * has gone out. Chrome on Windows does this (2026-11-19: 10,240 writes "done" in 29 s).
   */
  hostQueuesWrites: boolean;
  /** With a radio: reads and writes with response skip the queue (the worst case for a barrier). */
  requestsJumpAir: boolean;
}

export interface UpdateScript {
  /** The bootloader never answers: after 46 the HMI waits in update mode forever (PROTOCOL.md step 5). */
  neverReady: boolean;
  /** Ask for a resend (`3C 02 <k>`) the first time block k arrives; each k once. */
  resendAt: number[];
  /** Report failure (`3C 01 00 00`) when block k arrives. */
  failAt: number | null;
  /** Drop the link when block k arrives. */
  disconnectAt: number | null;
  /**
   * MOCK ASSUMPTION (PROTOCOL.md only says the HMI's streaming timeout "re-requests from a seq
   * (status 2) or fails (status 1)"; the period isn't documented): no expected block for this long →
   * `3C 02 <expected>`; after `streamRetries` of those in a row → `3C 01 00 00`. Off by default.
   */
  streamTimeoutMs: number;
  streamRetries: number;
  /** Controller SW on page 19 after a successful flash. */
  flashedVersion: string;
  /** If set, blocks are compared with this image; any mismatch ends in status 1 instead of 0. */
  expectImage: Uint8Array | null;
  /** Every block arrives but the final status never comes (the display stays in update mode). */
  silentEnd: boolean;
}

export interface MockHmiOptions {
  name?: string;
  dis?: Partial<Record<'manufacturer' | 'model' | 'hw_rev' | 'fw_rev' | 'sw_rev', string>>;
  /** Identity text by field name (ctrl_sw: '03.06.s0'); missing = blank (all spaces), like the real HMI. */
  identity?: Partial<Record<string, string>>;
  live?: Partial<MockLive>;
  config?: Partial<MockConfig>;
  status?: Partial<MockStatus>;
  bleBatteryPct?: number;
  logs?: Partial<Record<1 | 2 | 3, Uint8Array>>;
  /** Expose the Nordic Secure DFU service 0xFE59. Unknown on the real HMI: tests decide. */
  dfuService?: boolean;
  /** …0011 properties. Default: write without response only (globe_capture.py "write-no-resp"). */
  blockCharProps?: Partial<CharProperties>;
  /** The controller answers none of its identity fields and reports e031 (the recovery case). */
  controllerSilent?: boolean;
  timing?: Partial<MockTiming>;
  update?: Partial<UpdateScript>;
  /** Record every notification in `events` (off by default: the live loop is chatty). */
  recordNotifications?: boolean;
  /** The battery's BMS. Default: its version follows identity batt_sw (page 24, nibble-swapped). */
  bms?: MockBmsOptions;
  /** Bus noise while bus access is on (display polls, BMS telemetry). Default on. */
  busNoise?: boolean;
}

export interface MockStatus {
  awake: boolean;
  locked: boolean;
  charging: boolean;
  imperial: boolean;
}

export interface MockEvent {
  /** ms since the mock was created */
  t: number;
  kind: 'connect' | 'disconnect' | 'read' | 'write' | 'subscribe' | 'unsubscribe' | 'notify' | 'violation' | 'state';
  char?: string;
  mode?: WriteMode;
  hex?: string;
  note?: string;
}

/**
 * The simulated bike: the hardware-test bike's display, versions and models (PROTOCOL.md), with
 * made-up serial numbers (real ones stay out of the repo).
 */
export const DEMO_BIKE = {
  name: 'EH02_00001',
  dis: { manufacturer: 'Eagotech', model: 'EH2CG0B071', hw_rev: '1.2', fw_rev: '1.0', sw_rev: '5.19' },
  identity: {
    ctrl_serial1: '200000001', ctrl_model: '1B', ctrl_sw: '03.06.s0', ctrl_hw: 'AS.03',
    batt_serial1: '30000001', batt_sw: '10.00.21.RC',
  },
} as const;

const DEFAULT_LIVE: MockLive = {
  assist: 1, speed_x10: 0, error_bits: 0, ride_time_s: 15, trip_m: 814_200, odometer_m: 814_000, range_km: 79,
  cadence_rpm: 0, batt_temp_c: 20, batt_current_ma: 90, batt_mv: 52_192, motor_rpm: 0, assist_levels: 5,
  batt_pct: 81, key_flags: '010101010101', headlight: 1,
};
const DEFAULT_CONFIG: MockConfig = {
  assist_levels: 5, wheel_circ_mm: 2235, speed_limit_x10: 250, headlight: 1, shutdown_timer_s: 0,
  ctrl_err_code: 0, batt_err_code: 0, motor_err_code: 0,
};
const DEFAULT_TIMING: MockTiming = {
  writeMs: 5, blockWriteMs: 1, ackMs: 60, pagesMs: 60, liveIntervalMs: 100, statusIntervalMs: 0,
  fwAckMs: 150, eraseMs: 4_570, finishMs: 148, dumpChunkMs: 10,
  airMsPerPacket: 0, hostQueuesWrites: false, requestsJumpAir: false,
};
const DEFAULT_UPDATE: UpdateScript = {
  neverReady: false, resendAt: [], failAt: null, disconnectAt: null, streamTimeoutMs: Infinity,
  streamRetries: 3, flashedVersion: '03.06.s0', expectImage: null, silentEnd: false,
};

/** sbc bit 21, controller_e031 "Update FW Error" (from protocol/errors.ts SBC_TABLE). */
const E031 = 1 << 21;
const CONTROLLER_IDENTITY = ['ctrl_serial1', 'ctrl_serial2', 'ctrl_model', 'ctrl_sw', 'ctrl_hw', 'ctrl_mfr'];
/** Pages the HMI 5.19 page builder answers (PROTOCOL.md "Which pages the HMI can build"). */
const BUILT_PAGES = new Set([...Array.from({ length: 28 }, (_, i) => i + 1), 40, 51, 52, 53, 54, 55, 56]);
/** What the mock expects this app to send on …0010 (independent of frames.ts). */
const EXPECTED_OPS = new Set([0x3c, 0x3d, 0x3e, 0x29, 0x46, 0x50, 0x52, 0x09]);
/** sbc bit 1, bms_e032 "Battery - Communication Error": the display can't reach the BMS application. */
const BMS_E032 = 1 << 1;
const ZERO8 = '0000000000000000';
/** The battery-update CAN frames this app may put on the bus (PROTOCOL.md section 7), independent of frames.ts. */
const BMS_FRAMES: Readonly<Record<number, string | null>> = {
  0x101: '55aa55aa00000000', 0x10f: ZERO8, 0x280: ZERO8, 0x281: ZERO8, 0x049: ZERO8, 0x045: '000000004541474f', 0x047: null,
};

/** "10.00.21.RC" (page 24) → "010012RC" (what the BMS answers on 0x280); '' if it isn't that shape. */
function fromPage24(v: string | undefined): string {
  const m = /^(\d)(\d)\.(\d)(\d)\.(\d)(\d)\.([A-Z]{2})$/.exec(v ?? '');
  return m ? `${m[2]}${m[1]}${m[4]}${m[3]}${m[6]}${m[5]}${m[7]}` : '';
}

interface MirrorFrame {
  id: number;
  data: Uint8Array;
  /** 0 = received from the bus, 1 = put on the bus by the display. */
  src: 0 | 1;
}

type Update =
  | { phase: 'idle' }
  | { phase: 'erasing'; total: number }
  | { phase: 'streaming'; total: number; expected: number; resent: Set<number>; retries: number; mismatch: boolean }
  | { phase: 'finishing'; total: number };

type Sub = (v: Uint8Array) => void;

export class MockHmi {
  readonly name: string;
  readonly events: MockEvent[] = [];
  readonly violations: string[] = [];
  /** Every …0010 write and …0011 write, in order. */
  readonly writes: { t: number; char: string; mode: WriteMode; bytes: Uint8Array }[] = [];
  /** Accepted (in-sequence) firmware blocks. */
  blocksAccepted = 0;
  /** Times a stale/out-of-sequence block was ignored. */
  blocksIgnored = 0;
  /** With a radio: the most packets ever waiting in the air queue. */
  airPeak = 0;

  live: MockLive;
  config: MockConfig;
  status: MockStatus;
  identity: Record<string, string>;
  dis: Record<string, string>;
  logs: Partial<Record<1 | 2 | 3, Uint8Array>>;
  timing: MockTiming;
  update: UpdateScript;
  bleBatteryPct: number;
  controllerSilent: boolean;

  /** Live pages stop while true: the HMI only sends page 0x3C until the update ends or a power cycle. */
  inUpdateMode = false;
  /** `50 01`: bus access on. Data pages stop; bus frames are mirrored. */
  canBus = false;
  /** The battery's BMS on the CAN bus. */
  readonly bms: MockBms;
  /** `52` frames put on the bus, in order (id + data hex). */
  readonly busFrames: { t: number; id: number; hex: string }[] = [];
  /** restartSystem(): the bike is off (no connections) until then (Date.now() ms). */
  offlineUntil = 0;
  /** Times the battery restarted the whole bike. */
  systemRestarts = 0;
  /** The auto-off value at power-on: `09` may only set 0 or this. */
  private readonly autoOffOriginal: number;
  private readonly busNoise: boolean;
  /** Timers on the bike itself (the BMS restart): they run whether or not a phone is connected. */
  private readonly bikeTimers = new Set<ReturnType<typeof setTimeout>>();
  private noiseTimers: ReturnType<typeof setInterval>[] = [];
  /** 46 was received: the controller's application is gone until a transfer completes. */
  controllerErased = false;
  updateState: Update = { phase: 'idle' };

  private readonly t0 = Date.now();
  private readonly dfuService: boolean;
  private readonly blockProps: CharProperties;
  private readonly recordNotifications: boolean;
  private connected = false;
  /** powerCycleUnnoticed(): the computer thinks it's connected, but nothing gets through. */
  private deadLink = false;
  private pageMode = false;
  private loopPages: number[] | null = null;
  private readonly subs = new Map<string, Sub>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private liveTimer: ReturnType<typeof setInterval> | null = null;
  private statusTimer: ReturnType<typeof setInterval> | null = null;
  private streamTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly disconnectListeners = new Set<() => void>();

  constructor(opts: MockHmiOptions = {}) {
    this.name = opts.name ?? DEMO_BIKE.name;
    this.dis = { ...DEMO_BIKE.dis, ...opts.dis };
    this.identity = { ...DEMO_BIKE.identity, ...opts.identity } as Record<string, string>;
    this.live = { ...DEFAULT_LIVE, ...opts.live };
    this.config = { ...DEFAULT_CONFIG, ...opts.config };
    this.status = { awake: true, locked: false, charging: false, imperial: true, ...opts.status };
    this.bleBatteryPct = opts.bleBatteryPct ?? this.live.batt_pct;
    this.logs = { ...opts.logs };
    this.dfuService = opts.dfuService ?? false;
    this.blockProps = { read: false, write: false, writeWithoutResponse: true, notify: false, indicate: false, ...opts.blockCharProps };
    this.controllerSilent = opts.controllerSilent ?? false;
    this.timing = { ...DEFAULT_TIMING, ...opts.timing };
    this.update = { ...DEFAULT_UPDATE, ...opts.update };
    this.recordNotifications = opts.recordNotifications ?? false;
    this.bms = new MockBms({ version: fromPage24(this.identity.batt_sw), ...opts.bms });
    if (opts.bms?.version !== undefined && opts.identity?.batt_sw === undefined) this.identity.batt_sw = page24Form(this.bms.version);
    this.autoOffOriginal = this.config.shutdown_timer_s;
    this.busNoise = opts.busNoise ?? true;
    const listeners = this.disconnectListeners;
    this.device = {
      id: `mock-${this.name}-${Math.random().toString(36).slice(2, 8)}`,
      name: this.name,
      connect: () => this.connect(),
      onDisconnected: (l: () => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    };
  }

  // ---- what the transport sees ---------------------------------------------------------------

  /** A connected HMI stops advertising (PROTOCOL.md "One connection at a time"). */
  get advertising(): boolean {
    return !this.connected;
  }

  readonly advertisedServices = [SCAN_UUID];

  /** What requestDevice hands the app for this bike. */
  readonly device: BleDevice;

  get isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<GattLink> {
    if (this.connected) throw new Error('NetworkError: the display is already connected to another central');
    if (Date.now() < this.offlineUntil) throw Object.assign(new Error('NetworkError: Connection attempt failed (the bike is off).'), { name: 'NetworkError' });
    this.connected = true;
    this.pageMode = false;
    this.log({ kind: 'connect' });
    const link = new MockLink(this);
    if (this.timing.statusIntervalMs > 0) {
      this.statusTimer = setInterval(() => this.emit(CH_POWER, this.statusBytes()), this.timing.statusIntervalMs);
    }
    return link;
  }

  /** The link drops (out of range, bike switched off, Windows dropped it). */
  dropLink(note = 'link lost'): void {
    if (!this.connected) return;
    this.connected = false;
    this.deadLink = false;
    this.log({ kind: 'disconnect', note });
    this.stopTimers();
    this.subs.clear();
    for (const l of [...this.disconnectListeners]) l();
  }

  /**
   * Power button off/on. Update mode ends; a controller left without an application now sits in its
   * bootloader: it answers no identity request and reports controller_e031 (PROTOCOL.md step 6).
   */
  powerCycle(): void {
    this.dropLink('power cycle');
    this.inUpdateMode = false;
    this.updateState = { phase: 'idle' };
    this.loopPages = null;
    if (this.controllerErased) this.controllerSilent = true;
  }

  /**
   * The bike is switched off and on, but the computer never notices: no disconnect event, the old
   * link still "claims to be up", and nothing more arrives on it (writes on it fail). Closing the link
   * from the app ends that; then the bike can be connected again.
   */
  powerCycleUnnoticed(): void {
    if (!this.connected) return;
    this.log({ kind: 'state', note: 'power cycle the computer did not notice' });
    this.stopTimers();
    this.subs.clear();
    this.deadLink = true;
    this.inUpdateMode = false;
    this.updateState = { phase: 'idle' };
    this.loopPages = null;
    if (this.controllerErased) this.controllerSilent = true;
  }

  /**
   * The battery's restart cuts system power (PROTOCOL.md section 2): the link drops, the bike is off for
   * [offlineMs], then the display boots and reads the battery version (page 24) from the BMS again.
   */
  restartSystem(offlineMs: number): void {
    this.systemRestarts++;
    this.log({ kind: 'state', note: `system restart (battery): off for ${offlineMs} ms` });
    this.dropLink('battery restart: system power cut');
    this.canBus = false;
    this.loopPages = null;
    this.inUpdateMode = false;
    this.offlineUntil = Date.now() + offlineMs;
    this.identity.batt_sw = this.bms.app ? page24Form(this.bms.version) : '';
  }

  /** Test hook: the display sends its final verdict now (e.g. after the app stopped waiting). */
  finishNow(ok: boolean): void {
    if (this.updateState.phase === 'streaming' || this.updateState.phase === 'finishing') this.finishUpdate(ok, 'finished on request');
  }

  setLive(v: Partial<MockLive>): void {
    Object.assign(this.live, v);
  }

  setStatus(s: Partial<MockStatus>): void {
    Object.assign(this.status, s);
    if (this.connected) this.emit(CH_POWER, this.statusBytes());
  }

  /** …0010 command frames received, in order. */
  commands(): Uint8Array[] {
    return this.writes.filter((w) => w.char === CH_WRITE).map((w) => w.bytes);
  }

  /** Page-0x3C notifications sent, as hex. */
  fwStatusesSent(): string[] {
    return this.events.filter((e) => e.kind === 'notify' && e.char === CH_READ && e.hex?.startsWith('3c')).map((e) => e.hex!);
  }

  // ---- GATT table ------------------------------------------------------------------------------

  services(): GattServiceInfo[] {
    const p = (o: Partial<CharProperties>): CharProperties => ({ read: false, write: false, writeWithoutResponse: false, notify: false, indicate: false, ...o });
    const out: GattServiceInfo[] = [
      {
        uuid: SVC_EBIKE,
        characteristics: [
          { uuid: CH_READ, properties: p({ notify: true }) },
          { uuid: CH_WRITE, properties: p({ write: true, indicate: true }) },
          { uuid: CH_BYPASS, properties: { ...this.blockProps } },
          { uuid: CH_POWER, properties: p({ read: true, notify: true }) },
        ],
      },
      {
        uuid: SVC_DIS,
        characteristics: [...Object.values(DIS_CHARS), DIS_SERIAL_BLOCKLISTED].map((uuid) => ({ uuid, properties: p({ read: true }) })),
      },
      { uuid: SVC_BATTERY, characteristics: [{ uuid: CH_BATTERY_LEVEL, properties: p({ read: true, notify: true }) }] },
    ];
    // MOCK ASSUMPTION: the FE59 characteristics aren't modelled until the HMI DFU milestone.
    if (this.dfuService) out.push({ uuid: SVC_SECURE_DFU, characteristics: [] });
    return out;
  }

  // ---- called by MockLink ----------------------------------------------------------------------

  /** @internal */
  requireConnected(): void {
    if (!this.connected) throw new LinkLostError();
    if (this.deadLink) throw Object.assign(new Error('NetworkError: GATT operation failed for unknown reason.'), { name: 'NetworkError' });
  }

  /** @internal */
  read(service: string, char: string): Uint8Array {
    this.requireConnected();
    this.log({ kind: 'read', char });
    if (char === DIS_SERIAL_BLOCKLISTED) {
      this.violation('read the DIS Serial Number 0x2A25 (on Chrome\'s GATT blocklist)');
      throw Object.assign(new Error('SecurityError: blocklisted UUID'), { name: 'SecurityError' });
    }
    if (service === SVC_DIS) {
      const key = (Object.entries(DIS_CHARS).find(([, u]) => u === char) ?? [])[0];
      const v = key ? this.dis[key] : undefined;
      if (v === undefined) throw new Error(`NotFoundError: ${char}`);
      return new TextEncoder().encode(v);
    }
    if (char === CH_BATTERY_LEVEL) return Uint8Array.of(this.bleBatteryPct);
    if (char === CH_POWER) return this.statusBytes();
    throw new Error(`NotSupportedError: ${char} is not readable`);
  }

  /** @internal */
  subscribe(char: string, cb: Sub): void {
    this.requireConnected();
    this.log({ kind: 'subscribe', char });
    this.subs.set(char, cb);
    if (char === CH_READ) this.syncLiveTimer();
  }

  /** @internal */
  unsubscribe(char: string): void {
    this.log({ kind: 'unsubscribe', char });
    this.subs.delete(char);
    if (char === CH_READ) this.syncLiveTimer();
  }

  /**
   * Test hook: the next [times] writes whose hex starts with [hexPrefix] fail with a transient
   * "GATT operation failed" and never reach the display (as a BlueZ / WinRT hiccup would).
   */
  failWrites(hexPrefix: string, times = 1): void {
    this.writeFailures.set(hexPrefix.toLowerCase(), times);
  }

  private readonly writeFailures = new Map<string, number>();

  /** @internal Handle a write the moment it reaches the display. */
  receiveWrite(char: string, bytes: Uint8Array, mode: WriteMode): void {
    this.requireConnected();
    for (const [prefix, left] of this.writeFailures) {
      if (left > 0 && hex(bytes).startsWith(prefix)) {
        this.writeFailures.set(prefix, left - 1);
        this.log({ kind: 'state', note: `write ${hex(bytes)} failed (scripted)` });
        throw Object.assign(new Error('NetworkError: GATT operation failed for unknown reason.'), { name: 'NetworkError' });
      }
    }
    const b = bytes.slice();
    this.writes.push({ t: this.now(), char, mode, bytes: b });
    this.log({ kind: 'write', char, mode, hex: hex(b) });
    if (char === CH_WRITE) {
      if (mode !== 'with-response') this.violation(`…0010 written without response: ${hex(b)}`);
      this.onCommand(b);
    } else if (char === CH_BYPASS) {
      const allowed = mode === 'with-response' ? this.blockProps.write : this.blockProps.writeWithoutResponse;
      if (!allowed) {
        this.violation(`…0011 written ${mode} but its properties don't allow that`);
        throw Object.assign(new Error(`NotSupportedError: …0011 doesn't support ${mode}`), { name: 'NotSupportedError' });
      }
      this.onBlock(b);
    } else {
      this.violation(`write to ${char}: ${hex(b)}`);
      throw new Error(`NotSupportedError: ${char} is not writable`);
    }
  }

  // ---- protocol --------------------------------------------------------------------------------

  private onCommand(b: Uint8Array): void {
    const op = b[0] ?? -1;
    if (!EXPECTED_OPS.has(op)) {
      this.violation(`unexpected command ${hex(b)}`);
      this.later(this.timing.ackMs, () => this.ack(op, 2));
      return;
    }
    switch (op) {
      case 0x3c:
        if (b.length !== 2 || b[1] !== 1) this.violation(`odd 3C frame ${hex(b)}`);
        this.pageMode = true;
        this.later(this.timing.ackMs, () => this.ack(op, 1));
        return;
      case 0x3d: {
        if (b.length !== 19) this.violation(`3D frame of ${b.length} bytes (page_req makes 19)`);
        const pages = [...b.subarray(1)].filter((p) => p !== 0);
        // A one-shot request replaces the loop (the stock update trace pauses the stream with `3D 37`).
        this.loopPages = null;
        this.syncLiveTimer();
        this.later(this.timing.ackMs, () => this.ack(op, 1));
        // MOCK ASSUMPTION: in update mode the HMI answers no data pages (PROTOCOL.md: it "sends ONLY this page").
        // With bus access on it sends no data pages either (PROTOCOL.md "While CAN mirroring (50 01) is on").
        if (this.canBus) this.violation(`3D while bus access is on: ${hex(b)}`);
        if (!this.inUpdateMode && !this.canBus) this.later(this.timing.pagesMs, () => this.sendPages(pages.filter((p) => BUILT_PAGES.has(p))));
        return;
      }
      case 0x3e: {
        if (b.length !== 19) this.violation(`3E frame of ${b.length} bytes (page_req makes 19)`);
        this.loopPages = [...b.subarray(1)].filter((p) => p !== 0);
        this.later(this.timing.ackMs, () => this.ack(op, 1));
        this.syncLiveTimer();
        return;
      }
      case 0x29: {
        const type = b[1];
        if (b.length !== 4 || (type !== 1 && type !== 2 && type !== 3) || b[2] !== 0 || b[3] !== 0) {
          this.violation(`odd 29 frame ${hex(b)}`);
          this.later(this.timing.ackMs, () => this.ack(op, 3));
          return;
        }
        this.later(this.timing.ackMs, () => this.ack(op, 1));
        this.later(this.timing.ackMs + 20, () => this.sendDump(this.logs[type] ?? new Uint8Array(0)));
        return;
      }
      case 0x46:
        this.onFwStart(b);
        return;
      case 0x50:
        if (b.length !== 2 || (b[1] !== 0 && b[1] !== 1)) {
          this.violation(`odd 50 frame ${hex(b)}`);
          this.later(this.timing.ackMs, () => this.ack(op, 3));
          return;
        }
        this.canBus = b[1] === 1;
        this.log({ kind: 'state', note: this.canBus ? 'bus access on (BPIN)' : 'bus access off (BPOU)' });
        this.syncLiveTimer();
        this.syncNoise();
        this.later(this.timing.ackMs, () => this.ack(op, 1));
        return;
      case 0x52:
        this.onCanSend(b);
        return;
      case 0x09: {
        const v = b.length === 5 ? (b[1]! | (b[2]! << 8) | (b[3]! << 16) | (b[4]! << 24)) >>> 0 : -1;
        if (v !== 0 && v !== this.autoOffOriginal) this.violation(`09 that is neither 0 nor the original auto-off: ${hex(b)}`);
        if (v >= 0) this.config.shutdown_timer_s = v;
        this.later(this.timing.ackMs, () => this.ack(op, v >= 0 ? 1 : 3));
        return;
      }
    }
  }

  /** `52 <id u32 LE> 08 <8 data>`: one frame on the bus; echoed (src 1) and answered while bus access is on. */
  private onCanSend(b: Uint8Array): void {
    if (b.length !== 14 || b[5] !== 8) {
      this.violation(`odd 52 frame ${hex(b)}`);
      this.later(this.timing.ackMs, () => this.ack(0x52, 3));
      return;
    }
    const id = (b[1]! | (b[2]! << 8) | (b[3]! << 16) | (b[4]! << 24)) >>> 0;
    const data = b.slice(6, 14);
    this.busFrames.push({ t: this.now(), id, hex: hex(data) });
    if (!(id in BMS_FRAMES)) this.violation(`52 to CAN 0x${id.toString(16)}: not a battery-update frame`);
    else if (BMS_FRAMES[id] !== null && hex(data) !== BMS_FRAMES[id]) this.violation(`52 to CAN 0x${id.toString(16)} with ${hex(data)}`);
    if (!this.canBus) this.violation(`52 while bus access is off: ${hex(b)}`);
    // Replies within 2 ms come back in the same connection event as the echo: one notification.
    const sameEvent: MirrorFrame[] = [];
    const bus: BmsBus = {
      reply: (rid, rdata, delayMs) => {
        if (delayMs <= 2) sameEvent.push({ id: rid, data: rdata, src: 0 });
        else this.later(this.timing.ackMs + delayMs, () => this.mirror([{ id: rid, data: rdata, src: 0 }]));
      },
      schedule: (ms, fn) => this.bikeLater(this.timing.ackMs + ms, fn),
      restartSystem: (ms) => this.restartSystem(ms),
      note: (m) => this.log({ kind: 'state', note: m }),
    };
    this.bms.onFrame(id, data, bus);
    this.later(this.timing.ackMs, () => {
      this.ack(0x52, 1);
      this.mirror([{ id, data, src: 1 }, ...sameEvent]);
    });
  }

  /** Mirrored bus frames, 19 bytes each, in one notification (only while bus access is on). */
  private mirror(frames: MirrorFrame[]): void {
    if (!this.canBus || frames.length === 0) return;
    const out = new Uint8Array(frames.length * 19);
    const ts = this.now() >>> 0;
    frames.forEach((f, k) => {
      const o = k * 19;
      out[o] = 0x51;
      out[o + 1] = f.id & 0xff;
      out[o + 2] = (f.id >>> 8) & 0xff;
      out[o + 3] = (f.id >>> 16) & 0xff;
      out[o + 4] = (f.id >>> 24) & 0xff;
      out[o + 5] = 8;
      out.set(f.data.subarray(0, 8), o + 6);
      out[o + 14] = f.src;
      out[o + 15] = ts & 0xff;
      out[o + 16] = (ts >>> 8) & 0xff;
      out[o + 17] = (ts >>> 16) & 0xff;
      out[o + 18] = (ts >>> 24) & 0xff;
    });
    this.emit(CH_READ, out);
  }

  /** While bus access is on: the display's own polls (0x2C1, src 1) and the BMS telemetry (0x283, src 0). */
  private syncNoise(): void {
    for (const t of this.noiseTimers) clearInterval(t);
    this.noiseTimers = [];
    if (!this.canBus || !this.busNoise || !this.connected) return;
    this.noiseTimers.push(setInterval(() => this.mirror([{ id: 0x2c1, data: new Uint8Array(8), src: 1 }]), 1_200));
    this.noiseTimers.push(setInterval(() => {
      if (this.bms.app) this.mirror([{ id: 0x283, data: Uint8Array.of(0x3b, 0x12, 0x0c, 0, 11, 20, this.live.batt_pct, 0), src: 0 }]);
    }, 256));
  }

  private bikeLater(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.bikeTimers.delete(t);
      fn();
    }, ms);
    this.bikeTimers.add(t);
  }

  private onFwStart(b: Uint8Array): void {
    if (b.length !== 7 || b[1] !== 0) {
      this.violation(`46 frame that isn't a type-0 controller start: ${hex(b)}`);
      this.later(this.timing.fwAckMs, () => this.ack(0x46, 3));
      return;
    }
    const total = b[2]! | (b[3]! << 8);
    // Re-sending 46 restarts at step 1: the controller re-erases (PROTOCOL.md, "seen 6 times").
    this.clearStreamTimer();
    this.inUpdateMode = true;
    this.controllerErased = true;
    this.loopPages = null;
    this.syncLiveTimer();
    this.updateState = { phase: 'erasing', total };
    this.log({ kind: 'state', note: `update mode: erasing, ${total} blocks` });
    this.later(this.timing.fwAckMs, () => this.ack(0x46, 1));
    if (this.update.neverReady) return;
    this.later(this.timing.eraseMs, () => {
      if (this.updateState.phase !== 'erasing') return;
      this.updateState = { phase: 'streaming', total, expected: 1, resent: new Set(), retries: 0, mismatch: false };
      this.fwStatus(2, 1);
      this.armStreamTimer();
    });
  }

  private onBlock(b: Uint8Array): void {
    const u = this.updateState;
    if (b[0] !== 0x47 || b.length !== 12) {
      this.violation(`…0011 frame that isn't a 12-byte 47 block: ${hex(b)}`);
      return;
    }
    if (u.phase !== 'streaming') {
      this.violation(`block received outside streaming (${u.phase})`);
      return;
    }
    const seq = b[1]! | (b[2]! << 8);
    const len = b[3]!;
    if (seq !== u.expected) {
      this.blocksIgnored++;
      return;
    }
    if (this.update.disconnectAt === seq) {
      this.dropLink(`link dropped at block ${seq}`);
      return;
    }
    if (this.update.failAt === seq) {
      this.finishUpdate(false, `failure scripted at block ${seq}`);
      return;
    }
    if (this.update.resendAt.includes(seq) && !u.resent.has(seq)) {
      u.resent.add(seq);
      this.fwStatus(2, seq);
      this.armStreamTimer();
      return;
    }
    const img = this.update.expectImage;
    if (img) {
      const from = (seq - 1) * 8;
      const want = img.subarray(from, Math.min(from + 8, img.length));
      const got = b.subarray(4, 4 + len);
      if (len !== want.length || want.some((x, i) => x !== got[i]) || b.subarray(4 + len).some((x) => x !== 0)) u.mismatch = true;
    }
    this.blocksAccepted++;
    u.expected++;
    u.retries = 0;
    if (u.expected > u.total) {
      this.clearStreamTimer();
      const mismatch = u.mismatch;
      this.updateState = { phase: 'finishing', total: u.total };
      if (this.update.silentEnd) {
        this.log({ kind: 'state', note: 'all blocks received; scripted to never send the final status' });
        return;
      }
      this.later(this.timing.finishMs, () => this.finishUpdate(!mismatch, mismatch ? 'image mismatch' : 'all blocks acked'));
    } else {
      this.armStreamTimer();
    }
  }

  private finishUpdate(ok: boolean, note: string): void {
    this.clearStreamTimer();
    this.fwStatus(ok ? 0 : 1, 0);
    this.inUpdateMode = false; // BPOU
    this.updateState = { phase: 'idle' };
    this.log({ kind: 'state', note: `update ${ok ? 'succeeded' : 'failed'}: ${note}` });
    if (ok) {
      this.controllerErased = false;
      this.controllerSilent = false;
      this.identity.ctrl_sw = this.update.flashedVersion;
    }
  }

  private armStreamTimer(): void {
    this.clearStreamTimer();
    if (!Number.isFinite(this.update.streamTimeoutMs)) return;
    this.streamTimer = setTimeout(() => {
      const u = this.updateState;
      if (u.phase !== 'streaming' || !this.connected) return;
      u.retries++;
      if (u.retries > this.update.streamRetries) this.finishUpdate(false, 'HMI streaming timeout');
      else {
        this.fwStatus(2, u.expected);
        this.armStreamTimer();
      }
    }, this.update.streamTimeoutMs);
  }

  private clearStreamTimer(): void {
    if (this.streamTimer) clearTimeout(this.streamTimer);
    this.streamTimer = null;
  }

  private fwStatus(status: number, seq: number): void {
    this.emit(CH_READ, Uint8Array.of(0x3c, status, seq & 0xff, (seq >>> 8) & 0xff), true);
  }

  private ack(op: number, status: number): void {
    this.emit(CH_WRITE, Uint8Array.of(0x10, op & 0xff, status), true);
  }

  /** Error bits as the HMI reports them now. */
  errorBits(): number {
    let bits = this.live.error_bits;
    if (this.controllerSilent || (this.controllerErased && !this.inUpdateMode)) bits |= E031;
    if (!this.bms.app) bits |= BMS_E032;
    return bits >>> 0;
  }

  private page(pid: number): Uint8Array | null {
    const key = STRING_PAGES[pid];
    if (key !== undefined) {
      const blank = this.controllerSilent && CONTROLLER_IDENTITY.includes(key);
      return identityPage(pid, blank ? '' : (this.identity[key] ?? ''));
    }
    const live: MockLive = { ...this.live, error_bits: this.errorBits() };
    if (this.controllerSilent) {
      // MOCK ASSUMPTION: with no controller application, the controller-sourced live fields read "not reported".
      Object.assign(live, { speed_x10: 0xffff, trip_m: 0xffffffff, odometer_m: 0xffffffff, ride_time_s: 0xffffffff, range_km: 0xffff });
    }
    switch (pid) {
      case 5:
        return settings5Page(this.config);
      case 7: case 8: case 9: case 10: case 40:
        return livePage(pid, live);
      case 54:
        return configPage(this.config);
      case 55:
        return settingsPage(this.config, this.live.assist, this.errorBits());
      case 56:
        return productionPage();
      default:
        // MOCK ASSUMPTION: other built pages answer with their id and 0xFF fill (pages 1/2/3 are "empty echoes").
        return BUILT_PAGES.has(pid) ? Uint8Array.from({ length: 20 }, (_, i) => (i === 0 ? pid : 0xff)) : null;
    }
  }

  /** Send pages packed as the HMI does in MTU page mode (12 x 20 B per notification at MTU 247). */
  private sendPages(pids: number[]): void {
    const pages = pids.map((p) => this.page(p)).filter((p): p is Uint8Array => p !== null);
    const per = this.pageMode ? 12 : 1;
    for (let i = 0; i < pages.length; i += per) {
      const chunk = pages.slice(i, i + per);
      const out = new Uint8Array(chunk.length * 20);
      chunk.forEach((p, j) => out.set(p, j * 20));
      this.emit(CH_READ, out);
    }
  }

  /**
   * MOCK ASSUMPTION on framing: `BE` alone, then the bytes in notifications of up to 240 (page mode) or
   * 20 bytes, then `ED` alone (globe_capture.py only needs byte 0 of each to be BE / ED). A running
   * live loop keeps interleaving its pages, which is why the app must pause it first.
   */
  private sendDump(data: Uint8Array): void {
    const per = this.pageMode ? 240 : 20;
    const chunks: Uint8Array[] = [Uint8Array.of(0xbe)];
    for (let i = 0; i < data.length; i += per) chunks.push(data.slice(i, i + per));
    chunks.push(Uint8Array.of(0xed));
    chunks.forEach((c, i) => this.later(i * this.timing.dumpChunkMs, () => this.emit(CH_READ, c)));
  }

  private syncLiveTimer(): void {
    const on = this.connected && this.loopPages !== null && !this.inUpdateMode && !this.canBus && this.subs.has(CH_READ);
    if (on && !this.liveTimer) {
      this.liveTimer = setInterval(() => {
        if (this.loopPages && !this.inUpdateMode && !this.canBus) this.sendPages(this.loopPages.filter((p) => BUILT_PAGES.has(p)));
      }, this.timing.liveIntervalMs);
    } else if (!on && this.liveTimer) {
      clearInterval(this.liveTimer);
      this.liveTimer = null;
    }
  }

  statusBytes(): Uint8Array {
    const s = this.status;
    return Uint8Array.of(s.awake ? 1 : 0, s.locked ? 1 : 0, s.charging ? 1 : 0, s.imperial ? 1 : 0);
  }

  private emit(char: string, bytes: Uint8Array, always = false): void {
    if (!this.connected || this.deadLink) return;
    if (always || this.recordNotifications) this.log({ kind: 'notify', char, hex: hex(bytes) });
    this.subs.get(char)?.(bytes.slice());
  }

  private later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (this.connected) fn();
    }, ms);
    this.timers.add(t);
  }

  private stopTimers(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.clearStreamTimer();
    if (this.liveTimer) clearInterval(this.liveTimer);
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.liveTimer = this.statusTimer = null;
    for (const t of this.noiseTimers) clearInterval(t);
    this.noiseTimers = [];
  }

  private violation(what: string): void {
    this.violations.push(what);
    this.log({ kind: 'violation', note: what });
  }

  private now(): number {
    return Date.now() - this.t0;
  }

  private log(e: Omit<MockEvent, 't'>): void {
    this.events.push({ t: this.now(), ...e });
  }
}

/**
 * The GattLink a MockHmi hands out. Each write takes the configured time to "complete". With a radio
 * (MockTiming.airMsPerPacket > 0) writes and reads go through one FIFO air queue first.
 */
class MockLink implements GattLink {
  private readonly air: { deliver: () => void; resolve: () => void; reject: (e: unknown) => void }[] = [];
  private airTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly hmi: MockHmi) {}

  get connected(): boolean {
    return this.hmi.isConnected;
  }

  /** Send one packet over the air; resolves once the display has it. */
  private overAir(deliver: () => void): Promise<void> {
    return new Promise((resolve, reject) => {
      this.air.push({ deliver, resolve, reject });
      this.hmi.airPeak = Math.max(this.hmi.airPeak, this.air.length);
      this.pumpAir();
    });
  }

  private pumpAir(): void {
    if (this.airTimer || this.air.length === 0) return;
    this.airTimer = setTimeout(() => {
      this.airTimer = null;
      if (!this.hmi.isConnected) {
        for (const p of this.air.splice(0)) p.reject(new LinkLostError());
        return;
      }
      const p = this.air.shift()!;
      try {
        p.deliver();
        p.resolve();
      } catch (e) {
        p.reject(e);
      }
      this.pumpAir();
    }, this.hmi.timing.airMsPerPacket);
  }

  private get radio(): boolean {
    return this.hmi.timing.airMsPerPacket > 0;
  }

  async services(): Promise<GattServiceInfo[]> {
    this.hmi.requireConnected();
    return this.hmi.services();
  }

  async properties(service: string, characteristic: string): Promise<CharProperties | null> {
    this.hmi.requireConnected();
    const s = this.hmi.services().find((x) => x.uuid === service);
    return s?.characteristics.find((c) => c.uuid === characteristic)?.properties ?? null;
  }

  async read(service: string, characteristic: string): Promise<Uint8Array> {
    if (this.radio && !this.hmi.timing.requestsJumpAir) {
      this.hmi.requireConnected();
      await this.overAir(() => undefined);
    }
    await tick(this.hmi.timing.writeMs);
    return this.hmi.read(service, characteristic);
  }

  async write(_service: string, characteristic: string, value: Uint8Array, mode: WriteMode): Promise<void> {
    const t = this.hmi.timing;
    const local = characteristic === CH_BYPASS ? t.blockWriteMs : t.writeMs;
    if (!this.radio || (mode === 'with-response' && t.requestsJumpAir)) {
      this.hmi.receiveWrite(characteristic, value, mode);
      await tick(local);
      this.hmi.requireConnected();
      return;
    }
    this.hmi.requireConnected();
    const copy = value.slice();
    const delivered = this.overAir(() => this.hmi.receiveWrite(characteristic, copy, mode));
    if (mode === 'without-response' && t.hostQueuesWrites) {
      // "Done" once queued here; a packet that can't be delivered later is simply lost.
      delivered.catch(() => undefined);
      await tick(local);
      this.hmi.requireConnected();
      return;
    }
    await delivered;
    await tick(local);
    this.hmi.requireConnected();
  }

  async subscribe(_service: string, characteristic: string, onValue: (value: Uint8Array) => void): Promise<void> {
    await tick(this.hmi.timing.writeMs);
    this.hmi.subscribe(characteristic, onValue);
  }

  async unsubscribe(_service: string, characteristic: string): Promise<void> {
    this.hmi.unsubscribe(characteristic);
  }

  async disconnect(): Promise<void> {
    this.hmi.dropLink('disconnected by the app');
  }
}

function tick(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
