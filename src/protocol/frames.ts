/**
 * THE send whitelist (docs/SPEC.md "Hard safety rules"). This module can build only these frames:
 *
 *   3C 01                     MTU page mode                           …0010
 *   3D <pages…> (19 B, 0-pad) one-shot page request: 1-28, 40, 51-56  …0010
 *   3E 28 07 08 09 0A (19 B)  the live loop                           …0010
 *   29 <1|2|3> 00 00          dump the event / ride / period log      …0010
 *   46 00 <N u16> v0 v1 v2    controller update start (type 0 ONLY)   …0010  verified image only
 *   47 <seq u16> <len> <8 B>  controller update block                 …0011  verified image only
 *
 * and, ONLY inside the battery update (update/battery.ts sets FrameContext.battery; docs/DECISIONS.md
 * 2026-11-20, PROTOCOL.md "Battery (BMS) firmware update over BLE" section 7, the shared whitelist):
 *
 *   50 01 / 50 00             bus access (CAN mirroring) on / off     …0010
 *   09 <u32 LE>               auto-off timer: 0, or the value read from page 5 before the update
 *   52 <id u32 LE> 08 <8 B>   one CAN frame, ONLY these:              …0010
 *       0x101 55 AA 55 AA 00 00 00 00      wake
 *       0x10F / 0x280 / 0x281  00 x8        reads (0x10F only during a flash)
 *       0x045 00 00 00 00 45 41 47 4F      start ("....EAGO"), only during a flash
 *       0x047 <8 bytes>                    the block the updater is on, of a verified battery image
 *       0x049 00 x8                        end, only during a flash
 *
 * and checkFrame() refuses anything else, on any characteristic. Every write in the app goes through
 * checkFrame (ble/link.ts). Page requests are built exactly like page_req() in globe_capture.py.
 * Nordic Secure DFU writes are not frames of this protocol; they are gated in update/hmiDfu.ts.
 */
import { bytesEqual, hexSpaced, u16, u32 } from './bytes';
import {
  fwVersionBytes,
  isVerifiedFirmware,
  readFirmware,
  FW_BLOCK_SIZE,
  type VerifiedFirmware,
} from '../analysis/firmware';
import { isVerifiedBms, readBmsBlock, type VerifiedBmsFirmware } from '../analysis/bmsFirmware';

export const OP_MTU_PAGE_MODE = 0x3c; // 60
export const OP_ONCE_PAGE = 0x3d; // 61
export const OP_LOOP_PAGE = 0x3e; // 62
export const OP_DUMP_LOG = 0x29; // 41
export const OP_FW_START = 0x46; // 70
export const OP_FW_BLOCK = 0x47; // 71
export const FW_TYPE_CONTROLLER = 0x00;
export const OP_AUTO_OFF = 0x09;
export const OP_CAN_BUS = 0x50; // 80
export const OP_CAN_SEND = 0x52; // 82
/** `52 <id u32 LE> <len> <8 data>`. */
export const CAN_SEND_FRAME_SIZE = 14;
/** The stock app refuses an auto-off of 1-59 s (PROTOCOL.md `09`). */
export const AUTO_OFF_MIN_S = 60;

/** The battery-update CAN IDs (PROTOCOL.md "Battery (BMS) firmware update over BLE"). */
export const BMS_CAN = Object.freeze({
  PROBE_10F: 0x10f,
  WAKE: 0x101,
  VERSION: 0x280,
  HW_TYPE: 0x281,
  START: 0x045,
  ERASED: 0x046,
  DATA: 0x047,
  ACK: 0x048,
  END: 0x049,
  RESULT: 0x04a,
});
const BMS_WAKE_DATA = [0x55, 0xaa, 0x55, 0xaa, 0, 0, 0, 0] as const;
/** "....EAGO": the dealer tool's start frame (not the HMI relay's "0" + version bytes). */
const BMS_START_DATA = [0, 0, 0, 0, 0x45, 0x41, 0x47, 0x4f] as const;
export type BmsReadId = typeof BMS_CAN.PROBE_10F | typeof BMS_CAN.VERSION | typeof BMS_CAN.HW_TYPE;

/** Identity strings, once (PAGES_IDENTITY). */
export const PAGES_IDENTITY: readonly number[] = Object.freeze(range(11, 28));
/** Config + errors (PAGES_CONFIG), plus page 56 production info like the Android app. */
export const PAGES_CONFIG: readonly number[] = Object.freeze([54, 55, 56]);
/** What HMI 5.19 actually streams (PAGES_LOOP). Not 51/52/53. */
export const PAGES_LOOP: readonly number[] = Object.freeze([40, 7, 8, 9, 10]);
/** Settings + error bitmask; a one-shot request for it also pauses the live loop (stock update trace). */
export const ERROR_PAGE = 55;
export const CTRL_SW_PAGE = 19;
/** Every page the HMI 5.19 page builder has a handler for (PROTOCOL.md): the only 3D targets. */
export const ONCE_PAGES_ALLOWED: ReadonlySet<number> = new Set([...range(1, 28), 40, ...range(51, 56)]);
export const PAGE_REQ_LENGTH = 19;
export const MAX_PAGES_PER_REQUEST = 18;

export const LOG_TYPES = { event: 1, ride: 2, period: 3 } as const;
export type LogType = (typeof LOG_TYPES)[keyof typeof LOG_TYPES];
export const FW_BLOCK_FRAME_SIZE = 12;
export const FW_START_FRAME_SIZE = 7;

function range(a: number, b: number): number[] {
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}

/** page_req(op, pages): 19 bytes, op then up to 18 page ids, zero padded. Private: use the builders. */
function pageReq(op: number, pages: readonly number[]): Uint8Array {
  const b = new Uint8Array(PAGE_REQ_LENGTH);
  b[0] = op;
  pages.slice(0, MAX_PAGES_PER_REQUEST).forEach((p, i) => (b[i + 1] = p));
  return b;
}

export class ForbiddenFrameError extends Error {
  constructor(readonly target: FrameTarget, readonly frame: Uint8Array, reason: string) {
    super(`Refused to send ${target === 'command' ? '…0010' : '…0011'} [${hexSpaced(frame)}]: ${reason}`);
    this.name = 'ForbiddenFrameError';
  }
}

/** `3C 01`: pack several 20-byte pages per notification. */
export function mtuPageMode(): Uint8Array {
  return Uint8Array.of(OP_MTU_PAGE_MODE, 1);
}

/** `3D p1 p2 …`, 19 bytes zero padded. Only pages the HMI builds; 1..18 of them. */
export function oncePages(pages: readonly number[]): Uint8Array {
  if (pages.length < 1 || pages.length > MAX_PAGES_PER_REQUEST) {
    throw new Error(`A one-shot request carries 1-${MAX_PAGES_PER_REQUEST} pages, not ${pages.length}`);
  }
  for (const p of pages) {
    if (!ONCE_PAGES_ALLOWED.has(p)) throw new Error(`Page ${p} is not a page this app may request`);
  }
  return pageReq(OP_ONCE_PAGE, pages);
}

/** `3E 28 07 08 09 0A` + zero padding: the only live loop there is. */
export function liveLoop(): Uint8Array {
  return pageReq(OP_LOOP_PAGE, PAGES_LOOP);
}

/** `29 <type> 00 00`: READ a stored log (1 event, 2 ride history, 3 period). Never the erase (2A). */
export function dumpLog(type: LogType): Uint8Array {
  if (type !== 1 && type !== 2 && type !== 3) throw new Error('Log type must be 1, 2 or 3');
  return Uint8Array.of(OP_DUMP_LOG, type, 0, 0);
}

function requireController(img: VerifiedFirmware): void {
  if (!isVerifiedFirmware(img)) throw new Error('Firmware frames need a verified (allowlisted) image');
  if (img.entry.component !== 'controller') throw new Error('Only the controller image is flashed with 46/47');
}

/**
 * `46 00 <N_lo> <N_hi> <v0> <v1> <v2>`. Type is always 0x00 (controller): there is no parameter for it,
 * so a battery (type 0x01) frame can't be built. M1B0306s0.bin -> 46 00 00 28 31 42 73.
 */
export function fwStart(img: VerifiedFirmware): Uint8Array {
  requireController(img);
  const n = img.blockCount;
  const [v0, v1, v2] = fwVersionBytes(img.entry.fileName);
  return Uint8Array.of(OP_FW_START, FW_TYPE_CONTROLLER, n & 0xff, (n >>> 8) & 0xff, v0, v1, v2);
}

/** `47 <seq_lo> <seq_hi> <len> <8 data bytes>`: block [seq] (1-based) of the image, as stored, zero padded. */
export function fwBlock(img: VerifiedFirmware, seq: number): Uint8Array {
  requireController(img);
  if (!Number.isInteger(seq) || seq < 1 || seq > img.blockCount) throw new Error(`Block ${seq} is outside 1..${img.blockCount}`);
  const from = (seq - 1) * FW_BLOCK_SIZE;
  const data = readFirmware(img, from, Math.min(from + FW_BLOCK_SIZE, img.size));
  const frame = new Uint8Array(FW_BLOCK_FRAME_SIZE);
  frame[0] = OP_FW_BLOCK;
  frame[1] = seq & 0xff;
  frame[2] = (seq >>> 8) & 0xff;
  frame[3] = data.length;
  frame.set(data, 4);
  return frame;
}

// ---- battery update (update/battery.ts only) -----------------------------------------------------

/** `50 01` / `50 00`: bus access (CAN mirroring) on / off. */
export function canBus(on: boolean): Uint8Array {
  return Uint8Array.of(OP_CAN_BUS, on ? 1 : 0);
}

/** `52 <id u32 LE> 08 <8 data>`. Private: only the battery-update builders below use it. */
function canSend(id: number, data: ArrayLike<number>): Uint8Array {
  const f = new Uint8Array(CAN_SEND_FRAME_SIZE);
  f[0] = OP_CAN_SEND;
  f[1] = id & 0xff;
  f[2] = (id >>> 8) & 0xff;
  f[3] = (id >>> 16) & 0xff;
  f[4] = (id >>> 24) & 0xff;
  f[5] = 8;
  f.set(Array.from(data).slice(0, 8), 6);
  return f;
}

/** CAN 0x101 `55 AA 55 AA 00 00 00 00` (the dealer tool's "MCWakeup"). */
export function bmsWake(): Uint8Array {
  return canSend(BMS_CAN.WAKE, BMS_WAKE_DATA);
}

/** CAN 0x10F / 0x280 (version) / 0x281 (hardware type), 8 zero bytes. */
export function bmsRead(id: BmsReadId): Uint8Array {
  if (id !== BMS_CAN.PROBE_10F && id !== BMS_CAN.VERSION && id !== BMS_CAN.HW_TYPE) throw new Error(`0x${(id as number).toString(16)} is not a battery read`);
  return canSend(id, [0, 0, 0, 0, 0, 0, 0, 0]);
}

/** CAN 0x045 `00 00 00 00 45 41 47 4F`: the BMS bootloader start. */
export function bmsStart(): Uint8Array {
  return canSend(BMS_CAN.START, BMS_START_DATA);
}

/** CAN 0x049, 8 zero bytes: the end of the image. */
export function bmsEnd(): Uint8Array {
  return canSend(BMS_CAN.END, [0, 0, 0, 0, 0, 0, 0, 0]);
}

/** CAN 0x047 with block [index] (0-based) of a verified battery image, exactly as stored. */
export function bmsBlock(img: VerifiedBmsFirmware, index: number): Uint8Array {
  if (!isVerifiedBms(img)) throw new Error('Battery blocks need a verified (allowlisted) battery image');
  return canSend(BMS_CAN.DATA, readBmsBlock(img, index));
}

/** `09 <u32 LE seconds>`: the auto-off timer. 0 = never; otherwise at least 60 s (the stock rule). */
export function autoOff(seconds: number): Uint8Array {
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 0xffffffff || (seconds > 0 && seconds < AUTO_OFF_MIN_S)) {
    throw new Error(`Auto-off must be 0 or ${AUTO_OFF_MIN_S}+ seconds, not ${seconds}`);
  }
  return Uint8Array.of(OP_AUTO_OFF, seconds & 0xff, (seconds >>> 8) & 0xff, (seconds >>> 16) & 0xff, (seconds >>> 24) & 0xff);
}

/** Where a frame is written: …0010 (commands, with response) or …0011 (controller blocks). */
export type FrameTarget = 'command' | 'block';

/** Set ONLY by update/battery.ts. Without it, 50 / 52 / 09 are refused. */
export interface BatteryFrameContext {
  /** The image being flashed; null while the battery is only being read. 0x045 / 0x047 / 0x049 need it. */
  image: VerifiedBmsFirmware | null;
  /** 0-based index of the one 0x047 block allowed now (the next block in file order). */
  block?: number;
  /** The auto-off value read from page 5 before the update: the only nonzero `09` allowed. */
  autoOffRestore?: number | null;
}

/**
 * Set ONLY by update/controller.ts (firmware) or update/battery.ts (battery) while that update runs.
 * Without it, 46/47 and 50/52/09 are refused even for a verified image.
 */
export interface FrameContext {
  firmware?: VerifiedFirmware;
  battery?: BatteryFrameContext;
}

/** Opcodes that must never be sent, with why (docs/SPEC.md). Used for clear refusal messages. */
export const NEVER_SEND: Readonly<Record<number, string>> = {
  0x01: 'assist level (01): this shop tool never changes assist',
  0x02: 'wheel circumference (02)',
  0x04: 'set PIN (04): there is no lock control in this app',
  0x05: 'unlock with PIN (05): there is no unlock in this app',
  0x06: 'clear PIN (06)',
  0x07: 'headlight (07)',
  0x08: 'power off (08)',
  0x0b: 'sensitivity (0B): unsupported on this bike',
  0x0c: 'suspend (0C): a power-off on this bike',
  0x1e: 'raw CAN bypass (1E)',
  0x20: 'raw CAN frame (20): the battery update uses the proven 52 path only',
  0x2a: 'LOG ERASE (2A): destructive',
  0x2b: 'config bundle (2B): includes the speed-limit and capacity fields',
  0x2c: 'units (2C)',
};

/** null = the frame may be sent to [target]; otherwise why not. Never throws. */
export function checkFrame(target: FrameTarget, frame: Uint8Array, ctx: FrameContext = {}): string | null {
  if (!(frame instanceof Uint8Array) || frame.length === 0) return 'empty frame';
  const op = frame[0]!;
  if (target === 'block') {
    if (op !== OP_FW_BLOCK) return 'only 0x47 controller firmware blocks are ever written to …0011';
    return checkBlock(frame, ctx);
  }
  switch (op) {
    case OP_MTU_PAGE_MODE:
      return bytesEqual(frame, mtuPageMode()) ? null : 'the only 3C frame is 3C 01';
    case OP_ONCE_PAGE:
      return checkOnce(frame);
    case OP_LOOP_PAGE:
      return bytesEqual(frame, liveLoop()) ? null : 'the only 3E frame is the live loop 3E 28 07 08 09 0A (19 bytes)';
    case OP_DUMP_LOG:
      return frame.length === 4 && frame[1]! >= 1 && frame[1]! <= 3 && frame[2] === 0 && frame[3] === 0
        ? null
        : 'only the stored-log reads 29 01|02|03 00 00 are allowed';
    case OP_FW_START: {
      if (frame.length >= 2 && frame[1] !== FW_TYPE_CONTROLLER) {
        return `firmware type 0x${frame[1]!.toString(16).padStart(2, '0')} refused: only the controller (type 0x00); the battery is updated with raw CAN frames (52), never the display's relay`;
      }
      const img = ctx.firmware;
      if (!img) return '46 is only sent by the controller update, with a verified image';
      if (!isVerifiedFirmware(img) || img.entry.component !== 'controller') return '46 needs a verified controller image';
      return bytesEqual(frame, fwStart(img)) ? null : "46 frame doesn't match the verified image's start frame";
    }
    case OP_FW_BLOCK:
      return 'firmware blocks (47) go to …0011, never …0010';
    case OP_CAN_BUS:
      if (!ctx.battery) return '50 (bus access) is only sent by the battery update';
      return bytesEqual(frame, canBus(true)) || bytesEqual(frame, canBus(false)) ? null : 'the only 50 frames are 50 01 and 50 00';
    case OP_CAN_SEND:
      return checkCanSend(frame, ctx.battery);
    case OP_AUTO_OFF:
      return checkAutoOff(frame, ctx.battery);
    default:
      return NEVER_SEND[op] !== undefined
        ? `never sent: ${NEVER_SEND[op]}`
        : `opcode 0x${op.toString(16).padStart(2, '0')} is not on this app's whitelist`;
  }
}

function checkOnce(frame: Uint8Array): string | null {
  if (frame.length !== PAGE_REQ_LENGTH) return `3D frames are exactly ${PAGE_REQ_LENGTH} bytes (page_req)`;
  const pages: number[] = [];
  let i = 1;
  for (; i < frame.length && frame[i] !== 0; i++) pages.push(frame[i]!);
  for (; i < frame.length; i++) if (frame[i] !== 0) return '3D frames are zero padded after the page list';
  if (pages.length === 0) return '3D frame with no pages';
  const bad = pages.filter((p) => !ONCE_PAGES_ALLOWED.has(p));
  return bad.length ? `3D for page(s) ${bad.join(', ')}: not pages the HMI builds` : null;
}

function checkBlock(frame: Uint8Array, ctx: FrameContext): string | null {
  const img = ctx.firmware;
  if (!img) return '47 is only sent by the controller update, with a verified image';
  if (!isVerifiedFirmware(img) || img.entry.component !== 'controller') return '47 needs a verified controller image';
  if (frame.length !== FW_BLOCK_FRAME_SIZE) return `47 frames are exactly ${FW_BLOCK_FRAME_SIZE} bytes`;
  const seq = u16(frame, 1)!;
  if (seq < 1 || seq > img.blockCount) return `block ${seq} is outside 1..${img.blockCount}`;
  return bytesEqual(frame, fwBlock(img, seq)) ? null : `block ${seq} doesn't match the verified image`;
}

function checkCanSend(frame: Uint8Array, b: BatteryFrameContext | undefined): string | null {
  if (!b) return '52 (CAN frame) is only sent by the battery update';
  if (frame.length !== CAN_SEND_FRAME_SIZE || frame[5] !== 8) return `52 frames are exactly ${CAN_SEND_FRAME_SIZE} bytes with length 8`;
  const id = u32(frame, 1)!;
  const name = `CAN 0x${id.toString(16).padStart(3, '0')}`;
  const flashing = b.image !== null && isVerifiedBms(b.image);
  if (b.image !== null && !flashing) return '52 needs a verified battery image';
  switch (id) {
    case BMS_CAN.WAKE:
      return bytesEqual(frame, bmsWake()) ? null : `${name}: only 55 AA 55 AA 00 00 00 00`;
    case BMS_CAN.VERSION:
    case BMS_CAN.HW_TYPE:
      return bytesEqual(frame, bmsRead(id)) ? null : `${name}: only 8 zero bytes`;
    case BMS_CAN.PROBE_10F:
      if (!flashing) return `${name} is only sent during a battery flash`;
      return bytesEqual(frame, bmsRead(id)) ? null : `${name}: only 8 zero bytes`;
    case BMS_CAN.START:
      if (!flashing) return `${name} (start) is only sent during a battery flash, with a verified image`;
      return bytesEqual(frame, bmsStart()) ? null : `${name}: only 00 00 00 00 45 41 47 4F`;
    case BMS_CAN.END:
      if (!flashing) return `${name} (end) is only sent during a battery flash, with a verified image`;
      return bytesEqual(frame, bmsEnd()) ? null : `${name}: only 8 zero bytes`;
    case BMS_CAN.DATA: {
      if (!flashing) return `${name} (data) is only sent during a battery flash, with a verified image`;
      const i = b.block;
      if (i === undefined || !Number.isInteger(i) || i < 0 || i >= b.image!.blockCount) return `${name}: no block is due now`;
      return bytesEqual(frame, bmsBlock(b.image!, i)) ? null : `${name}: isn't block ${i} of the verified image`;
    }
    default:
      return `${name} is not a battery-update frame`;
  }
}

function checkAutoOff(frame: Uint8Array, b: BatteryFrameContext | undefined): string | null {
  if (!b) return '09 (auto-off) is only sent by the battery update';
  if (frame.length !== 5) return '09 frames are exactly 5 bytes';
  const v = u32(frame, 1)!;
  if (v === 0) return null;
  if (v >= AUTO_OFF_MIN_S && b.autoOffRestore != null && v === b.autoOffRestore) return null;
  return `09 may only set 0 or restore the value read before the update${b.autoOffRestore ? ` (${b.autoOffRestore} s)` : ''}`;
}

/** checkFrame, throwing ForbiddenFrameError. */
export function assertFrame(target: FrameTarget, frame: Uint8Array, ctx: FrameContext = {}): void {
  const why = checkFrame(target, frame, ctx);
  if (why !== null) throw new ForbiddenFrameError(target, frame, why);
}
