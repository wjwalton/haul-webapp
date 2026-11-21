/**
 * Battery (BMS) firmware files: validation and the verified-image wrapper (docs/DECISIONS.md
 * 2026-11-20). The record parser is a port of globe-bms-flasher's firmware.py (PROTOCOL.md "Battery
 * (BMS) firmware images", record format CONFIRMED on both official files):
 *
 *   N records of 139 bytes: 5A | 89 55 55 57 | address u32 LE | 128 payload bytes | XOR(bytes 1..136) | 69
 *   addresses 0x0000, 0x0080, … with no gaps; then zero padding and an 8-byte ASCII trailer "010012RC";
 *   the whole file is a multiple of 8. Record 0 is a header: +0x00 project name, +0x14 payload size u32,
 *   +0x18 BCD build date dd mm yy 20, +0x20 a check value, +0x30 description. The header names the CPU,
 *   the trailer names the line, and they must agree.
 *
 * A file becomes flashable only as a VerifiedBmsFirmware: its SHA-256 is on BMS_ALLOWLIST, its records all
 * check, and the version and line read from the file match that entry. Its bytes are a private copy;
 * protocol/frames.ts builds 0x047 CAN frames only from it, 8 bytes at a time, exactly as stored.
 */
import { BMS_ALLOWLIST, MAX_FIRMWARE_BYTES, sha256Hex, type AllowedBmsFirmware, type BmsLine } from './firmware';

export const BMS_RECORD_LEN = 139;
export const BMS_RECORD_PAYLOAD = 128;
const RECORD_MAGIC = [0x5a, 0x89, 0x55, 0x55, 0x57] as const;
const RECORD_END = 0x69;
export const BMS_BLOCK_SIZE = 8;

/** 0x281 reply byte 2 (PROTOCOL.md, CONFIRMED 2026-11-20): 1 = SC line, 2 = RC line. */
export const BMS_HW_TYPE: Readonly<Record<BmsLine, number>> = Object.freeze({ SC: 1, RC: 2 });

export function lineOfHwType(t: number | null | undefined): BmsLine | null {
  return t === 1 ? 'SC' : t === 2 ? 'RC' : null;
}

/** What the file itself says. */
export interface BmsImageInfo {
  line: BmsLine;
  /** "01.00.12" */
  version: string;
  /** The trailer, e.g. "010012RC". */
  versionAscii: string;
  project: string;
  description: string;
  payloadSize: number;
  /** "2022-07-12" */
  buildDate: string;
  /** Header +0x20 (the algorithm isn't identified; the BMS checks it, we only show it). */
  imageCheck: number;
  records: number;
  /** 8-byte CAN blocks: the whole file, header and trailer included. */
  blocks: number;
  warnings: string[];
}

export type BmsParse = { ok: true; info: BmsImageInfo } | { ok: false; reason: string };

const latin1 = (b: Uint8Array) => Array.from(b, (c) => String.fromCharCode(c)).join('');
const bcd = (b: number) => `${b >> 4}${b & 0xf}`;
const u32le = (b: Uint8Array, o: number) => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;

/** firmware.py parse(): every structural rule, never throws. */
export function parseBmsImage(raw: Uint8Array): BmsParse {
  const fail = (reason: string): BmsParse => ({ ok: false, reason });
  if (raw.length < BMS_RECORD_LEN + 8) return fail(`The file is too small to be a battery image (${raw.length} bytes)`);
  if (raw.length % BMS_BLOCK_SIZE) return fail(`File length ${raw.length} is not a multiple of 8; the official images always are. Truncated or wrong file`);

  let n = 0;
  let expectedAddr = 0;
  while ((n + 1) * BMS_RECORD_LEN <= raw.length && RECORD_MAGIC.every((m, i) => raw[n * BMS_RECORD_LEN + i] === m)) {
    const r = raw.subarray(n * BMS_RECORD_LEN, (n + 1) * BMS_RECORD_LEN);
    const addr = u32le(r, 5);
    if (addr !== expectedAddr) return fail(`Record ${n} has address 0x${addr.toString(16)}, expected 0x${expectedAddr.toString(16)} (file damaged)`);
    let x = 0;
    for (let i = 1; i < 137; i++) x ^= r[i]!;
    if (x !== r[137]) return fail(`Record ${n} (address 0x${addr.toString(16)}) checksum mismatch (file damaged)`);
    if (r[138] !== RECORD_END) return fail(`Record ${n} end marker is 0x${r[138]!.toString(16)}, expected 0x69`);
    expectedAddr += BMS_RECORD_PAYLOAD;
    n++;
  }
  if (n < 2) return fail('No valid 5A 89 55 55 57 records: this is not a battery (BMS) image');

  const tail = raw.subarray(n * BMS_RECORD_LEN);
  if (tail.length < 8 || tail.length > 64) return fail(`Unexpected trailer length ${tail.length} after ${n} records`);
  const pad = tail.subarray(0, tail.length - 8);
  if (pad.some((b) => b !== 0)) return fail('Non-zero bytes between the last record and the version trailer');
  const ver = tail.subarray(tail.length - 8);
  if (ver.some((b) => b < 0x20 || b > 0x7e)) return fail('The version trailer is not ASCII');
  const versionAscii = latin1(ver);
  const line = versionAscii.slice(6);
  if (!/^\d{6}$/.test(versionAscii.slice(0, 6)) || (line !== 'RC' && line !== 'SC')) {
    return fail(`Version trailer "${versionAscii}" is not of the form NNNNNNRC / NNNNNNSC`);
  }

  const hdr = raw.subarray(9, 137);
  const project = latin1(hdr.subarray(0, 16)).replace(/[\0 ]+$/, '');
  const descBytes = hdr.subarray(0x30, 0x54);
  const z = descBytes.indexOf(0);
  const description = latin1(z < 0 ? descBytes : descBytes.subarray(0, z)).trim();
  const payloadSize = u32le(hdr, 0x14);
  if (payloadSize !== n * BMS_RECORD_PAYLOAD) {
    return fail(`The header says ${payloadSize} payload bytes but the file has ${n} records (${n * BMS_RECORD_PAYLOAD} bytes)`);
  }
  const d = hdr.subarray(0x18, 0x1c);
  const buildDate = `${bcd(d[3]!)}${bcd(d[2]!)}-${bcd(d[1]!)}-${bcd(d[0]!)}`;
  const imageCheck = u32le(hdr, 0x20);

  // The header names the CPU, the trailer names the line: a mixed-up file is refused.
  const warnings: string[] = [];
  const text = `${project} ${description}`.toUpperCase();
  const hdrLine: BmsLine | null = text.includes('RL78') ? 'RC' : text.includes('SBC_EBIKE_BMUV1') || text.includes('48V E-BIKE FW') ? 'SC' : null;
  if (hdrLine === null) warnings.push(`The header project "${project}" is not one of the two known battery platforms`);
  else if (hdrLine !== line) return fail(`The header says the ${hdrLine} platform but the trailer says ${line}: refusing a mixed-up file`);

  return {
    ok: true,
    info: {
      line, version: `${versionAscii.slice(0, 2)}.${versionAscii.slice(2, 4)}.${versionAscii.slice(4, 6)}`, versionAscii,
      project, description, payloadSize, buildDate, imageCheck, records: n, blocks: raw.length / BMS_BLOCK_SIZE, warnings,
    },
  };
}

/** 0x280 reply: 8 ASCII bytes "010012RC" → { version "01.00.12", line "RC" }; null if it isn't that. */
export function parseBmsVersion(data: Uint8Array): { version: string; line: string } | null {
  if (data.length < 8 || data.subarray(0, 8).some((b) => b < 0x20 || b > 0x7e)) return null;
  const s = latin1(data.subarray(0, 8));
  if (!/^\d{6}/.test(s)) return null;
  return { version: `${s.slice(0, 2)}.${s.slice(2, 4)}.${s.slice(4, 6)}`, line: s.slice(6, 8) };
}

// ---- verified images ------------------------------------------------------------------------

export interface VerifiedBmsFirmware {
  readonly entry: AllowedBmsFirmware;
  readonly info: Readonly<BmsImageInfo>;
  readonly sha256: string;
  readonly size: number;
  /** 8-byte CAN blocks. */
  readonly blockCount: number;
  readonly source: string;
  readonly bundled: boolean;
  readonly notes: readonly string[];
}

export type BmsVerifyResult =
  | { ok: true; firmware: VerifiedBmsFirmware }
  | { ok: false; reason: string; sha256: string | null; size: number };

const PRIVATE = new WeakMap<VerifiedBmsFirmware, Uint8Array>();

export function isVerifiedBms(x: unknown): x is VerifiedBmsFirmware {
  return typeof x === 'object' && x !== null && PRIVATE.has(x as VerifiedBmsFirmware);
}

/** The 8 bytes of block [index] (0-based), exactly as stored. */
export function readBmsBlock(v: VerifiedBmsFirmware, index: number): Uint8Array {
  const b = PRIVATE.get(v);
  if (!b) throw new Error('Not a verified battery image');
  if (!Number.isInteger(index) || index < 0 || index >= v.blockCount) throw new Error(`Block ${index} is outside 0..${v.blockCount - 1}`);
  return b.slice(index * BMS_BLOCK_SIZE, (index + 1) * BMS_BLOCK_SIZE);
}

/**
 * Validate [input] as a battery image: on BMS_ALLOWLIST by full SHA-256 (or, with [canonicalName], that
 * entry's hash), the right size, every record checks, and the file's own version and line equal the
 * entry's.
 */
export async function verifyBmsFirmware(
  input: Uint8Array,
  opts: { source: string; canonicalName?: string; pickedName?: string; bundled?: boolean },
): Promise<BmsVerifyResult> {
  const size = input.length;
  if (size > MAX_FIRMWARE_BYTES) return { ok: false, reason: 'The file is too large to be battery firmware', sha256: null, size };
  const bytes = input.slice();
  const sha = await sha256Hex(bytes);
  const fail = (reason: string): BmsVerifyResult => ({ ok: false, reason, sha256: sha, size });
  const entry = opts.canonicalName !== undefined
    ? BMS_ALLOWLIST.find((e) => e.fileName === opts.canonicalName)
    : BMS_ALLOWLIST.find((e) => e.sha256 === sha);
  if (!entry) {
    return fail(opts.canonicalName !== undefined
      ? `No battery allowlist entry named ${opts.canonicalName}`
      : "This file isn't one of the two official battery images. Its SHA-256 isn't on the allowlist, so it won't be flashed.");
  }
  if (sha !== entry.sha256) return fail(`SHA-256 doesn't match the allowlist entry for ${entry.fileName}`);
  if (size !== entry.size) return fail(`Size is ${size} bytes, expected ${entry.size}`);
  const parsed = parseBmsImage(bytes);
  if (!parsed.ok) return fail(parsed.reason);
  const info = parsed.info;
  if (info.line !== entry.line || info.version !== entry.version) {
    return fail(`The file says ${info.version} ${info.line}, but its allowlist entry is ${entry.version} ${entry.line}`);
  }
  const notes: string[] = [];
  if (opts.pickedName !== undefined && opts.pickedName !== entry.fileName) {
    notes.push(`Picked as "${opts.pickedName}"; the contents match ${entry.fileName}.`);
  }
  const firmware: VerifiedBmsFirmware = Object.freeze({
    entry, info: Object.freeze({ ...info, warnings: [...info.warnings] }), sha256: sha, size, blockCount: info.blocks,
    source: opts.source, bundled: opts.bundled ?? false, notes: Object.freeze(notes),
  });
  PRIVATE.set(firmware, bytes);
  return { ok: true, firmware };
}

/** Right before flashing: hash the private copy again and re-run every rule. */
export async function recheckBmsFirmware(v: VerifiedBmsFirmware): Promise<boolean> {
  const b = PRIVATE.get(v);
  if (!b) return false;
  const r = await verifyBmsFirmware(b, { source: `recheck:${v.source}`, canonicalName: v.entry.fileName });
  return r.ok && r.firmware.sha256 === v.sha256 && r.firmware.entry === v.entry && v.sha256 === v.entry.sha256;
}
