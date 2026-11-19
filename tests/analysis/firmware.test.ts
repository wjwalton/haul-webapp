import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  ALLOWLIST, batteryReading, compareVersions, controllerReading, correctBatteryVersion, fileType, hmiReading,
  isVerifiedFirmware, LatestKnown, readFirmware, recheckFirmware, sha256Hex, swType, verifyFirmware,
} from '../../src/analysis/firmware';
import { bundledBytes, FIRMWARE_DIR, HAS_FIRMWARE, ROOT } from '../helpers';

const CONTROLLER_SHA = 'e7e308034972da1604a72676acc05fdb45bbbdbb15947ef88d99052a71e9f6e4';
const HMI_SHA = '1c8f1374bb929d8b8176fd19b8bf81726fe4bbf0b42939793dac8afd66d715d2';

describe('allowlist', () => {
  it('has exactly the two officially app-updatable images, full hashes', () => {
    expect(ALLOWLIST.map((e) => [e.component, e.fileName, e.version, e.model, e.sha256, e.size])).toEqual([
      ['hmi', 'EH02_Eagotech_5.19.zip', '5.19', 'EH02', HMI_SHA, 98_963],
      ['controller', 'M1B0306s0.bin', '03.06.s0', '1B', CONTROLLER_SHA, 81_920],
    ]);
    for (const e of ALLOWLIST) expect(e.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(ALLOWLIST)).toBe(true);
  });

  it('src/assets/firmware holds nothing but those two files (and its README)', () => {
    const names = existsSync(FIRMWARE_DIR) ? readdirSync(FIRMWARE_DIR).filter((f) => f !== 'README.md') : [];
    for (const f of names) expect(['EH02_Eagotech_5.19.zip', 'M1B0306s0.bin']).toContain(f);
  });

  it('file / SW types: M1B0306s0.bin -> s0, 03.06.s0 -> s0', () => {
    expect(fileType('M1B0306s0.bin')).toBe('s0');
    expect(swType('03.06.s0')).toBe('s0');
    expect(swType('03.06')).toBeNull();
    expect(swType(null)).toBeNull();
  });
});

describe.runIf(HAS_FIRMWARE)('the bundled images verify (hash check)', () => {
  it('controller M1B0306s0.bin', async () => {
    const b = bundledBytes('M1B0306s0.bin');
    expect(await sha256Hex(b)).toBe(CONTROLLER_SHA);
    const r = await verifyFirmware(b, 'controller', { source: 'bundled', canonicalName: 'M1B0306s0.bin', bundled: true });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.firmware.blockCount).toBe(10_240);
      expect(isVerifiedFirmware(r.firmware)).toBe(true);
      expect(await recheckFirmware(r.firmware)).toBe(true);
    }
  });

  it('HMI EH02_Eagotech_5.19.zip (application-only DFU package)', async () => {
    const r = await verifyFirmware(bundledBytes('EH02_Eagotech_5.19.zip'), 'hmi', { source: 'bundled', canonicalName: 'EH02_Eagotech_5.19.zip' });
    expect(r.ok, r.ok ? '' : r.report.reason!).toBe(true);
  });

  it('the reference copies match too (when reference/firmware is present)', async () => {
    for (const e of ALLOWLIST) {
      const p = join(ROOT, 'reference', 'firmware', e.fileName);
      if (!existsSync(p)) continue;
      expect(await sha256Hex(new Uint8Array(readFileSync(p)))).toBe(e.sha256);
    }
  });
});

describe.runIf(HAS_FIRMWARE)('rejections', () => {
  it('one flipped bit is rejected, by name and by hash', async () => {
    const b = bundledBytes('M1B0306s0.bin');
    b[40_000] ^= 1;
    const byName = await verifyFirmware(b, 'controller', { source: 't', canonicalName: 'M1B0306s0.bin' });
    expect(byName.ok).toBe(false);
    expect(byName.report.failedRule).toBe('SHA-256');
    const byHash = await verifyFirmware(b, 'controller', { source: 't' });
    expect(byHash.ok).toBe(false);
    expect(byHash.report.reason).toMatch(/isn't on the allowlist/);
  });

  it('a truncated file fails on size, a picked file is matched by hash and renamed', async () => {
    const b = bundledBytes('M1B0306s0.bin');
    const short = await verifyFirmware(b.subarray(0, 1000), 'controller', { source: 't', canonicalName: 'M1B0306s0.bin' });
    expect(short.report.failedRule).toBe('size');
    const picked = await verifyFirmware(b, 'controller', { source: 'file:x.bin', pickedName: 'x.bin' });
    expect(picked.ok).toBe(true);
    if (picked.ok) {
      expect(picked.firmware.entry.fileName).toBe('M1B0306s0.bin');
      expect(picked.firmware.notes[0]).toMatch(/Picked as "x.bin"/);
    }
  });

  it('the controller file offered as HMI firmware (and vice versa) says what it is', async () => {
    const r = await verifyFirmware(bundledBytes('M1B0306s0.bin'), 'hmi', { source: 't' });
    expect(r.ok).toBe(false);
    expect(r.report.reason).toMatch(/official controller file \(M1B0306s0.bin\)/);
  });

  it('the older M1B0260s0.bin is not flashable (no allowlist entry)', async () => {
    const p = join(ROOT, 'reference', 'firmware', 'M1B0260s0.bin');
    if (!existsSync(p)) return;
    const r = await verifyFirmware(new Uint8Array(readFileSync(p)), 'controller', { source: 'file:M1B0260s0.bin', pickedName: 'M1B0260s0.bin' });
    expect(r.ok).toBe(false);
  });

  it('oversized input is refused before hashing', async () => {
    const r = await verifyFirmware(new Uint8Array(4 * 1024 * 1024 + 1), 'controller', { source: 't' });
    expect(r.report.failedRule).toBe('read');
  });
});

describe.runIf(HAS_FIRMWARE)('the verified copy is private', () => {
  it('mutating the caller\'s buffer or a returned slice changes nothing', async () => {
    const b = bundledBytes('M1B0306s0.bin');
    const r = await verifyFirmware(b, 'controller', { source: 't', canonicalName: 'M1B0306s0.bin' });
    if (!r.ok) throw new Error('expected ok');
    b.fill(0);
    const slice = readFirmware(r.firmware, 0, 8);
    slice.fill(0);
    expect(readFirmware(r.firmware, 0, 8)).toEqual(bundledBytes('M1B0306s0.bin').subarray(0, 8));
    expect(await recheckFirmware(r.firmware)).toBe(true);
    expect(isVerifiedFirmware({ ...r.firmware })).toBe(false);
    expect(Object.isFrozen(r.firmware)).toBe(true);
  });
});

describe('HMI DFU package structure (Android FirmwareValidation)', () => {
  // These zips aren't on the allowlist, so structure is checked via the exported rule directly.
  it('accepts application-only packages and refuses bootloader/SoftDevice or extra files', async () => {
    const { structureProblem } = await import('../../src/analysis/firmware');
    const manifest = (m: object) => strToU8(JSON.stringify({ manifest: m }));
    const app = { application: { bin_file: 'application.bin', dat_file: 'application.dat' } };
    const ok = zipSync({ 'manifest.json': manifest(app), 'application.bin': Uint8Array.of(1), 'application.dat': Uint8Array.of(2) });
    expect(structureProblem('hmi', ok)).toBeNull();
    const withBootloader = zipSync({ 'manifest.json': manifest({ ...app, bootloader: {} }), 'application.bin': Uint8Array.of(1), 'application.dat': Uint8Array.of(2) });
    expect(structureProblem('hmi', withBootloader)).toMatch(/more than the application/);
    const extra = zipSync({ 'manifest.json': manifest(app), 'application.bin': Uint8Array.of(1), 'application.dat': Uint8Array.of(2), 'sd.bin': Uint8Array.of(3) });
    expect(structureProblem('hmi', extra)).toMatch(/exactly manifest.json/);
    const empty = zipSync({ 'manifest.json': manifest(app), 'application.bin': new Uint8Array(0), 'application.dat': Uint8Array.of(2) });
    expect(structureProblem('hmi', empty)).toMatch(/empty image/);
    expect(structureProblem('hmi', Uint8Array.of(1, 2, 3))).toMatch(/Not a readable DFU .zip/);
  });
});

describe('LatestKnown and verdicts (Android FirmwareVersions)', () => {
  it('one table: HMI 5.19, controller s0 -> 03.06.s0, battery SC 01.00.08 / RC 01.00.12', () => {
    expect(LatestKnown).toEqual({ hmi: '5.19', controllerByType: { s0: '03.06.s0' }, batteryByLine: { SC: '01.00.08', RC: '01.00.12' } });
    expect(Object.isFrozen(LatestKnown)).toBe(true);
    // the allowlisted files are the latest known
    expect(ALLOWLIST.find((e) => e.component === 'hmi')!.version).toBe(LatestKnown.hmi);
    expect(ALLOWLIST.find((e) => e.component === 'controller')!.version).toBe(LatestKnown.controllerByType.s0);
  });

  it('compares numbers as numbers, text as text, and refuses different shapes', () => {
    expect(compareVersions('03.06.s0', '3.6.s0')).toBe(0);
    expect(compareVersions('03.05.s0', '03.06.s0')).toBe(-1);
    expect(compareVersions('5.20', '5.19')).toBe(1);
    expect(compareVersions('03.06.s1', '03.06.s0')).toBe(1);
    expect(compareVersions('5.19', '03.06.s0')).toBeNull();
    expect(compareVersions('5.x', '5.19')).toBeNull();
  });

  it('HMI: DIS software revision, falling back to the firmware revision', () => {
    expect(hmiReading('5.19', '1.0').verdict).toBe('latest');
    expect(hmiReading('5.17', '1.0').verdict).toBe('older');
    expect(hmiReading('', '5.19').verdict).toBe('latest');
    expect(hmiReading(null, null)).toMatchObject({ verdict: 'unknown', label: 'not read' });
  });

  it('controller: judged against the latest for its own type suffix', () => {
    expect(controllerReading('03.06.s0').verdict).toBe('latest');
    expect(controllerReading('03.05.s0').verdict).toBe('older');
    expect(controllerReading('03.06.s1')).toMatchObject({ verdict: 'unknown' });
    expect(controllerReading('03.06.s1').label).toMatch(/type s1 isn't in the latest-known table/);
    expect(controllerReading('')).toMatchObject({ verdict: 'unknown', label: 'not read' });
  });

  it('battery: nibble-swap corrected (PROTOCOL.md), judged per line, raw kept', () => {
    expect(correctBatteryVersion('10.00.21.RC')).toBe('01.00.12 RC');
    expect(correctBatteryVersion('10.00.80.SC')).toBe('01.00.08 SC');
    expect(correctBatteryVersion('1.00.21.RC')).toBeNull();
    expect(batteryReading('10.00.21.RC')).toMatchObject({ raw: '10.00.21.RC', corrected: '01.00.12 RC', line: 'RC', verdict: 'latest' });
    expect(batteryReading('10.00.80.SC')).toMatchObject({ corrected: '01.00.08 SC', verdict: 'latest' });
    expect(batteryReading('10.00.50.SC')).toMatchObject({ corrected: '01.00.05 SC', verdict: 'older' });
    expect(batteryReading('10.00.21')).toMatchObject({ corrected: '01.00.12', line: null, verdict: 'unknown' });
    expect(batteryReading(undefined)).toMatchObject({ verdict: 'unknown', label: 'not read' });
  });
});
