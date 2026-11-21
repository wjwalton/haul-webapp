/**
 * ShopApp: one tab, one bike. Picks a bike through the transport's chooser, connects, runs the
 * session's opening sequence, holds the "confirmed" flag, reconnects to the same device without the
 * chooser, and wipes everything on "Disconnect / connect another bike" (docs/SPEC.md: stateless).
 *
 * It also runs the controller firmware update (update/controller.ts) after re-checking every pre-flight
 * condition at the moment Start is pressed, keeps the result and its session log, and verifies the
 * new controller version on the next connection (after the power-cycle).
 *
 * And the battery (BMS) update (update/battery.ts, docs/DECISIONS.md 2026-11-20): "Read the battery",
 * then Start (every check re-run), then, after a success, the bike's own restart: the link drops, the
 * app reconnects by itself for up to 3 minutes, restores the auto-off timer and checks the new version.
 *
 * Reconnecting (2026-11-19: a reconnect after a stale link needed a page reload on Windows): Reconnect
 * closes the old link, waits RECONNECT.settleMs for the OS to let go of it, then tries up to
 * RECONNECT.attempts times. A disconnect event that arrives while the current link still reports
 * connected belongs to an older connection and is ignored. Picking the same bike in the chooser again
 * keeps its confirmation and update result. Every step goes into a connection log (ShopState.events).
 *
 * No DOM and no navigator here: the UI renders ShopState (useSyncExternalStore) and calls the methods.
 */
import { batteryReading, type BmsLine, type VerifiedFirmware } from '../analysis/firmware';
import type { VerifiedBmsFirmware } from '../analysis/bmsFirmware';
import { openBikeLink, type BikeLink } from '../ble/link';
import type { BleDevice, DeviceRequest, GattTransport } from '../ble/transport';
import { RawRecorder } from '../export/rawJsonl';
import { NAME_PREFIX, OPTIONAL_SERVICES, SCAN_UUID } from '../protocol/gatt';
import { BikeSession, type SessionState } from '../protocol/session';
import { runControllerUpdate, type FlashTiming, type UpdateProgress, type UpdateResult } from '../update/controller';
import {
  afterBatteryRestart, BMS_TIMING, readBattery, runBatteryUpdate, type BatteryProgress, type BatteryReadResult,
  type BatteryUpdateResult, type BmsTiming,
} from '../update/battery';
import { batteryChecks } from '../update/batteryGate';
import { controllerSilent } from '../update/gate';
import { bitOf, hasBit } from '../protocol/errors';
import { controllerChecks, isArmed } from '../update/preflight';

/** docs/SPEC.md "Picking a bike": name prefix OR the advertised scan UUID; the Globe service is GATT-only. */
export const BIKE_REQUEST: DeviceRequest = Object.freeze({
  namePrefix: NAME_PREFIX,
  advertisedServices: [SCAN_UUID],
  optionalServices: [...OPTIONAL_SERVICES],
});

export type ShopPhase = 'idle' | 'choosing' | 'connecting' | 'connected' | 'lost' | 'failed';

export interface ShopState {
  phase: ShopPhase;
  device: { id: string; name: string | null } | null;
  /** The mechanic confirmed this is the bike in front of them (kept across reconnects to the same device). */
  confirmed: boolean;
  /** The current (or last) connection's session. */
  session: SessionState | null;
  /** Why the app is idle / lost / failed, in words for the mechanic. */
  message: string | null;
  /** Connections made to this device (1 = first). */
  connections: number;
  /** The controller update: running, or its last result (until dismissed or the bike is forgotten). */
  update: UpdateState | null;
  /** Connection log for this bike: connects, failures, disconnect events, reconnects (time-stamped). */
  events: readonly string[];
  /** The battery update: the last battery read, the run, its result and the restart that follows. */
  battery: BatteryState;
}

export interface BatteryState {
  /** "Read the battery" is running. */
  reading: boolean;
  /** Its last result on the CURRENT connection (cleared on every new connection). */
  read: BatteryReadResult | null;
  running: boolean;
  progress: BatteryProgress | null;
  result: BatteryUpdateResult | null;
  /** After a successful update: the restart, the reconnect, the check. */
  after: BatteryAfter | null;
}

export interface BatteryAfter {
  status: 'reconnecting' | 'checking' | 'verified' | 'mismatch' | 'silent' | 'gave-up' | 'stopped';
  /** "01.00.12 RC" */
  target: string;
  /** What page 24 reports after the restart (corrected), or null. */
  reported: string | null;
  autoOffBefore: number | null;
  autoOffRestored: boolean | null;
  startedAt: number;
  /** Nothing yet after BMS_TIMING.powerButtonHintMs: ask for the power button. */
  powerButtonHint: boolean;
  /** bms_e032 still active after the restart. */
  e032: boolean;
}

/** What battery Start needs from the page. */
export interface BatteryEnv {
  platformVerified: boolean;
  platformLabel: string;
  typedName: string;
  chosenLine: BmsLine | null;
  reflashSameVersion: boolean;
  stamp?: string;
}

export const NO_BATTERY: BatteryState = { reading: false, read: null, running: false, progress: null, result: null, after: null };
const BMS_E032_BIT = bitOf('bms_e032');

export interface UpdateState {
  running: boolean;
  progress: UpdateProgress | null;
  result: UpdateResult | null;
  /** A successful update whose new version is read on the next connection (after the power-cycle). */
  verify: VerifyState | null;
}

export interface VerifyState {
  target: string;
  before: string | null;
  status: 'waiting' | 'verified' | 'mismatch' | 'silent';
  reported: string | null;
}

/** What Start needs from the page besides the session: platform, the mechanic's choices, the typed name. */
export interface UpdateEnv {
  platformVerified: boolean;
  platformLabel: string;
  /** "Reflash the same version" was ticked (only counts when the controller runs the file's version). */
  reflashSameVersion?: boolean;
  typedName: string;
  /** File-name stamp for the session log (local time). */
  stamp?: string;
}

const INITIAL: ShopState = {
  phase: 'idle', device: null, confirmed: false, session: null, message: null, connections: 0, update: null, events: [], battery: NO_BATTERY,
};

/** Reconnect tuning. Windows can take a moment to let go of a link that was dropped or closed. */
export const RECONNECT = Object.freeze({
  /** After closing a link on purpose, before connecting again. */
  settleMs: 1_500,
  /** Attempts on Reconnect (each with its own connect timeout). */
  attempts: 3,
  /** Attempts right after the chooser. */
  firstAttempts: 2,
  /** Between failed attempts. */
  retryPauseMs: 2_000,
});

const MAX_EVENTS = 400;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface ShopOptions {
  now?: () => number;
  /** Passed to each session (tests switch the 30 s poll off). */
  errorPoll?: boolean;
  /** Tests: shorter flasher timeouts. */
  flashTiming?: Partial<FlashTiming>;
  /** Tests: shorter battery-update timeouts. */
  batteryTiming?: Partial<BmsTiming>;
}

export class ShopApp {
  private s: ShopState = INITIAL;
  private readonly listeners = new Set<() => void>();
  private readonly now: () => number;
  private device: BleDevice | null = null;
  private unsubDevice: (() => void) | null = null;
  private link: BikeLink | null = null;
  private session: BikeSession | null = null;
  private unsubSession: (() => void) | null = null;
  private recorder: RawRecorder | null = null;
  /** A disconnect the app asked for: the gattserverdisconnected that follows isn't a "lost link". */
  private closing = false;
  /** Bumped on every connect / close, so late callbacks from an older connection do nothing. */
  private gen = 0;
  private updateJob: Promise<void> | null = null;
  /** Verify on connections newer than this one (the one the update ran on). */
  private verifyAfterGen = Infinity;
  private batteryJob: Promise<void> | null = null;
  /** The battery restart's check runs on connections newer than this one. */
  private batteryAfterGen = Infinity;
  private batteryChecking = false;
  /** The automatic reconnect after a battery update is running. */
  private restartLoop = false;

  constructor(readonly transport: GattTransport, private readonly opts: ShopOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
  }

  // ---- store -------------------------------------------------------------------------------------

  readonly subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  readonly getSnapshot = (): ShopState => this.s;

  private set(patch: Partial<ShopState>): void {
    this.s = { ...this.s, ...patch };
    for (const l of [...this.listeners]) l();
  }

  get currentSession(): BikeSession | null {
    return this.session;
  }

  // ---- actions -----------------------------------------------------------------------------------

  /**
   * Open the chooser and connect to the picked bike. Call it straight from a click handler: the
   * chooser request is made before anything is awaited (browsers require a user gesture).
   */
  chooseBike(): Promise<void> {
    if (this.updateRunning) return Promise.resolve();
    const request = this.transport.requestDevice(BIKE_REQUEST);
    return this.afterChooser(request);
  }

  private async afterChooser(request: Promise<BleDevice>): Promise<void> {
    const before = this.s;
    this.set({ phase: 'choosing', message: null });
    let picked: BleDevice;
    try {
      picked = await request;
    } catch (e) {
      const cancelled = (e as Error).name === 'NotFoundError';
      // Back to where we were (a cancelled chooser changes nothing).
      this.set({ ...before, message: cancelled ? before.message : `The chooser failed: ${errorText(e)}` });
      return;
    }
    if (this.device && picked.id === this.s.device?.id) {
      // The same bike again (the fallback when Reconnect keeps failing): keep its confirmation, update
      // result and logs; only the device handle is new.
      this.event(`Chooser: picked ${picked.name ?? picked.id} again (same bike: confirmation and update result kept)`);
      const hadLink = this.link !== null;
      await this.closeLink('picked again');
      this.unsubDevice?.();
      this.device = picked;
      this.unsubDevice = picked.onDisconnected(() => this.onDisconnected());
      this.set({ device: { id: picked.id, name: picked.name } });
      if (hadLink && !(await this.settle())) return;
      await this.connect(RECONNECT.attempts);
      return;
    }
    await this.wipe(null);
    this.device = picked;
    this.unsubDevice = picked.onDisconnected(() => this.onDisconnected());
    this.recorder = new RawRecorder(this.now);
    this.set({ ...INITIAL, device: { id: picked.id, name: picked.name } });
    this.event(`Chooser: picked ${picked.name ?? '(no name)'}`);
    await this.connect(RECONNECT.firstAttempts);
  }

  /**
   * Connect again to the same bike (no chooser). Keeps the confirmation: it's the same device. The old
   * link is closed first and the OS gets RECONNECT.settleMs to let go of it.
   */
  async reconnect(): Promise<void> {
    if (!this.device || this.updateRunning || this.restartLoop) return;
    const st = this.s.session;
    this.event(`Reconnect requested (${this.s.phase}${st?.stale ? `, no data for ${Math.round(st.stale.quietMs / 1000)} s` : ''})`);
    await this.closeLink('reconnecting');
    if (!(await this.settle())) return;
    await this.connect(RECONNECT.attempts);
  }

  /** Wait for the OS to let go of a closed link. False if something else took over meanwhile. */
  private async settle(): Promise<boolean> {
    const g = this.gen;
    this.set({ phase: 'connecting', session: null, message: 'Reconnecting…' });
    await sleep(RECONNECT.settleMs);
    return g === this.gen && this.device !== null;
  }

  /** This bike's connection log as text (for the download). */
  connectionLog(): string {
    return [`Globe Haul Shop Tool connection log: ${this.s.device?.name ?? 'no bike'}`, ...this.s.events].join('\n') + '\n';
  }

  private event(msg: string): void {
    const line = `${clock(this.now())}  ${msg}`;
    const events = this.s.events.length >= MAX_EVENTS ? [...this.s.events.slice(1 - MAX_EVENTS), line] : [...this.s.events, line];
    this.set({ events });
  }

  confirm(): void {
    if (this.s.phase === 'connected' && this.s.session?.phase === 'live') this.set({ confirmed: true });
  }

  /** "Wrong bike": disconnect and forget it. */
  async wrongBike(): Promise<void> {
    if (this.updateRunning) return;
    const name = this.s.device?.name ?? 'that bike';
    this.event('Wrong bike: disconnecting');
    await this.wipe(`Disconnected from ${name} (wrong bike). Choose the right one.`);
  }

  /** "Disconnect / connect another bike": wipes all state. */
  async disconnect(): Promise<void> {
    if (this.updateRunning) return;
    const name = this.s.device?.name;
    await this.wipe(name ? `Disconnected from ${name}.` : null);
  }

  /** This bike's raw.jsonl (every connection to it since it was chosen), in the Python format. */
  rawJsonl(): string {
    return this.recorder?.text() ?? '';
  }

  get rawLineCount(): number {
    return this.recorder?.count ?? 0;
  }

  // ---- controller update -------------------------------------------------------------------------

  get updateRunning(): boolean {
    return this.s.update?.running === true || this.s.battery.running || this.s.battery.reading;
  }

  /**
   * Start the controller update with [firmware]. Every check is run again now (the screen may be
   * stale); returns why it can't start, or null once it has started. Progress and the result are in
   * ShopState.update.
   */
  startControllerUpdate(firmware: VerifiedFirmware, env: UpdateEnv): string | null {
    const session = this.session;
    const link = this.link;
    if (this.updateRunning) return 'An update is already running';
    if (!session || !link || this.s.phase !== 'connected') return 'Not connected to a bike';
    if (this.restartLoop || this.s.battery.after?.status === 'checking') return 'The bike is restarting after the battery update';
    const checks = controllerChecks({
      session: session.state, confirmed: this.s.confirmed, platformVerified: env.platformVerified, platformLabel: env.platformLabel,
      firmware, reflashSameVersion: env.reflashSameVersion, updateRunning: false, now: this.now(),
    });
    const failing = [...checks.gate.checks, ...checks.preflight].find((c) => c.ok !== true);
    if (failing) return `${failing.label}: ${failing.detail}`;
    if (!isArmed(env.typedName, this.s.device?.name ?? null)) return "Type the bike's name to arm the update";
    const need = checks.gate.checks.find((c) => c.id === 'need');

    const gen = this.gen;
    this.event(`Controller update started (${need ? need.detail : 'offered'})`);
    this.set({ update: { running: true, progress: null, result: null, verify: null } });
    this.updateJob = runControllerUpdate({
      session, link, firmware,
      deviceName: this.s.device?.name ?? 'bike',
      platformLabel: env.platformLabel,
      why: need ? need.detail : 'not stated',
      now: this.now,
      timing: this.opts.flashTiming,
      stamp: env.stamp,
      onProgress: (p) => {
        if (this.s.update?.running) this.set({ update: { ...this.s.update, progress: p } });
      },
    }).then(
      (result) => {
        this.event(`Controller update ${result.ok ? 'finished: success' : `failed (${result.kind}): ${result.message}`}`);
        this.verifyAfterGen = result.awaitingPowerCycle ? gen : Infinity;
        const verify: VerifyState | null = result.awaitingPowerCycle
          ? { target: result.target, before: result.before, status: 'waiting', reported: null }
          : null;
        this.set({ update: { running: false, progress: this.s.update?.progress ?? null, result, verify } });
      },
      (e: unknown) => {
        // runControllerUpdate never throws; if a bug makes it, the screen must not stay locked on "running".
        this.event(`Controller update stopped on an internal error: ${errorText(e)}`);
        const result: UpdateResult = {
          ok: false, kind: 'protocol', before: null, after: null, target: firmware.entry.version, controllerErased: true, verified: false,
          awaitingPowerCycle: false, writeMode: null, timing: null, writes: 0, resends: 0,
          message: `The update stopped on an internal error (${errorText(e)}). If the display shows "bypass", power-cycle the bike, reconnect, and flash again (recovery). Download the connection log.`,
          log: this.connectionLog(), logName: `update_${this.s.device?.name ?? 'bike'}_${env.stamp ?? 'error'}.txt`,
        };
        this.set({ update: { running: false, progress: this.s.update?.progress ?? null, result, verify: null } });
      },
    );
    return null;
  }

  /** Resolves when the running update (if any) has finished. */
  whenUpdateDone(): Promise<void> {
    return this.updateJob ?? Promise.resolve();
  }

  /** Clear the update result (not while it runs). */
  dismissUpdate(): void {
    if (!this.updateRunning) {
      this.verifyAfterGen = Infinity;
      this.set({ update: null });
    }
  }

  /** After a successful update: the first later connection that reads the controller version decides. */
  private checkVerify(gen: number, st: SessionState): void {
    const u = this.s.update;
    const v = u?.verify;
    if (!u || !v || v.status !== 'waiting' || gen <= this.verifyAfterGen || st.phase !== 'live') return;
    const sw = st.identity.ctrl_sw;
    if (sw) {
      this.set({ update: { ...u, verify: { ...v, status: sw === v.target ? 'verified' : 'mismatch', reported: sw } } });
    } else if (controllerSilent(st)) {
      this.set({ update: { ...u, verify: { ...v, status: 'silent', reported: null } } });
    }
  }

  // ---- battery update ----------------------------------------------------------------------------

  private setBattery(patch: Partial<BatteryState>): void {
    this.set({ battery: { ...this.s.battery, ...patch } });
  }

  /** "Read the battery": bus access on, version + hardware type, bus access off. Changes nothing. */
  async readBattery(): Promise<void> {
    const session = this.session;
    const link = this.link;
    if (!session || !link || this.s.phase !== 'connected' || this.updateRunning || this.restartLoop) return;
    const gen = this.gen;
    this.event('Reading the battery (bus access on, 0x280 / 0x281, bus access off)');
    this.setBattery({ reading: true });
    try {
      const read = await readBattery(session, link, { timing: this.opts.batteryTiming, now: this.now });
      const id = read.identity;
      this.event(`Battery read: ${read.problem ?? (id?.responding ? `${id.version} ${id.line}, hardware type ${id.hwType}` : 'no answer')}`);
      this.setBattery({ reading: false, read: gen === this.gen ? read : this.s.battery.read });
    } catch (e) {
      this.event(`Battery read stopped on an internal error: ${errorText(e)}`);
      this.setBattery({ reading: false });
    }
  }

  /**
   * Start the battery update with [firmware]. Every check is run again now; returns why it can't
   * start, or null once it has started.
   */
  startBatteryUpdate(firmware: VerifiedBmsFirmware, env: BatteryEnv): string | null {
    const session = this.session;
    const link = this.link;
    if (this.updateRunning || this.restartLoop) return 'An update is already running';
    if (!session || !link || this.s.phase !== 'connected') return 'Not connected to a bike';
    const b = this.s.battery;
    const checks = batteryChecks({
      session: session.state, confirmed: this.s.confirmed, platformVerified: env.platformVerified, platformLabel: env.platformLabel,
      firmware, read: b.read, chosenLine: env.chosenLine, reflashSameVersion: env.reflashSameVersion, updateRunning: false, now: this.now(),
    });
    const failing = checks.checks.find((c) => c.ok !== true);
    if (failing) return `${failing.label}: ${failing.detail}`;
    if (!isArmed(env.typedName, this.s.device?.name ?? null)) return "Type the bike's name to arm the update";
    const identity = b.read?.identity ?? null;
    const need = checks.checks.find((c) => c.id === 'version');
    const gen = this.gen;
    this.event(`Battery update started: ${firmware.info.version} ${firmware.info.line} (${need?.detail ?? 'offered'})`);
    this.setBattery({ running: true, progress: null, result: null, after: null });
    this.batteryJob = runBatteryUpdate({
      session, link, firmware,
      expected: identity,
      chosenLine: identity?.responding ? null : env.chosenLine,
      sameVersion: env.reflashSameVersion && checks.sameVersion,
      deviceName: this.s.device?.name ?? 'bike',
      platformLabel: env.platformLabel,
      why: need?.detail,
      now: this.now,
      timing: this.opts.batteryTiming,
      stamp: env.stamp,
      onProgress: (p) => {
        if (this.s.battery.running) this.setBattery({ progress: p });
      },
    }).then((result) => {
      this.event(`Battery update ${result.ok ? 'finished: success' : `failed (${result.kind}): ${result.message}`}`);
      const after: BatteryAfter | null = result.ok && result.restarting
        ? {
            status: 'reconnecting', target: result.target, reported: null, autoOffBefore: result.autoOff.changed ? result.autoOff.before : null,
            autoOffRestored: null, startedAt: this.now(), powerButtonHint: false, e032: false,
          }
        : null;
      this.batteryAfterGen = after ? gen : Infinity;
      this.setBattery({ running: false, result, after, read: null });
      if (after) void this.awaitBatteryRestart();
    }, (e: unknown) => {
      // runBatteryUpdate never throws; if a bug makes it, the screen must not stay locked on "running".
      this.event(`Battery update stopped on an internal error: ${errorText(e)}`);
      const result: BatteryUpdateResult = {
        ok: false, kind: 'not-started', before: null, target: `${firmware.info.version} ${firmware.info.line}`, line: firmware.info.line,
        packInBootloader: false, restarting: false, after: null, autoOff: { before: null, changed: false, restored: null }, attempts: 0, ackTiming: null,
        message: `The update stopped on an internal error (${errorText(e)}). Read the battery before doing anything else, and download the connection log.`,
        log: this.connectionLog(), logName: `battery_update_${this.s.device?.name ?? 'bike'}_${env.stamp ?? 'error'}.txt`,
      };
      this.setBattery({ running: false, result, after: null, read: null });
    });
    return null;
  }

  whenBatteryDone(): Promise<void> {
    return this.batteryJob ?? Promise.resolve();
  }

  /** Clear the battery result (not while it runs or the bike restarts). */
  dismissBattery(): void {
    if (this.s.battery.running || this.restartLoop) return;
    this.batteryAfterGen = Infinity;
    this.setBattery({ result: null, progress: null, after: null });
  }

  /** Stop the automatic reconnect after a battery update (the mechanic takes over). */
  stopBatteryReconnect(): void {
    if (!this.restartLoop) return;
    this.restartLoop = false;
    const a = this.s.battery.after;
    if (a && a.status === 'reconnecting') this.setBattery({ after: { ...a, status: 'stopped' } });
  }

  get batteryReconnecting(): boolean {
    return this.restartLoop;
  }

  /**
   * After a successful battery update the BMS restart cuts system power: the display reboots and the
   * link drops (PROTOCOL.md section 2). Reconnect by itself (same device, no chooser) for up to
   * BMS_TIMING.reconnectMs; after powerButtonHintMs, ask for the power button.
   */
  private async awaitBatteryRestart(): Promise<void> {
    const t = { ...BMS_TIMING, ...this.opts.batteryTiming };
    const t0 = this.now();
    this.restartLoop = true;
    this.event('The bike is restarting after the battery update: reconnecting by itself');
    try {
      if (this.link) await this.closeLink('battery restart');
      this.set({ phase: 'lost', message: 'The bike is restarting after the battery update. Reconnecting…' });
      await sleep(t.reconnectPauseMs);
      while (this.restartLoop && this.device && this.now() - t0 < t.reconnectMs) {
        const a = this.s.battery.after;
        if (a && !a.powerButtonHint && this.now() - t0 >= t.powerButtonHintMs) this.setBattery({ after: { ...a, powerButtonHint: true } });
        await this.connect(1);
        if (!this.restartLoop || !this.device) return;
        if (this.s.phase === 'connected') return; // the session subscription runs the check
        this.set({ message: 'The bike is restarting after the battery update. Reconnecting…' });
        await sleep(t.reconnectPauseMs);
      }
      const a = this.s.battery.after;
      if (this.restartLoop && a?.status === 'reconnecting') {
        this.setBattery({ after: { ...a, status: 'gave-up' } });
        this.set({ message: "The bike didn't come back within 3 minutes. Switch it on, then click Reconnect: the app then checks the battery version." });
      }
    } finally {
      this.restartLoop = false;
    }
  }

  /** On the first live connection after the restart: restore auto-off, then compare page 24. */
  private checkBatteryAfter(gen: number, st: SessionState): void {
    const a = this.s.battery.after;
    if (!a || (a.status !== 'reconnecting' && a.status !== 'gave-up' && a.status !== 'stopped') || gen <= this.batteryAfterGen || st.phase !== 'live') return;
    if (this.batteryChecking) return;
    const session = this.session;
    const link = this.link;
    if (!session || !link) return;
    this.batteryChecking = true;
    this.setBattery({ after: { ...a, status: 'checking' } });
    void afterBatteryRestart(session, link, a.autoOffBefore)
      .catch(() => ({ restored: false }))
      .then(({ restored }) => {
        const cur = this.session?.state ?? st;
        const r = batteryReading(cur.identity.batt_sw);
        const reported = r.corrected ?? r.raw;
        const status: BatteryAfter['status'] = reported === null ? 'silent' : reported === a.target ? 'verified' : 'mismatch';
        this.event(`After the battery update: page 24 ${reported ?? 'not reported'} (target ${a.target}): ${status}${restored === null ? '' : `; auto-off restored: ${restored ? 'yes' : 'NO'}`}`);
        this.setBattery({ after: { ...a, status, reported, autoOffRestored: restored, e032: hasBit(cur.errorBits, BMS_E032_BIT) } });
      })
      .finally(() => {
        this.batteryChecking = false;
      });
  }

  // ---- internals ---------------------------------------------------------------------------------

  /** Connect to the current device, up to [attempts] times, then read it (BikeSession.start). */
  private async connect(attempts = 1): Promise<void> {
    const device = this.device;
    if (!device) return;
    let gen = ++this.gen;
    this.closing = false;
    const name = device.name ?? 'the bike';
    this.set({ phase: 'connecting', session: null, message: null, connections: this.s.connections + 1 });
    for (let attempt = 1; ; attempt++) {
      const last = attempt >= attempts;
      const t0 = this.now();
      this.event(`Connecting (attempt ${attempt} of ${attempts})`);
      let link: BikeLink;
      try {
        link = await openBikeLink(device, { recorder: this.recorder ?? undefined });
      } catch (e) {
        if (gen !== this.gen) return;
        this.event(`Connect failed after ${this.now() - t0} ms: ${errorText(e)}`);
        if (!last) {
          this.set({ message: `Couldn't connect (${errorText(e)}). Trying again: attempt ${attempt + 1} of ${attempts}…` });
          await sleep(RECONNECT.retryPauseMs);
          if (gen !== this.gen) return;
          continue;
        }
        this.set({
          phase: 'failed',
          message: `Couldn't connect to ${name} (${attempts > 1 ? `${attempts} attempts; ` : ''}${errorText(e)}). Check the bike is on and nothing else ` +
            '(another tab, app or phone) is connected to it, then try again. If it still won\'t connect, choose the bike again.',
        });
        return;
      }
      if (gen !== this.gen) {
        await link.disconnect('superseded').catch(() => undefined);
        return;
      }
      this.event(`Connected in ${this.now() - t0} ms`);
      const session = new BikeSession(link, { now: this.now, errorPoll: this.opts.errorPoll });
      this.link = link;
      this.session = session;
      // A battery read belongs to the connection it was made on.
      if (this.s.battery.read) this.setBattery({ read: null });
      let stale = false;
      const g = gen;
      this.unsubSession = session.subscribe((st) => {
        if (g !== this.gen) return;
        if ((st.stale !== null) !== stale) {
          stale = st.stale !== null;
          this.event(stale ? `No data for ${Math.round(st.stale!.quietMs / 1000)} s while the link reports connected (stale)` : 'Data arriving again');
        }
        this.set({ session: st });
        this.checkVerify(g, st);
        this.checkBatteryAfter(g, st);
      });
      this.set({ phase: 'connected', session: session.state, message: null });
      try {
        await session.start();
        if (gen === this.gen) this.event('Reading done: live data');
        return;
      } catch (e) {
        if (gen !== this.gen || this.s.phase === 'lost') return;
        this.event(`Reading the bike failed: ${errorText(e)}`);
        const expected = this.gen + 1;
        await this.closeLink('opening failed');
        if (this.gen !== expected) return;
        gen = this.gen;
        if (!last) {
          this.set({ phase: 'connecting', session: null, message: `Reading the bike failed (${errorText(e)}). Trying again: attempt ${attempt + 1} of ${attempts}…` });
          await sleep(RECONNECT.settleMs);
          if (gen !== this.gen) return;
          this.closing = false;
          continue;
        }
        this.set({ phase: 'failed', message: `Connected to ${name}, but reading it failed: ${errorText(e)}` });
        return;
      }
    }
  }

  private onDisconnected(): void {
    // While 'connecting', connect() itself reports the failure ("couldn't connect", not "lost").
    if (this.closing || this.s.phase !== 'connected') {
      this.event(`Disconnect event (expected: ${this.closing ? 'closing the link on purpose' : this.s.phase})`);
      return;
    }
    // Chrome marks the server disconnected before it fires the event, so a link that still reports
    // connected means the event belongs to an earlier connection.
    if (this.link?.gattConnected) {
      this.event('Disconnect event ignored: the current link still reports connected (an earlier connection\'s event)');
      return;
    }
    this.event('Disconnect event: the link was lost');
    this.gen++;
    this.session?.end('the Bluetooth link was lost');
    this.link?.lost('link lost');
    this.unsubSession?.();
    this.unsubSession = null;
    const name = this.s.device?.name ?? 'the bike';
    this.set({
      phase: 'lost',
      session: this.session?.state ?? this.s.session,
      message: `The connection to ${name} was lost (bike switched off, out of range, or Windows dropped it).`,
    });
  }

  /** Close the current link on purpose (session ended, queue closed, GATT disconnected). */
  private async closeLink(reason: string): Promise<void> {
    this.gen++;
    this.closing = true;
    this.unsubSession?.();
    this.unsubSession = null;
    this.session?.end(reason);
    const link = this.link;
    this.link = null;
    this.session = null;
    if (link) await link.disconnect(reason).catch(() => undefined);
  }

  /** Forget the bike and everything read from it. */
  private async wipe(message: string | null): Promise<void> {
    this.restartLoop = false;
    await this.closeLink('disconnected');
    this.unsubDevice?.();
    this.unsubDevice = null;
    this.device = null;
    this.recorder = null;
    this.set({ ...INITIAL, message });
  }
}

/** Local time of day, HH:MM:SS.mmm. */
function clock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  return String(e);
}
