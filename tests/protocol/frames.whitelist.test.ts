/**
 * THE whitelist test (docs/SPEC.md "Hard safety rules"): frames.ts builds only the allowed frames,
 * byte-identical to page_req() & co. in globe_capture.py, and checkFrame refuses everything else,
 * including 46 with a type other than 0x00.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import * as frames from '../../src/protocol/frames';
import {
  assertFrame, checkFrame, dumpLog, ForbiddenFrameError, fwBlock, fwStart, liveLoop, mtuPageMode, NEVER_SEND,
  ONCE_PAGES_ALLOWED, oncePages, PAGES_CONFIG, PAGES_IDENTITY, PAGES_LOOP,
} from '../../src/protocol/frames';
import { bytesEqual, fromHex, hex } from '../../src/protocol/bytes';
import { verifyFirmware, type VerifiedFirmware } from '../../src/analysis/firmware';
import type { VerifiedBmsFirmware } from '../../src/analysis/bmsFirmware';
import { autoOff, bmsBlock, bmsEnd, bmsRead, bmsStart, bmsWake, canBus } from '../../src/protocol/frames';
import { bmsBytes, bundledBms, bundledBytes, bundledController, captureFixture, fixture, HAS_BMS_FIRMWARE, HAS_CAPTURES, HAS_FIRMWARE } from '../helpers';

interface FrameCase { name: string; op: number; pages: number[]; hex: string }
const py = fixture<{ cases: FrameCase[] }>('py_frames.json');
/** Every frame the Python client wrote in the real captures (git-ignored, personal). */
const captureTx = captureFixture<{ capture_tx: { capture: string; hex: string }[] }>('py_capture_tx.json')?.capture_tx ?? [];

let img: VerifiedFirmware;
beforeAll(async () => {
  if (HAS_FIRMWARE) img = await bundledController();
});

/** Deterministic PRNG for the fuzz part. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
    return s / 0x100000000;
  };
}

describe('builders match globe_capture.py byte for byte', () => {
  it.each(py.cases.map((c) => [c.name, c] as const))('%s', (_n, c) => {
    let built: Uint8Array;
    if (c.op === 0x3c) built = mtuPageMode();
    else if (c.op === 0x3e) built = liveLoop();
    else if (c.op === 0x29) built = dumpLog(c.pages[0] as 1 | 2 | 3);
    else built = oncePages(c.pages);
    expect(hex(built)).toBe(c.hex);
  });

  it('page requests are 19 bytes, zero padded (page_req)', () => {
    for (const pages of [[55], [19], [54, 55, 56], PAGES_IDENTITY]) {
      const f = oncePages(pages);
      expect(f.length).toBe(19);
      expect(f[0]).toBe(0x3d);
      expect([...f.subarray(1 + pages.length)].every((x) => x === 0)).toBe(true);
    }
    expect(hex(oncePages([55]))).toBe('3d37' + '00'.repeat(17));
    expect(liveLoop().length).toBe(19);
    expect(hex(liveLoop())).toBe('3e280708090a' + '00'.repeat(13));
    expect(PAGES_LOOP).toEqual([40, 7, 8, 9, 10]);
    expect(PAGES_CONFIG).toEqual([54, 55, 56]);
  });

  it('3D only for the pages the HMI builds (1-28, 40, 51-56), 1-18 at a time', () => {
    expect([...ONCE_PAGES_ALLOWED].sort((a, b) => a - b)).toEqual([...Array.from({ length: 28 }, (_, i) => i + 1), 40, 51, 52, 53, 54, 55, 56]);
    for (const bad of [0, 29, 39, 41, 50, 57, 60, 81, 255]) expect(() => oncePages([bad])).toThrow();
    expect(() => oncePages([])).toThrow();
    expect(() => oncePages(Array(19).fill(1))).toThrow();
  });

  it('only log READS 29 01|02|03 00 00', () => {
    expect([1, 2, 3].map((t) => hex(dumpLog(t as 1 | 2 | 3)))).toEqual(['29010000', '29020000', '29030000']);
    expect(() => dumpLog(0 as 1)).toThrow();
    expect(() => dumpLog(4 as 1)).toThrow();
  });
});

describe.runIf(HAS_FIRMWARE)('controller update frames', () => {
  it('M1B0306s0.bin start frame is exactly 46 00 00 28 31 42 73', () => {
    expect(hex(fwStart(img))).toBe('460000283142' + '73');
    expect(img.blockCount).toBe(10_240);
  });

  it('blocks are 47 <seq LE> <len> <8 bytes as stored>', () => {
    const raw = bundledBytes('M1B0306s0.bin');
    const b1 = fwBlock(img, 1);
    expect(b1.length).toBe(12);
    expect(hex(b1.subarray(0, 4))).toBe('47010008');
    expect(bytesEqual(b1.subarray(4), raw.subarray(0, 8))).toBe(true);
    const last = fwBlock(img, 10_240);
    expect(hex(last.subarray(0, 4))).toBe('47002808');
    expect(bytesEqual(last.subarray(4), raw.subarray(81_912))).toBe(true);
    expect(() => fwBlock(img, 0)).toThrow();
    expect(() => fwBlock(img, 10_241)).toThrow();
  });

  it('46/47 are refused without the update context, with it they must match the image', () => {
    const ctx = { firmware: img };
    expect(checkFrame('command', fwStart(img))).toMatch(/only sent by the controller update/);
    expect(checkFrame('command', fwStart(img), ctx)).toBeNull();
    expect(checkFrame('block', fwBlock(img, 7))).toMatch(/only sent by the controller update/);
    expect(checkFrame('block', fwBlock(img, 7), ctx)).toBeNull();
    const tampered = fwBlock(img, 7);
    tampered[5] ^= 0xff;
    expect(checkFrame('block', tampered, ctx)).toMatch(/doesn't match the verified image/);
    expect(checkFrame('block', Uint8Array.of(0x47, 0, 0, 8, 1, 2, 3, 4, 5, 6, 7, 8), ctx)).toMatch(/outside/);
    expect(checkFrame('command', fwBlock(img, 1), ctx)).toMatch(/go to …0011/);
    expect(checkFrame('block', fwStart(img), ctx)).toMatch(/only 0x47/);
  });

  it('refuses 46 with any type other than 0x00 (battery is dealer-only), even with a verified image', () => {
    for (let type = 1; type < 256; type++) {
      const f = fwStart(img);
      f[1] = type;
      expect(checkFrame('command', f, { firmware: img })).toMatch(/only the controller/);
    }
    expect(Object.keys(frames)).not.toContain('fwStartBattery');
  });

  it('refuses a forged "verified" image and the HMI image', async () => {
    const forged = { ...img } as VerifiedFirmware;
    expect(() => fwStart(forged)).toThrow(/verified/);
    expect(checkFrame('command', fwStart(img), { firmware: forged })).toMatch(/verified controller image/);
    const hmi = await verifyFirmware(bundledBytes('EH02_Eagotech_5.19.zip'), 'hmi', { source: 'test', canonicalName: 'EH02_Eagotech_5.19.zip' });
    expect(hmi.ok).toBe(true);
    if (hmi.ok) expect(() => fwStart(hmi.firmware)).toThrow(/controller/);
  });
});

describe('everything else is refused', () => {
  it('every never-send opcode, in any shape, on either characteristic', () => {
    const r = rng(1);
    for (const op of Object.keys(NEVER_SEND).map(Number)) {
      for (let len = 1; len <= 20; len++) {
        const f = Uint8Array.from({ length: len }, (_, i) => (i === 0 ? op : Math.floor(r() * 256)));
        expect(checkFrame('command', f), `${hex(f)}`).toMatch(/never sent/);
        expect(checkFrame('block', f)).not.toBeNull();
        if (!HAS_FIRMWARE) continue;
        expect(checkFrame('command', f, { firmware: img })).not.toBeNull();
        expect(checkFrame('block', f, { firmware: img })).not.toBeNull();
      }
    }
    // the spec's list, explicitly (09 / 50 / 52: only inside the battery update, see below)
    for (const op of [0x2a, 0x2b, 0x1e, 0x20, 0x0b, 0x08, 0x0c, 0x01, 0x02, 0x04, 0x05, 0x06, 0x07, 0x2c]) {
      expect(NEVER_SEND[op]).toBeDefined();
    }
    for (const op of [0x09, 0x50, 0x52]) {
      for (let len = 1; len <= 20; len++) {
        const f = Uint8Array.from({ length: len }, (_, i) => (i === 0 ? op : Math.floor(r() * 256)));
        expect(checkFrame('command', f), hex(f)).toMatch(/only sent by the battery update/);
        expect(checkFrame('block', f)).not.toBeNull();
      }
    }
  });

  it('fuzz: a frame passes only if it is exactly one of the allowed frames', () => {
    const r = rng(42);
    const canonical = new Set([hex(mtuPageMode()), hex(liveLoop()), ...[1, 2, 3].map((t) => hex(dumpLog(t as 1 | 2 | 3)))]);
    const validOnce = (f: Uint8Array) => {
      try {
        const pages = [...f.subarray(1)].filter((x) => x !== 0);
        return bytesEqual(oncePages(pages), f);
      } catch {
        return false;
      }
    };
    const candidates: Uint8Array[] = [];
    // random frames for every opcode
    for (let op = 0; op < 256; op++) {
      for (let k = 0; k < 60; k++) {
        const len = 1 + Math.floor(r() * 24);
        candidates.push(Uint8Array.from({ length: len }, (_, i) => (i === 0 ? op : r() < 0.6 ? 0 : Math.floor(r() * 64))));
      }
    }
    // the valid frames, and every one-byte mutation, truncation and extension of them
    const valid = [mtuPageMode(), liveLoop(), dumpLog(1), dumpLog(2), dumpLog(3), oncePages([55]), oncePages(PAGES_IDENTITY), oncePages([54, 55, 56])];
    for (const v of valid) {
      candidates.push(v);
      for (let i = 0; i < v.length; i++) {
        for (const x of [0, 1, 0x29, 0x3d, 0x57, 0xff, (v[i]! + 1) & 0xff]) {
          const m = v.slice();
          m[i] = x;
          candidates.push(m);
        }
      }
      for (let n = 0; n < v.length; n++) candidates.push(v.slice(0, n));
      candidates.push(Uint8Array.from([...v, 0]), Uint8Array.from([...v, 1]));
    }
    let passed = 0;
    for (const f of candidates) {
      if (f.length && checkFrame('command', f) === null) {
        passed++;
        expect(canonical.has(hex(f)) || (f[0] === 0x3d && validOnce(f)), hex(f)).toBe(true);
      }
      expect(checkFrame('block', f)).not.toBeNull();
    }
    expect(passed).toBeGreaterThan(valid.length);
  });

  it.runIf(HAS_CAPTURES)('every frame the Python client sent in the captures: page/loop/MTU frames pass, 50/52 never outside the battery update', () => {
    for (const { hex: h } of captureTx) {
      const f = fromHex(h);
      const ok = checkFrame('command', f) === null;
      if (f[0] === 0x50 || f[0] === 0x52) expect(ok, h).toBe(false);
      else if (f[0] === 0x3d) {
        const pages = [...f.subarray(1)].filter((x) => x !== 0);
        expect(ok, h).toBe(pages.every((p) => ONCE_PAGES_ALLOWED.has(p)));
      } else expect(ok, h).toBe(true);
    }
    expect(captureTx.some((t) => t.hex.startsWith('52'))).toBe(true);
  });

  it('assertFrame throws ForbiddenFrameError with the reason', () => {
    expect(() => assertFrame('command', Uint8Array.of(0x2a, 1))).toThrow(ForbiddenFrameError);
    expect(() => assertFrame('command', Uint8Array.of(0x2a, 1))).toThrow(/LOG ERASE/);
    expect(() => assertFrame('command', new Uint8Array(0))).toThrow(/empty/);
  });

  it('frames.ts exports no other builders', () => {
    const fns = Object.entries(frames).filter(([, v]) => typeof v === 'function').map(([k]) => k).sort();
    expect(fns).toEqual([
      'ForbiddenFrameError', 'assertFrame', 'autoOff', 'bmsBlock', 'bmsEnd', 'bmsRead', 'bmsStart', 'bmsWake', 'canBus', 'checkFrame',
      'dumpLog', 'fwBlock', 'fwStart', 'liveLoop', 'mtuPageMode', 'oncePages',
    ]);
  });
});

describe('battery update frames (docs/DECISIONS.md 2026-11-20, PROTOCOL.md section 7)', () => {
  const read = { battery: { image: null } };

  it('the exact bytes', () => {
    expect(hex(canBus(true))).toBe('5001');
    expect(hex(canBus(false))).toBe('5000');
    expect(hex(bmsWake())).toBe('52' + '01010000' + '08' + '55aa55aa00000000');
    expect(hex(bmsRead(0x280))).toBe('52' + '80020000' + '08' + '0000000000000000');
    expect(hex(bmsRead(0x281))).toBe('52' + '81020000' + '08' + '0000000000000000');
    expect(hex(bmsRead(0x10f))).toBe('52' + '0f010000' + '08' + '0000000000000000');
    expect(hex(bmsStart())).toBe('52' + '45000000' + '08' + '000000004541474f'); // "....EAGO"
    expect(hex(bmsEnd())).toBe('52' + '49000000' + '08' + '0000000000000000');
    expect(hex(autoOff(0))).toBe('0900000000');
    expect(hex(autoOff(600))).toBe('0958020000');
    expect(() => autoOff(30)).toThrow(/0 or 60/);
    expect(() => bmsRead(0x282 as 0x280)).toThrow();
  });

  it('none of them without the battery-update context', () => {
    for (const f of [canBus(true), canBus(false), bmsWake(), bmsRead(0x280), bmsRead(0x281), bmsStart(), bmsEnd(), autoOff(0)]) {
      expect(checkFrame('command', f), hex(f)).toMatch(/only sent by the battery update/);
      expect(checkFrame('block', f)).not.toBeNull();
    }
  });

  it('reading the battery: bus access, wake, 0x280, 0x281 only; never start, end, 0x10F or a block', () => {
    for (const f of [canBus(true), canBus(false), bmsWake(), bmsRead(0x280), bmsRead(0x281), autoOff(0)]) expect(checkFrame('command', f, read), hex(f)).toBeNull();
    expect(checkFrame('command', bmsStart(), read)).toMatch(/only sent during a battery flash/);
    expect(checkFrame('command', bmsEnd(), read)).toMatch(/only sent during a battery flash/);
    expect(checkFrame('command', bmsRead(0x10f), read)).toMatch(/only sent during a battery flash/);
    expect(checkFrame('command', fromHex('52' + '47000000' + '08' + '5a89555557000000'), read)).toMatch(/only sent during a battery flash/);
  });

  it('fuzz: with the battery context, a 52 / 50 / 09 passes only if it is one of the exact frames', () => {
    const r = rng(7);
    const exact = new Set([canBus(true), canBus(false), bmsWake(), bmsRead(0x280), bmsRead(0x281), autoOff(0)].map(hex));
    const ids = [0x101, 0x10f, 0x280, 0x281, 0x282, 0x045, 0x046, 0x047, 0x048, 0x049, 0x04a, 0x005, 0x1b0, 0x273, 0x7ff];
    let passed = 0;
    for (let k = 0; k < 20_000; k++) {
      const pick = r();
      let f: Uint8Array;
      if (pick < 0.7) {
        const id = ids[Math.floor(r() * ids.length)]!;
        f = Uint8Array.of(0x52, id & 0xff, id >> 8, 0, 0, r() < 0.9 ? 8 : Math.floor(r() * 9), ...Array.from({ length: 8 }, () => (r() < 0.7 ? 0 : Math.floor(r() * 256))));
        if (r() < 0.2) f = f.subarray(0, Math.floor(r() * 14));
      } else if (pick < 0.85) {
        f = Uint8Array.of(0x50, Math.floor(r() * 3), ...(r() < 0.2 ? [0] : []));
      } else {
        f = Uint8Array.of(0x09, ...Array.from({ length: r() < 0.8 ? 4 : Math.floor(r() * 6) }, () => (r() < 0.6 ? 0 : Math.floor(r() * 256))));
      }
      if (f.length && checkFrame('command', f, read) === null) {
        passed++;
        expect(exact.has(hex(f)), hex(f)).toBe(true);
      }
    }
    expect(passed).toBeGreaterThan(10);
  });

  it('09: only 0, or the value read from page 5 before the update (60 s or more)', () => {
    expect(checkFrame('command', autoOff(600), read)).toMatch(/only set 0 or restore/);
    expect(checkFrame('command', autoOff(600), { battery: { image: null, autoOffRestore: 600 } })).toBeNull();
    expect(checkFrame('command', autoOff(900), { battery: { image: null, autoOffRestore: 600 } })).toMatch(/only set 0 or restore/);
    expect(checkFrame('command', fromHex('091e000000'), { battery: { image: null, autoOffRestore: 30 } })).toMatch(/only set 0 or restore/);
    expect(checkFrame('command', fromHex('09000000'), read)).toMatch(/exactly 5 bytes/);
  });

  it('a forged battery image is refused', () => {
    const forged = { entry: {}, info: {}, blockCount: 10 } as unknown as VerifiedBmsFirmware;
    expect(checkFrame('command', bmsStart(), { battery: { image: forged } })).toMatch(/verified battery image/);
    expect(() => bmsBlock(forged, 0)).toThrow(/verified/);
  });
});

describe.runIf(HAS_BMS_FIRMWARE)('battery update frames with the official image', () => {
  let rc: VerifiedBmsFirmware;
  let sc: VerifiedBmsFirmware;
  beforeAll(async () => {
    rc = await bundledBms('RC');
    sc = await bundledBms('SC');
  });

  it('0x047 carries exactly the block the updater is on, as stored', () => {
    const raw = bmsBytes('RC');
    const b0 = bmsBlock(rc, 0);
    expect(hex(b0)).toBe('52' + '47000000' + '08' + hex(raw.subarray(0, 8)));
    expect(hex(bmsBlock(rc, 13_416)).slice(-16)).toBe(hex(new TextEncoder().encode('010012RC')));
    const flash = (block?: number) => ({ battery: { image: rc, block } });
    expect(checkFrame('command', b0, flash(0))).toBeNull();
    expect(checkFrame('command', bmsBlock(rc, 5), flash(5))).toBeNull();
    expect(checkFrame('command', bmsBlock(rc, 5), flash(6))).toMatch(/isn't block 6/);
    expect(checkFrame('command', bmsBlock(rc, 5), flash())).toMatch(/no block is due/);
    expect(checkFrame('command', bmsBlock(rc, 5), flash(13_417))).toMatch(/no block is due/);
    // the other line's image never passes as this one's block
    expect(checkFrame('command', bmsBlock(sc, 5), flash(5))).toMatch(/isn't block 5/);
    const tampered = bmsBlock(rc, 9);
    tampered[8] ^= 0xff;
    expect(checkFrame('command', tampered, flash(9))).toMatch(/isn't block 9/);
    // start, end and 0x10F only during a flash
    for (const f of [bmsStart(), bmsEnd(), bmsRead(0x10f)]) expect(checkFrame('command', f, flash())).toBeNull();
  });
});
