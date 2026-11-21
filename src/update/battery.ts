/**
 * Battery (BMS) firmware update over BLE (docs/DECISIONS.md 2026-11-20; PROTOCOL.md "Battery (BMS)
 * firmware update over BLE", CONFIRMED on a real bike 2026-11-20 with the reference flasher). The
 * display puts each CAN frame on the bus (`52`) and mirrors the bus back (`50 01`); the frames are the
 * dealer tool's, byte for byte:
 *
 *   identify  0x101 wake, 0x280 → "010012RC", 0x281 → byte 2 = hardware type (1 SC, 2 RC)
 *   start     (0x10F), 0x101, 200 ms, 0x045 "....EAGO" → 0x046 (data[1] == 1 = erase error)
 *   data      0x047 = the next 8 bytes of the file → 0x048 for every block (stop-and-wait, 5 s each)
 *   end       0x049 → 0x04A, all zero = success
 *
 * Only `src` 0 frames (received from the bus) count as replies: the display echoes every frame it sends
 * (`src` 1). A missed ack, an extra ack, an out-of-order echo or a bootloader restart ends the attempt;
 * the next attempt starts again from 0x045 (never resend a single block: the bootloader parses the
 * stream as 139-byte records). Up to 3 attempts. Every outcome ends with `50 00`.
 *
 * Two parts, like update/controller.ts:
 * - flashBms(): the CAN-level state machine against a BmsChannel (a port of globe-bms-flasher's
 *   flasher.py, plus the BLE rules), tested on its own with synthetic images.
 * - readBattery() / runBatteryUpdate() / afterBatteryRestart(): on a live bike, through BikeSession and
 *   BikeLink (every frame passes the send whitelist with FrameContext.battery), with the guardrails:
 *   auto-off to 0 and back, bus-access probe, identity re-checked against what the mechanic approved.
 */
import { BMS_ALLOWLIST, type BmsLine } from '../analysis/firmware';
import { BMS_HW_TYPE, lineOfHwType, parseBmsVersion, readBmsBlock, recheckBmsFirmware, type VerifiedBmsFirmware } from '../analysis/bmsFirmware';
import type { LinkTap } from '../ble/link';
import { BUILD_LABEL } from '../build';
import { bytesEqual, hex } from '../protocol/bytes';
import {
  autoOff, bmsBlock, bmsEnd, bmsRead, bmsStart, bmsWake, BMS_CAN, canBus, liveLoop, type BatteryFrameContext, type BmsReadId,
} from '../protocol/frames';
import { ACK_STATUS, ACK_SUCCESS, type CanFrame } from '../protocol/pages';
import { TIMING, type BikeSession } from '../protocol/session';
import { UpdateTrace, type BlockTiming } from './trace';

export const BMS_TIMING = Object.freeze({
  /** BUS_ON: the 0x280 probe's echo (src 1) must come back within this. */
  probeEchoMs: 1_500,
  /** After the 0x101 wake. */
  wakeSettleMs: 200,
  /** IDENTIFY: each 0x280 / 0x281 read waits this long; 3 and 2 tries. */
  readReplyMs: 600,
  versionTries: 3,
  hwTries: 2,
  /** The optional 0x10F before a start (reply ignored). */
  probe10fMs: 1_000,
  /** START: 0x045 → 0x046 (measured 4 ms; the dealer tool's erase wait is generous). */
  eraseReplyMs: 30_000,
  /** A second 0x046 right after the first (a start still in flight): take the latest. */
  duplicateEraseMs: 300,
  /** STREAM: one 0x048 per block (the dealer tool's 5 s timer). */
  blockAckMs: 5_000,
  /** END: 0x049 → 0x04A (measured 1.75 s). */
  resultMs: 15_000,
  attempts: 3,
  /** Between attempts. */
  retryPauseMs: 3_000,
  /** After success and `50 00`: the BMS restart cuts system power ~13.5 s after 0x04A; the link drops. */
  restartDropMs: 30_000,
  /** Then the app reconnects for up to this long, asking for the power button after powerButtonHintMs. */
  reconnectMs: 180_000,
  powerButtonHintMs: 45_000,
  reconnectPauseMs: 3_000,
  /** A write that failed (link still up) is tried again up to this many times (PROTOCOL.md "During and after"). */
  writeRetries: 3,
  /** Before a CAN frame is sent again: look this long for its echo (it may have reached the bus after all). */
  echoCheckMs: 500,
  retryWriteMs: 200,
});

export type BmsTiming = { -readonly [K in keyof typeof BMS_TIMING]: number };

/** Bike battery (page 10) while the BMS application runs: refuse below, warn below the second. */
export const MIN_BATTERY_PCT = 20;
export const WARN_BATTERY_PCT = 40;

// ---- the CAN channel -----------------------------------------------------------------------------

/** Mirrored CAN frames in arrival order (the session's CAN sink pushes; the updater takes). */
export class CanQueue {
  private readonly q: CanFrame[] = [];
  private waiter: ((f: CanFrame | null) => void) | null = null;

  push(f: CanFrame): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(f);
    } else this.q.push(f);
  }

  take(): CanFrame | null {
    return this.q.shift() ?? null;
  }

  /** Frames that were read but not used go back to the front, in their order. */
  putBack(frames: readonly CanFrame[]): void {
    if (frames.length) this.q.unshift(...frames);
  }

  next(timeoutMs: number): Promise<CanFrame | null> {
    const f = this.q.shift();
    if (f) return Promise.resolve(f);
    return new Promise((resolve) => {
      const done = (x: CanFrame | null) => {
        clearTimeout(timer);
        resolve(x);
      };
      const timer = setTimeout(() => {
        if (this.waiter === done) this.waiter = null;
        resolve(null);
      }, Math.max(0, timeoutMs));
      this.waiter = done;
    });
  }

  clear(): void {
    this.q.length = 0;
  }
}

export interface BmsChannel {
  readonly connected: boolean;
  /** Put one frame on the bus (`52` on …0010). Resolves to the `10 52` ack status, or null if none came. */
  send(frame: Uint8Array, label: string, block?: number): Promise<number | null>;
  next(timeoutMs: number): Promise<CanFrame | null>;
  take(): CanFrame | null;
  /** Put frames back at the front of the queue, in order (see CanQueue.putBack). */
  putBack(frames: readonly CanFrame[]): void;
  clear(): void;
}

/** The frames to send. Production: protocol/frames.ts from a VerifiedBmsFirmware. */
export interface BmsReadFrames {
  wake(): Uint8Array;
  read(id: BmsReadId): Uint8Array;
}

export interface BmsFlashFrames extends BmsReadFrames {
  /** 8-byte blocks in the image. */
  readonly total: number;
  start(): Uint8Array;
  end(): Uint8Array;
  /** The `52` frame carrying block [i] (0-based). */
  block(i: number): Uint8Array;
  /** Block [i]'s 8 data bytes (for the echo check). */
  blockData(i: number): Uint8Array;
}

const isRx = (f: CanFrame, id: number) => f.src === 'HMI_RX' && f.canId === id;
const isTx = (f: CanFrame, id: number) => f.src === 'HMI_TX' && f.canId === id;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Pull frames until [onFrame] says done (true) or [ms] pass (false). */
async function waitFor(ch: BmsChannel, ms: number, now: () => number, onFrame: (f: CanFrame) => boolean): Promise<boolean> {
  const deadline = now() + ms;
  for (;;) {
    const left = deadline - now();
    if (left <= 0) return false;
    const f = await ch.next(left);
    if (f === null) return false;
    if (onFrame(f)) return true;
  }
}

class SendError extends Error {
  constructor(readonly kind: 'link-lost' | 'refused' | 'write-failed', message: string) {
    super(message);
  }
}

interface SendCtx {
  t: BmsTiming;
  now: () => number;
  log: (m: string) => void;
}

/** Errors that must never lead to the same frame being written again. */
const NO_RESEND = new Set(['GattTimeoutError', 'ForbiddenFrameError']);

/**
 * Did [frame] reach the bus? Look for its echo (src 1, same ID and data) for up to [ms]. Every frame read
 * meanwhile goes back to the queue, so the caller still sees the acknowledgement it is waiting for.
 */
async function sawEcho(ch: BmsChannel, frame: Uint8Array, ms: number, now: () => number): Promise<boolean> {
  const id = (frame[1]! | (frame[2]! << 8) | (frame[3]! << 16) | (frame[4]! << 24)) >>> 0;
  const data = frame.subarray(6, 14);
  const read: CanFrame[] = [];
  let seen = false;
  await waitFor(ch, ms, now, (fr) => {
    read.push(fr);
    seen = isTx(fr, id) && bytesEqual(fr.data, data);
    return seen;
  });
  ch.putBack(read);
  return seen;
}

/**
 * Put one frame on the bus. A write that fails while the link is up is a transient BlueZ / WinRT error
 * (PROTOCOL.md: retry up to 3×), but the frame may have reached the bus anyway, and a battery block put
 * on the bus twice would shift the bootloader's 139-byte record stream. So it is written again only when
 * no echo of it shows up. A write that timed out is never written again (it may still go out): the
 * attempt ends and the next one starts cleanly from the start frame.
 */
async function send(ch: BmsChannel, frame: Uint8Array, label: string, sx: SendCtx, block?: number): Promise<void> {
  for (let tries = 1; ; tries++) {
    let st: number | null;
    try {
      st = await ch.send(frame, label, block);
    } catch (e) {
      if (!ch.connected) throw new SendError('link-lost', `Connection lost while sending ${label} (${errText(e)})`);
      const name = e instanceof Error ? e.name : '';
      if (NO_RESEND.has(name)) throw new SendError('write-failed', `Couldn't send ${label} (${errText(e)}); not sent again`);
      if (await sawEcho(ch, frame, sx.t.echoCheckMs, sx.now)) {
        sx.log(`write of ${label} reported an error (${errText(e)}), but its echo shows it reached the bus: carrying on`);
        return;
      }
      if (tries > sx.t.writeRetries) throw new SendError('write-failed', `Couldn't send ${label} after ${tries} tries (${errText(e)})`);
      sx.log(`write of ${label} failed (${errText(e)}) and it isn't on the bus: sending it again (${tries} of ${sx.t.writeRetries})`);
      await sleep(sx.t.retryWriteMs);
      continue;
    }
    if (st !== null && st !== ACK_SUCCESS) throw new SendError('refused', `The display refused ${label} (${ACK_STATUS[st] ?? `status ${st}`})`);
    return;
  }
}

// ---- identify ------------------------------------------------------------------------------------

/** What the battery's BMS said on the bus (PROTOCOL.md IDENTIFY). */
export interface BmsIdentity {
  /** The display echoed the 0x280 probe (src 1): bus access works. */
  echo: boolean;
  versionRaw: string | null;
  /** "01.00.09" */
  version: string | null;
  /** "RC" / "SC", from the version string. */
  line: string | null;
  hwRaw: string | null;
  /** 0x281 byte 2: 1 = SC, 2 = RC. */
  hwType: number | null;
  /** The BMS application answered 0x280 or 0x281. A pack in its bootloader answers neither. */
  responding: boolean;
  /**
   * Round trip of one frame (write → reply, or → echo when nothing answers), median, ms. Every block of
   * the update costs about this: it's the link's speed, measured before anything is flashed.
   */
  rttMs: number | null;
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

async function readReply(
  ch: BmsChannel, f: BmsReadFrames, id: BmsReadId, tries: number, ms: number, sx: SendCtx, seen: { echo: boolean; rtt: number[] },
): Promise<Uint8Array | null> {
  const now = sx.now;
  for (let t = 0; t < tries; t++) {
    const t0 = now();
    await send(ch, f.read(id), `CAN 0x${id.toString(16)} read`, sx);
    const box: { got: Uint8Array | null } = { got: null };
    await waitFor(ch, ms, now, (fr) => {
      if (isTx(fr, id)) seen.echo = true;
      if (isRx(fr, id)) {
        box.got = fr.data;
        return true;
      }
      return false;
    });
    if (box.got !== null) {
      seen.rtt.push(now() - t0);
      return box.got;
    }
  }
  return null;
}

/**
 * BUS_ON probe + IDENTIFY: one 0x280 whose echo proves the send path, then 0x101 wake, 0x280 ×3,
 * 0x281 ×2 (0.6 s each). Bus access must already be on. Throws SendError if a write fails.
 */
export async function identifyBms(ch: BmsChannel, f: BmsReadFrames, o: { timing?: Partial<BmsTiming>; now?: () => number; log?: (m: string) => void } = {}): Promise<BmsIdentity> {
  const t = { ...BMS_TIMING, ...o.timing };
  const now = o.now ?? (() => Date.now());
  const log = o.log ?? (() => undefined);
  const sx: SendCtx = { t, now, log };
  const seen = { echo: false, rtt: [] as number[] };
  ch.clear();
  const p0 = now();
  await send(ch, f.read(BMS_CAN.VERSION), 'CAN 0x280 probe', sx);
  const probe: { early: Uint8Array | null; echoMs: number | null } = { early: null, echoMs: null };
  await waitFor(ch, t.probeEchoMs, now, (fr) => {
    if (isTx(fr, BMS_CAN.VERSION) && !seen.echo) {
      seen.echo = true;
      probe.echoMs = now() - p0;
    }
    if (isRx(fr, BMS_CAN.VERSION)) probe.early = fr.data;
    return seen.echo;
  });
  const id: BmsIdentity = { echo: seen.echo, versionRaw: null, version: null, line: null, hwRaw: null, hwType: null, responding: false, rttMs: probe.echoMs };
  if (!seen.echo) {
    log(`no echo of the 0x280 probe within ${t.probeEchoMs} ms: the display didn't put the frame on the bus`);
    return id;
  }
  await send(ch, f.wake(), 'CAN 0x101 wake', sx);
  await sleep(t.wakeSettleMs);
  const v = probe.early ?? (await readReply(ch, f, BMS_CAN.VERSION, t.versionTries, t.readReplyMs, sx, seen));
  if (v) {
    id.versionRaw = hex(v);
    const p = parseBmsVersion(v);
    if (p) {
      id.version = p.version;
      id.line = p.line;
    }
  }
  const h = await readReply(ch, f, BMS_CAN.HW_TYPE, t.hwTries, t.readReplyMs, sx, seen);
  if (h) {
    id.hwRaw = hex(h);
    id.hwType = h.length > 2 ? h[2]! : null;
  }
  id.responding = v !== null || h !== null;
  id.rttMs = median(seen.rtt) ?? id.rttMs;
  log(`identify: ${describeIdentity(id)}${id.rttMs !== null ? `; round trip ${Math.round(id.rttMs)} ms` : ''}`);
  return id;
}

export function describeIdentity(id: BmsIdentity | null): string {
  if (!id) return 'not read';
  if (!id.echo) return 'bus access did not work (no echo)';
  if (!id.responding) return 'the battery\'s BMS did not answer (in its bootloader, asleep, or not connected)';
  const parts: string[] = [];
  parts.push(id.version ? `firmware ${id.version} ${id.line}` : id.versionRaw ? `firmware reply ${id.versionRaw} (not a version)` : 'no firmware reply');
  parts.push(id.hwType !== null ? `hardware type ${id.hwType}${lineOfHwType(id.hwType) ? ` (${lineOfHwType(id.hwType)} line)` : ''}` : 'no hardware-type reply');
  return parts.join(', ');
}

// ---- the flash -----------------------------------------------------------------------------------

export type BmsFailKind =
  /** Nothing was sent to the BMS bootloader (bus, identity, file or pre-flight). The pack is untouched. */
  | 'not-started'
  /** The display refused a frame (ack status ≠ 1). */
  | 'refused'
  | 'erase-error'
  | 'no-erase-reply'
  | 'ack-timeout'
  | 'extra-ack'
  | 'echo-mismatch'
  /** 0x046 / 0x04A in the middle of the transfer: the bootloader restarted. */
  | 'restarted'
  | 'result-failed'
  | 'result-timeout'
  /** A write failed and couldn't safely be sent again: the next attempt starts from the start frame. */
  | 'write-failed'
  | 'link-lost';

export interface BmsFlashProgress {
  attempt: number;
  attempts: number;
  phase: 'starting' | 'erasing' | 'sending' | 'finishing';
  /** Blocks acknowledged in this attempt. */
  block: number;
  total: number;
  elapsedMs: number;
  blocksPerSecond: number;
  etaMs: number | null;
}

export type BmsFlashResult =
  | { ok: true; attempts: number; elapsedMs: number; streamMs: number; eraseMs: number; resultMs: number; ackTiming: BlockTiming | null }
  | { ok: false; kind: BmsFailKind; reason: string; attempts: number; startSent: boolean; stoppedAt: number; total: number; ackTiming: BlockTiming | null };

type Attempt =
  | { ok: true; eraseMs: number; streamMs: number; resultMs: number }
  | { ok: false; kind: BmsFailKind; reason: string; startSent: boolean; stoppedAt: number };

class Stats {
  count = 0;
  min = Infinity;
  max = 0;
  sum = 0;
  add(ms: number): void {
    this.count++;
    this.sum += ms;
    this.min = Math.min(this.min, ms);
    this.max = Math.max(this.max, ms);
  }
  get value(): BlockTiming | null {
    return this.count ? { count: this.count, minMs: this.min, maxMs: this.max, avgMs: this.sum / this.count } : null;
  }
}

/** One attempt: START, STREAM (stop-and-wait), END. */
async function attemptOnce(
  ch: BmsChannel, f: BmsFlashFrames, t: BmsTiming, now: () => number, log: (m: string) => void,
  progress: (p: Omit<BmsFlashProgress, 'attempt' | 'attempts'>) => void, stats: Stats,
): Promise<Attempt> {
  const sx: SendCtx = { t, now, log };
  let startSent = false;
  let acked = 0;
  const fail = (kind: BmsFailKind, reason: string): Attempt => {
    log(`attempt failed (${kind}): ${reason}`);
    return { ok: false, kind, reason, startSent, stoppedAt: acked };
  };
  try {
    // START: (0x10F), 0x101, 200 ms, 0x045 → 0x046.
    progress({ phase: 'starting', block: 0, total: f.total, elapsedMs: 0, blocksPerSecond: 0, etaMs: null });
    await send(ch, f.read(BMS_CAN.PROBE_10F), 'CAN 0x10F', sx);
    await waitFor(ch, t.probe10fMs, now, (fr) => {
      if (isRx(fr, BMS_CAN.PROBE_10F)) log(`0x10F answered ${hex(fr.data)} (ignored for the battery)`);
      return isRx(fr, BMS_CAN.PROBE_10F);
    });
    await send(ch, f.wake(), 'CAN 0x101 wake', sx);
    await sleep(t.wakeSettleMs);
    ch.clear();
    const s0 = now();
    startSent = true;
    await send(ch, f.start(), 'CAN 0x045 start', sx);
    progress({ phase: 'erasing', block: 0, total: f.total, elapsedMs: 0, blocksPerSecond: 0, etaMs: null });
    const box: { erased: Uint8Array | null; result: Uint8Array | null; bad: Attempt | null } = { erased: null, result: null, bad: null };
    await waitFor(ch, t.eraseReplyMs, now, (fr) => {
      if (isRx(fr, BMS_CAN.ERASED)) box.erased = fr.data;
      return box.erased !== null;
    });
    if (box.erased === null) {
      return fail(ch.connected ? 'no-erase-reply' : 'link-lost', `No erase reply (0x046) from the battery's bootloader within ${t.eraseReplyMs / 1000} s`);
    }
    // A start still in flight from an earlier attempt can answer too: the latest one counts.
    await waitFor(ch, t.duplicateEraseMs, now, (fr) => {
      if (isRx(fr, BMS_CAN.ERASED)) {
        log(`second erase reply ${hex(fr.data)}: using it`);
        box.erased = fr.data;
      }
      return false;
    });
    const eraseMs = now() - s0;
    log(`erase reply after ${eraseMs} ms: ${hex(box.erased)}`);
    if (box.erased[1] === 1) return fail('erase-error', 'The battery\'s bootloader reported an erase error (0x046 data[1] = 1)');

    // STREAM: one block, then its 0x048, then the next. The echo (src 1) must be the block just sent.
    const streamStart = now();
    const recent: number[] = [];
    let lastEmit = 0;
    const onStreamFrame = (fr: CanFrame, i: number, waiting: boolean): boolean => {
      if (fr.src === 'HMI_RX' && (fr.canId === BMS_CAN.ERASED || fr.canId === BMS_CAN.RESULT)) {
        box.bad = fail('restarted', `The bootloader sent 0x${fr.canId.toString(16).padStart(3, '0')} ${hex(fr.data)} in the middle of the transfer (block ${i + 1}): it restarted`);
        return true;
      }
      if (isTx(fr, BMS_CAN.DATA)) {
        const okEcho = bytesEqual(fr.data, f.blockData(i)) || (i > 0 && bytesEqual(fr.data, f.blockData(i - 1)));
        if (!okEcho) {
          box.bad = fail('echo-mismatch', `The display put ${hex(fr.data)} on the bus around block ${i + 1}, not that block: out of order`);
          return true;
        }
      }
      if (isRx(fr, BMS_CAN.ACK)) {
        if (!waiting) {
          box.bad = fail('extra-ack', `An extra acknowledgement (0x048) arrived before block ${i + 1} was sent`);
        }
        return true;
      }
      return false;
    };
    for (let i = 0; i < f.total; i++) {
      for (let fr = ch.take(); fr !== null; fr = ch.take()) {
        if (onStreamFrame(fr, i, false) && box.bad) return box.bad;
      }
      const w0 = now();
      await send(ch, f.block(i), `block ${i + 1}`, sx, i);
      const got = await waitFor(ch, t.blockAckMs, now, (fr) => onStreamFrame(fr, i, true));
      if (box.bad) return box.bad;
      if (!got) {
        return fail(ch.connected ? 'ack-timeout' : 'link-lost', `No acknowledgement (0x048) for block ${(i + 1).toLocaleString('en-US')} of ${f.total.toLocaleString('en-US')} within ${t.blockAckMs / 1000} s`);
      }
      stats.add(now() - w0);
      acked = i + 1;
      recent.push(now());
      if (recent.length > 128) recent.shift();
      if (now() - lastEmit >= 250 || acked === f.total) {
        lastEmit = now();
        const elapsed = now() - streamStart;
        const per = recent.length >= 8 ? (recent[recent.length - 1]! - recent[0]!) / (recent.length - 1) : null;
        progress({
          phase: 'sending', block: acked, total: f.total, elapsedMs: elapsed,
          blocksPerSecond: elapsed > 0 ? (acked * 1000) / elapsed : 0, etaMs: per !== null && per > 0 ? (f.total - acked) * per : null,
        });
      }
    }
    const streamMs = now() - streamStart;
    for (let fr = ch.take(); fr !== null; fr = ch.take()) {
      if (onStreamFrame(fr, f.total - 1, false) && box.bad) return box.bad;
    }

    // END: 0x049 → 0x04A, all zero = success.
    progress({ phase: 'finishing', block: f.total, total: f.total, elapsedMs: streamMs, blocksPerSecond: (f.total * 1000) / Math.max(1, streamMs), etaMs: null });
    const e0 = now();
    await send(ch, f.end(), 'CAN 0x049 end', sx);
    await waitFor(ch, t.resultMs, now, (fr) => {
      if (isRx(fr, BMS_CAN.ERASED)) {
        box.bad = fail('restarted', `The bootloader sent 0x046 ${hex(fr.data)} instead of a result: it restarted`);
        return true;
      }
      if (isRx(fr, BMS_CAN.RESULT)) box.result = fr.data;
      return box.result !== null;
    });
    if (box.bad) return box.bad;
    const result = box.result;
    if (result === null) return fail(ch.connected ? 'result-timeout' : 'link-lost', `No result (0x04A) within ${t.resultMs / 1000} s of the end frame`);
    const resultMs = now() - e0;
    log(`result 0x04A ${hex(result)} after ${resultMs} ms`);
    if (result.some((b) => b !== 0)) return fail('result-failed', `The battery reported failure: 0x04A = ${hex(result)} (all zeros means OK)`);
    return { ok: true, eraseMs, streamMs, resultMs };
  } catch (e) {
    if (e instanceof SendError) return fail(!ch.connected ? 'link-lost' : e.kind, e.message);
    throw e;
  }
}

export interface BmsFlashOptions {
  timing?: Partial<BmsTiming>;
  now?: () => number;
  log?: (m: string) => void;
  onProgress?: (p: BmsFlashProgress) => void;
}

/** The whole flash: up to `attempts` attempts, each from the start frame. */
export async function flashBms(ch: BmsChannel, f: BmsFlashFrames, o: BmsFlashOptions = {}): Promise<BmsFlashResult> {
  const t = { ...BMS_TIMING, ...o.timing };
  const now = o.now ?? (() => Date.now());
  const log = o.log ?? (() => undefined);
  const stats = new Stats();
  const t0 = now();
  let startSent = false;
  let made = 0;
  let last: Extract<Attempt, { ok: false }> | null = null;
  for (let attempt = 1; attempt <= t.attempts; attempt++) {
    if (!ch.connected) break;
    made = attempt;
    log(`attempt ${attempt} of ${t.attempts}: ${f.total} blocks`);
    const r = await attemptOnce(ch, f, t, now, log, (p) => o.onProgress?.({ ...p, attempt, attempts: t.attempts }), stats);
    if (r.ok) {
      log(`success on attempt ${attempt}: erase ${r.eraseMs} ms, stream ${(r.streamMs / 1000).toFixed(1)} s, result ${r.resultMs} ms`);
      return { ok: true, attempts: attempt, elapsedMs: now() - t0, streamMs: r.streamMs, eraseMs: r.eraseMs, resultMs: r.resultMs, ackTiming: stats.value };
    }
    startSent ||= r.startSent;
    last = r;
    if (r.kind === 'link-lost' || r.kind === 'refused' || !ch.connected) break;
    if (attempt < t.attempts) {
      log(`waiting ${t.retryPauseMs / 1000} s, then starting again from the start frame`);
      await sleep(t.retryPauseMs);
      ch.clear();
    }
  }
  const l = last ?? { kind: 'link-lost' as const, reason: 'Not connected', startSent: false, stoppedAt: 0 };
  return { ok: false, kind: l.kind, reason: l.reason, attempts: made, startSent: startSent || l.startSent, stoppedAt: l.stoppedAt, total: f.total, ackTiming: stats.value };
}

// ---- the checks shared by the screen (update/batteryGate.ts) and the run --------------------------

/**
 * Is [file] right for this battery? (PROTOCOL.md guardrail 2.) A battery that answers must report the
 * file's line in its version AND its hardware type. One that doesn't answer (its BMS is in the
 * bootloader) needs the line the mechanic took from the pack label, never a guess. Page 24 (what the
 * display read at power-on), when it names a line, must agree too.
 */
export function lineProblem(id: BmsIdentity | null, chosenLine: BmsLine | null, file: BmsLine, page24Line: string | null): string | null {
  if (page24Line && page24Line !== file) return `The display reports a ${page24Line} battery (page 24); this file is for the ${file} line`;
  if (id?.responding) {
    if (id.line !== file) return id.line ? `The battery runs the ${id.line} line; this file is for the ${file} line` : 'The battery didn\'t report its line (0x280)';
    if (id.hwType === null) return 'The battery didn\'t report its hardware type (0x281): read it again';
    if (id.hwType !== BMS_HW_TYPE[file]) return `The battery reports hardware type ${id.hwType}; the ${file} line is type ${BMS_HW_TYPE[file]}`;
    return null;
  }
  if (chosenLine === null) return 'The battery doesn\'t answer: choose its line (RC or SC) from the pack label';
  if (chosenLine !== file) return `You chose the ${chosenLine} line; this file is for the ${file} line`;
  return null;
}

/** File vs battery version: > 0 the file is newer; null if either is unreadable. */
export function bmsVersionCmp(file: string, battery: string | null): number | null {
  const p = (v: string) => v.split('.').map(Number);
  if (!battery || !/^\d\d\.\d\d\.\d\d$/.test(battery) || !/^\d\d\.\d\d\.\d\d$/.test(file)) return null;
  const a = p(file);
  const b = p(battery);
  return a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;
}

/** Why the version rule refuses, or null. Only within a line: another line's file is the line check's refusal. */
export function versionProblem(id: BmsIdentity | null, fileVersion: string, fileLine: BmsLine, sameVersionChosen: boolean): string | null {
  if (!id?.responding) return null; // recovery: the pack has no application to compare with
  if (id.line !== fileLine) return null;
  const c = bmsVersionCmp(fileVersion, id.version);
  if (c === null) return `Can't compare the battery's version (${id.version ?? id.versionRaw ?? 'none'}) with ${fileVersion}`;
  if (c < 0) return `${fileVersion} is older than the battery's ${id.version}. Older firmware is never flashed.`;
  if (c === 0 && !sameVersionChosen) return `The battery already runs ${id.version}. Tick "Re-flash the same version" to write it again as a repair.`;
  return null;
}

// ---- on a live bike -------------------------------------------------------------------------------

/** What runBatteryUpdate / readBattery need from the link (BikeLink). */
export interface TapLink {
  readonly connected: boolean;
  addTap(tap: LinkTap): () => void;
}

export interface BatteryReadResult {
  at: number;
  /** `10 50 status` for 50 01, or null if no ack came. */
  busAck: number | null;
  identity: BmsIdentity | null;
  /** Why the read didn't happen (not connected, bus access refused…). */
  problem: string | null;
  /** Page 5 / page 10 read just before (null = not reported). */
  autoOffS: number | null;
  batteryPct: number | null;
  log: string[];
}

function readFrames(): BmsReadFrames {
  return { wake: bmsWake, read: bmsRead };
}

/** A BmsChannel over the session: `52` through sendCommand (every frame checked against the whitelist). */
function sessionChannel(session: BikeSession, link: TapLink, queue: CanQueue, ctx: (block?: number) => BatteryFrameContext): BmsChannel {
  return {
    get connected() {
      return link.connected && !session.isEnded;
    },
    send: (frame, label, block) => session.sendCommand(frame, `battery: ${label}`, { battery: ctx(block) }),
    next: (ms) => queue.next(ms),
    take: () => queue.take(),
    putBack: (frames) => queue.putBack(frames),
    clear: () => queue.clear(),
  };
}

/**
 * A display command that is safe to repeat (`50 01`, `50 00`, `09`): retried when the write itself
 * failed while the link is up. Never after a timeout (the write may still be in flight).
 */
async function commandRetry(session: BikeSession, link: TapLink, frame: Uint8Array, label: string, ctx: BatteryFrameContext, t: BmsTiming): Promise<number | null> {
  for (let tries = 1; ; tries++) {
    try {
      return await session.sendCommand(frame, label, { battery: ctx });
    } catch (e) {
      const name = e instanceof Error ? e.name : '';
      if (!link.connected || session.isEnded || NO_RESEND.has(name) || tries > t.writeRetries) throw e;
      session.note(`[battery] ${label} failed (${errText(e)}): trying again (${tries} of ${t.writeRetries})`);
      await sleep(t.retryWriteMs);
    }
  }
}

/**
 * Bus access on, then off again: `50 01` (needs its ack), run [fn] with the mirrored frames, `50 00`
 * whatever happened. The live loop must already be paused.
 */
async function withBus<T>(
  session: BikeSession, link: TapLink, ctx: BatteryFrameContext, log: (m: string) => void, t: BmsTiming, fn: (queue: CanQueue) => Promise<T>,
): Promise<{ ack: number | null; value: T | null }> {
  const queue = new CanQueue();
  session.beginCanBus((f) => queue.push(f));
  let ack: number | null = null;
  let on = false;
  try {
    // Marked "on" before the write: if it fails half way, 50 00 is still sent.
    on = true;
    ack = await commandRetry(session, link, canBus(true), 'battery: bus access on', ctx, t);
    if (ack !== ACK_SUCCESS) {
      log(`bus access on (50 01): ${ack === null ? 'no ack' : `ack ${ACK_STATUS[ack] ?? ack}`}: not going on`);
      return { ack, value: null };
    }
    log('bus access on (50 01, ack 10 50 01)');
    return { ack, value: await fn(queue) };
  } finally {
    if (on && link.connected && !session.isEnded) {
      const off = await commandRetry(session, link, canBus(false), 'battery: bus access off', ctx, t).catch((e: unknown) => {
        log(`bus access off (50 00) failed: ${errText(e)}`);
        return null;
      });
      log(`bus access off (50 00)${off === ACK_SUCCESS ? ', ack 10 50 01' : off === null ? ', no ack' : `, ack ${off}`}`);
    }
    session.endCanBus();
  }
}

/** Pause the live loop with a one-shot request for [pages]. Null if the stream didn't stop; else the pages that didn't come. */
async function pauseLive(session: BikeSession, pages: number[], label: string): Promise<number[] | null> {
  session.setLivePaused(true);
  // A one-shot request replaces the live loop (the stock update trace pauses it the same way).
  const missing = await session.requestOnce(pages, label, TIMING.pagesMs);
  return (await session.awaitStreamQuiet()) ? missing : null;
}

async function resumeLive(session: BikeSession, link: TapLink): Promise<void> {
  if (link.connected && !session.isEnded) await session.sendCommand(liveLoop(), 'loop').catch(() => null);
  session.setLivePaused(false);
}

const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

/**
 * "Read the battery": bus access on, probe, identify, bus access off, live loop back. Sends no start
 * frame and nothing that changes the battery.
 */
export async function readBattery(session: BikeSession, link: TapLink, o: { timing?: Partial<BmsTiming>; now?: () => number } = {}): Promise<BatteryReadResult> {
  const now = o.now ?? (() => Date.now());
  const lines: string[] = [];
  const log = (m: string) => {
    lines.push(m);
    session.note(`[battery] ${m}`);
  };
  const base = { at: now(), busAck: null, identity: null, autoOffS: null, batteryPct: null, log: lines };
  if (!link.connected || session.isEnded) return { ...base, problem: 'Not connected to the bike' };
  return session.runExclusive(async () => {
    try {
      if ((await pauseLive(session, [5, 10], 'battery: read pages')) === null) {
        return { ...base, problem: 'The bike kept streaming live data, so the battery wasn\'t read' };
      }
      const st = session.state;
      const ctx: BatteryFrameContext = { image: null };
      const t = { ...BMS_TIMING, ...o.timing };
      const r = await withBus(session, link, ctx, log, t, (queue) =>
        identifyBms(sessionChannel(session, link, queue, () => ctx), readFrames(), { timing: t, now, log }),
      );
      const identity = r.value;
      const problem = r.ack !== ACK_SUCCESS
        ? `The display didn't turn bus access on (${r.ack === null ? 'no answer' : ACK_STATUS[r.ack] ?? `status ${r.ack}`})`
        : identity && !identity.echo ? 'The display didn\'t put the read request on the bus (no echo): the battery can\'t be reached this way' : null;
      return { ...base, busAck: r.ack, identity, problem, autoOffS: st.autoOffS, batteryPct: num(st.live.batt_pct) };
    } catch (e) {
      log(`read failed: ${errText(e)}`);
      return { ...base, problem: `Reading the battery failed (${errText(e)})` };
    } finally {
      await resumeLive(session, link);
    }
  });
}

export type BatteryStep = 'checking file' | 'preparing' | 'bus on' | 'identifying' | 'starting' | 'erasing' | 'sending' | 'finishing' | 'restarting' | 'verifying' | 'done';

export interface BatteryProgress {
  step: BatteryStep;
  text: string;
  /** 0x045 has gone out: the pack's application is gone until an attempt succeeds. */
  pastPointOfNoReturn: boolean;
  flash: BmsFlashProgress | null;
  startedAt: number;
}

export interface BatteryUpdateResult {
  ok: boolean;
  kind: BmsFailKind | null;
  message: string;
  /** "01.00.09 RC", or null when the battery didn't answer (recovery). */
  before: string | null;
  /** "01.00.12 RC" */
  target: string;
  line: BmsLine;
  /** 0x045 went out and no attempt succeeded: the pack waits in its bootloader (the bike shows E032). */
  packInBootloader: boolean;
  /** Success, and the bike restarted (the link dropped): the app reconnects, then verifies. */
  restarting: boolean;
  /** Success and the link stayed up: what the battery reports now. */
  after: BmsIdentity | null;
  autoOff: { before: number | null; changed: boolean; restored: boolean | null };
  attempts: number;
  ackTiming: BlockTiming | null;
  log: string;
  logName: string;
}

export interface BatteryUpdateDeps {
  session: BikeSession;
  link: TapLink;
  firmware: VerifiedBmsFirmware;
  /** What "Read the battery" found and the mechanic approved. */
  expected: BmsIdentity | null;
  /** Recovery (the battery doesn't answer): the line taken from the pack label. */
  chosenLine: BmsLine | null;
  /** "Re-flash the same version" was ticked. */
  sameVersion: boolean;
  deviceName: string;
  platformLabel: string;
  why?: string;
  onProgress: (p: BatteryProgress) => void;
  now?: () => number;
  timing?: Partial<BmsTiming>;
  stamp?: string;
}

/** One battery update. Never throws: every outcome is a BatteryUpdateResult with its log. */
export async function runBatteryUpdate(d: BatteryUpdateDeps): Promise<BatteryUpdateResult> {
  const t = { ...BMS_TIMING, ...d.timing };
  const now = d.now ?? (() => Date.now());
  const fw = d.firmware;
  const line = fw.info.line;
  const target = `${fw.info.version} ${line}`;
  const before = d.expected?.responding && d.expected.version ? `${d.expected.version} ${d.expected.line}` : null;
  const s0 = d.session.state;
  const startedAt = now();
  const logName = `battery_update_${d.deviceName}_${d.stamp ?? 'battery'}.txt`;
  const trace = new UpdateTrace(
    `Globe Haul Shop Tool battery update: ${fw.entry.fileName} (${target}, ${fw.blockCount} blocks), sha256 ${fw.sha256}, ${fw.source}; ` +
      `bike ${d.deviceName}, HMI ${s0.dis.sw_rev ?? '?'} (fw ${s0.dis.fw_rev ?? '?'}), battery ${before ?? 'not answering'}` +
      `${d.chosenLine ? ` (line chosen: ${d.chosenLine})` : ''}, page 24 ${s0.identity.batt_sw || 'not reported'}; ${d.platformLabel}; app ${BUILD_LABEL}`,
    now,
  );
  if (d.why) trace.state(`offered: ${d.why}`);
  let progress: BatteryProgress = { step: 'checking file', text: 'Checking the file (SHA-256)…', pastPointOfNoReturn: false, flash: null, startedAt };
  let lastEmit = 0;
  const emit = (patch: Partial<BatteryProgress>, force = true) => {
    progress = { ...progress, ...patch };
    if (force || now() - lastEmit >= 250) {
      lastEmit = now();
      d.onProgress(progress);
    }
  };
  const log = (m: string) => {
    trace.state(m);
    d.session.note(`[battery] ${m}`);
  };
  emit({});

  const autoOffState: BatteryUpdateResult['autoOff'] = { before: null, changed: false, restored: null };
  let flash: BmsFlashResult | null = null;
  let after: BmsIdentity | null = null;
  let restarting = false;
  let notStarted: string | null = null;

  const finish = (): BatteryUpdateResult => {
    const ok = flash?.ok === true;
    const kind: BmsFailKind | null = ok ? null : notStarted !== null ? 'not-started' : flash && !flash.ok ? flash.kind : 'not-started';
    const startSent = flash !== null && !flash.ok && flash.startSent;
    let message: string;
    if (ok) {
      const f = flash as Extract<BmsFlashResult, { ok: true }>;
      const stats = `${fw.blockCount.toLocaleString('en-US')} blocks in ${(f.streamMs / 1000 / 60).toFixed(1)} min${f.attempts > 1 ? `, attempt ${f.attempts}` : ''}`;
      message = restarting
        ? `The battery accepted the new firmware (${stats}). The bike then restarted by itself, as expected; the new version is checked on the next connection (below).`
        : after?.responding
          ? after.version === fw.info.version && after.line === line
            ? `The battery accepted the new firmware (${stats}) and now reports ${after.version} ${after.line}.`
            : `The battery accepted the new firmware (${stats}), but now reports ${describeIdentity(after)}. Check it before the bike is ridden.`
          : `The battery accepted the new firmware (${stats}), but hasn't answered since. Switch the bike off and on, then reconnect and read the battery.`;
    } else if (notStarted !== null) {
      message = `${notStarted}. Nothing was sent to the battery's bootloader; the battery is unchanged.`;
    } else {
      const f = flash as Extract<BmsFlashResult, { ok: false }>;
      message = `${f.reason}.`;
      if (startSent) {
        message += ` Stopped at block ${f.stoppedAt.toLocaleString('en-US')} of ${f.total.toLocaleString('en-US')} after ${f.attempts} attempt(s).` +
          ' The battery\'s firmware was erased when the update started: the pack waits in its bootloader, the display shows E032 and the motor has no power until an update completes.' +
          (f.kind === 'link-lost'
            ? ' Reconnect, read the battery (it won\'t answer), choose its line from the pack label, and run the update again from the start.'
            : ' It is safe to run the update again from the start: read the battery (it won\'t answer), choose its line from the pack label, and start.');
      } else {
        message += ' The start frame was never sent; the battery is unchanged.';
      }
    }
    const summary = [
      `Result: ${ok ? 'SUCCESS' : `FAILED (${kind})`}${notStarted ? `: ${notStarted}` : flash && !flash.ok ? `: ${flash.reason}` : ''}`,
      `Battery before: ${before ?? 'not answering'}${d.chosenLine ? ` (line chosen: ${d.chosenLine})` : ''}; target ${target}; after: ${restarting ? 'the bike restarted (verified on reconnect)' : describeIdentity(after)}`,
      `Auto-off: ${autoOffState.before === null ? 'not read' : `${autoOffState.before} s`}${autoOffState.changed ? `, set to 0 for the update, restored: ${autoOffState.restored === null ? 'after the reconnect' : autoOffState.restored ? 'yes' : 'NO'}` : ', unchanged'}`,
    ];
    if (flash) {
      summary.push(`Attempts: ${flash.attempts}; 0x045 sent: ${ok || startSent ? 'yes' : 'no'}`);
      if (flash.ok) summary.push(`Erase reply ${flash.eraseMs} ms; stream ${(flash.streamMs / 1000).toFixed(1)} s (${((fw.blockCount * 1000) / Math.max(1, flash.streamMs)).toFixed(1)} blocks/s); result ${flash.resultMs} ms`);
      const at = flash.ackTiming;
      if (at) summary.push(`Block round trip (52 write → 0x048): min ${at.minMs.toFixed(0)} ms, avg ${at.avgMs.toFixed(1)} ms, max ${at.maxMs.toFixed(0)} ms over ${at.count}`);
    }
    for (const s of summary) trace.addSummary(s);
    trace.state(`finished: ${ok ? 'OK' : `FAILED (${kind})`}`);
    emit({ step: 'done', text: ok ? 'Done' : 'Stopped' });
    return {
      ok, kind, message, before, target, line, packInBootloader: startSent, restarting, after, autoOff: autoOffState,
      attempts: flash?.attempts ?? 0, ackTiming: flash?.ackTiming ?? null, log: trace.text(), logName,
    };
  };

  if (!(await recheckBmsFirmware(fw))) {
    notStarted = 'The file no longer matches the allowlist (SHA-256 re-check failed). Load it again';
    return finish();
  }
  trace.state(`SHA-256 re-checked: ${fw.sha256}`);
  if (!d.link.connected || d.session.isEnded) {
    notStarted = 'Not connected to the bike';
    return finish();
  }

  const untap = d.link.addTap((e) => trace.frame(e.dir, e.char, e.bytes, e.dir === 'tx' ? e.label : undefined));
  const session = d.session;
  try {
    await session.runExclusive(async () => {
      const ctxBase = (): BatteryFrameContext => ({ image: fw, autoOffRestore: autoOffState.before });
      const restoreAutoOff = async () => {
        if (!autoOffState.changed || autoOffState.restored !== null || autoOffState.before === null || !d.link.connected || session.isEnded) return;
        const v = autoOffState.before;
        const st = await commandRetry(session, d.link, autoOff(v), 'battery: restore auto-off', ctxBase(), t).catch(() => null);
        await session.requestOnce([5], 'battery: auto-off read-back').catch(() => [5]);
        autoOffState.restored = st === ACK_SUCCESS && session.state.autoOffS === v;
        log(`auto-off restored to ${v} s: ${autoOffState.restored ? 'yes' : `NO (page 5 reads ${session.state.autoOffS ?? 'nothing'})`}`);
      };
      let keepPaused = false;
      try {
        // PREP: page 5 (auto-off), 10 (battery %), 40 (errors), which also pauses the live loop.
        emit({ step: 'preparing', text: 'Preparing: pausing live data, checking the auto-off timer…' });
        const missing = await pauseLive(session, [5, 10, 40], 'battery: prep pages');
        if (missing === null) {
          notStarted = 'The bike kept streaming live data, so the update didn\'t start';
          return;
        }
        const st = session.state;
        if (missing.includes(5)) {
          notStarted = 'The auto-off timer (page 5) didn\'t come back, so the bike can\'t be kept awake';
          return;
        }
        autoOffState.before = st.autoOffS;
        const pct = num(st.live.batt_pct);
        log(`prep: auto-off ${st.autoOffS ?? 'not read'} s, battery ${pct ?? '?'} %, error bits ${st.errorBits === null ? '?' : `0x${st.errorBits.toString(16).padStart(8, '0')}`}`);
        if (st.autoOffS === null) {
          notStarted = 'The auto-off timer (page 5) couldn\'t be read, so the bike can\'t be kept awake';
          return;
        }
        if (d.expected?.responding && pct !== null && pct < MIN_BATTERY_PCT) {
          notStarted = `The bike battery is at ${pct} % (at least ${MIN_BATTERY_PCT} % is needed)`;
          return;
        }
        if (st.autoOffS !== 0) {
          const a = await commandRetry(session, d.link, autoOff(0), 'battery: auto-off off', ctxBase(), t);
          autoOffState.changed = true;
          await session.requestOnce([5], 'battery: auto-off read-back');
          if (a !== ACK_SUCCESS || session.state.autoOffS !== 0) {
            notStarted = `The auto-off timer couldn't be switched off (it reads ${session.state.autoOffS ?? 'nothing'} s), so the bike could switch itself off mid-update`;
            return;
          }
          log(`auto-off set to 0 for the update (was ${autoOffState.before} s; restored afterwards)`);
        }

        // BUS_ON, IDENTIFY, START … END, then 50 00.
        emit({ step: 'bus on', text: 'Turning bus access on…' });
        const bus = await withBus(session, d.link, ctxBase(), log, t, async (queue) => {
          const ch = sessionChannel(session, d.link, queue, (block) => ({ ...ctxBase(), block }));
          emit({ step: 'identifying', text: 'Reading the battery…' });
          const id = await identifyBms(ch, readFrames(), { timing: t, now, log });
          if (!id.echo) {
            notStarted = 'The display didn\'t put the read request on the bus (no echo), so the battery can\'t be reached';
            return;
          }
          const exp = d.expected;
          if (exp?.responding) {
            if (!id.responding || id.version !== exp.version || id.line !== exp.line || id.hwType !== exp.hwType) {
              notStarted = `The battery now reports ${describeIdentity(id)}, not what was read before (${describeIdentity(exp)}). Read the battery again`;
              return;
            }
          } else if (id.responding) {
            notStarted = `The battery answers now (${describeIdentity(id)}). Read the battery again so its version and line are checked`;
            return;
          }
          const lp = lineProblem(id, d.chosenLine, line, null);
          const vp = versionProblem(id, fw.info.version, line, d.sameVersion);
          if (lp || vp) {
            notStarted = (lp ?? vp)!;
            return;
          }
          const frames: BmsFlashFrames = {
            total: fw.blockCount,
            wake: bmsWake,
            read: bmsRead,
            start: bmsStart,
            end: bmsEnd,
            block: (i) => bmsBlock(fw, i),
            blockData: (i) => readBmsBlock(fw, i),
          };
          log(`flashing ${fw.entry.fileName}: ${target}, ${fw.blockCount} blocks, stop-and-wait`);
          flash = await flashBms(ch, frames, {
            timing: t,
            now,
            log,
            onProgress: (p) => {
              emit({
                pastPointOfNoReturn: progress.pastPointOfNoReturn || p.phase !== 'starting',
                step: p.phase,
                text: p.phase === 'starting' ? `Starting${p.attempt > 1 ? ` (attempt ${p.attempt} of ${p.attempts})` : ''}…`
                  : p.phase === 'erasing' ? 'The battery is entering its bootloader…'
                    : p.phase === 'sending' ? `Sending firmware${p.attempt > 1 ? ` (attempt ${p.attempt} of ${p.attempts})` : ''}…`
                      : 'All blocks sent. Waiting for the battery to check the image…',
                flash: p,
              }, p.phase !== 'sending');
            },
          });
        });
        if (bus.ack !== ACK_SUCCESS && notStarted === null && flash === null) {
          notStarted = `The display didn't turn bus access on (${bus.ack === null ? 'no answer' : ACK_STATUS[bus.ack] ?? `status ${bus.ack}`})`;
        }
        const f = flash as BmsFlashResult | null;
        if (f?.ok) {
          // RESTART: the BMS restart cuts system power about 13 s after 0x04A; the link drops.
          emit({ step: 'restarting', text: 'Done. The bike restarts by itself in about 15 s: wait…' });
          log(`waiting up to ${t.restartDropMs / 1000} s for the bike to restart (the link drops)`);
          const deadline = now() + t.restartDropMs;
          while (now() < deadline && d.link.connected && !session.isEnded) await sleep(250);
          if (!d.link.connected || session.isEnded) {
            restarting = true;
            keepPaused = true;
            log('the link dropped: the bike is restarting');
            return;
          }
          // The link stayed up: verify on this connection.
          emit({ step: 'verifying', text: 'Checking the new version…' });
          log('the link stayed up: checking the battery on this connection');
          await restoreAutoOff();
          const v = await withBus(session, d.link, { image: null }, log, t, (queue) =>
            identifyBms(sessionChannel(session, d.link, queue, () => ({ image: null })), readFrames(), { timing: t, now, log }),
          );
          after = v.value;
        } else if (f && !f.ok && f.startSent && f.kind !== 'link-lost') {
          log('the pack waits in its bootloader (E032) and can be flashed again');
        }
      } finally {
        if (!restarting) await restoreAutoOff().catch(() => undefined);
        if (keepPaused || !d.link.connected || session.isEnded) {
          session.setLivePaused(true);
        } else {
          await resumeLive(session, d.link);
        }
      }
    });
  } catch (e) {
    log(`exception: ${errText(e)}`);
    if (flash === null) notStarted = `The update stopped on an error (${errText(e)})`;
  } finally {
    untap();
  }
  return finish();
}

/**
 * After a successful update the bike restarts and the app reconnects (app/shop.ts). On that new
 * connection: restore the auto-off timer if the update changed it, then compare page 24 (which the
 * display reads from the BMS at power-on, nibble-swapped) with the target.
 */
export async function afterBatteryRestart(session: BikeSession, link: TapLink, autoOffBefore: number | null): Promise<{ restored: boolean | null }> {
  if (autoOffBefore === null || autoOffBefore === 0) return { restored: null };
  if (!link.connected || session.isEnded) return { restored: false };
  return session.runExclusive(async () => {
    try {
      session.setLivePaused(true);
      const ctx: BatteryFrameContext = { image: null, autoOffRestore: autoOffBefore };
      const st = await commandRetry(session, link, autoOff(autoOffBefore), 'battery: restore auto-off', ctx, BMS_TIMING);
      await session.requestOnce([5], 'battery: auto-off read-back');
      const restored = st === ACK_SUCCESS && session.state.autoOffS === autoOffBefore;
      session.note(`[battery] auto-off restored to ${autoOffBefore} s after the restart: ${restored ? 'yes' : 'NO'}`);
      return { restored };
    } finally {
      await resumeLive(session, link);
    }
  });
}

/** Which official image fits [line]. */
export function imageForLine(line: string | null): (typeof BMS_ALLOWLIST)[number] | null {
  return BMS_ALLOWLIST.find((e) => e.line === line) ?? null;
}

function errText(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}
