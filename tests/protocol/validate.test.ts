import { describe, expect, it } from 'vitest';
import { concat, fromHex } from '../../src/protocol/bytes';
import { classifyNotification, decodeAck, decodeFwStatus, decodePower, disString, controllerType } from '../../src/protocol/pages';
import { ErrorDebouncer, gateNotification, plausibleErrorBits, validatePage } from '../../src/protocol/validate';
import { PAGES_LOOP } from '../../src/protocol/frames';
import { capture, HAS_CAPTURES } from '../helpers';

describe('page validation (Android PageValidator port)', () => {
  it.runIf(HAS_CAPTURES)('accepts every page the real bike sent in the captures', () => {
    for (const name of ['2026-10-25_1209_bench_raw.jsonl', '2026-10-25_1205_short_ride_raw.jsonl', '2026-10-25_1016_short_connect_raw.jsonl']) {
      for (const r of capture(name)) {
        if (r.ch !== 'read') continue;
        const n = classifyNotification(fromHex(r.hex));
        if (n.kind !== 'pages') continue;
        for (const p of n.pages) {
          const v = validatePage(p);
          expect(v.ok, `${name} ${r.hex.slice(0, 40)} ${v.ok ? '' : v.reasons.join(', ')}`).toBe(true);
        }
      }
    }
  });

  it('drops sentinels from every field and never surfaces sensitivity', () => {
    const v = validatePage(fromHex('3701ff010000000000000000000000000000ffff'));
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.fields).not.toHaveProperty('sensitivity');
      expect(v.fields).toMatchObject({ assist: 1, headlight: 1, shutdown_timer_s: 0, error_bits: 0 });
    }
    const p40 = validatePage(fromHex('2801000000000000ffffffffffffff00ffffffff'));
    expect(p40.ok && Object.keys(p40.fields).sort()).toEqual(['assist', 'error_bits', 'speed_kmh']);
  });

  it('rejects the garbage an abandoned log dump produces (Android 2026-11-01)', () => {
    // wheel 1024 mm is fine, but auto-off 707270168 s / error bits from timestamp bytes are not
    const p55 = fromHex('37' + '01' + 'ff' + '01' + '18162a2a' + '0a040e13' + '0000000000000000');
    expect(p55.length).toBe(20);
    const v55 = validatePage(p55);
    expect(v55.ok).toBe(false);
    expect(!v55.ok && v55.reasons.join()).toMatch(/shutdown_timer_s=.*error_bits=0x130e040a/);
    expect(validatePage(fromHex('28' + '01' + '0000' + '0a040e13' + 'ff'.repeat(12))).ok).toBe(false);
    expect(validatePage(fromHex('13' + 'c3'.repeat(16) + 'ffffff')).ok).toBe(false); // not text
    expect(validatePage(fromHex('99' + '00'.repeat(19))).ok).toBe(false); // unknown id
    expect(validatePage(fromHex('0a01')).ok).toBe(false); // short
  });

  it('page 56 needs its build date and record type', () => {
    expect(validatePage(fromHex('38000132303232303938c5de6a4700000003ffff')).ok).toBe(true);
    expect(validatePage(fromHex('38ffffffffffffffffffffffffffffffffffffff')).ok).toBe(false);
  });

  it('error bitmask plausibility: defined SBC bits only, at most 8 at once', () => {
    expect(plausibleErrorBits(0)).toBe(true);
    expect(plausibleErrorBits(0x00010000)).toBe(true);
    expect(plausibleErrorBits(0x00200003)).toBe(true);
    expect(plausibleErrorBits(0x01000000)).toBe(false); // bit 24: not in the table
    expect(plausibleErrorBits(0x000001ff)).toBe(false); // 9 bits
  });

  it('a notification is pages only if every slice is an expected page', () => {
    const live = fromHex('2801000000000000ffffffffffffff00ffffffff07010000ffff0f000000786c0c00b06b0c004f00');
    const g = gateNotification(live, new Set(PAGES_LOOP));
    expect(g.kind === 'pages' && g.ok.map((v) => v.pid)).toEqual([40, 7]);
    const withStray = concat(live, fromHex('1330332e30362e73302020202020202020ffffff'));
    expect(gateNotification(withStray, new Set(PAGES_LOOP)).kind).toBe('not-pages');
    expect(gateNotification(withStray, new Set([...PAGES_LOOP, 19])).kind).toBe('pages');
    expect(gateNotification(fromHex('3c020100'), new Set(PAGES_LOOP)).kind).toBe('not-pages');
  });

  it('error debounce: 3 identical frames before a change shows', () => {
    const d = new ErrorDebouncer();
    expect(d.offer(0x10000)).toBeNull();
    expect(d.offer(0x10000)).toBeNull();
    expect(d.offer(0x10000)).toBe(0x10000);
    expect(d.offer(0)).toBe(0x10000);
    expect(d.offer(0x5)).toBe(0x10000);
    expect(d.offer(0)).toBe(0x10000);
    expect(d.offer(0)).toBe(0x10000);
    expect(d.offer(0)).toBe(0);
  });
});

describe('short frames: page 0x3C, acks, status, DIS', () => {
  it('page 0x3C is 3C <status> <seq u16 LE> (PROTOCOL.md, corrected 2026-11-09)', () => {
    expect(decodeFwStatus(fromHex('3c020100'))).toEqual({ status: 2, seq: 1 });
    expect(decodeFwStatus(fromHex('3c000000'))).toEqual({ status: 0, seq: 0 });
    expect(decodeFwStatus(fromHex('3c010000'))).toEqual({ status: 1, seq: 0 });
    expect(decodeFwStatus(fromHex('3c020028'))).toEqual({ status: 2, seq: 10_240 });
    expect(decodeFwStatus(fromHex('3c02'))).toEqual({ status: 2, seq: null });
    expect(decodeFwStatus(fromHex('3c'))).toBeNull();
    // never eaten by the page splitter or the dump framing
    expect(classifyNotification(fromHex('3c020100'))).toMatchObject({ kind: 'fw-status', status: { status: 2, seq: 1 } });
  });

  it('acks are exactly [10 op status]', () => {
    expect(decodeAck(fromHex('104601'))).toEqual({ op: 0x46, status: 1, text: 'SUCCESS' });
    expect(decodeAck(fromHex('103d02'))?.text).toBe('OP_CODE_NOT_SUPPORTED');
    expect(decodeAck(fromHex('1046'))).toBeNull();
    expect(decodeAck(fromHex('114601'))).toBeNull();
  });

  it('status characteristic: awake, unlocked, not charging, imperial', () => {
    expect(decodePower(fromHex('01000001'))).toMatchObject({ suspended: false, locked: false, charging: false, units: 'imperial' });
    expect(decodePower(fromHex('00010100'))).toMatchObject({ suspended: true, locked: true, charging: true, units: 'metric' });
    expect(decodePower(fromHex('010000'))).toBeNull();
  });

  it('DIS strings strip NULs and spaces; HMI 5.x is sbc', () => {
    expect(disString(new TextEncoder().encode('5.19\0\0 '))).toBe('5.19');
    expect(controllerType('5.19', '1.0')).toBe('sbc');
    expect(controllerType(null, '0.9')).toBe('sbc');
    expect(controllerType('4.2', '1.2.3')).toBeNull();
  });

  it('dump framing and CAN frames are recognised', () => {
    expect(classifyNotification(Uint8Array.of(0xbe)).kind).toBe('dump-start');
    expect(classifyNotification(Uint8Array.of(0xed)).kind).toBe('dump-end');
    const can = classifyNotification(fromHex('51' + 'af010000' + '08' + '0003000039000000' + '00' + '10270000'));
    expect(can.kind === 'can' && can.frame).toMatchObject({ canId: 0x1af, len: 8, src: 'HMI_RX' });
  });
});
