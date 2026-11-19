/**
 * ShopApp: one tab, one bike. Picks a bike through the transport's chooser, connects, runs the
 * session's opening sequence, holds the "confirmed" flag, reconnects to the same device without the
 * chooser, and wipes everything on "Disconnect / connect another bike" (docs/SPEC.md: stateless).
 *
 * It also runs the controller firmware update (update/controller.ts) after re-checking every pre-flight
 * condition at the moment Start is pressed, keeps the result and its session log, and verifies the
 * new controller version on the next connection (after the power-cycle).
 *
 * No DOM and no navigator here: the UI renders ShopState (useSyncExternalStore) and calls the methods.
 */
import type { VerifiedFirmware } from '../analysis/firmware';
import { openBikeLink, type BikeLink } from '../ble/link';
import type { BleDevice, DeviceRequest, GattTransport } from '../ble/transport';
import { RawRecorder } from '../export/rawJsonl';
import { NAME_PREFIX, OPTIONAL_SERVICES, SCAN_UUID } from '../protocol/gatt';
import { BikeSession, type SessionState } from '../protocol/session';
import { runControllerUpdate, type FlashTiming, type UpdateProgress, type UpdateResult } from '../update/controller';
import { controllerSilent } from '../update/gate';
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
}

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

const INITIAL: ShopState = { phase: 'idle', device: null, confirmed: false, session: null, message: null, connections: 0, update: null };

export interface ShopOptions {
  now?: () => number;
  /** Passed to each session (tests switch the 30 s poll off). */
  errorPoll?: boolean;
  /** Tests: shorter flasher timeouts. */
  flashTiming?: Partial<FlashTiming>;
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
    await this.wipe(null);
    this.device = picked;
    this.unsubDevice = picked.onDisconnected(() => this.onDisconnected());
    this.recorder = new RawRecorder(this.now);
    this.set({ ...INITIAL, device: { id: picked.id, name: picked.name } });
    await this.connect();
  }

  /** Connect again to the same bike (no chooser). Keeps the confirmation: it's the same device. */
  async reconnect(): Promise<void> {
    if (!this.device || this.updateRunning) return;
    await this.closeLink('reconnecting');
    await this.connect();
  }

  confirm(): void {
    if (this.s.phase === 'connected' && this.s.session?.phase === 'live') this.set({ confirmed: true });
  }

  /** "Wrong bike": disconnect and forget it. */
  async wrongBike(): Promise<void> {
    if (this.updateRunning) return;
    const name = this.s.device?.name ?? 'that bike';
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
    return this.s.update?.running === true;
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
    const checks = controllerChecks({
      session: session.state, confirmed: this.s.confirmed, platformVerified: env.platformVerified, platformLabel: env.platformLabel,
      firmware, reflashSameVersion: env.reflashSameVersion, updateRunning: false, now: this.now(),
    });
    const failing = [...checks.gate.checks, ...checks.preflight].find((c) => c.ok !== true);
    if (failing) return `${failing.label}: ${failing.detail}`;
    if (!isArmed(env.typedName, this.s.device?.name ?? null)) return "Type the bike's name to arm the update";
    const need = checks.gate.checks.find((c) => c.id === 'need');

    const gen = this.gen;
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
    }).then((result) => {
      this.verifyAfterGen = result.awaitingPowerCycle ? gen : Infinity;
      const verify: VerifyState | null = result.awaitingPowerCycle
        ? { target: result.target, before: result.before, status: 'waiting', reported: null }
        : null;
      this.set({ update: { running: false, progress: this.s.update?.progress ?? null, result, verify } });
    });
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

  // ---- internals ---------------------------------------------------------------------------------

  private async connect(): Promise<void> {
    const device = this.device;
    if (!device) return;
    const gen = ++this.gen;
    this.closing = false;
    const name = device.name ?? 'the bike';
    this.set({ phase: 'connecting', session: null, message: null, connections: this.s.connections + 1 });
    let link: BikeLink;
    try {
      link = await openBikeLink(device, { recorder: this.recorder ?? undefined });
    } catch (e) {
      if (gen !== this.gen) return;
      this.set({
        phase: 'failed',
        message: `Couldn't connect to ${name}: ${errorText(e)}. Check the bike is on and nothing else (another tab, app or phone) is connected to it.`,
      });
      return;
    }
    if (gen !== this.gen) {
      await link.disconnect('superseded').catch(() => undefined);
      return;
    }
    const session = new BikeSession(link, { now: this.now, errorPoll: this.opts.errorPoll });
    this.link = link;
    this.session = session;
    this.unsubSession = session.subscribe((st) => {
      if (gen !== this.gen) return;
      this.set({ session: st });
      this.checkVerify(gen, st);
    });
    this.set({ phase: 'connected', session: session.state });
    try {
      await session.start();
    } catch (e) {
      if (gen !== this.gen || this.s.phase === 'lost') return;
      await this.closeLink('opening failed');
      this.set({ phase: 'failed', message: `Connected to ${name}, but reading it failed: ${errorText(e)}` });
    }
  }

  private onDisconnected(): void {
    // While 'connecting', connect() itself reports the failure ("couldn't connect", not "lost").
    if (this.closing || this.s.phase !== 'connected') return;
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
    await this.closeLink('disconnected');
    this.unsubDevice?.();
    this.unsubDevice = null;
    this.device = null;
    this.recorder = null;
    this.set({ ...INITIAL, message });
  }
}

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  return String(e);
}
