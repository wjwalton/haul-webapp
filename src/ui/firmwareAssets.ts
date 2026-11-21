/**
 * The official images, when they are built into the app (src/assets/firmware/). They are NOT in the git
 * repo (Specialized's files): whoever builds the app drops them in locally, or builds without them and
 * the mechanic loads the file from disk (allowlist-only, docs/SPEC.md "Deployment").
 *
 * The glob names the files exactly (the controller and HMI images, and the two battery images,
 * docs/DECISIONS.md 2026-11-20), so nothing else in that folder can ever be picked up, and a missing file
 * is simply absent (the build doesn't fail). Present files are emitted as separate assets (never
 * inlined), fetched from the app's own origin and verified like any picked file.
 */
import { BMS_ALLOWLIST, verifyFirmware, type BmsLine, type FirmwareComponent, type VerifyResult } from '../analysis/firmware';
import { verifyBmsFirmware, type BmsVerifyResult } from '../analysis/bmsFirmware';

const URLS = import.meta.glob<string>(
  [
    '../assets/firmware/M1B0306s0.bin',
    '../assets/firmware/EH02_Eagotech_5.19.zip',
    '../assets/firmware/F.00.00G1.B.02.A12_V01.00.12.bin',
    '../assets/firmware/F.00.00G1.B.01.A08_V01.00.08.bin',
  ],
  { query: '?url', import: 'default', eager: true },
);

/** File name → emitted URL, for the images this build has. */
const BY_NAME = new Map(Object.entries(URLS).map(([path, url]) => [path.slice(path.lastIndexOf('/') + 1), url]));

const NAMES: Readonly<Record<FirmwareComponent, string>> = {
  controller: 'M1B0306s0.bin',
  hmi: 'EH02_Eagotech_5.19.zip',
};

export function bundledFirmwareName(component: FirmwareComponent): string {
  return NAMES[component];
}

/** Is this image built into the app? */
export function hasBundledFirmware(component: FirmwareComponent): boolean {
  return BY_NAME.has(NAMES[component]);
}

async function fetchBytes(name: string, url: string): Promise<Uint8Array> {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Couldn't load the built-in ${name} (HTTP ${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Load and verify the built-in image; null when this build has none. */
export async function loadBundledFirmware(component: FirmwareComponent): Promise<VerifyResult | null> {
  const name = NAMES[component];
  const url = BY_NAME.get(name);
  if (url === undefined) return null;
  return verifyFirmware(await fetchBytes(name, url), component, { source: `bundled:${name}`, canonicalName: name, bundled: true });
}

function bmsName(line: BmsLine): string {
  return BMS_ALLOWLIST.find((e) => e.line === line)!.fileName;
}

export function hasBundledBms(line: BmsLine): boolean {
  return BY_NAME.has(bmsName(line));
}

/** Load and verify the built-in battery image for [line]; null when this build has none. */
export async function loadBundledBms(line: BmsLine): Promise<BmsVerifyResult | null> {
  const name = bmsName(line);
  const url = BY_NAME.get(name);
  if (url === undefined) return null;
  return verifyBmsFirmware(await fetchBytes(name, url), { source: `bundled:${name}`, canonicalName: name, bundled: true });
}
