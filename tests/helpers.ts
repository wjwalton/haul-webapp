import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyFirmware, type VerifiedFirmware } from '../src/analysis/firmware';
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
