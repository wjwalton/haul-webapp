/**
 * BikeSession: one connection's connect/read sequence and live state (docs/SPEC.md "Connect / read
 * sequence"). It mirrors cmd_capture in reference/globe_capture.py, with the Android app's proven
 * additions (GlobeBleManager.initialize / runOpening / onDataBytes / requestOnce / sendCommand /
 * startErrorPoll / startIdentityRecheck, LinkPolicy.isStale):
 *
 *   0. GATT table (the e-bike service and its …0001 / …0010 / …0004 must be there).
 *   1. Read DIS (each field on its own, never the blocklisted serial) and the BLE battery level.
 *      Error table = sbc (controllerType from the HMI version).
 *   2. Indications on …0010, notifications on …0004, one read of …0004.
 *   3. `3C 01`, then notifications on …0001.
 *   4. Locked (status byte 1 = 1): noted. There is no unlock in this app.
 *   5. `3D` identity pages 11-28, then `3D` 54 55 56 (4 s each, missing pages reported, not fatal).
 *   6. `3E` live loop.
 *
 * Then, while live: page 55 is polled every 30 s (raw error codes) with the loop restarted after it;
 * blank controller identity is re-read once after 5 s before anything calls the controller silent; a
 * watchdog flags a stream that went quiet for 5 s. Every command waits up to 3 s for its ack and goes
 * on without one (the Python's "no ack (continuing)").
 *
 * Pure TypeScript: no DOM, no navigator. It talks to the bike only through SessionLink (BikeLink),
 * so every frame still passes the send whitelist.
 */
import type { CharProperties, GattServiceInfo } from '../ble/transport';
import { hex } from './bytes';
import { decodeErrors, type DecodedError } from './errors';
import { liveLoop, mtuPageMode, oncePages, ERROR_PAGE, PAGES_CONFIG, PAGES_IDENTITY, PAGES_LOOP, type FrameContext } from './frames';
import {
  CH_BATTERY_LEVEL, CH_BYPASS, CH_POWER, CH_READ, CH_WRITE, DIS_CHARS, SVC_BATTERY, SVC_DIS, SVC_EBIKE,
  SVC_SECURE_DFU, type DisField,
} from './gatt';
import {
  ACK_STATUS, ACK_SUCCESS, classifyNotification, controllerType, decodeAck, decodePower, disString,
  splitPages, STRING_PAGES, DUMP_END, type CanFrame, type Decoded, type FwStatus, type PowerStatus,
} from './pages';
import { ErrorDebouncer, gateNotification } from './validate';

/** What the session needs from the link (BikeLink implements it; every write is whitelisted there). */
export interface SessionLink {
  readonly connected: boolean;
  command(frame: Uint8Array, label: string, ctx?: FrameContext): Promise<void>;
  read(service: string, characteristic: string, label?: string): Promise<Uint8Array>;
  subscribe(service: string, characteristic: string, onValue: (v: Uint8Array) => void, label?: string): Promise<void>;
  services(): Promise<GattServiceInfo[]>;
}

// ---- timings (Android GlobeBleManager / ConnectionManager / LinkPolicy) -----------------------

export const TIMING = Object.freeze({
  /** write_cmd: wait this long for [10 op status]. */
  ackMs: 3_000,
  /** request_once: wait this long for every requested page. */
  pagesMs: 4_000,
  /** One opening step (ConnectionManager OPEN_STEP_MS). */
  openStepMs: 10_000,
  /** The whole opening sequence (OPENING_TOTAL_MS). */
  openTotalMs: 45_000,
  /** Page-55 poll period and its page timeout (ERROR_POLL_MS / ERROR_POLL_TIMEOUT_MS). */
  errorPollMs: 30_000,
  errorPollPagesMs: 2_500,
  /** Re-read blank controller identity once, this long after going live (IDENTITY_RECHECK_MS). */
  identityRecheckMs: 5_000,
  /** No data page (or, while locked, no status notification) for this long = stale (LinkPolicy). */
  staleAfterMs: 5_000,
  watchdogTickMs: 500,
  /** An unrequested log dump is dropped until 0xED, or until it has been quiet this long / this old. */
  drainQuietMs: 2_000,
  drainMaxMs: 5 * 60_000,
  /** After the battery update turns bus access off: mirrored frames still in flight are dropped quietly. */
  canDrainMs: 2_000,
  /** Before a firmware update: no live page for this long = the stream has stopped (STREAM_QUIET_MS) … */
  streamQuietMs: 500,
  /** … waited for at most this long (STREAM_QUIET_MAX_MS). */
  streamQuietMaxMs: 3_000,
});

/** Controller identity fields (pages 16-20). All blank on two reads = the controller isn't answering. */
export const CONTROLLER_IDENTITY_KEYS = ['ctrl_serial1', 'ctrl_serial2', 'ctrl_model', 'ctrl_sw', 'ctrl_hw'] as const;
export const CONTROLLER_PAGES: readonly number[] = [16, 17, 18, 19, 20];

const LOG_MAX = 400;
const REJECT_NOTES_PER_WINDOW = 5;
const REJECT_WINDOW_MS = 10_000;

export type SessionPhase = 'opening' | 'live' | 'failed' | 'ended';

export interface DataQuality {
  /** Notifications dropped whole because they weren't (expected) data pages. */
  dropped: number;
  /** Pages rejected by validation, per page id. */
  rejectedByPid: Readonly<Record<number, number>>;
  lastReject: string | null;
}

export interface SessionState {
  phase: SessionPhase;
  /** The opening step running now. */
  step: string | null;
  failure: string | null;
  startedAt: number;
  /** When the opening sequence finished and the live loop started (Android connectedSinceMs). */
  liveSince: number | null;

  gatt: {
    services: readonly GattServiceInfo[] | null;
    /** …0011 properties, read at runtime (the controller update picks its write method from them). */
    blockChar: CharProperties | null;
    /** Nordic Secure DFU service 0xFE59 visible. */
    dfuService: boolean;
  };
  dis: Readonly<Partial<Record<DisField, string>>>;
  disMissing: readonly DisField[];
  /** 'sbc' only when the HMI version confirms it (needed by the controller update). */
  ctype: 'sbc' | null;
  bleBatteryPct: number | null;
  power: PowerStatus | null;

  /** Identity text by field (motor_serial1 … batt_mfr). '' = the page came back blank ("not reported"). */
  identity: Readonly<Record<string, string>>;
  identityMissing: readonly number[];
  /** Identity requests made on this connection (opening + re-reads). */
  identityReads: number;
  /** Page 54 fields, as validated. */
  config: Readonly<Decoded> | null;
  /** Page 55 fields, as validated (headlight, auto-off timer, raw component error codes). */
  settings: Readonly<Decoded> | null;
  /** Auto power-off timer in seconds from page 5 (0 = off); null until page 5 was read (battery update). */
  autoOffS: number | null;
  configMissing: readonly number[];
  production: { buildDate: string | null; prodId: number | null };

  /** Live pages 40/7/8/9/10 and 55 merged (each page updates the fields it carries; sentinels never). */
  live: Readonly<Decoded>;
  liveAt: number | null;
  /** The 32-bit error bitmask, once stable for 3 frames (ErrorDebouncer). */
  errorBits: number | null;
  errors: readonly DecodedError[];

  /** Live loop deliberately stopped (log read, firmware update): the stale watchdog ignores it. */
  livePaused: boolean;
  stale: { quietMs: number; what: 'data page' | 'status notification' } | null;
  /** Page 0x3C arrived outside an update: the display is still in update mode. */
  displayInUpdateMode: boolean;
  /** A firmware verdict (0 = success, 1 = failed) that arrived after the update had stopped waiting. */
  lateFwStatus: number | null;
  /** CAN-analysis frames seen outside the battery update: another app left CAN analysis on. */
  canFrames: number;
  /** The battery update has bus access (50 01) on: data pages stop, CAN frames go to the update. */
  busAccess: boolean;

  quality: DataQuality;
  /** …0001 notification sizes seen, bytes → count (docs/SPEC.md "Log the observed sizes"). */
  sizes: Readonly<Record<number, number>>;
  pagesReceived: number;
  log: readonly string[];
}

export class OpeningFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpeningFailed';
  }
}

export class SessionEndedError extends Error {
  constructor(message = 'The session ended') {
    super(message);
    this.name = 'SessionEndedError';
  }
}

export interface SessionOptions {
  now?: () => number;
  /** Turn the 30 s page-55 poll off (tests). */
  errorPoll?: boolean;
}

/** One async mutex: callers run one at a time, in order. */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const r = this.tail.then(fn, fn);
    this.tail = r.catch(() => undefined);
    return r;
  }
}

interface Waiter {
  done: () => boolean;
  resolve: (ok: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class BikeSession {
  private s: SessionState;
  private readonly listeners = new Set<(s: SessionState) => void>();
  private readonly now: () => number;
  private readonly errorPoll: boolean;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private ended = false;

  private readonly commandLock = new Mutex();
  /** Multi-step operations (identity re-read, page-55 poll, later log reads) one at a time. */
  private readonly opsLock = new Mutex();
  private acks: { op: number; status: number }[] = [];
  private ackWake: (() => void) | null = null;
  private pending = new Map<number, number>(); // page id → outstanding requests
  private received = new Set<number>();
  private readonly waiters = new Set<Waiter>();
  private readonly debounce = new ErrorDebouncer();
  private lastPowerHex: string | null = null;
  private lastStatusAt: number;
  private streamBaseline: number;
  private drainingSince: number | null = null;
  private lastReadAt = 0;
  private rejectWindowAt = 0;
  private rejectNotes = 0;
  /** Set while a firmware update owns the link: page 0x3C goes here, not to "still in update mode". */
  private fwStatusSink: ((st: FwStatus, raw: Uint8Array) => void) | null = null;
  /** Set while the battery update owns the bus: mirrored CAN frames go here. */
  private canSink: ((f: CanFrame) => void) | null = null;
  /** Mirrored frames still arriving after the battery update let go of the bus are dropped until then. */
  private canDrainUntil = 0;
  private pollWaiting = false;

  constructor(private readonly link: SessionLink, opts: SessionOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.errorPoll = opts.errorPoll ?? true;
    const t = this.now();
    this.lastStatusAt = t;
    this.streamBaseline = t;
    this.s = {
      phase: 'opening', step: null, failure: null, startedAt: t, liveSince: null,
      gatt: { services: null, blockChar: null, dfuService: false },
      dis: {}, disMissing: [], ctype: null, bleBatteryPct: null, power: null,
      identity: {}, identityMissing: [], identityReads: 0,
      config: null, settings: null, configMissing: [], production: { buildDate: null, prodId: null },
      live: {}, liveAt: null, errorBits: null, errors: [],
      autoOffS: null,
      livePaused: false, stale: null, displayInUpdateMode: false, lateFwStatus: null, canFrames: 0, busAccess: false,
      quality: { dropped: 0, rejectedByPid: {}, lastReject: null },
      sizes: {}, pagesReceived: 0, log: [],
    };
  }

  // ---- observable state ------------------------------------------------------------------------

  get state(): SessionState {
    return this.s;
  }

  subscribe(listener: (s: SessionState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Last …0004 notification (repeats included; ~55 Hz), for the locked-bike stale check. */
  get lastStatusNotificationAt(): number {
    return this.lastStatusAt;
  }

  private set(patch: Partial<SessionState>): void {
    this.s = { ...this.s, ...patch };
    for (const l of [...this.listeners]) l(this.s);
  }

  /** Update without notifying: bookkeeping that changes thousands of times a minute (the battery update's frames). */
  private setQuiet(patch: Partial<SessionState>): void {
    this.s = { ...this.s, ...patch };
  }

  /** Connection log (shown in the debug panel, part of the session record). */
  note(msg: string): void {
    const t = ((this.now() - this.s.startedAt) / 1000).toFixed(1);
    const log = [...this.s.log, `+${t} s  ${msg}`];
    this.set({ log: log.length > LOG_MAX ? log.slice(log.length - LOG_MAX) : log });
  }

  // ---- opening sequence -------------------------------------------------------------------------

  /** Run the opening sequence. Resolves when the live loop is running; throws OpeningFailed otherwise. */
  async start(): Promise<void> {
    let total: ReturnType<typeof setTimeout> | undefined;
    const overall = new Promise<never>((_, reject) => {
      total = setTimeout(() => reject(new OpeningFailed(`the opening sequence took over ${TIMING.openTotalMs / 1000} s`)), TIMING.openTotalMs);
    });
    try {
      await Promise.race([this.open(), overall]);
    } catch (e) {
      const why = e instanceof OpeningFailed ? e.message : `opening failed (${errorText(e)})`;
      if (!this.ended) {
        this.note(`Opening failed: ${why}`);
        this.set({ phase: 'failed', step: null, failure: why });
      }
      this.stopTimers();
      throw e instanceof OpeningFailed ? e : new OpeningFailed(why);
    } finally {
      clearTimeout(total);
    }
  }

  private async open(): Promise<void> {
    const link = this.link;
    // 0. The GATT table: needed for the debug panel, …0011's properties and the FE59 check.
    const services = await this.step('GATT services', () => link.services());
    const ebike = services.find((x) => x.uuid === SVC_EBIKE);
    const chars = new Map((ebike?.characteristics ?? []).map((c) => [c.uuid, c.properties]));
    this.set({
      gatt: {
        services,
        blockChar: chars.get(CH_BYPASS) ?? null,
        dfuService: services.some((x) => x.uuid === SVC_SECURE_DFU),
      },
    });
    this.note(`GATT: ${services.map((x) => x.uuid.slice(4, 8)).join(', ')}; …0011 ${describeProps(chars.get(CH_BYPASS) ?? null)}`);
    const missing = [CH_READ, CH_WRITE, CH_POWER].filter((c) => !chars.has(c));
    if (!ebike || missing.length) {
      throw new OpeningFailed(
        !ebike
          ? 'This device has no Globe e-bike service: it is not a Globe Haul display'
          : `The e-bike service is missing ${missing.map((c) => '…' + c.slice(4, 8)).join(', ')}`,
      );
    }

    // 1. DIS, each field on its own (never the blocklisted serial), and the BLE battery level.
    const dis: Partial<Record<DisField, string>> = {};
    const disMissing: DisField[] = [];
    const hasDis = services.some((x) => x.uuid === SVC_DIS);
    for (const [key, uuid] of Object.entries(DIS_CHARS) as [DisField, string][]) {
      if (!hasDis) {
        disMissing.push(key);
        continue;
      }
      try {
        dis[key] = disString(await this.step(`DIS ${key}`, () => link.read(SVC_DIS, uuid, `read DIS ${key}`)));
      } catch (e) {
        if (e instanceof OpeningFailed) throw e;
        disMissing.push(key);
      }
    }
    const ctype = controllerType(dis.sw_rev, dis.fw_rev);
    this.set({ dis, disMissing, ctype });
    this.note(`HMI: ${Object.entries(dis).map(([k, v]) => `${k}=${v}`).join(', ') || 'no DIS'}; error table sbc${ctype ? '' : ' (version not confirmed sbc)'}`);
    if (services.some((x) => x.uuid === SVC_BATTERY)) {
      try {
        const b = await this.step('BLE battery level', () => link.read(SVC_BATTERY, CH_BATTERY_LEVEL, 'read battery level'));
        if (b.length) this.set({ bleBatteryPct: b[0]! });
      } catch (e) {
        if (e instanceof OpeningFailed) throw e;
      }
    }

    // 2. Acks on …0010, status on …0004 (plus one read).
    try {
      await this.step('indications on …0010', () => link.subscribe(SVC_EBIKE, CH_WRITE, (v) => this.onAck(v)));
    } catch (e) {
      // Android: logged, and the sequence carries on (every command then waits out its 3 s ack timeout).
      if (e instanceof OpeningFailed) throw e;
      this.note(`Enable indications on …0010 failed (${errorText(e)}): no acks this connection`);
    }
    try {
      await this.step('notifications on …0004', () => link.subscribe(SVC_EBIKE, CH_POWER, (v) => this.onPower(v)));
    } catch (e) {
      if (e instanceof OpeningFailed) throw e;
      this.note(`Status characteristic notify unavailable (${errorText(e)})`);
    }
    try {
      this.onPower(await this.step('read …0004', () => link.read(SVC_EBIKE, CH_POWER, 'read status')));
    } catch (e) {
      if (e instanceof OpeningFailed) throw e;
    }

    // 3. MTU page mode, then data notifications.
    await this.step('MTU page mode', () => this.sendCommand(mtuPageMode(), 'mtu-page-mode'));
    await this.step('notifications on …0001', () => link.subscribe(SVC_EBIKE, CH_READ, (v) => this.onData(v)));

    // 4. Locked: reading goes on (as in the Python); updates are blocked elsewhere.
    if (this.s.power?.locked) this.note('Bike reports PIN-LOCKED. This app has no unlock; updates are blocked while locked.');

    // 5. Identity, then config + errors + production.
    const idMissing = await this.step('identity pages 11-28', () => this.requestOnce(PAGES_IDENTITY, 'identity'), TIMING.openStepMs);
    this.set({ identityMissing: idMissing, identityReads: this.s.identityReads + 1 });
    const cfgMissing = await this.step('config pages 54, 55, 56', () => this.requestOnce(PAGES_CONFIG, 'config+errors'), TIMING.openStepMs);
    this.set({ configMissing: cfgMissing });
    const ids = Object.entries(this.s.identity).filter(([, v]) => v);
    this.note(`Identity: ${ids.map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`);

    // 6. Live loop.
    await this.step('live loop 40/7/8/9/10', () => this.sendCommand(liveLoop(), 'loop'));
    if (this.ended) throw new SessionEndedError();
    const t = this.now();
    this.streamBaseline = t;
    this.set({ phase: 'live', step: null, liveSince: t });
    this.note('Live: streaming pages 40, 7, 8, 9, 10');
    this.startWatchdog();
    if (this.errorPoll) this.every(TIMING.errorPollMs, () => this.pollErrors());
    this.later(TIMING.identityRecheckMs, () => {
      if (!this.s.livePaused && CONTROLLER_IDENTITY_KEYS.every((k) => !this.s.identity[k])) {
        this.note('[identity] controller fields blank: reading identity once more before calling it silent');
        void this.refreshIdentity().catch(() => undefined);
      }
    });
  }

  private async step<T>(name: string, fn: () => Promise<T>, timeoutMs: number = TIMING.openStepMs): Promise<T> {
    if (this.ended) throw new SessionEndedError();
    this.set({ step: name });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        fn(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new OpeningFailed(`${name} timed out after ${timeoutMs / 1000} s`)), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- commands ----------------------------------------------------------------------------------

  /**
   * write_cmd: drop stale acks, write with response, then wait up to 3 s for this opcode's ack.
   * Returns the ack status (1 = SUCCESS) or null if none came (the caller carries on, as the Python does).
   */
  sendCommand(frame: Uint8Array, label: string, ctx?: FrameContext): Promise<number | null> {
    return this.commandLock.run(async () => {
      if (this.ended) throw new SessionEndedError();
      this.acks = [];
      const op = frame[0]!;
      await this.link.command(frame, label, ctx);
      const status = await this.awaitAck(op, label);
      if (status === null) this.note(`[${label}] no ack (continuing)`);
      else if (status !== ACK_SUCCESS) this.note(`[${label}] ack op=0x${op.toString(16).padStart(2, '0')} ${ACK_STATUS[status] ?? `status ${status}`}`);
      return status;
    });
  }

  private awaitAck(op: number, label: string): Promise<number | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.ackWake = null;
        resolve(null);
      }, TIMING.ackMs);
      const check = (): boolean => {
        while (this.acks.length) {
          const a = this.acks.shift()!;
          if (a.op === op) {
            clearTimeout(timer);
            this.ackWake = null;
            resolve(a.status);
            return true;
          }
          this.note(`[${label}] ignoring ack for op=0x${a.op.toString(16).padStart(2, '0')}`);
        }
        return false;
      };
      if (!check()) this.ackWake = () => void check();
    });
  }

  /** request_once: ask for [pages] once, wait (default 4 s) for every one. Returns the missing ones. */
  async requestOnce(pages: readonly number[], label: string, timeoutMs: number = TIMING.pagesMs): Promise<number[]> {
    for (const p of pages) this.received.delete(p);
    for (const p of pages) this.pending.set(p, (this.pending.get(p) ?? 0) + 1);
    try {
      await this.sendCommand(oncePages(pages), label);
      await this.until(() => pages.every((p) => this.received.has(p)), timeoutMs);
    } finally {
      // Late answers to this request are no longer expected (and are dropped as unexpected).
      for (const p of pages) {
        const n = (this.pending.get(p) ?? 1) - 1;
        if (n > 0) this.pending.set(p, n);
        else this.pending.delete(p);
      }
    }
    const missing = pages.filter((p) => !this.received.has(p));
    if (missing.length) this.note(`[${label}] pages not received: ${missing.join(', ')}`);
    return missing;
  }

  /** Re-read identity pages 11-28 (read-only), then restart the loop. Returns the missing pages. */
  refreshIdentity(): Promise<number[]> {
    return this.opsLock.run(async () => {
      try {
        const missing = await this.requestOnce(PAGES_IDENTITY, 'identity re-read');
        this.set({ identityMissing: missing, identityReads: this.s.identityReads + 1 });
        return missing;
      } finally {
        if (!this.ended) await this.sendCommand(liveLoop(), 'loop').catch(() => null);
      }
    });
  }

  /** Run [fn] with no other multi-step operation (page-55 poll, identity re-read) interleaved. */
  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    return this.opsLock.run(fn);
  }

  /** Live loop deliberately stopped (or restarted): the stale watchdog ignores a paused stream. */
  setLivePaused(paused: boolean): void {
    if (!paused) this.streamBaseline = this.now();
    this.set({ livePaused: paused, stale: paused ? null : this.s.stale });
  }

  /** True once no live page has arrived for 500 ms (Android awaitStreamQuiet); false after 3 s of pages. */
  async awaitStreamQuiet(): Promise<boolean> {
    const deadline = this.now() + TIMING.streamQuietMaxMs;
    for (;;) {
      if (this.ended) return false;
      const quietFor = this.now() - (this.s.liveAt ?? 0);
      if (quietFor >= TIMING.streamQuietMs) return true;
      if (this.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, Math.min(100, TIMING.streamQuietMs - quietFor)));
    }
  }

  /**
   * A firmware update owns the link: page 0x3C notifications go to [sink] (in arrival order) instead of
   * marking the display "still in update mode". endFirmware() hands them back.
   */
  beginFirmware(sink: (st: FwStatus, raw: Uint8Array) => void): void {
    this.fwStatusSink = sink;
  }

  endFirmware(): void {
    this.fwStatusSink = null;
  }

  /**
   * The battery update owns the bus (it is about to send 50 01): every mirrored CAN frame goes to [sink],
   * in arrival order. endCanBus() hands them back (after 50 00); frames still in flight are then dropped
   * for TIMING.canDrainMs instead of being reported as "another app left CAN analysis on".
   */
  beginCanBus(sink: (f: CanFrame) => void): void {
    this.canSink = sink;
    this.set({ busAccess: true });
  }

  endCanBus(): void {
    this.canSink = null;
    this.canDrainUntil = this.now() + TIMING.canDrainMs;
    this.set({ busAccess: false });
  }

  /** After a failed update that sent 0x46: the display waits in update mode until power-cycled. */
  markDisplayInUpdateMode(why: string): void {
    if (!this.s.displayInUpdateMode) this.note(`[firmware] ${why}: the display stays in update mode until the bike is power-cycled`);
    this.set({ displayInUpdateMode: true });
  }

  /** The 30 s poll of page 55 (raw component error codes), then the stream is restarted. */
  private pollErrors(): void {
    // A poll that comes due while a long operation (a firmware update) holds the lock waits for it;
    // further ones don't stack up behind it.
    if (this.pollWaiting) return;
    this.pollWaiting = true;
    void this.opsLock
      .run(async () => {
        this.pollWaiting = false;
        if (this.ended || this.s.livePaused) return;
        try {
          await this.requestOnce([ERROR_PAGE], 'err-poll', TIMING.errorPollPagesMs);
        } finally {
          if (!this.ended) await this.sendCommand(liveLoop(), 'loop').catch(() => null);
        }
      })
      .catch((e) => {
        this.pollWaiting = false;
        if (!this.ended) this.note(`[err-poll] failed: ${errorText(e)}`);
      });
  }

  private until(done: () => boolean, timeoutMs: number): Promise<boolean> {
    if (done()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const w: Waiter = {
        done,
        resolve,
        timer: setTimeout(() => {
          this.waiters.delete(w);
          resolve(false);
        }, timeoutMs),
      };
      this.waiters.add(w);
    });
  }

  private wakeWaiters(): void {
    for (const w of [...this.waiters]) {
      if (w.done()) {
        clearTimeout(w.timer);
        this.waiters.delete(w);
        w.resolve(true);
      }
    }
  }

  // ---- incoming --------------------------------------------------------------------------------

  private onAck(v: Uint8Array): void {
    const a = decodeAck(v);
    if (!a) return;
    this.acks.push({ op: a.op, status: a.status });
    this.ackWake?.();
  }

  private onPower(v: Uint8Array): void {
    this.lastStatusAt = this.now();
    const h = hex(v);
    if (h === this.lastPowerHex) return; // ~55 Hz repeats: act on changes only
    this.lastPowerHex = h;
    const p = decodePower(v);
    if (!p) return;
    const was = this.s.power;
    this.set({ power: p });
    if (was && was.locked !== p.locked) this.note(p.locked ? 'Bike is now PIN-locked' : 'Bike unlocked');
    if (was && was.suspended !== p.suspended) this.note(p.suspended ? 'Display went to standby' : 'Display awake');
  }

  /** …0001: the Android onDataBytes order. */
  private onData(b: Uint8Array): void {
    if (this.ended) return;
    const now = this.now();
    const quietMs = now - this.lastReadAt;
    this.lastReadAt = now;
    const sizes = { ...this.s.sizes, [b.length]: (this.s.sizes[b.length] ?? 0) + 1 };
    const patch: Partial<SessionState> = { sizes };

    // The rest of an unrequested log dump: dropped until its end marker (or it goes quiet).
    if (this.drainingSince !== null) {
      const endMark = b[0] === DUMP_END;
      if (endMark || quietMs > TIMING.drainQuietMs || now - this.drainingSince > TIMING.drainMaxMs) {
        this.drainingSince = null;
        this.note(`[logs] unrequested dump ${endMark ? 'ended (0xED)' : 'went quiet'}: reading pages again`);
        if (endMark) return this.set(patch);
      } else {
        return this.set(patch);
      }
    }

    const n = classifyNotification(b);
    switch (n.kind) {
      case 'empty':
      case 'dump-end':
        return this.set(patch);
      case 'dump-start':
        // This app hasn't asked for a log in this milestone: a dump now is left over (another app,
        // an earlier connection). Its bytes must never reach identity or live data.
        this.drainingSince = now;
        this.note('[logs] a log dump started that this connection did not ask for: ignoring it until it ends');
        return this.set(patch);
      case 'fw-status':
        if (this.fwStatusSink) {
          if (n.status) this.fwStatusSink(n.status, b);
          else this.note(`[firmware] page 0x3C too short to carry a status: ${hex(b)}`);
          return this.set(patch);
        }
        // Page 0x3C outside an update. Status 0 or 1 is a late verdict on an update the app had stopped
        // waiting for (the display leaves update mode with it, BPOU); anything else means it is still in
        // update mode.
        if (n.status && (n.status.status === 0 || n.status.status === 1)) {
          this.note(
            `[firmware] page 0x3C ${hex(b)} after the app stopped waiting: the display reports the update ` +
              `${n.status.status === 0 ? 'SUCCEEDED' : 'FAILED'} and leaves update mode. Power-cycle the bike and reconnect to read the controller version.`,
          );
          return this.set({ ...patch, lateFwStatus: n.status.status });
        }
        if (!this.s.displayInUpdateMode) this.note(`[firmware] page 0x3C outside an update (${hex(b)}): the display is still in update mode`);
        return this.set({ ...patch, displayInUpdateMode: true });
      case 'can':
        if (this.canSink) {
          for (const f of n.frames) this.canSink(f);
          return this.setQuiet(patch);
        }
        if (now < this.canDrainUntil) return this.set(patch);
        if (this.s.canFrames === 0) {
          this.note('[CAN] CAN-analysis frames are arriving outside the battery update: another app left CAN analysis on. Power-cycle the bike.');
        }
        return this.set({ ...patch, canFrames: this.s.canFrames + 1 });
      case 'bypass-reply':
        this.note(`[raw CAN] unexpected bypass reply (0x1F): ${hex(b)}`);
        return this.set(patch);
      case 'pages':
        break;
    }

    if (n.pages.length === 0) return this.set(patch);
    // Every slice must be a page expected now, and each page must pass validation.
    const expected = new Set<number>([...PAGES_LOOP, ...this.pending.keys()]);
    const gate = gateNotification(b, expected);
    if (gate.kind === 'not-pages') {
      // After an assist change the display pushes page 55 nobody asked for (harmless).
      const pids = splitPages(b).map((p) => p[0]);
      if (pids.length && pids.every((p) => p === ERROR_PAGE)) return this.set(patch);
      this.rejectNote(`Dropped a notification that isn't data pages: ${gate.reason}`);
      return this.set({ ...patch, quality: { ...this.s.quality, dropped: this.s.quality.dropped + 1 } });
    }

    let quality = this.s.quality;
    for (const r of gate.rejected) {
      quality = {
        ...quality,
        rejectedByPid: { ...quality.rejectedByPid, [r.pid]: (quality.rejectedByPid[r.pid] ?? 0) + 1 },
        lastReject: `page ${r.pid}: ${r.reasons.join(', ')}`,
      };
      this.rejectNote(`Rejected page ${r.pid}: ${r.reasons.join(', ')}`);
    }
    if (quality !== this.s.quality) patch.quality = quality;

    let identity = this.s.identity;
    let live = this.s.live;
    let liveChanged = false;
    let stable = this.s.errorBits;
    for (const v of gate.ok) {
      const pid = v.pid;
      const d = v.fields;
      const key = STRING_PAGES[pid];
      if (key !== undefined) {
        const text = typeof d[key] === 'string' ? (d[key] as string) : '';
        if (identity[key] !== text) identity = { ...identity, [key]: text };
      } else if (PAGES_LOOP.includes(pid) || pid === ERROR_PAGE) {
        // The bitmask reaches the state only once stable for 3 frames (ErrorDebouncer).
        const { error_bits: bits, ...fields } = d;
        const s = typeof bits === 'number' ? this.debounce.offer(bits) : this.debounce.stable;
        if (s !== null) stable = s;
        live = { ...live, ...fields };
        liveChanged = true;
        if (pid === ERROR_PAGE) patch.settings = d;
      } else if (pid === 54) {
        patch.config = d;
      } else if (pid === 5) {
        patch.autoOffS = typeof d.shutdown_timer_s === 'number' ? d.shutdown_timer_s : null;
      } else if (pid === 56) {
        const date = typeof d.build_date === 'string' ? d.build_date : null;
        const id = typeof d.prod_id === 'number' ? d.prod_id : null;
        patch.production = { buildDate: date ?? this.s.production.buildDate, prodId: id ?? this.s.production.prodId };
      }
      this.received.add(pid);
    }
    if (identity !== this.s.identity) patch.identity = identity;
    if (liveChanged) {
      patch.live = live;
      patch.liveAt = now;
    }
    if (stable !== null && stable !== this.s.errorBits) {
      const was = this.s.errorBits;
      patch.errorBits = stable;
      patch.errors = decodeErrors(stable);
      const codes = patch.errors.map((e) => e.code).join(', ');
      this.note(`Error bitmask ${was === null ? '' : `${hex32(was)} → `}${hex32(stable)}${codes ? `: ${codes}` : ' (no active errors)'}`);
    }
    patch.pagesReceived = this.s.pagesReceived + gate.ok.length;
    this.set(patch);
    this.wakeWaiters();
  }

  private rejectNote(msg: string): void {
    const now = this.now();
    if (now - this.rejectWindowAt > REJECT_WINDOW_MS) {
      this.rejectWindowAt = now;
      this.rejectNotes = 0;
    }
    if (this.rejectNotes++ < REJECT_NOTES_PER_WINDOW) this.note(`[validation] ${msg}`);
  }

  // ---- watchdog, timers, end -------------------------------------------------------------------

  private startWatchdog(): void {
    this.watchdog = setInterval(() => this.checkStale(), TIMING.watchdogTickMs);
  }

  /** LinkPolicy.isStale: no data page for 5 s (or, while locked, no status notification). */
  checkStale(): void {
    if (this.ended || this.s.phase !== 'live') return;
    const now = this.now();
    const locked = this.s.power?.locked === true;
    let stale: SessionState['stale'] = null;
    if (!this.s.livePaused) {
      const last = locked ? this.lastStatusAt : Math.max(this.s.liveAt ?? 0, this.streamBaseline);
      const quiet = now - last;
      if (quiet > TIMING.staleAfterMs) stale = { quietMs: quiet, what: locked ? 'status notification' : 'data page' };
    }
    if ((stale === null) !== (this.s.stale === null)) {
      if (stale) this.note(`No ${stale.what} for ${Math.round(stale.quietMs / 1000)} s while the link claims to be up: stale`);
      else this.note('Data is arriving again');
    }
    if (stale || this.s.stale) this.set({ stale });
  }

  private later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (!this.ended) fn();
    }, ms);
    this.timers.add(t);
  }

  private every(ms: number, fn: () => void): void {
    this.later(ms, () => {
      fn();
      this.every(ms, fn);
    });
  }

  private stopTimers(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
  }

  /** End this session (link lost, or the app disconnected). Pending waits resolve as missing. */
  end(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    this.stopTimers();
    for (const w of [...this.waiters]) {
      clearTimeout(w.timer);
      w.resolve(false);
    }
    this.waiters.clear();
    this.ackWake?.();
    this.note(`Session ended: ${reason}`);
    this.set({ phase: this.s.phase === 'failed' ? 'failed' : 'ended', step: null, stale: null });
  }

  get isEnded(): boolean {
    return this.ended;
  }
}

function describeProps(p: CharProperties | null): string {
  if (!p) return 'absent';
  const on = Object.entries(p).filter(([, v]) => v).map(([k]) => k);
  return on.length ? on.join('+') : 'no properties';
}

function hex32(v: number): string {
  return `0x${(v >>> 0).toString(16).padStart(8, '0')}`;
}

function errorText(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}
