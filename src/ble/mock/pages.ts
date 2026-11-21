/**
 * Page ENCODERS for the simulated HMI (mock only; the app never builds pages). Each page starts from a
 * template captured from the owner's bike (tests/fixtures/captures/2026-10-25_1209_bench)
 * and only the decoded fields are overwritten, so bytes nobody decodes stay exactly as the real HMI
 * sends them. Offsets are decode_page's.
 */
import { fromHex } from '../../protocol/bytes';
import { STRING_PAGES } from '../../protocol/pages';

/** One real page of each id, as captured. */
export const CAPTURED: Readonly<Record<number, string>> = {
  7: '07010000ffff0f000000786c0c00b06b0c004f00',
  8: '0801000000000f000000786c0c00000000000000',
  9: '09010000ffff145a00e0cbffffff0000ffffffff',
  10: '0a0100000551102701010101010101ff00000000',
  40: '2801000000000000ffffffffffffff00ffffffff',
  54: '3605bb08fa0000ff1027ffffffffffffffffffff',
  55: '3701ff010000000000000000000000000000ffff',
  56: '38000132303232303938c5de6a4700000003ffff',
};

/** Live values the simulated bike reports. Units as in the decoded field names. */
export interface MockLive {
  assist: number;
  speed_x10: number;
  error_bits: number;
  ride_time_s: number;
  trip_m: number;
  odometer_m: number;
  range_km: number;
  cadence_rpm: number;
  batt_temp_c: number;
  batt_current_ma: number;
  batt_mv: number;
  motor_rpm: number;
  assist_levels: number;
  batt_pct: number;
  /** Page 10 bytes 8..13 as hex (one-hot "last press" latches). */
  key_flags: string;
  /** Page 10 byte 14. */
  headlight: number;
}

export interface MockConfig {
  assist_levels: number;
  wheel_circ_mm: number;
  /** x0.1, as on the wire (250 = 25.0). */
  speed_limit_x10: number;
  /** Page 55 */
  headlight: number;
  shutdown_timer_s: number;
  ctrl_err_code: number;
  batt_err_code: number;
  motor_err_code: number;
}

function put16(b: Uint8Array, o: number, v: number) {
  b[o] = v & 0xff;
  b[o + 1] = (v >>> 8) & 0xff;
}
function put32(b: Uint8Array, o: number, v: number) {
  put16(b, o, v & 0xffff);
  put16(b, o + 2, (v >>> 16) & 0xffff);
}
const tpl = (pid: number) => fromHex(CAPTURED[pid]!);

/** Identity page: 16 bytes of text padded with spaces, then FF FF FF (as the HMI sends them). */
export function identityPage(pid: number, text: string): Uint8Array {
  if (STRING_PAGES[pid] === undefined) throw new Error(`${pid} isn't an identity page`);
  const b = new Uint8Array(20).fill(0x20);
  b[0] = pid;
  for (let i = 0; i < Math.min(16, text.length); i++) b[1 + i] = text.charCodeAt(i) & 0x7f;
  b[17] = b[18] = b[19] = 0xff;
  return b;
}

export function livePage(pid: 7 | 8 | 9 | 10 | 40, v: MockLive): Uint8Array {
  const b = tpl(pid);
  b[1] = v.assist;
  put16(b, 2, v.speed_x10);
  switch (pid) {
    case 40:
      put32(b, 4, v.error_bits);
      break;
    case 7:
      put32(b, 6, v.ride_time_s);
      put32(b, 10, v.trip_m);
      put32(b, 14, v.odometer_m);
      put16(b, 18, v.range_km);
      break;
    case 8:
      put32(b, 6, v.ride_time_s);
      put32(b, 10, v.trip_m);
      put16(b, 18, v.cadence_rpm);
      break;
    case 9:
      b[6] = v.batt_temp_c;
      put16(b, 7, v.batt_current_ma & 0xffff);
      put16(b, 9, v.batt_mv);
      put16(b, 14, v.motor_rpm);
      break;
    case 10:
      b[4] = v.assist_levels;
      b[5] = v.batt_pct;
      b.set(fromHex(v.key_flags), 8);
      b[14] = v.headlight;
      break;
  }
  return b;
}

export function configPage(c: MockConfig): Uint8Array {
  const b = tpl(54);
  b[1] = c.assist_levels;
  put16(b, 2, c.wheel_circ_mm);
  put16(b, 4, c.speed_limit_x10);
  return b;
}

export function settingsPage(c: MockConfig, assist: number, errorBits: number): Uint8Array {
  const b = tpl(55);
  b[1] = assist;
  b[3] = c.headlight;
  put32(b, 4, c.shutdown_timer_s);
  put32(b, 8, errorBits);
  put16(b, 12, c.ctrl_err_code);
  put16(b, 14, c.batt_err_code);
  put16(b, 16, c.motor_err_code);
  return b;
}

/**
 * Page 5 (PROTOCOL.md "Page 5 — settings"): auto-off u32 @1, wheel u16 @5, light @7, sensitivity @8
 * (0xFF), charge count @9 (0xFFFF = not reported). MOCK ASSUMPTION: the undecoded bytes are 0xFF and
 * byte 19 (assist levels in decode_page) is the level count; no page 5 was ever captured.
 */
export function settings5Page(c: MockConfig): Uint8Array {
  const b = new Uint8Array(20).fill(0xff);
  b[0] = 5;
  put32(b, 1, c.shutdown_timer_s);
  put16(b, 5, c.wheel_circ_mm);
  b[7] = c.headlight;
  b[19] = c.assist_levels;
  return b;
}

/** Page 56 as captured (build date 2022-09). */
export function productionPage(): Uint8Array {
  return tpl(56);
}
