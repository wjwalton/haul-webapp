import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyFirmware, type VerifiedFirmware } from '../src/analysis/firmware';
import { verifyBmsFirmware, type VerifiedBmsFirmware } from '../src/analysis/bmsFirmware';
import { RENAMED_FROM_PYTHON } from '../src/protocol/pages';
import { parseRawJsonl, type RawRecord } from '../src/export/rawJsonl';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURES = join(ROOT, 'tests', 'fixtures');

/** Real captures (the owner's bike) and what make_fixtures.py derives from them. Git-ignored: personal. */
export const CAPTURES = join(FIXTURES, 'captures');
export const HAS_CAPTURES = existsSync(CAPTURES) && readdirSync(CAPTURES).some((f) => f.endsWith('_raw.jsonl'));
/** The two official images. Git-ignored (Specialized's files): supplied separately, see README.md. */
export const FIRMWARE_DIR = join(ROOT, 'src', 'assets', 'firmware');
export const HAS_FIRMWARE = ['M1B0306s0.bin', 'EH02_Eagotech_5.19.zip'].every((f) => existsSync(join(FIRMWARE_DIR, f)));

/** The two official battery (BMS) images, also git-ignored (docs/DECISIONS.md 2026-11-20). */
export const BMS_FILES = { RC: 'F.00.00G1.B.02.A12_V01.00.12.bin', SC: 'F.00.00G1.B.01.A08_V01.00.08.bin' } as const;
export const HAS_BMS_FIRMWARE = Object.values(BMS_FILES).every((f) => existsSync(join(FIRMWARE_DIR, f)));

export function bmsBytes(line: 'RC' | 'SC'): Uint8Array {
  return new Uint8Array(readFileSync(join(FIRMWARE_DIR, BMS_FILES[line])));
}

export async function bundledBms(line: 'RC' | 'SC'): Promise<VerifiedBmsFirmware> {
  const r = await verifyBmsFirmware(bmsBytes(line), { source: `bundled:${BMS_FILES[line]}`, canonicalName: BMS_FILES[line], bundled: true });
  if (!r.ok) throw new Error(`bundled battery image rejected: ${r.reason}`);
  return r.firmware;
}

/**
 * A synthetic image in the official record format (PROTOCOL.md), for parser and state-machine tests
 * that must run without the real files. [records] payload records after the header.
 */
export function syntheticBmsImage(records = 3, line: 'RC' | 'SC' = 'RC', version = '010012'): Uint8Array {
  const recs: Uint8Array[] = [];
  const n = records + 1;
  for (let k = 0; k < n; k++) {
    const r = new Uint8Array(139);
    r.set([0x5a, 0x89, 0x55, 0x55, 0x57], 0);
    const addr = k * 128;
    r.set([addr & 0xff, (addr >>> 8) & 0xff, (addr >>> 16) & 0xff, (addr >>> 24) & 0xff], 5);
    const payload = r.subarray(9, 137);
    if (k === 0) {
      payload.set(new TextEncoder().encode(line === 'RC' ? 'KG EBIKE-48_RL78' : 'KG 48V E-Bike FW'), 0);
      const size = n * 128;
      payload.set([size & 0xff, (size >>> 8) & 0xff, (size >>> 16) & 0xff, (size >>> 24) & 0xff], 0x14);
      payload.set([0x12, 0x07, 0x22, 0x20], 0x18);
      payload.set(new TextEncoder().encode(line === 'RC' ? 'kg ebIKE-48_RL78E-Bike Project' : 'kg 48v e-BIKE fwSBC_EBIKE_BMUV1'), 0x30);
    } else {
      for (let i = 0; i < 128; i++) payload[i] = (k * 31 + i * 7) & 0xff;
    }
    let x = 0;
    for (let i = 1; i < 137; i++) x ^= r[i]!;
    r[137] = x;
    r[138] = 0x69;
    recs.push(r);
  }
  const body = recs.length * 139;
  const total = Math.ceil((body + 8) / 8) * 8;
  const out = new Uint8Array(total);
  recs.forEach((r, k) => out.set(r, k * 139));
  out.set(new TextEncoder().encode(`${version}${line}`), total - 8);
  return out;
}

export function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as T;
}

/** A capture-derived fixture (tests/fixtures/captures/py_capture_*.json); null when the captures are absent. */
export function captureFixture<T>(name: string): T | null {
  const p = join(CAPTURES, name);
  return HAS_CAPTURES && existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as T) : null;
}

export function captureNames(): string[] {
  return HAS_CAPTURES ? readdirSync(CAPTURES).filter((f) => f.endsWith('_raw.jsonl')).sort() : [];
}

export function capture(name: string): RawRecord[] {
  return parseRawJsonl(readFileSync(join(CAPTURES, name), 'utf8'));
}

export function bundledBytes(name: 'M1B0306s0.bin' | 'EH02_Eagotech_5.19.zip'): Uint8Array {
  return new Uint8Array(readFileSync(join(FIRMWARE_DIR, name)));
}

export async function bundledController(): Promise<VerifiedFirmware> {
  const r = await verifyFirmware(bundledBytes('M1B0306s0.bin'), 'controller', {
    source: 'bundled:M1B0306s0.bin', canonicalName: 'M1B0306s0.bin', bundled: true,
  });
  if (!r.ok) throw new Error(`bundled controller image rejected: ${r.report.reason}`);
  return r.firmware;
}

/** Python field names -> this app's, through the ONE documented list (pages.ts DEVIATIONS). */
export function pyToTs(py: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(py)) {
    if (k === 'walk_mode') continue; // DEVIATIONS: no walk mode on this bike
    out[(RENAMED_FROM_PYTHON as Record<string, string>)[k] ?? k] = v;
  }
  return out;
}
