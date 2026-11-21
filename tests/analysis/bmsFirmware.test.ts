/**
 * Battery (BMS) images: the record parser (a port of globe-bms-flasher's firmware.py) on synthetic
 * images everywhere, and the two official files (git-ignored) when they're present: allowlist by full
 * SHA-256, version and line read from the file itself, PROTOCOL.md's record / block counts.
 */
import { describe, expect, it } from 'vitest';
import { BMS_ALLOWLIST, LatestKnown } from '../../src/analysis/firmware';
import {
  BMS_HW_TYPE, isVerifiedBms, lineOfHwType, parseBmsImage, parseBmsVersion, readBmsBlock, recheckBmsFirmware, verifyBmsFirmware,
} from '../../src/analysis/bmsFirmware';
import { bmsBytes, bundledBms, bundledBytes, HAS_BMS_FIRMWARE, HAS_FIRMWARE, syntheticBmsImage } from '../helpers';

const RC_SHA = '2c3821a26eae19ed3d276ab43b97dbf5564d3825327baf2d69f7c21a5832d751';
const SC_SHA = 'aae2884bbe92492dd2956221650b82f755a3ad9d863ce55b24203166a8174465';

describe('battery allowlist', () => {
  it('exactly the two official images, full hashes, and they are the latest known per line', () => {
    expect(BMS_ALLOWLIST.map((e) => [e.line, e.fileName, e.version, e.sha256, e.size])).toEqual([
      ['RC', 'F.00.00G1.B.02.A12_V01.00.12.bin', '01.00.12', RC_SHA, 107_336],
      ['SC', 'F.00.00G1.B.01.A08_V01.00.08.bin', '01.00.08', SC_SHA, 108_728],
    ]);
    expect(Object.isFrozen(BMS_ALLOWLIST)).toBe(true);
    for (const e of BMS_ALLOWLIST) expect(LatestKnown.batteryByLine[e.line]).toBe(e.version);
  });

  it('hardware types: SC = 1, RC = 2 (0x281 byte 2)', () => {
    expect(BMS_HW_TYPE).toEqual({ SC: 1, RC: 2 });
    expect([lineOfHwType(1), lineOfHwType(2), lineOfHwType(0), lineOfHwType(null)]).toEqual(['SC', 'RC', null, null]);
  });

  it('0x280 replies: 8 ASCII bytes', () => {
    expect(parseBmsVersion(new TextEncoder().encode('010009RC'))).toEqual({ version: '01.00.09', line: 'RC' });
    expect(parseBmsVersion(new Uint8Array(8))).toBeNull();
    expect(parseBmsVersion(new TextEncoder().encode('0100'))).toBeNull();
  });
});

describe('record parser (firmware.py)', () => {
  it('a well-formed image: line, version, header fields, blocks', () => {
    const img = syntheticBmsImage(3, 'RC', '010012');
    const r = parseBmsImage(img);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.info).toMatchObject({ line: 'RC', version: '01.00.12', versionAscii: '010012RC', records: 4, payloadSize: 512, buildDate: '2022-07-12', blocks: img.length / 8 });
    expect(r.info.project).toBe('KG EBIKE-48_RL78');
    expect(parseBmsImage(syntheticBmsImage(2, 'SC', '010008'))).toMatchObject({ ok: true, info: { line: 'SC', version: '01.00.08' } });
  });

  it('refuses every kind of damage', () => {
    const base = syntheticBmsImage(3);
    const bad = (mutate: (b: Uint8Array) => Uint8Array | void) => {
      const b = base.slice();
      const r = parseBmsImage(mutate(b) ?? b);
      return r.ok ? 'OK' : r.reason;
    };
    expect(bad((b) => void (b[139 + 50] ^= 1))).toMatch(/checksum mismatch/);
    expect(bad((b) => void (b[139 + 138] = 0x68))).toMatch(/end marker/);
    expect(bad((b) => void (b[139 * 2 + 6] = 0x10))).toMatch(/address/);
    expect(bad((b) => b.subarray(0, b.length - 8))).toMatch(/trailer|record/);
    expect(bad((b) => b.subarray(0, b.length - 3))).toMatch(/multiple of 8/);
    expect(bad((b) => void b.set(new TextEncoder().encode('0100XXRC'), b.length - 8))).toMatch(/NNNNNNRC/);
    expect(bad((b) => void b.set(new TextEncoder().encode('010012XC'), b.length - 8))).toMatch(/NNNNNNRC/);
    expect(bad((b) => void (b[b.length - 9] = 1))).toMatch(/Non-zero bytes/);
    // the header says RL78 (RC) but the trailer says SC
    expect(bad((b) => void b.set(new TextEncoder().encode('010012SC'), b.length - 8))).toMatch(/mixed-up/);
    // header payload size wrong (re-checksummed so only that rule fires)
    expect(bad((b) => {
      b[9 + 0x15] = 0x05;
      let x = 0;
      for (let i = 1; i < 137; i++) x ^= b[i]!;
      b[137] = x;
    })).toMatch(/payload bytes/);
    expect(parseBmsImage(new Uint8Array(1000)).ok).toBe(false);
  });

  it.runIf(HAS_FIRMWARE)('the controller image is not a battery image', () => {
    expect(parseBmsImage(bundledBytes('M1B0306s0.bin'))).toMatchObject({ ok: false, reason: expect.stringMatching(/not a battery/) });
  });

  it('a synthetic (unlisted) image never verifies, however well-formed', async () => {
    const r = await verifyBmsFirmware(syntheticBmsImage(3), { source: 'test' });
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/isn't one of the two official battery images/) });
    expect(isVerifiedBms({})).toBe(false);
  });
});

describe.runIf(HAS_BMS_FIRMWARE)('the official battery images (PROTOCOL.md)', () => {
  it('RC 01.00.12: Renesas RL78 platform, 772 records, 13,417 blocks, built 2022-07-12', async () => {
    const fw = await bundledBms('RC');
    expect(fw.sha256).toBe(RC_SHA);
    expect(fw.info).toMatchObject({ line: 'RC', version: '01.00.12', versionAscii: '010012RC', records: 772, blocks: 13_417, buildDate: '2022-07-12' });
    expect(fw.info.project).toMatch(/RL78/);
    expect(fw.blockCount).toBe(13_417);
    expect(fw.info.imageCheck).toBe(0x62f508a3);
    expect(await recheckBmsFirmware(fw)).toBe(true);
    // blocks are the file as stored, 8 bytes each, header and trailer included
    const raw = bmsBytes('RC');
    expect(readBmsBlock(fw, 0)).toEqual(raw.subarray(0, 8));
    expect(new TextDecoder().decode(readBmsBlock(fw, 13_416))).toBe('010012RC');
    expect(() => readBmsBlock(fw, 13_417)).toThrow();
  });

  it('SC 01.00.08: ARM Cortex-M platform (SBC_EBIKE_BMUV1), 782 records, 13,591 blocks, built 2025-03-18', async () => {
    const fw = await bundledBms('SC');
    expect(fw.sha256).toBe(SC_SHA);
    expect(fw.info).toMatchObject({ line: 'SC', version: '01.00.08', records: 782, blocks: 13_591, buildDate: '2025-03-18' });
    expect(fw.info.description).toMatch(/SBC_EBIKE_BMUV1/);
  });

  it('a picked file is found by hash; one flipped bit is refused; a forged wrapper is not verified', async () => {
    const picked = await verifyBmsFirmware(bmsBytes('SC'), { source: 'disk:x.bin', pickedName: 'x.bin' });
    expect(picked.ok && picked.firmware.entry.line).toBe('SC');
    expect(picked.ok && picked.firmware.notes[0]).toMatch(/contents match F\.00\.00G1\.B\.01\.A08_V01\.00\.08\.bin/);
    const b = bmsBytes('RC');
    b[50_000] ^= 1;
    expect(await verifyBmsFirmware(b, { source: 't' })).toMatchObject({ ok: false, reason: expect.stringMatching(/allowlist/) });
    expect(await verifyBmsFirmware(b, { source: 't', canonicalName: 'F.00.00G1.B.02.A12_V01.00.12.bin' })).toMatchObject({ ok: false, reason: expect.stringMatching(/SHA-256/) });
    const fw = await bundledBms('RC');
    const forged = { ...fw };
    expect(isVerifiedBms(forged)).toBe(false);
    expect(() => readBmsBlock(forged, 0)).toThrow(/verified/);
  });

  it.runIf(HAS_FIRMWARE)('the controller and HMI images are refused as battery firmware', async () => {
    expect((await verifyBmsFirmware(bundledBytes('M1B0306s0.bin'), { source: 't' })).ok).toBe(false);
    expect((await verifyBmsFirmware(bundledBytes('EH02_Eagotech_5.19.zip'), { source: 't' })).ok).toBe(false);
  });
});
