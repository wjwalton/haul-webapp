/**
 * decode_page / strip_na parity with reference/globe_capture.py, field by field, on 1,200+ pages:
 * PROTOCOL.md and Android-test examples, edge cases, seeded random pages, short pages, and every
 * distinct page seen in the real captures. Differences are only those in pages.ts DEVIATIONS.
 */
import { describe, expect, it } from 'vitest';
import { fromHex } from '../../src/protocol/bytes';
import { decodePage, DEVIATIONS, stripNa, text16, text16Strict } from '../../src/protocol/pages';
import { captureFixture, fixture, HAS_CAPTURES, pyToTs } from '../helpers';

interface PageCase {
  name: string;
  hex: string;
  raw?: Record<string, unknown>;
  stripped: Record<string, unknown>;
}
const synthetic = fixture<{ cases: PageCase[] }>('py_pages.json').cases;
/** Every distinct page seen in the real captures (git-ignored, personal); absent on a fresh clone. */
const fromCaptures = captureFixture<{ cases: PageCase[] }>('py_capture_pages.json')?.cases ?? [];
const cases = [...synthetic, ...fromCaptures];

const PAGE56_KEYS = ['prod_record_type', 'build_date', 'prod_id'];
function withoutPage56(pid: number, d: Record<string, unknown>) {
  if (pid !== 56) return d;
  const out = { ...d };
  for (const k of PAGE56_KEYS) delete out[k];
  return out;
}

describe('decode_page parity', () => {
  it('has a meaningful fixture set', () => {
    expect(synthetic.length).toBeGreaterThan(600);
    if (HAS_CAPTURES) expect(fromCaptures.length).toBeGreaterThan(100);
  });

  it.each(cases.filter((c) => c.raw).map((c) => [c.name, c] as const))('decodePage: %s', (_n, c) => {
    const b = fromHex(c.hex);
    const pid = b[0]!;
    if (pid === 56) expect(c.raw, 'the reference has no page-56 decoder (DEVIATIONS)').toEqual({});
    expect(withoutPage56(pid, decodePage(b))).toEqual(pyToTs(c.raw!));
  });

  it.each(cases.map((c) => [c.name, c] as const))('strip_na: %s', (_n, c) => {
    const b = fromHex(c.hex);
    expect(withoutPage56(b[0]!, stripNa(decodePage(b)))).toEqual(pyToTs(c.stripped));
  });

  it('documents its deviations', () => {
    expect(DEVIATIONS.length).toBe(4);
    expect(DEVIATIONS[3]).toMatch(/multiple of 19 is split into that many CAN frames/);
  });
});

describe('page details (PROTOCOL.md)', () => {
  it('page 56: build date and unit id', () => {
    const d = decodePage(fromHex('38000132303232303938c5de6a4700000003ffff'));
    expect(d.build_date).toBe('2022-09');
    expect(d.prod_id).toBe(4_680_414);
    expect(d.prod_record_type).toBe(0x0100); // bytes 00 01, read LE
    const badMonth = fromHex('38000132303232313338c5de6a4700000003ffff'); // "202213"
    expect(decodePage(badMonth).build_date).toBeNull();
  });

  it('page 7 from the owner\'s bike: odometer, trip, range in km', () => {
    const d = stripNa(decodePage(fromHex('07010000ffff0f000000786c0c00b06b0c004f00')));
    expect(d).toMatchObject({ assist: 1, speed_kmh: 0, ride_time_s: 15, trip_m: 814_200, odometer_m: 814_000, range_km: 79 });
  });

  it('page 9: signed current, mV, temperature; motor temp 0xFF is not reported', () => {
    const d = stripNa(decodePage(fromHex('09' + '02' + '9900' + '0000' + '14' + '92ff' + '37ca' + 'ff' + '0000' + '7c01' + '0000' + '0000')));
    expect(d).toMatchObject({ assist: 2, speed_kmh: 15.3, batt_temp_c: 20, batt_current_ma: -110, batt_mv: 51_767, motor_rpm: 380 });
    expect(d).not.toHaveProperty('motor_temp_c');
    expect(d).not.toHaveProperty('walk_mode');
  });

  it('assist 255 is dropped, not shown as walk mode', () => {
    const d = decodePage(fromHex('07' + 'ff' + '0000' + '0000' + '8b010000' + 'b80b0000' + '30330b00' + '4d00'));
    expect(d).not.toHaveProperty('assist');
    expect(d).not.toHaveProperty('walk_mode');
  });

  it('page 8 cadence is rpm x1', () => {
    expect(decodePage(fromHex('08' + '02' + '0000' + '0000' + '00000000' + '00000000' + '00000000' + '3e00')).cadence_rpm).toBe(62);
  });

  it('text16 keeps Python semantics; text16Strict rejects non-text', () => {
    const p = (s: number[]) => Uint8Array.from([16, ...s, ...Array(19 - s.length).fill(0)]);
    expect(text16(p([0x1c, 0x41, 0x1f]))).toBe('A'); // Python strips \x1c-\x1f; JS trim() wouldn't
    expect(text16(p([0x31, 0x42, 0xc3]))).toBe('1B�');
    expect(text16Strict(p([0x31, 0x42, 0xc3]))).toBeNull();
    const real = fromHex('1031323334353637383920202020202020ffffff'); // real layout: text, space padding, ff ff ff
    expect(text16(real)).toBe('123456789');
    expect(text16Strict(real)).toBe('123456789');
    expect(text16Strict(fromHex('0b20202020202020202020202020202020ffffff'))).toBe('');
  });
});
