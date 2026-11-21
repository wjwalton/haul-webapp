/**
 * Firmware files: the SHA-256 allowlist and the validation gate. Ported from the Android app
 * (firmware/FirmwareAllowlist.kt, FirmwareValidation.kt, FirmwareVerifier.kt).
 *
 * Controller and HMI: the two official images in ALLOWLIST. Battery: the two official BMS images in
 * BMS_ALLOWLIST (docs/DECISIONS.md 2026-11-20), validated by analysis/bmsFirmware.ts. The older
 * M1B0260s0.bin, the dealer tool and the stock APK have no entry and no code path.
 *
 * A file becomes flashable only as a VerifiedFirmware returned by verifyFirmware(): its bytes are a
 * private copy that nothing outside this module can modify, and protocol/frames.ts builds 0x46/0x47
 * frames only from a VerifiedFirmware. recheckFirmware() re-hashes that copy right before a flash.
 */
import { unzipSync } from 'fflate';

export type FirmwareComponent = 'controller' | 'hmi';

export interface AllowedFirmware {
  readonly component: FirmwareComponent;
  /** The official file name. Controller: chars 1, 2, 7 are the 0x46 version bytes. */
  readonly fileName: string;
  /** What the bike reports afterwards (HMI: DIS sw rev; controller: identity page 19). */
  readonly version: string;
  /** HMI: advertised name prefix. Controller: identity page 18 (ctrl_model). */
  readonly model: string;
  /** Full lowercase SHA-256 of the whole file. Never shortened. */
  readonly sha256: string;
  readonly size: number;
}

/** THE allowlist (same entries as the Android app's assets/firmware_allowlist.txt). Edit only by hand. */
export const ALLOWLIST: readonly AllowedFirmware[] = Object.freeze([
  Object.freeze<AllowedFirmware>({
    component: 'hmi',
    fileName: 'EH02_Eagotech_5.19.zip',
    version: '5.19',
    model: 'EH02',
    sha256: '1c8f1374bb929d8b8176fd19b8bf81726fe4bbf0b42939793dac8afd66d715d2',
    size: 98_963,
  }),
  Object.freeze<AllowedFirmware>({
    component: 'controller',
    fileName: 'M1B0306s0.bin',
    version: '03.06.s0',
    model: '1B',
    sha256: 'e7e308034972da1604a72676acc05fdb45bbbdbb15947ef88d99052a71e9f6e4',
    size: 81_920,
  }),
]);

/** The battery's two BMS platforms (PROTOCOL.md "Battery (BMS) firmware images"). */
export type BmsLine = 'RC' | 'SC';

/** One official battery (BMS) image. Its version and line are also read from the file itself. */
export interface AllowedBmsFirmware {
  readonly line: BmsLine;
  /** Specialized's file name (for the screen only: nothing is derived from it). */
  readonly fileName: string;
  /** "01.00.12": what the BMS answers on 0x280 afterwards, and page 24 nibble-swapped. */
  readonly version: string;
  /** Full lowercase SHA-256 of the whole file. Never shortened. */
  readonly sha256: string;
  readonly size: number;
}

/**
 * THE battery allowlist (docs/DECISIONS.md 2026-11-20, PROTOCOL.md "Battery (BMS) firmware images"):
 * the two official BMS images. They are different CPUs (RC = Renesas RL78, SC = ARM Cortex-M), so the
 * line is checked against the battery before anything is sent. Edit only by hand.
 */
export const BMS_ALLOWLIST: readonly AllowedBmsFirmware[] = Object.freeze([
  Object.freeze<AllowedBmsFirmware>({
    line: 'RC',
    fileName: 'F.00.00G1.B.02.A12_V01.00.12.bin',
    version: '01.00.12',
    sha256: '2c3821a26eae19ed3d276ab43b97dbf5564d3825327baf2d69f7c21a5832d751',
    size: 107_336,
  }),
  Object.freeze<AllowedBmsFirmware>({
    line: 'SC',
    fileName: 'F.00.00G1.B.01.A08_V01.00.08.bin',
    version: '01.00.08',
    sha256: 'aae2884bbe92492dd2956221650b82f755a3ad9d863ce55b24203166a8174465',
    size: 108_728,
  }),
]);

/** Both official files are ~100 KB; anything this big isn't one of them (checked before hashing). */
export const MAX_FIRMWARE_BYTES = 4 * 1024 * 1024;
/** The SDK refuses shorter controller file names (it reads version bytes up to index 7). */
export const FW_NAME_MIN_LENGTH = 13;
export const FW_BLOCK_SIZE = 8;
export const MAX_FW_BLOCKS = 0xffff;

export function fwBlockCount(size: number): number {
  return Math.ceil(size / FW_BLOCK_SIZE);
}

/** Controller image type = the file name after its 7-char model/version prefix: M1B0306s0.bin -> s0. */
export function fileType(fileName: string): string | null {
  const stem = fileName.includes('.') ? fileName.slice(0, fileName.lastIndexOf('.')) : fileName;
  return stem.length > 7 ? stem.slice(7) : null;
}

/** The controller's type = 3rd field of its SW version (identity page 19): 03.06.s0 -> s0. */
export function swType(sw: string | null | undefined): string | null {
  const t = sw?.trim().split('.')[2];
  return t ? t : null;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, '0')).join('');
}

export type FirmwareRule = 'read' | 'allowlist entry' | 'size' | 'SHA-256' | 'file name / type rule' | 'version bytes' | 'file structure';

/** Everything the validator looked at, so a rejection says WHY. failedRule null = valid. */
export interface ValidationReport {
  component: FirmwareComponent;
  /** "bundled:M1B0306s0.bin" or "file:<picked name>". */
  source: string;
  canonicalName: string | null;
  size: number;
  expectedSize: number | null;
  sha256: string | null;
  expectedSha256: string | null;
  failedRule: FirmwareRule | null;
  reason: string | null;
}

/** A file that passed every rule. Its bytes live in this module only (see readFirmware). */
export interface VerifiedFirmware {
  readonly entry: AllowedFirmware;
  readonly sha256: string;
  readonly size: number;
  readonly blockCount: number;
  readonly source: string;
  /** The official image shipped inside the app (src/assets/firmware/), not a picked file. */
  readonly bundled: boolean;
  /** e.g. "Picked as "x.bin"; the contents match M1B0306s0.bin, so that name is used." */
  readonly notes: readonly string[];
}

const PRIVATE_BYTES = new WeakMap<VerifiedFirmware, Uint8Array>();

export function isVerifiedFirmware(x: unknown): x is VerifiedFirmware {
  return typeof x === 'object' && x !== null && PRIVATE_BYTES.has(x as VerifiedFirmware);
}

/** A copy of bytes [start, end) of a verified image (the private copy is never handed out). */
export function readFirmware(v: VerifiedFirmware, start = 0, end?: number): Uint8Array {
  const b = PRIVATE_BYTES.get(v);
  if (!b) throw new Error('Not a verified firmware image');
  return b.slice(start, end ?? b.length);
}

export type VerifyResult =
  | { ok: true; firmware: VerifiedFirmware; report: ValidationReport }
  | { ok: false; report: ValidationReport };

/**
 * Validate [bytes] as [component] firmware. With [canonicalName] (a bundled file) the entry is looked
 * up by that name and the bytes must match ITS size and hash; without (a picked file, whose name means
 * nothing) the entry is found by hash. Either way every later rule runs on the entry's canonical name.
 */
export async function verifyFirmware(
  input: Uint8Array,
  component: FirmwareComponent,
  opts: { source: string; canonicalName?: string; pickedName?: string; bundled?: boolean },
): Promise<VerifyResult> {
  const base = {
    component, source: opts.source, canonicalName: opts.canonicalName ?? null, size: input.length,
    expectedSize: null, sha256: null, expectedSha256: null,
  } satisfies Partial<ValidationReport>;
  const fail = (rule: FirmwareRule, reason: string, extra: Partial<ValidationReport> = {}): VerifyResult =>
    ({ ok: false, report: { ...base, ...extra, failedRule: rule, reason } });

  if (input.length > MAX_FIRMWARE_BYTES) {
    return fail('read', `File is too large to be firmware (over ${MAX_FIRMWARE_BYTES / 1024 / 1024} MB)`);
  }
  // Our own copy first: the caller's buffer may change after this point; the hash is of this copy.
  const bytes = input.slice();
  const sha = await sha256Hex(bytes);
  let entry: AllowedFirmware | undefined;
  if (opts.canonicalName !== undefined) {
    entry = ALLOWLIST.find((e) => e.component === component && e.fileName === opts.canonicalName);
    if (!entry) return fail('allowlist entry', `No ${component} allowlist entry named ${opts.canonicalName}`, { sha256: sha });
    const known = { canonicalName: entry.fileName, expectedSize: entry.size, sha256: sha, expectedSha256: entry.sha256 };
    if (bytes.length !== entry.size) {
      const hint = looksLikeLfsPointer(bytes) ? ' (it is a Git LFS pointer, not the firmware)' : bytes.length === 0 ? ' (empty)' : '';
      return fail('size', `Size is ${bytes.length} bytes, expected ${entry.size}${hint}`, known);
    }
    if (sha !== entry.sha256) return fail('SHA-256', `SHA-256 doesn't match the allowlist entry for ${entry.fileName}`, known);
  } else {
    entry = ALLOWLIST.find((e) => e.component === component && e.sha256 === sha);
    if (!entry) {
      const other = ALLOWLIST.find((e) => e.sha256 === sha);
      const expected = ALLOWLIST.filter((e) => e.component === component);
      return fail(
        'SHA-256',
        other
          ? `This is the official ${other.component} file (${other.fileName}), not ${component} firmware.`
          : "This file isn't a recognized official firmware. Its SHA-256 isn't on the allowlist, so it won't be flashed.",
        { sha256: sha, expectedSha256: expected.map((e) => e.sha256).join(' or ') || null, expectedSize: expected.length === 1 ? expected[0]!.size : null },
      );
    }
    if (bytes.length !== entry.size) {
      return fail('size', `Size is ${bytes.length} bytes, expected ${entry.size}`, {
        canonicalName: entry.fileName, expectedSize: entry.size, sha256: sha, expectedSha256: entry.sha256,
      });
    }
  }
  const known: Partial<ValidationReport> = { canonicalName: entry.fileName, expectedSize: entry.size, sha256: sha, expectedSha256: entry.sha256 };
  const nameProblem = fileNameProblem(component, entry.fileName);
  if (nameProblem) return fail('file name / type rule', `Allowlist entry is malformed: ${nameProblem}`, known);
  if (component === 'controller') {
    const vb = versionBytesProblem(entry);
    if (vb) return fail('version bytes', vb, known);
  }
  const structure = structureProblem(component, bytes);
  if (structure) return fail('file structure', structure, known);

  const notes: string[] = [];
  if (opts.pickedName !== undefined && opts.pickedName !== entry.fileName) {
    notes.push(`Picked as "${opts.pickedName}"; the contents match ${entry.fileName}, so that name is used.`);
  }
  const firmware: VerifiedFirmware = Object.freeze({
    entry, sha256: sha, size: bytes.length, blockCount: fwBlockCount(bytes.length),
    source: opts.source, bundled: opts.bundled ?? false, notes: Object.freeze(notes),
  });
  PRIVATE_BYTES.set(firmware, bytes);
  return { ok: true, firmware, report: { ...base, ...known, failedRule: null, reason: null } as ValidationReport };
}

/**
 * Right before flashing: hash the private copy again and re-run every rule against the same entry.
 * False if anything changed (it can't, short of a bug, which is exactly what this catches).
 */
export async function recheckFirmware(v: VerifiedFirmware): Promise<boolean> {
  const b = PRIVATE_BYTES.get(v);
  if (!b) return false;
  const r = await verifyFirmware(b, v.entry.component, { source: `recheck:${v.source}`, canonicalName: v.entry.fileName });
  return r.ok && r.firmware.sha256 === v.sha256 && r.firmware.entry === v.entry && v.sha256 === v.entry.sha256;
}

const CONTROLLER_NAME = /^[A-Za-z0-9]{9,}\.bin$/;

/** Structural check on an official file name; null when it's fine. */
export function fileNameProblem(component: FirmwareComponent, name: string): string | null {
  if (component === 'hmi') return name.toLowerCase().endsWith('.zip') ? null : 'HMI firmware must be a Nordic DFU .zip';
  if (name.length < FW_NAME_MIN_LENGTH) return `controller file name must be at least ${FW_NAME_MIN_LENGTH} characters`;
  if (!CONTROLLER_NAME.test(name)) return 'controller file name must look like M1B0306s0.bin';
  return null;
}

/** SDK: version bytes = file name chars at index 1, 2 and 7 (M1B0306s0.bin -> '1', 'B', 's'). */
export function fwVersionBytes(fileName: string): [number, number, number] {
  if (fileName.length < FW_NAME_MIN_LENGTH) throw new Error(`Firmware file name must be at least ${FW_NAME_MIN_LENGTH} characters`);
  if ([...fileName].some((c) => c.charCodeAt(0) < 0x21 || c.charCodeAt(0) > 0x7e)) throw new Error('Firmware file name must be plain ASCII');
  return [fileName.charCodeAt(1), fileName.charCodeAt(2), fileName.charCodeAt(7)];
}

function versionBytesProblem(entry: AllowedFirmware): string | null {
  try {
    fwVersionBytes(entry.fileName);
  } catch (e) {
    return (e as Error).message;
  }
  const name = entry.fileName;
  if (name.slice(1, 3) !== entry.model) return `File name chars 1-2 (${name.slice(1, 3)}) don't match model ${entry.model}`;
  const ft = fileType(name);
  const st = swType(entry.version);
  if (ft === null || ft !== st) return `File type "${ft}" doesn't match the version's type "${st}"`;
  return null;
}

const HMI_ENTRIES = ['application.bin', 'application.dat', 'manifest.json'];

export function structureProblem(component: FirmwareComponent, bytes: Uint8Array): string | null {
  if (component === 'controller') {
    if (bytes.length === 0) return 'The file is empty';
    if (fwBlockCount(bytes.length) > MAX_FW_BLOCKS) return 'Too many blocks for the update protocol';
    return null;
  }
  return hmiZipProblem(bytes);
}

/** Nordic DFU package with an application image only: manifest.json + application.bin + application.dat. */
function hmiZipProblem(bytes: Uint8Array): string | null {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch (e) {
    return `Not a readable DFU .zip (${(e as Error).message})`;
  }
  const names = Object.keys(files).filter((n) => !n.endsWith('/')).sort();
  if (names.join('|') !== HMI_ENTRIES.join('|')) {
    return `Not the expected DFU package: it must contain exactly manifest.json, application.bin and application.dat (found ${names.join(', ')})`;
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']))?.manifest;
  } catch {
    return 'The DFU manifest is not valid JSON';
  }
  const m = manifest as Record<string, unknown> | undefined;
  const app = m?.application as Record<string, unknown> | undefined;
  if (!m || typeof m !== 'object' || Object.keys(m).join() !== 'application' || !app || typeof app !== 'object') {
    return 'The DFU manifest updates more than the application (bootloader/SoftDevice updates aren\'t allowed)';
  }
  if (app.bin_file !== 'application.bin' || app.dat_file !== 'application.dat') {
    return "The DFU manifest doesn't point at application.bin / application.dat";
  }
  if (files['application.bin']!.length === 0 || files['application.dat']!.length === 0) {
    return 'The DFU package has an empty image or init packet';
  }
  return null;
}

/** A Git LFS pointer checked in instead of the binary: a ~130-byte text file. */
export function looksLikeLfsPointer(bytes: Uint8Array): boolean {
  return bytes.length < 1024 && new TextDecoder('ascii').decode(bytes).startsWith('version https://git-lfs');
}

/** The rejection text the screen shows: the reason plus the numbers behind it. */
export function reasonText(r: ValidationReport): string {
  return [
    r.reason ?? 'Not valid',
    `Rule: ${r.failedRule ?? '-'} · Source: ${r.source}`,
    `Bytes: ${r.size}${r.expectedSize != null ? ` (expected ${r.expectedSize})` : ''}`,
    `SHA-256: ${r.sha256 ?? '-'}`,
    ...(r.expectedSha256 ? [`Expected: ${r.expectedSha256}`] : []),
  ].join('\n');
}

// ---- LatestKnown and version verdicts (Android analysis/FirmwareVersions.kt) -----------------

/**
 * THE "latest known" table, the only place versions are judged against (docs/SPEC.md "Report" 2).
 * There is no update server, so "latest" means the newest official file known to exist (PROTOCOL.md):
 * HMI EH02_Eagotech_5.19.zip; controller by SW type suffix (s0 -> M1B0306s0.bin = 03.06.s0); battery
 * by line, compared after the nibble-swap correction (dealer update only). Change a version here only.
 */
export const LatestKnown = Object.freeze({
  hmi: '5.19',
  controllerByType: Object.freeze({ s0: '03.06.s0' }) as Readonly<Record<string, string>>,
  batteryByLine: Object.freeze({ SC: '01.00.08', RC: '01.00.12' }) as Readonly<Record<string, string>>,
});

/** A part's processor, as far as its official firmware shows it. */
export interface ChipInfo {
  readonly chip: string;
  /** A qualifier worth showing beside it (a probable part number, the BMS hardware type), or null. */
  readonly note: string | null;
}

/**
 * THE chip table, the only place a part's processor is named. The bike reports versions, never a
 * chip: each entry is the processor that part's official firmware is built for (PROTOCOL.md: the HMI
 * 5.19 image is an nRF52832 application; "Controller hardware and firmware image"; "Battery (BMS)
 * firmware images"). The battery comes on two BMS platforms, told apart by the line suffix of its
 * version (…RC / …SC; 0x281 byte 2 = hardware type 2 / 1). They are different CPUs, so one line's
 * firmware never fits the other. Battery firmware stays dealer update only: this is for display.
 */
export const KnownChips = Object.freeze({
  hmi: Object.freeze<ChipInfo>({ chip: 'Nordic nRF52832', note: null }),
  controllerByType: Object.freeze({
    s0: Object.freeze<ChipInfo>({ chip: 'TI C2000 (C28x)', note: 'most likely a TMS320F2803x' }),
  }) as Readonly<Record<string, ChipInfo>>,
  batteryByLine: Object.freeze({
    RC: Object.freeze<ChipInfo>({ chip: 'Renesas RL78', note: 'BMS hardware type 2' }),
    SC: Object.freeze<ChipInfo>({ chip: 'ARM Cortex-M', note: 'BMS hardware type 1' }),
  }) as Readonly<Record<string, ChipInfo>>,
});

export type Verdict = 'latest' | 'older' | 'newer' | 'unknown';

export interface VersionReading {
  version: string | null;
  verdict: Verdict;
  label: string;
}

/** A part's version verdict plus its chip (null when the version doesn't tell which one). */
export interface PartReading extends VersionReading {
  chip: ChipInfo | null;
}

/**
 * Dot-separated parts, numbers compared as numbers ("03" == "3"), other parts as text ("s0" < "s1").
 * Null when the two don't have the same shape, so no verdict is made.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const pa = a.trim().split('.');
  const pb = b.trim().split('.');
  if (pa.length !== pb.length || pa.some((p) => p === '')) return null;
  for (let i = 0; i < pa.length; i++) {
    const na = /^\d+$/.test(pa[i]!) ? Number(pa[i]) : null;
    const nb = /^\d+$/.test(pb[i]!) ? Number(pb[i]) : null;
    let c: number;
    if (na !== null && nb !== null) c = na - nb;
    else if (na === null && nb === null) c = pa[i]!.toLowerCase() < pb[i]!.toLowerCase() ? -1 : pa[i]!.toLowerCase() > pb[i]!.toLowerCase() ? 1 : 0;
    else return null;
    if (c !== 0) return c < 0 ? -1 : 1;
  }
  return 0;
}

export function judgeVersion(version: string | null, latest: string): VersionReading {
  if (version === null) return { version: null, verdict: 'unknown', label: 'not read' };
  const c = compareVersions(version, latest);
  if (c === null) return { version, verdict: 'unknown', label: `version ${version}` };
  if (c === 0) return { version, verdict: 'latest', label: `${version}: current (latest known)` };
  if (c < 0) return { version, verdict: 'older', label: `${version}: older than latest known (${latest})` };
  return { version, verdict: 'newer', label: `${version}: newer than latest known (${latest})` };
}

const blankToNull = (s: string | null | undefined): string | null => (s && s.trim() ? s.trim() : null);

/** The HMI's version: DIS software revision, falling back to the firmware revision. */
export function hmiVersion(swRev: string | null | undefined, fwRev: string | null | undefined): string | null {
  return blankToNull(swRev) ?? blankToNull(fwRev);
}

/** The display is always an EH02, so its chip is known even before its version is read. */
export function hmiReading(swRev: string | null | undefined, fwRev: string | null | undefined): PartReading {
  return { ...judgeVersion(hmiVersion(swRev, fwRev), LatestKnown.hmi), chip: KnownChips.hmi };
}

/** Controller SW (identity page 19), judged against the latest for ITS type suffix; the chip by that type. */
export function controllerReading(ctrlSw: string | null | undefined): PartReading {
  const v = blankToNull(ctrlSw);
  if (v === null) return { version: null, verdict: 'unknown', label: 'not read', chip: null };
  const type = swType(v);
  if (type === null) return { version: v, verdict: 'unknown', label: `version ${v}`, chip: null };
  const chip = KnownChips.controllerByType[type] ?? null;
  const latest = LatestKnown.controllerByType[type];
  if (latest === undefined) return { version: v, verdict: 'unknown', label: `${v}: type ${type} isn't in the latest-known table`, chip };
  return { ...judgeVersion(v, latest), chip };
}

export interface BatteryReading extends PartReading {
  /** As the HMI reports it (nibble-swapped). */
  raw: string | null;
  /** Each 2-digit group reversed plus the line, e.g. "01.00.12 RC"; null if the string doesn't have that shape. */
  corrected: string | null;
  /** "RC" / "SC" (the BMS platform), or null. */
  line: string | null;
}

/** "10.00.21.RC" -> "01.00.12 RC" (PROTOCOL.md: the HMI formats the battery version low-nibble-first). */
export function correctBatteryVersion(raw: string): string | null {
  const parts = raw.trim().split(/[. ]/).filter((p) => p !== '');
  let n = 0;
  while (n < parts.length && /^\d+$/.test(parts[n]!)) n++;
  const digits = parts.slice(0, n);
  const rest = parts.slice(n);
  if (digits.length === 0 || digits.some((d) => d.length !== 2) || rest.some((p) => /\d/.test(p))) return null;
  return digits.map((d) => d[1]! + d[0]!).join('.') + rest.map((p) => ` ${p}`).join('');
}

/**
 * Battery firmware: dealer update only. Judged corrected, against the latest for its line; the chip
 * is the line's BMS platform (KnownChips). An unknown line names no chip: never guess one.
 */
export function batteryReading(battSw: string | null | undefined): BatteryReading {
  const raw = blankToNull(battSw);
  if (raw === null) return { raw: null, corrected: null, line: null, version: null, verdict: 'unknown', label: 'not read', chip: null };
  const corrected = correctBatteryVersion(raw);
  if (corrected === null) return { raw, corrected: null, line: null, version: raw, verdict: 'unknown', label: `version ${raw}`, chip: null };
  const numeric = corrected.split(' ')[0]!;
  const line = corrected.includes(' ') ? corrected.slice(corrected.indexOf(' ') + 1).toUpperCase() : null;
  const chip = line ? KnownChips.batteryByLine[line] ?? null : null;
  const latest = line ? LatestKnown.batteryByLine[line] : undefined;
  if (latest === undefined) return { raw, corrected, line, version: corrected, verdict: 'unknown', label: corrected, chip };
  const c = compareVersions(numeric, latest);
  const base = { raw, corrected, line, version: corrected, chip };
  if (c === null) return { ...base, verdict: 'unknown', label: corrected };
  if (c === 0) return { ...base, verdict: 'latest', label: `${corrected}: current (latest for ${line})` };
  if (c < 0) return { ...base, verdict: 'older', label: `${corrected}: older than latest for ${line} (${latest})` };
  return { ...base, verdict: 'newer', label: `${corrected}: newer than latest known for ${line} (${latest})` };
}
