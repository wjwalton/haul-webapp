/**
 * Page decoding: a port of decode_page / strip_na / text16 / on_read's dispatch from
 * reference/globe_capture.py (BaseEBikeParser.java). Offsets, widths and the sentinel rules are the
 * Python's. The only differences are listed in DEVIATIONS below, each backed by PROTOCOL.md, and the
 * parity tests (tests/protocol/pages.parity.test.ts) translate through exactly that list.
 */
import { hex, s16, u16, u32, u8 } from './bytes';

export const PAGE_SIZE = 20;

/**
 * Field renames vs globe_capture.py, so units are in the name where PROTOCOL.md has CONFIRMED them.
 * key = Python field name, value = this app's name.
 */
export const RENAMED_FROM_PYTHON = {
  /** "Speed units: CONFIRMED km/h x0.1 (ride 2026-10-25)". */
  speed: 'speed_kmh',
  /** "Range-estimate units (page 7 off18): CONFIRMED kilometres, 1 km units". */
  range_est: 'range_km',
  /** "Cadence: CONFIRMED rpm x1 (ride 2026-10-25). Drop the 'raw' label." */
  cadence_raw: 'cadence_rpm',
} as const;

/** Every intentional difference from decode_page, in one place. */
export const DEVIATIONS = [
  'Fields renamed with their confirmed units: speed -> speed_kmh, range_est -> range_km, cadence_raw -> cadence_rpm (RENAMED_FROM_PYTHON).',
  'Assist 255 is dropped (no "assist" key) and walk_mode is never emitted: PROTOCOL.md "this bike has no walk mode". The Python emits walk_mode true/false.',
  'Page 56 (production info) is decoded (prod_record_type u16@1, build_date "YYYY-MM" from ASCII @3-8, prod_id u32@11): PROTOCOL.md "Page 56". The Python returns {} for it.',
] as const;

export const STRING_PAGES: Readonly<Record<number, string>> = {
  11: 'motor_serial1', 12: 'motor_serial2', 13: 'motor_model', 14: 'motor_sw',
  15: 'motor_hw', 16: 'ctrl_serial1', 17: 'ctrl_serial2', 18: 'ctrl_model',
  19: 'ctrl_sw', 20: 'ctrl_hw', 21: 'batt_serial1', 22: 'batt_serial2',
  23: 'batt_model', 24: 'batt_sw', 25: 'batt_hw', 26: 'motor_mfr',
  27: 'ctrl_mfr', 28: 'batt_mfr',
};

export type FieldValue = number | string | boolean | null;
export type Decoded = Record<string, FieldValue>;

function tenth(v: number | null): number | null {
  return v === null ? null : v / 10;
}

/**
 * Python str.strip() for strings decoded from ASCII: the whitespace it removes there is
 * \t \n \v \f \r \x1c-\x1f and space. (JS trim() differs: it keeps \x1c-\x1f.)
 */
function pyStrip(s: string): string {
  const ws = (c: number) => c === 0x20 || (c >= 0x09 && c <= 0x0d) || (c >= 0x1c && c <= 0x1f);
  let a = 0;
  let b = s.length;
  while (a < b && ws(s.charCodeAt(a))) a++;
  while (b > a && ws(s.charCodeAt(b - 1))) b--;
  return s.slice(a, b);
}

/** Python `bytes.decode("ascii", "replace")`: every byte >= 0x80 becomes U+FFFD. */
function asciiReplace(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x < 0x80 ? String.fromCharCode(x) : '�';
  return s;
}

/** text16: bytes 1..16, cut at the first NUL, ASCII with replacement, stripped (Python parity). */
export function text16(p: Uint8Array): string {
  const field = p.subarray(Math.min(1, p.length), Math.min(17, p.length));
  const nul = field.indexOf(0);
  return pyStrip(asciiReplace(nul >= 0 ? field.subarray(0, nul) : field));
}

/**
 * Strict text for what the app stores and shows (the Android app's text16Strict): bytes 1..16 cut at
 * the first NUL, trailing 0xFF / space padding and leading spaces trimmed, then every byte must be
 * printable ASCII. "" = all padding (not reported); null = not text at all (e.g. log-dump bytes).
 */
export function text16Strict(p: Uint8Array): string | null {
  const field = p.subarray(Math.min(1, p.length), Math.min(17, p.length));
  const nul = field.indexOf(0);
  let bytes = Array.from(nul >= 0 ? field.subarray(0, nul) : field);
  while (bytes.length && (bytes[bytes.length - 1] === 0xff || bytes[bytes.length - 1] === 0x20)) bytes.pop();
  while (bytes.length && bytes[0] === 0x20) bytes.shift();
  if (bytes.some((x) => x < 0x20 || x > 0x7e)) return null;
  return String.fromCharCode(...bytes);
}

/** assist_fields, minus walk mode (DEVIATIONS). */
function assistFields(v: number | null): Decoded {
  return v === null || v === 255 ? {} : { assist: v };
}

/** Page 56 bytes 3..8: ASCII "YYYYMM" -> "YYYY-MM"; null unless six digits with a month 01-12. */
function buildDate(p: Uint8Array): string | null {
  if (p.length < 9) return null;
  const s = String.fromCharCode(...p.subarray(3, 9));
  if (!/^\d{6}$/.test(s)) return null;
  const month = Number(s.slice(4));
  return month >= 1 && month <= 12 ? `${s.slice(0, 4)}-${s.slice(4)}` : null;
}

/** decode_page: one 20-byte page -> named fields. Never throws; fields past the end read as null. */
export function decodePage(p: Uint8Array): Decoded {
  if (p.length === 0) return {};
  const pid = p[0]!;
  const str = STRING_PAGES[pid];
  if (str !== undefined) return { [str]: text16(p) };
  switch (pid) {
    case 51: // live: battery %, speed, odo, trip, range, ride time (not streamed by HMI 5.19)
      return {
        batt_pct: u8(p, 1), speed_x10: u16(p, 2), speed_kmh: tenth(u16(p, 2)),
        odometer_raw: u32(p, 4), trip_raw: u32(p, 8), range_raw: u16(p, 12), ride_time_raw: u32(p, 14),
      };
    case 52: // live: battery + motor electrical/thermal (not streamed by HMI 5.19)
      return {
        batt_temp_raw: u8(p, 1), batt_current_raw: s16(p, 2), batt_voltage_raw: u16(p, 4),
        batt_remaining_cap_raw: u16(p, 6), ctrl_temp_raw: u8(p, 8), motor_temp_raw: u8(p, 9),
        motor_voltage_raw: u16(p, 10), motor_rpm: u16(p, 12), throttle_raw: u8(p, 14),
      };
    case 53: // live: pedalling. The app reads offset 5 twice; kept as in the Python.
      return {
        cw_raw: u8(p, 1), ccw_raw: u8(p, 2), torque_nm: tenth(u16(p, 3)),
        torque_voltage_raw: u16(p, 5), cadence_app: u16(p, 5), pedal_power_raw: u32(p, 7),
      };
    case 54: // config/state snapshot
      return {
        assist_levels: u8(p, 1), wheel_circ_mm: u16(p, 2), speed_limit: tenth(u16(p, 4)),
        motor_on: u8(p, 6), batt_health_pct: u8(p, 7), batt_full_cap_raw: u16(p, 8),
        charge_cycles: u16(p, 10), last_charge_duration_raw: u32(p, 12), last_charge_epoch: u32(p, 16),
      };
    case 55: // settings + error bitmask + raw component error codes
      return {
        ...assistFields(u8(p, 1)),
        sensitivity: u8(p, 2), headlight: u8(p, 3), shutdown_timer_s: u32(p, 4),
        error_bits: u32(p, 8), ctrl_err_code: u16(p, 12), batt_err_code: u16(p, 14), motor_err_code: u16(p, 16),
      };
    case 40: // live page with the error bitmask
      return {
        ...assistFields(u8(p, 1)),
        speed_kmh: tenth(u16(p, 2)), error_bits: u32(p, 4), torque_voltage_raw: u16(p, 8),
        cw_raw: u8(p, 10), ccw_raw: u8(p, 11), motor_voltage_raw: u16(p, 12), throttle_raw: u8(p, 14),
        last_charge_epoch: u32(p, 16),
      };
    case 56: // production info (DEVIATIONS: the Python doesn't decode it)
      return { prod_record_type: u16(p, 1), build_date: buildDate(p), prod_id: u32(p, 11) };
    case 5:
      return {
        shutdown_timer_s: u32(p, 1), wheel_circ_mm: u16(p, 5), headlight: u8(p, 7), sensitivity: u8(p, 8),
        charge_cycles: u16(p, 9), last_charge_duration_raw: u32(p, 15), assist_levels: u8(p, 19),
      };
    case 6:
      return {
        motor_on: u8(p, 1), speed_limit: tenth(u16(p, 2)), ctrl_temp_raw: u8(p, 4),
        motor_err_code: u16(p, 14), ctrl_err_code: u16(p, 16), batt_err_code: u16(p, 18),
      };
    case 7:
    case 8:
    case 9:
    case 10: {
      const d: Decoded = { ...assistFields(u8(p, 1)), speed_kmh: tenth(u16(p, 2)) };
      if (pid === 7) {
        return { ...d, ride_time_s: u32(p, 6), trip_m: u32(p, 10), odometer_m: u32(p, 14), range_km: u16(p, 18) };
      }
      if (pid === 8) {
        return {
          ...d, torque_nm: tenth(u16(p, 4)), ride_time_s: u32(p, 6), trip_m: u32(p, 10),
          pedal_power_raw: u32(p, 14), cadence_rpm: u16(p, 18),
        };
      }
      if (pid === 9) {
        return {
          ...d, batt_remaining_cap_raw: u16(p, 4), batt_temp_c: u8(p, 6), batt_current_ma: s16(p, 7),
          batt_mv: u16(p, 9), motor_temp_c: u8(p, 11), motor_rpm: u16(p, 14),
        };
      }
      // b8..b13: one-hot "last press" latches; b8 = "+", b13 = "-" (PROTOCOL.md page 10)
      return {
        ...d, assist_levels: u8(p, 4), batt_pct: u8(p, 5), batt_full_cap_raw: u16(p, 6),
        key_flags: hex(p.subarray(Math.min(8, p.length), Math.min(14, p.length))), headlight: u8(p, 14),
      };
    }
    default:
      return {};
  }
}

/** strip_na's per-key 0xFF list (u8 fields where 0xFF means "not reported"). */
const NA8 = new Set([
  'motor_temp_c', 'motor_temp_raw', 'throttle_raw', 'cw_raw', 'ccw_raw', 'sensitivity',
  'batt_health_pct', 'batt_temp_raw', 'headlight',
]);

/**
 * strip_na: drop "not reported" sentinels (0xFFFF / 0xFFFFFFFF on any integer field, 0xFF on the
 * NA8 fields, 6553.5 on the x0.1 fields). Nulls are kept, as in the Python.
 */
export function stripNa(d: Decoded): Decoded {
  const out: Decoded = {};
  for (const [k, v] of Object.entries(d)) {
    if (typeof v === 'number') {
      if (Number.isInteger(v) && (v === 0xffff || v === 0xffffffff || (v === 0xff && NA8.has(k)))) continue;
      if (v === 6553.5) continue;
    }
    out[k] = v;
  }
  return out;
}

/** Session.on_read's page splitting: whole 20-byte pages; a short tail is dropped. */
export function splitPages(b: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i + PAGE_SIZE <= b.length; i += PAGE_SIZE) out.push(b.slice(i, i + PAGE_SIZE));
  return out;
}

// ---- …0001 notification dispatch (Session.on_read order) ----------------------------------

export const DUMP_START = 0xbe;
export const DUMP_END = 0xed;
export const PAGE_FW_STATUS = 0x3c;
export const PAGE_CAN = 0x51;
export const PAGE_BYPASS_REPLY = 0x1f;
export const CAN_FRAME_SIZE = 19;

export interface FwStatus {
  /** 0 = success, 1 = failed, 2 = ready / resend from seq. */
  status: number;
  /** 1-based block number (u16 LE @2-3); null if the notification is too short to carry one. */
  seq: number | null;
}

/**
 * Page 0x3C, the 4-byte notification `3C <status> <seq u16 LE>` (PROTOCOL.md, CORRECTED 2026-11-09:
 * status is byte 1 and seq bytes 2-3, NOT offsets 17/18). Never dropped for being short.
 */
export function decodeFwStatus(b: Uint8Array): FwStatus | null {
  if (b.length < 2 || b[0] !== PAGE_FW_STATUS) return null;
  return { status: b[1]!, seq: b.length >= 4 ? b[2]! | (b[3]! << 8) : null };
}

export interface CanFrame {
  canId: number;
  len: number;
  data: Uint8Array;
  src: 'HMI_RX' | 'HMI_TX' | '?';
  hmiTs: number | null;
}

/** decode_can: page 81 = [81, id u32 LE, len, data x8, src, ts u32 LE]. Null if it isn't one. */
export function decodeCan(b: Uint8Array): CanFrame | null {
  if (b.length < 6 || b.length >= PAGE_SIZE || b[0] !== PAGE_CAN) return null;
  const n = Math.min(b[5]!, 8);
  const src = u8(b, 14);
  return {
    canId: u32(b, 1)!,
    len: n,
    data: b.slice(6, 6 + n),
    src: src === 0 ? 'HMI_RX' : src === 1 ? 'HMI_TX' : '?',
    hmiTs: u32(b, 15),
  };
}

/**
 * What one …0001 notification is, outside a log dump in progress (the dump collector sees the bytes
 * first while a dump is open). Same order as Session.on_read: 0xBE, 0xED, page 0x3C, a short 0x51
 * CAN frame, a short 0x1F bypass reply, else 20-byte pages.
 *
 * CAN frames only arrive while CAN analysis (50 01) is on, which this app never sends; seeing them
 * means another app left it on, and the bike must be power-cycled (the app can't send 50 00).
 */
export type Notification =
  | { kind: 'empty' }
  | { kind: 'dump-start' }
  | { kind: 'dump-end' }
  | { kind: 'fw-status'; status: FwStatus | null; bytes: Uint8Array }
  | { kind: 'can'; frame: CanFrame }
  | { kind: 'bypass-reply'; bytes: Uint8Array }
  | { kind: 'pages'; pages: Uint8Array[]; tail: number };

export function classifyNotification(b: Uint8Array): Notification {
  if (b.length === 0) return { kind: 'empty' };
  const first = b[0]!;
  if (first === DUMP_START) return { kind: 'dump-start' };
  if (first === DUMP_END) return { kind: 'dump-end' };
  if (first === PAGE_FW_STATUS) return { kind: 'fw-status', status: decodeFwStatus(b), bytes: b };
  if (b.length < PAGE_SIZE && first === PAGE_CAN) {
    const frame = decodeCan(b);
    if (frame) return { kind: 'can', frame };
  }
  if (b.length < PAGE_SIZE && first === PAGE_BYPASS_REPLY) return { kind: 'bypass-reply', bytes: b };
  return { kind: 'pages', pages: splitPages(b), tail: b.length % PAGE_SIZE };
}

// ---- …0004 status and …0010 acks ---------------------------------------------------------

export interface PowerStatus {
  /** byte 0 == 0 */
  suspended: boolean;
  /** byte 1 == 1: PIN-locked (PROTOCOL.md "Lock / PIN") */
  locked: boolean;
  /** byte 2 == 1 (CONFIRMED 2026-10-25) */
  charging: boolean;
  /** byte 3: 0 metric, 1 imperial; anything else is reported as the number. */
  units: 'metric' | 'imperial' | number;
  raw: string;
}

/** Session.on_power: [awake, locked, charging, units]; null if shorter than 4 bytes. */
export function decodePower(b: Uint8Array): PowerStatus | null {
  if (b.length < 4) return null;
  const u = b[3]!;
  return {
    suspended: b[0] === 0,
    locked: b[1] === 1,
    charging: b[2] === 1,
    units: u === 0 ? 'metric' : u === 1 ? 'imperial' : u,
    raw: hex(b),
  };
}

export const OP_ACK = 0x10;
export const ACK_STATUS: Readonly<Record<number, string>> = {
  1: 'SUCCESS', 2: 'OP_CODE_NOT_SUPPORTED', 3: 'INVALID_PARAMETER', 4: 'OPERATION_FAILED',
};
export const ACK_SUCCESS = 1;

export interface Ack {
  op: number;
  status: number;
  text: string;
}

/** Session.on_ack: exactly [0x10, opcode, status]; anything else is not an ack. */
export function decodeAck(b: Uint8Array): Ack | null {
  if (b.length !== 3 || b[0] !== OP_ACK) return null;
  return { op: b[1]!, status: b[2]!, text: ACK_STATUS[b[2]!] ?? `status${b[2]}` };
}

/** DIS strings: ASCII with replacement, NULs and spaces stripped from both ends (Python strip("\x00 ")). */
export function disString(b: Uint8Array): string {
  const s = asciiReplace(b);
  let a = 0;
  let e = s.length;
  const junk = (c: string) => c === '\0' || c === ' ';
  while (a < e && junk(s[a]!)) a++;
  while (e > a && junk(s[e - 1]!)) e--;
  return s.slice(a, e);
}

/**
 * guess_ctype / EBikeHMI.checkSBC: HMI version "X.Y" with X in {5, 0} -> "sbc". Unlike the Python
 * (which falls back to "sbc" anyway), null means the check did not pass: the controller update gate
 * needs a confirmed sbc (Android FirmwarePreflight).
 */
export function controllerType(swRev: string | null | undefined, fwRev: string | null | undefined): 'sbc' | null {
  for (const v of [swRev, fwRev]) {
    if (v && v.split('.').length === 2 && ['5', '0'].includes(v.split('.')[0]!)) return 'sbc';
  }
  return null;
}
