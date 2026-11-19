/**
 * The two official images, when they are built into the app (src/assets/firmware/). They are NOT in
 * the git repo (Specialized's files): whoever builds the app drops them in locally, or builds without
 * them and the mechanic loads the file from disk (allowlist-only, docs/SPEC.md "Deployment").
 *
 * The glob names the two files exactly, so nothing else in that folder can ever be picked up, and a
 * missing file is simply absent (the build doesn't fail). Present files are emitted as separate
 * assets (never inlined), fetched from the app's own origin and verified like any picked file.
 */
import { verifyFirmware, type FirmwareComponent, type VerifyResult } from '../analysis/firmware';

const URLS = import.meta.glob<string>(
  ['../assets/firmware/M1B0306s0.bin', '../assets/firmware/EH02_Eagotech_5.19.zip'],
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

/** Load and verify the built-in image; null when this build has none. */
export async function loadBundledFirmware(component: FirmwareComponent): Promise<VerifyResult | null> {
  const name = NAMES[component];
  const url = BY_NAME.get(name);
  if (url === undefined) return null;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Couldn't load the built-in ${name} (HTTP ${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  return verifyFirmware(bytes, component, { source: `bundled:${name}`, canonicalName: name, bundled: true });
}
