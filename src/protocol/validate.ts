/**
 * Plausibility gate between the decoder and everything that stores or shows a value. Ported from the
 * Android app (ble/PageValidator.kt, ble/LiveFilter.kt), field names translated per pages.ts
 * RENAMED_FROM_PYTHON.
 *
 * Why (Android, diagnosed 2026-11-01): the rest of an abandoned log dump keeps arriving on …0001 and
 * slices of it parse as 20-byte "pages" (wheel 1024 mm, auto-off 707270168 s, error bits 0x130E040A,
 * "����" strings). A page is accepted only if it is exactly 20 bytes, a known id, and EVERY field is
 * "not reported" or plausible; one bad field rejects the whole page.
 */
import { popcount32 } from './bytes';
import { DEFINED_ERROR_MASK } from './errors';
import { decodePage, PAGE_SIZE, splitPages, STRING_PAGES, text16Strict, type Decoded } from './pages';

type Width = 'u8' | 'u16' | 's16' | 'u32' | 'tenth16';

/** Width of every numeric field decodePage can produce. */
const WIDTH: Readonly<Record<string, Width>> = (() => {
  const w: Record<string, Width> = {};
  for (const k of [
    'assist', 'assist_levels', 'batt_pct', 'motor_on', 'batt_health_pct', 'sensitivity', 'headlight',
    'batt_temp_c', 'motor_temp_c', 'batt_temp_raw', 'ctrl_temp_raw', 'motor_temp_raw', 'throttle_raw',
    'cw_raw', 'ccw_raw',
  ]) w[k] = 'u8';
  for (const k of [
    'wheel_circ_mm', 'batt_full_cap_raw', 'charge_cycles', 'ctrl_err_code', 'batt_err_code', 'motor_err_code',
    'torque_voltage_raw', 'motor_voltage_raw', 'speed_x10', 'range_raw', 'range_km', 'batt_voltage_raw',
    'batt_remaining_cap_raw', 'motor_rpm', 'cadence_rpm', 'cadence_app', 'batt_mv', 'prod_record_type',
  ]) w[k] = 'u16';
  for (const k of ['batt_current_ma', 'batt_current_raw']) w[k] = 's16';
  for (const k of [
    'shutdown_timer_s', 'error_bits', 'last_charge_duration_raw', 'last_charge_epoch', 'odometer_raw', 'trip_raw',
    'ride_time_raw', 'ride_time_s', 'trip_m', 'odometer_m', 'pedal_power_raw', 'prod_id',
  ]) w[k] = 'u32';
  for (const k of ['speed_kmh', 'speed_limit', 'torque_nm']) w[k] = 'tenth16';
  return w;
})();

function isSentinel(key: string, v: unknown): boolean {
  if (typeof v !== 'number') return false;
  switch (WIDTH[key]) {
    case 'u8': return v === 0xff;
    case 'u16': return v === 0xffff;
    case 's16': return v === -1;
    case 'u32': return v === 0xffffffff;
    case 'tenth16': return v === 6553.5;
    default: return false;
  }
}

/** 1,000,000 km: the odometer / trip ceiling. */
export const MAX_DISTANCE_M = 1_000_000_000;
const MAX_AUTO_OFF_S = 7 * 86_400;
const AUTO_OFF_MIN_S = 60;
const WHEEL_CIRC_MM = [500, 5000] as const;

const range = (lo: number, hi: number) => (x: number) => x >= lo && x <= hi;

/**
 * Plausible ranges (physical limits with headroom, not expectations: the fastest ride logged was
 * 44.8 km/h; the bound is 100). Fields not listed are raw/undecoded and only sentinel-stripped.
 */
const RANGES: Readonly<Record<string, (x: number) => boolean>> = {
  assist: range(0, 10),
  assist_levels: range(1, 10),
  speed_kmh: range(0, 100),
  batt_pct: range(0, 100),
  batt_mv: range(20_000, 70_000),
  batt_current_ma: range(-60_000, 60_000),
  batt_temp_c: range(0, 100),
  motor_temp_c: range(0, 200),
  motor_rpm: range(0, 3_000),
  cadence_rpm: range(0, 300),
  ride_time_s: range(0, 360_000_000),
  trip_m: (x) => x >= 0 && x < MAX_DISTANCE_M,
  odometer_m: (x) => x >= 0 && x < MAX_DISTANCE_M,
  range_km: range(0, 2_000),
  wheel_circ_mm: range(WHEEL_CIRC_MM[0], WHEEL_CIRC_MM[1]),
  speed_limit: range(5, 100),
  batt_health_pct: range(0, 100),
  charge_cycles: range(0, 20_000),
  motor_on: range(0, 1),
  headlight: range(0, 1),
  shutdown_timer_s: (x) => x === 0 || (x >= AUTO_OFF_MIN_S && x <= MAX_AUTO_OFF_S),
  torque_nm: range(0, 300),
  pedal_power_raw: range(0, 5_000),
};

/** Raw fields with unconfirmed units: kept only when meaningful, never a reason to reject a page. */
const HIDE_UNLESS: Readonly<Record<string, (x: number) => boolean>> = {
  last_charge_duration_raw: (x) => x >= 1 && x <= 172_800,
  last_charge_epoch: (x) => x >= 1_420_070_400 && x <= 4_102_444_800,
};

/** Pedal sensitivity is unsupported on this bike (PROTOCOL.md); never surfaced. */
const ALWAYS_DROP = new Set(['sensitivity']);

const TEXT_SHAPE: Readonly<Record<string, RegExp>> = (() => {
  const serial = /^[0-9A-Za-z-]{1,16}$/;
  const version = /^[0-9A-Za-z][0-9A-Za-z._\- ]{0,15}$/;
  const name = /^[0-9A-Za-z][0-9A-Za-z._\-&,/ ]{0,15}$/;
  const out: Record<string, RegExp> = {};
  for (const k of Object.values(STRING_PAGES)) {
    out[k] = k.includes('serial') ? serial : k.endsWith('_sw') || k.endsWith('_hw') ? version : name;
  }
  return out;
})();

/** Pages the app decodes. Anything else in a page slot is not a page that was asked for. */
export const KNOWN_PIDS: ReadonlySet<number> = new Set([
  ...Object.keys(STRING_PAGES).map(Number), 5, 6, 7, 8, 9, 10, 40, 51, 52, 53, 54, 55, 56,
]);

/** Real logs show at most 3 bits at once; garbage is also stopped by the page gate and the debounce. */
export const MAX_ERROR_BITS = 8;

export function plausibleErrorBits(bits: number): boolean {
  return Number.isInteger(bits) && bits >= 0 && bits <= 0xffffffff &&
    ((bits & ~DEFINED_ERROR_MASK) >>> 0) === 0 && popcount32(bits) <= MAX_ERROR_BITS;
}

const BUILD_DATE = /^(19|20)\d\d-(0[1-9]|1[0-2])$/;
/** Real bikes send `00 01`, which the LE reader gives as 0x0100; either order passes, the date is the real check. */
const PRODUCTION_RECORD_TYPES = new Set([1, 0x0100]);

export type Verdict =
  | { ok: true; pid: number; fields: Decoded }
  | { ok: false; pid: number; reasons: string[] };

/** Range-check already-decoded fields. */
export function checkFields(pid: number, decoded: Decoded): Verdict {
  const reasons: string[] = [];
  const out: Decoded = {};
  for (const [k, v] of Object.entries(decoded)) {
    if (v === null || ALWAYS_DROP.has(k) || isSentinel(k, v)) continue;
    const hide = HIDE_UNLESS[k];
    if (hide) {
      if (typeof v === 'number' && hide(v)) out[k] = v;
      continue;
    }
    if (k === 'error_bits') {
      if (typeof v !== 'number' || !plausibleErrorBits(v)) {
        reasons.push(`error_bits=0x${typeof v === 'number' ? v.toString(16).padStart(8, '0') : '?'}`);
      } else out[k] = v;
      continue;
    }
    if (k === 'build_date') {
      if (typeof v !== 'string' || !BUILD_DATE.test(v)) reasons.push(`build_date=${String(v)}`);
      else out[k] = v;
      continue;
    }
    const r = RANGES[k];
    if (r) {
      if (typeof v !== 'number' || Number.isNaN(v) || !r(v)) reasons.push(`${k}=${String(v)}`);
      else out[k] = v;
      continue;
    }
    out[k] = v;
  }
  if (pid === 56) {
    const t = decoded.prod_record_type;
    if (out.build_date == null || typeof t !== 'number' || !PRODUCTION_RECORD_TYPES.has(t)) {
      reasons.push('page 56 without a build date / record type 1');
    }
  }
  return reasons.length ? { ok: false, pid, reasons } : { ok: true, pid, fields: out };
}

function checkText(pid: number, key: string, page: Uint8Array): Verdict {
  const text = text16Strict(page);
  if (text === null) return { ok: false, pid, reasons: [`${key}: not printable ASCII`] };
  if (text === '') return { ok: true, pid, fields: {} }; // all padding: not reported
  const shape = TEXT_SHAPE[key];
  if (shape && !shape.test(text)) return { ok: false, pid, reasons: [`${key}: "${text}" isn't a plausible value`] };
  return { ok: true, pid, fields: { [key]: text } };
}

/** Check one 20-byte page. Never throws. */
export function validatePage(page: Uint8Array): Verdict {
  if (page.length === 0) return { ok: false, pid: -1, reasons: ['empty'] };
  const pid = page[0]!;
  if (page.length !== PAGE_SIZE) return { ok: false, pid, reasons: [`length ${page.length}, not ${PAGE_SIZE}`] };
  if (!KNOWN_PIDS.has(pid)) return { ok: false, pid, reasons: [`unknown page id ${pid}`] };
  const key = STRING_PAGES[pid];
  if (key !== undefined) return checkText(pid, key, page);
  return checkFields(pid, decodePage(page));
}

/** Is an identity / DIS string a real value (printable, sane shape)? */
export function plausibleText(key: string, text: string): boolean {
  if (text === '') return true;
  if ([...text].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) > 0x7e)) return false;
  return TEXT_SHAPE[key]?.test(text) ?? true;
}

export type GateResult =
  | { kind: 'pages'; ok: Extract<Verdict, { ok: true }>[]; rejected: Extract<Verdict, { ok: false }>[] }
  | { kind: 'not-pages'; reason: string };

/**
 * NotificationGate: a notification counts as data pages only if EVERY 20-byte slice is a page
 * expected right now (the live loop's pages, or one an outstanding 3D request asked for). Any other id
 * means the bytes aren't pages (e.g. a log-dump tail): the whole notification is dropped. Then each
 * page is validated on its own.
 */
export function gateNotification(b: Uint8Array, expected: ReadonlySet<number>): GateResult {
  if (b.length < PAGE_SIZE) return { kind: 'not-pages', reason: `${b.length} bytes, shorter than one page` };
  const pages = splitPages(b);
  const unexpected = [...new Set(pages.map((p) => p[0]!).filter((pid) => !expected.has(pid)))];
  if (unexpected.length) {
    return { kind: 'not-pages', reason: `page ids ${unexpected.slice(0, 5).join(', ')} not expected (${b.length} bytes)` };
  }
  const ok: Extract<Verdict, { ok: true }>[] = [];
  const rejected: Extract<Verdict, { ok: false }>[] = [];
  for (const p of pages) {
    const v = validatePage(p);
    if (v.ok) ok.push(v);
    else rejected.push(v);
  }
  return { kind: 'pages', ok, rejected };
}

/**
 * The error bitmask only changes after `needed` consecutive identical frames (page 40 streams it at
 * ~10 Hz). A single odd frame never becomes a live error or clears one. One instance per connection.
 */
export class ErrorDebouncer {
  private candidate: number | null = null;
  private count = 0;
  stable: number | null = null;

  constructor(private readonly needed = 3) {}

  offer(bits: number): number | null {
    if (bits === this.candidate) this.count++;
    else {
      this.candidate = bits;
      this.count = 1;
    }
    if (this.count >= this.needed) this.stable = bits;
    return this.stable;
  }

  reset(): void {
    this.candidate = null;
    this.count = 0;
    this.stable = null;
  }
}
