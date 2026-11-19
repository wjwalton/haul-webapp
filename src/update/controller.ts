/**
 * Controller firmware update (docs/SPEC.md "1. Controller firmware update"; PROTOCOL.md "Controller /
 * battery firmware update"). Two parts:
 *
 * - flashController(): the 0x46/0x47 block stream, a port of the Android ControllerFlasher (proven on
 *   real bikes). It talks to a FirmwareChannel and a FirmwareFrames source, so its logic is tested on
 *   its own (resend, failure, stall, link loss, …) without the real image.
 * - runControllerUpdate(): one attempt on a live bike, a port of GlobeBleManager.flashLocked +
 *   FirmwareUpdater.runController: SHA re-check, pause the live loop with a one-shot `3D 37`, wait for the
 *   stream to go quiet, flash, then read page 19 and restore the loop. Every frame goes into the update
 *   session log (update/trace.ts).
 *
 * 0x46 is never re-sent automatically: every 0x46 re-erases the controller. A failure is handed back
 * to the mechanic. Only type 0x00 (controller) start frames exist; frames are built by protocol/frames.ts
 * from a VerifiedFirmware and checked again by BikeLink before they are written.
 */
import type { LinkTap } from '../ble/link';
import type { WriteMode } from '../ble/transport';
import { recheckFirmware, type VerifiedFirmware } from '../analysis/firmware';
import { BUILD_LABEL } from '../build';
import { hex } from '../protocol/bytes';
import { CTRL_SW_PAGE, ERROR_PAGE, fwBlock, fwStart, liveLoop, type FrameContext } from '../protocol/frames';
import { CH_BYPASS } from '../protocol/gatt';
import { ACK_STATUS, ACK_SUCCESS, type FwStatus } from '../protocol/pages';
import { TIMING, type BikeSession } from '../protocol/session';
import { UpdateTrace, type BlockTiming } from './trace';

// ---- the block stream ----------------------------------------------------------------------------

export const FW_STATUS = { OK: 0, FAILED: 1, READY: 2 } as const;

export const FLASH_TIMING = Object.freeze({
  /** 0x46 → page 0x3C status 2. The erase alone takes ~4.3-4.6 s; the stock app has no timeout here. */
  startTimeoutMs: 20_000,
  /** No completed write and no page 0x3C for this long = stalled. */
  stallMs: 30_000,
  /** Stock app: on a resend request, clear the queue and wait 500 ms. */
  resendPauseMs: 500,
  maxResends: 500,
  /** After the last block: how often to look for the final status. */
  waitSliceMs: 20,
});

export type FlashTiming = { -readonly [K in keyof typeof FLASH_TIMING]: number };

export type FailKind =
  /** Nothing was sent (link down, bad input). The controller is untouched. */
  | 'not-started'
  /** The display refused 0x46 (ack status ≠ 1). The controller is untouched. */
  | 'refused'
  /** 0x46 went out but no page 0x3C came: the controller is erased and waits in its bootloader. */
  | 'start-timeout'
  /** Page 0x3C status 1. */
  | 'controller-failed'
  /** No write completed and no page 0x3C for 30 s. */
  | 'stalled'
  | 'link-lost'
  /** A status the protocol doesn't allow here (seq out of range, too many resends, success before data). */
  | 'protocol';

/** Where the frames come from: the start frame and 1-based blocks. */
export interface FirmwareFrames {
  readonly total: number;
  start(): Uint8Array;
  block(seq: number): Uint8Array;
}

export interface FirmwareChannel {
  readonly connected: boolean;
  /** Write 0x46 to …0010. Resolves to the ack status, or null if none came (an ack isn't required). */
  sendStart(frame: Uint8Array): Promise<number | null>;
  /** Write one 0x47 block to …0011; resolves when the stack reports the write done. */
  writeBlock(frame: Uint8Array, seq: number): Promise<void>;
  /** The next page-0x3C status in arrival order, waiting up to [timeoutMs]; null if none came. */
  nextStatus(timeoutMs: number): Promise<FwStatus | null>;
  /** A status already received, without waiting. */
  takeStatus(): FwStatus | null;
  clearStatus(): void;
}

export interface FlashProgress {
  /** Last block written (1-based); goes back on a resend request. */
  position: number;
  total: number;
  /** Every completed block write, resends included. */
  writes: number;
  resends: number;
  /** ms since the first block. */
  elapsedMs: number;
  blocksPerSecond: number;
  /** Measured from the recent write rate; null until there is enough to measure. */
  etaMs: number | null;
}

export type FlashResult =
  | { ok: true; writes: number; resends: number; elapsedMs: number; readyAfterMs: number; timing: BlockTiming | null }
  | {
      ok: false;
      kind: FailKind;
      reason: string;
      /** Last block written (1-based), 0 if none. */
      stoppedAt: number;
      total: number;
      /** 0x46 went out without a refusal: the controller's application is erased until an update completes. */
      startSent: boolean;
      timing: BlockTiming | null;
    };

export interface FlashOptions {
  onProgress?: (p: FlashProgress) => void;
  log?: (msg: string) => void;
  now?: () => number;
  timing?: Partial<FlashTiming>;
}

const NONE = -1;
const ETA_WINDOW = 256;

class TimingStats {
  count = 0;
  min = Infinity;
  max = 0;
  sum = 0;
  add(ms: number): void {
    this.count++;
    this.sum += ms;
    if (ms < this.min) this.min = ms;
    if (ms > this.max) this.max = ms;
  }
  get value(): BlockTiming | null {
    return this.count ? { count: this.count, minMs: this.min, maxMs: this.max, avgMs: this.sum / this.count } : null;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The block stream (Android ControllerFlasher.flash). ONE attempt. */
export async function flashController(ch: FirmwareChannel, frames: FirmwareFrames, o: FlashOptions = {}): Promise<FlashResult> {
  const t = { ...FLASH_TIMING, ...o.timing };
  const now = o.now ?? (() => Date.now());
  const log = o.log ?? (() => undefined);
  const total = frames.total;
  const stats = new TimingStats();
  const fail = (kind: FailKind, reason: string, stoppedAt: number, startSent: boolean): FlashResult => {
    log(`FAILED (${kind}): ${reason}`);
    return { ok: false, kind, reason, stoppedAt, total, startSent, timing: stats.value };
  };
  if (total < 1 || total > 0xffff) return fail('not-started', `Image must be 1..65535 blocks, not ${total}`, 0, false);
  if (!ch.connected) return fail('not-started', 'Not connected to the bike', 0, false);

  // 1. Start frame. Once written without a refusal, the controller erases: the point of no return.
  const start = frames.start();
  ch.clearStatus();
  const t0 = now();
  let ack: number | null;
  try {
    ack = await ch.sendStart(start);
  } catch (e) {
    // The write itself failed: whether the display got it can't be known. Treat as started.
    return fail('link-lost', `Couldn't write the start frame (${errText(e)})`, 0, true);
  }
  log(`Start ${hex(start)} sent (${total} blocks); ack ${ack === null ? 'none (not required)' : ackText(ack)}`);
  if (ack !== null && ack !== ACK_SUCCESS) {
    return fail('refused', `The display refused to start the update (${ackText(ack)}); nothing was changed`, 0, false);
  }

  // 2. Wait for "ready" (status 2). Statuses that came during the ack wait are already queued.
  let first: FwStatus | null = null;
  while (first === null) {
    const left = t.startTimeoutMs - (now() - t0);
    if (left <= 0) break;
    const st = await ch.nextStatus(left);
    if (st === null) break;
    log(`Page 0x3C status ${st.status} seq ${st.seq} after ${now() - t0} ms`);
    if (st.status === FW_STATUS.OK || st.status === FW_STATUS.FAILED || st.status === FW_STATUS.READY) first = st;
  }
  if (first === null) {
    if (!ch.connected) return fail('link-lost', 'Connection lost while waiting for the controller bootloader', 0, true);
    return fail('start-timeout', `No page 0x3C ("ready") from the display within ${t.startTimeoutMs / 1000} s of the start frame`, 0, true);
  }
  if (first.status === FW_STATUS.FAILED) return fail('controller-failed', 'The display reported failure before any data was sent', 0, true);
  if (first.status === FW_STATUS.OK) return fail('protocol', 'The display reported success before any data was sent', 0, true);
  const readyAfterMs = now() - t0;
  const firstSeq = resumeFrom(first.seq, total, log);
  if (firstSeq === null) return fail('protocol', `The display asked to start at block ${first.seq}, outside 1..${total}`, 0, true);

  // 3. Stream: write, await the write, look at the statuses that arrived meanwhile, next block.
  const streamStart = now();
  let lastActivity = now();
  let next = firstSeq;
  let position = 0;
  let writes = 0;
  let resends = 0;
  let resendFrom = NONE;
  let final: FwStatus | null = null;
  const recent: number[] = [];

  const drain = (): void => {
    for (let st = ch.takeStatus(); st !== null && final === null; st = ch.takeStatus()) {
      lastActivity = now();
      log(`Page 0x3C status ${st.status} seq ${st.seq}`);
      if (st.status === FW_STATUS.READY) resendFrom = st.seq ?? 0;
      else if (st.status === FW_STATUS.OK || st.status === FW_STATUS.FAILED) final = st;
      else log(`Ignoring unknown page 0x3C status ${st.status}`);
    }
  };
  const progress = (): void => {
    const elapsed = now() - streamStart;
    let eta: number | null = null;
    if (recent.length >= 16) {
      const span = recent[recent.length - 1]! - recent[0]!;
      const perBlock = span / (recent.length - 1);
      if (perBlock > 0) eta = Math.max(0, total - position) * perBlock;
    }
    o.onProgress?.({
      position, total, writes, resends, elapsedMs: elapsed,
      blocksPerSecond: elapsed > 0 ? (writes * 1000) / elapsed : 0, etaMs: eta,
    });
  };

  for (;;) {
    drain();
    if (final !== null) {
      const st: FwStatus = final;
      if (st.status === FW_STATUS.FAILED) {
        return fail('controller-failed', 'The controller reported the update failed (page 0x3C status 1)', position, true);
      }
      if (position < total) log(`Success reported after block ${position} of ${total} (the display counts the controller's acks)`);
      log(`Success after ${writes} writes, ${resends} resend request(s), ${((now() - streamStart) / 1000).toFixed(1)} s`);
      return { ok: true, writes, resends, elapsedMs: now() - streamStart, readyAfterMs, timing: stats.value };
    }
    if (resendFrom !== NONE) {
      const asked = resendFrom;
      resendFrom = NONE;
      if (++resends > t.maxResends) return fail('protocol', `Too many resend requests (${resends})`, position, true);
      log(`Resend requested from block ${asked} (at block ${position}); pausing ${t.resendPauseMs} ms`);
      await sleep(t.resendPauseMs);
      drain(); // a newer request during the pause wins
      const latest = resendFrom !== NONE ? resendFrom : asked;
      resendFrom = NONE;
      if (final !== null) continue;
      const seq = resumeFrom(latest, total, log);
      if (seq === null) return fail('protocol', `The display asked to resend from block ${latest}, outside 1..${total}`, position, true);
      next = seq;
      recent.length = 0;
      lastActivity = now();
      continue;
    }
    if (now() - lastActivity > t.stallMs) {
      return fail('stalled', `Transfer stalled at block ${position}/${total}: no write completed and no page 0x3C for ${t.stallMs / 1000} s`, position, true);
    }
    if (!ch.connected) return fail('link-lost', `Connection lost at block ${position}/${total}`, position, true);
    if (next > total) {
      // Everything written: the display sends status 0 once the controller has acked all N blocks.
      const st = await ch.nextStatus(t.waitSliceMs);
      if (st !== null) {
        lastActivity = now();
        log(`Page 0x3C status ${st.status} seq ${st.seq}`);
        if (st.status === FW_STATUS.READY) resendFrom = st.seq ?? 0;
        else if (st.status === FW_STATUS.OK || st.status === FW_STATUS.FAILED) final = st;
      }
      continue;
    }
    const w0 = now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let written: boolean;
    try {
      written = await Promise.race([
        ch.writeBlock(frames.block(next), next).then(() => true),
        new Promise<boolean>((r) => {
          timer = setTimeout(() => r(false), t.stallMs);
        }),
      ]);
    } catch (e) {
      return fail(ch.connected ? 'stalled' : 'link-lost', `Couldn't write block ${next}/${total} (${errText(e)})`, position, true);
    } finally {
      clearTimeout(timer);
    }
    if (!written) {
      return fail('stalled', `Transfer stalled at block ${next}/${total}: the write didn't complete in ${t.stallMs / 1000} s`, position, true);
    }
    stats.add(now() - w0);
    position = next;
    writes++;
    next++;
    lastActivity = now();
    recent.push(lastActivity);
    if (recent.length > ETA_WINDOW) recent.shift();
    progress();
  }
}

/** Seq from a "ready / resend" status, 1-based. 0 or missing = from the beginning. */
function resumeFrom(seq: number | null, total: number, log: (m: string) => void): number | null {
  if (seq === null || seq === 0) {
    log('Status 2 without a seq (or seq 0): starting from block 1');
    return 1;
  }
  return seq >= 1 && seq <= total ? seq : null;
}

/** Page-0x3C statuses in arrival order (the session's firmware sink pushes; the flasher takes). */
export class StatusQueue {
  private readonly q: FwStatus[] = [];
  private waiter: ((st: FwStatus | null) => void) | null = null;

  push(st: FwStatus): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(st);
    } else this.q.push(st);
  }

  take(): FwStatus | null {
    return this.q.shift() ?? null;
  }

  next(timeoutMs: number): Promise<FwStatus | null> {
    const st = this.q.shift();
    if (st) return Promise.resolve(st);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.waiter === done) this.waiter = null;
        resolve(null);
      }, Math.max(0, timeoutMs));
      const done = (s: FwStatus | null) => {
        clearTimeout(timer);
        resolve(s);
      };
      this.waiter = done;
    });
  }

  clear(): void {
    this.q.length = 0;
  }
}

// ---- one update on a live bike -------------------------------------------------------------------

/** What runControllerUpdate needs from the link (BikeLink). */
export interface BlockLink {
  readonly connected: boolean;
  block(frame: Uint8Array, mode: WriteMode, ctx: FrameContext, label: string): Promise<void>;
  cancelPendingBlocks(reason: string): number;
  addTap(tap: LinkTap): () => void;
}

export type UpdateStep =
  | 'checking file'
  | 'pausing live data'
  | 'starting'
  | 'erasing'
  | 'sending'
  | 'finishing'
  | 'reading version'
  | 'done';

export interface UpdateProgress {
  step: UpdateStep;
  /** Plain words for the screen. */
  text: string;
  /** 0x46 has gone out: the controller has no application until this finishes. */
  pastPointOfNoReturn: boolean;
  writeMode: WriteMode | null;
  flash: FlashProgress | null;
  startedAt: number;
}

export interface UpdateResult {
  ok: boolean;
  kind: FailKind | null;
  /** What happened and what to do next, in plain words. */
  message: string;
  before: string | null;
  /** Page 19 right after the update (the display may still show the old one until a power-cycle). */
  after: string | null;
  target: string;
  /** 0x46 went out and the update didn't finish: the controller has no application. */
  controllerErased: boolean;
  /** after == target on a new version. */
  verified: boolean;
  /** Success, but the new version still has to be read after a power-cycle and reconnect. */
  awaitingPowerCycle: boolean;
  writeMode: WriteMode | null;
  timing: BlockTiming | null;
  writes: number;
  resends: number;
  log: string;
  logName: string;
}

export interface ControllerUpdateDeps {
  session: BikeSession;
  link: BlockLink;
  firmware: VerifiedFirmware;
  deviceName: string;
  platformLabel: string;
  /** Why it was offered (the gate's "Update needed" line), for the session log. */
  why?: string;
  onProgress: (p: UpdateProgress) => void;
  now?: () => number;
  /** For tests: shorter flasher timeouts. */
  timing?: Partial<FlashTiming>;
  /** File-name stamp (local time), e.g. 2026-11-18_1742. */
  stamp?: string;
}

/** Choose …0011's write method from its runtime properties: the stock app writes without response. */
export function blockWriteMode(p: { write: boolean; writeWithoutResponse: boolean } | null): WriteMode | null {
  if (!p) return null;
  if (p.writeWithoutResponse) return 'without-response';
  if (p.write) return 'with-response';
  return null;
}

/** One controller update attempt. Never throws: every outcome is an UpdateResult with its log. */
export async function runControllerUpdate(d: ControllerUpdateDeps): Promise<UpdateResult> {
  const now = d.now ?? (() => Date.now());
  const s0 = d.session.state;
  const fw = d.firmware;
  const target = fw.entry.version;
  const before = s0.identity.ctrl_sw || null;
  const mode = blockWriteMode(s0.gatt.blockChar);
  const startedAt = now();
  const logName = `update_${d.deviceName}_${d.stamp ?? 'controller'}.txt`;
  const trace = new UpdateTrace(
    `Globe Haul Shop Tool controller update: ${fw.entry.fileName} (${target}), sha256 ${fw.sha256}, ${fw.source}; ` +
      `bike ${d.deviceName}, HMI ${s0.dis.sw_rev ?? '?'} (fw ${s0.dis.fw_rev ?? '?'}), controller ${before ?? 'not answering'}; ` +
      `${d.platformLabel}; …0011 ${s0.gatt.blockChar ? Object.entries(s0.gatt.blockChar).filter(([, v]) => v).map(([k]) => k).join('+') : 'absent'}, ` +
      `blocks written ${mode ?? 'n/a'}; app ${BUILD_LABEL}`,
    now,
  );
  if (d.why) trace.state(`offered: ${d.why}`);
  let progress: UpdateProgress = { step: 'checking file', text: 'Checking the file (SHA-256)…', pastPointOfNoReturn: false, writeMode: mode, flash: null, startedAt };
  let lastEmit = 0;
  const emit = (patch: Partial<UpdateProgress>, force = true) => {
    progress = { ...progress, ...patch };
    const t = now();
    if (force || t - lastEmit >= 100) {
      lastEmit = t;
      d.onProgress(progress);
    }
  };
  emit({});

  type NotStarted = { ok: false; kind: 'not-started'; reason: string };
  const notStarted = (reason: string): NotStarted => ({ ok: false, kind: 'not-started', reason });
  let result: FlashResult | null = null;
  let after: string | null = null;
  const finish = (r: FlashResult | NotStarted): UpdateResult => {
    const ok = r.ok;
    const kind = r.ok ? null : r.kind;
    const startSent = !r.ok && 'startSent' in r ? r.startSent : false;
    const changed = after !== null && after !== '' && after === target && before !== target;
    const verified = ok && changed;
    const awaitingPowerCycle = ok && !verified;
    let message: string;
    if (r.ok) {
      const stats = `${r.writes.toLocaleString()} block writes in ${(r.elapsedMs / 1000).toFixed(1)} s${r.resends ? `, ${r.resends} resend request(s)` : ''}`;
      message = verified
        ? `The controller reported success (${stats}). Verified: it now reports ${after}.`
        : before === target
          ? `The controller reported success (${stats}). This was a same-version reflash, so the version can't show a change.` +
            ` Power-cycle the bike (off, then on), then click Reconnect: the app checks that the controller answers with ${target} again.`
          : `The controller reported success (${stats}). ${after ? `The display still shows ${after}` : 'The display hasn\'t reported the controller version yet'}` +
            ' (it reads the controller\'s version when it powers on). Power-cycle the bike (off, then on), then click Reconnect: the app reads the version again.';
    } else {
      message = failureMessage(r.kind, r.reason, 'stoppedAt' in r ? r.stoppedAt : 0, 'total' in r ? r.total : fw.blockCount, startSent);
    }
    const timing = r.ok ? r.timing : 'timing' in r ? r.timing : null;
    trace.addSummary(`Result: ${ok ? 'SUCCESS' : `FAILED (${kind})`}: ${r.ok ? 'controller reported status 0' : r.reason}`);
    trace.addSummary(`Controller before: ${before ?? 'not answering'}; page 19 after: ${after ?? 'not read'}; target ${target}`);
    trace.addSummary(`Write method on …0011: ${mode ?? 'n/a'}`);
    if (r.ok) trace.addSummary(`Ready (3C 02) ${r.readyAfterMs} ms after the start frame; stream ${(r.elapsedMs / 1000).toFixed(1)} s; ${r.writes} writes; ${r.resends} resend request(s)`);
    if (timing) {
      trace.addSummary(`Block write time: min ${timing.minMs.toFixed(1)} ms, avg ${timing.avgMs.toFixed(2)} ms, max ${timing.maxMs.toFixed(1)} ms over ${timing.count} writes`);
    }
    trace.addSummary(`0x46 sent: ${ok || startSent ? 'yes' : 'no'}${!ok && startSent ? ' (the controller application is erased until an update completes)' : ''}`);
    trace.state(`finished: ${ok ? 'OK' : `FAILED (${kind})`}`);
    emit({ step: 'done', text: ok ? 'Done' : 'Stopped' });
    return {
      ok, kind, message, before, after, target, controllerErased: !ok && startSent, verified, awaitingPowerCycle,
      writeMode: mode, timing, writes: r.ok ? r.writes : 0, resends: r.ok ? r.resends : 0, log: trace.text(), logName,
    };
  };

  // Same hash, same allowlist entry, same structure as when it was loaded, or nothing happens.
  if (!(await recheckFirmware(fw))) return finish(notStarted('The file no longer matches the allowlist (SHA-256 re-check failed). Load it again'));
  trace.state(`SHA-256 re-checked: ${fw.sha256}`);
  if (mode === null) return finish(notStarted('This display has no writable …0011 characteristic, which the blocks are written to'));
  if (!d.link.connected || d.session.isEnded) return finish(notStarted('Not connected to the bike'));

  const untap = d.link.addTap((e) => {
    if (e.dir === 'tx' && e.char === CH_BYPASS) return; // blocks are logged with their write time
    trace.frame(e.dir, e.char, e.bytes, e.dir === 'tx' ? e.label : undefined);
  });
  try {
    const outcome = await d.session.runExclusive(async (): Promise<FlashResult | NotStarted> => {
      const session = d.session;
      session.setLivePaused(true);
      const queue = new StatusQueue();
      let startWritten = false;
      try {
        emit({ step: 'pausing live data', text: 'Pausing live data…' });
        trace.state('pausing live pages (one-off page 55 request replaces the loop)');
        await session.requestOnce([ERROR_PAGE], 'firmware: pause stream', TIMING.errorPollPagesMs);
        if (!(await session.awaitStreamQuiet())) {
          trace.state('live pages kept arriving: not starting');
          return notStarted('The bike kept streaming live data, so the update didn\'t start');
        }
        session.beginFirmware((st) => queue.push(st));
        trace.state(`controller update: ${fw.entry.fileName}, ${fw.size} bytes, ${fw.blockCount} blocks; firmware session open`);
        session.note(`[firmware] controller update: ${fw.entry.fileName}, ${fw.blockCount} blocks, …0011 ${mode}`);
        const ctx: FrameContext = { firmware: fw };
        const channel: FirmwareChannel = {
          get connected() {
            return d.link.connected && !session.isEnded;
          },
          sendStart: (frame) => {
            startWritten = true;
            emit({ step: 'starting', text: 'Sending the start frame…', pastPointOfNoReturn: true });
            return session.sendCommand(frame, 'firmware start', ctx).then((st) => {
              emit({ step: 'erasing', text: 'The controller is erasing its application (about 4.5 s)…' });
              return st;
            });
          },
          writeBlock: async (frame, seq) => {
            const w0 = now();
            await d.link.block(frame, mode, ctx, `block ${seq}`);
            trace.add('TX 0011', `${hex(frame)}  ${(now() - w0).toFixed(1)} ms`);
          },
          nextStatus: (ms) => queue.next(ms),
          takeStatus: () => queue.take(),
          clearStatus: () => queue.clear(),
        };
        const frames: FirmwareFrames = { total: fw.blockCount, start: () => fwStart(fw), block: (seq) => fwBlock(fw, seq) };
        result = await flashController(channel, frames, {
          now,
          timing: d.timing,
          log: (m) => {
            trace.state(m);
            session.note(`[firmware] ${m}`);
          },
          onProgress: (p) => {
            const last = p.position >= p.total;
            emit({ step: last ? 'finishing' : 'sending', text: last ? 'All blocks sent; waiting for the controller to confirm…' : 'Sending firmware…', flash: p }, last);
          },
        });
        return result;
      } finally {
        session.endFirmware();
        d.link.cancelPendingBlocks('update ended');
        // A status-1 failure ends with BPOU (the display leaves update mode, PROTOCOL.md); a timeout,
        // stall or protocol stop after 0x46 leaves it waiting in update mode until a power-cycle.
        const r = result as FlashResult | null;
        if (r && !r.ok && r.startSent && r.kind !== 'controller-failed') session.markDisplayInUpdateMode('the update stopped after the start frame');
        else if (!r && startWritten) session.markDisplayInUpdateMode('the update stopped after the start frame');
        if (d.link.connected && !session.isEnded) {
          if (r?.ok) {
            emit({ step: 'reading version', text: 'Reading the controller version (page 19)…' });
            trace.state('reading the controller version (page 19), then restoring the live loop');
            const missing = await session.requestOnce([CTRL_SW_PAGE], 'firmware: controller version').catch(() => [CTRL_SW_PAGE]);
            after = missing.length ? null : session.state.identity.ctrl_sw ?? null;
          }
          await session.sendCommand(liveLoop(), 'loop').catch((e: unknown) => {
            trace.state(`couldn't restart the live loop: ${errText(e)}`);
            return null;
          });
        }
        session.setLivePaused(false);
        trace.state('firmware session closed');
      }
    });
    return finish(outcome);
  } catch (e) {
    // Only reachable through a bug or a session that ended mid-call: 0x46 may have gone out.
    trace.state(`exception: ${errText(e)}`);
    const r = result as FlashResult | null;
    return finish(r ?? notStarted(`The update stopped on an error (${errText(e)})`));
  } finally {
    untap();
  }
}

function failureMessage(kind: FailKind, reason: string, stoppedAt: number, total: number, startSent: boolean): string {
  const parts = [`${reason}.`];
  if (startSent) parts.push(`Stopped at block ${stoppedAt.toLocaleString()} of ${total.toLocaleString()}.`);
  if (!startSent) {
    parts.push('Nothing was changed on the bike.');
  } else if (kind === 'start-timeout') {
    parts.push('No answer from the controller bootloader. Power-cycle the bike and retry; it stays reflashable.');
  } else if (kind === 'link-lost') {
    parts.push('Reconnect and flash again. The controller stays in its bootloader (e031) and is reflashable.');
  } else {
    parts.push(
      'The controller\'s application was erased when the update started, so the bike won\'t drive until an update completes. ' +
        'Its bootloader stays ready: retrying is safe. If the display shows bypass or live data doesn\'t return: ' +
        'power-cycle the bike, reconnect, then do the recovery flash.',
    );
  }
  return parts.join(' ');
}

function ackText(status: number): string {
  return ACK_STATUS[status] ?? `status ${status}`;
}

function errText(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}
