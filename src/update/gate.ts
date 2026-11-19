/**
 * When the controller update is offered (docs/SPEC.md "1. Controller firmware update": "When it is
 * offered", "Recovery mode", plus the Android FirmwarePreflight checks that need only the session).
 * Pure: it reads a SessionState snapshot and returns a checklist; nothing here sends anything.
 *
 * preflight.ts adds the rest of the pre-flight (bike battery, connected ≥ 5 s, live data < 3 s old, the
 * file) and the typed bike name.
 *
 * docs/DECISIONS.md "Same-version reflash": when the controller already runs exactly the file's version,
 * the mechanic may tick "Reflash the same version" (reflashSameVersion) to flash it again as a repair.
 * Never a downgrade: an older file is never offered.
 */
import { ALLOWLIST, compareVersions, fileType, hmiVersion, swType, type AllowedFirmware } from '../analysis/firmware';
import { CTYPE, E031_BIT, E031_CODE, hasBit } from '../protocol/errors';
import { CONTROLLER_IDENTITY_KEYS, CONTROLLER_PAGES, type SessionState } from '../protocol/session';

/** The 46/47 relay was decoded and verified on this HMI version only (docs/SPEC.md "HMI must be 5.19"). */
export const RELAY_VERIFIED_HMI = '5.19';
/** The type the stock app assumes when no controller answers on an sbc display (recovery). */
export const RECOVERY_TYPE = 's0';

export const CONTROLLER_IMAGE: AllowedFirmware = ALLOWLIST.find((e) => e.component === 'controller')!;

export interface GateCheck {
  id: string;
  label: string;
  /** null = can't tell yet (still reading). */
  ok: boolean | null;
  detail: string;
}

export interface ControllerGate {
  offered: boolean;
  /** The controller isn't answering: reflashing the bundled image is the repair. */
  recovery: boolean;
  /** The HMI is older than 5.19: only the HMI update is offered ("update the HMI first"). */
  hmiFirst: boolean;
  /**
   * The controller already runs exactly the file's version (same type, no e031): the stock app wouldn't
   * offer it, but the mechanic may choose a same-version reflash (docs/DECISIONS.md).
   */
  sameVersion: boolean;
  checks: GateCheck[];
}

export interface GateInput {
  session: SessionState | null;
  confirmed: boolean;
  /** platform/detect.ts: in VERIFIED_UPDATE_PLATFORMS. */
  platformVerified: boolean;
  platformLabel: string;
  /** The mechanic ticked "Reflash the same version". Only counts when the versions are equal. */
  reflashSameVersion?: boolean;
}

/**
 * Recovery case (PROTOCOL.md, stock FirmwareActivity, Android FirmwarePreflight.controllerSilent): live,
 * identity read twice, the controller answered none of its fields, and none of its pages were rejected
 * as garbage on this connection (garbled pages ask for a reconnect instead).
 */
export function controllerSilent(s: SessionState): boolean {
  if (s.phase !== 'live' || s.identityReads < 2) return false;
  if (CONTROLLER_PAGES.some((p) => (s.quality.rejectedByPid[p] ?? 0) > 0)) return false;
  return CONTROLLER_IDENTITY_KEYS.every((k) => !s.identity[k]);
}

/** controller_e031 ("Update FW Error", sbc bit 21) in the live bitmask. */
export function e031Active(s: SessionState): boolean {
  return hasBit(s.errorBits, E031_BIT);
}

/** First two numeric fields of a version: 03.06.s0 -> [3, 6]; null if not numeric. */
export function versionNumbers(v: string | null | undefined): [number, number] | null {
  const p = v?.trim().split('.').slice(0, 2);
  if (!p || p.length !== 2 || !p.every((x) => /^\d+$/.test(x))) return null;
  return [Number(p[0]), Number(p[1])];
}

export function controllerUpdateGate(i: GateInput, image: AllowedFirmware = CONTROLLER_IMAGE): ControllerGate {
  const s = i.session;
  const checks: GateCheck[] = [];
  const add = (id: string, label: string, ok: boolean | null, detail: string) => checks.push({ id, label, ok, detail });

  add('platform', 'Verified browser for updates', i.platformVerified,
    i.platformVerified ? i.platformLabel : `${i.platformLabel}: updates are enabled only on Windows Chrome and Edge until this platform passes the hardware test. Reading works.`);

  if (!s || s.phase !== 'live') {
    add('connected', 'Connected, live data', false, s?.phase === 'opening' ? 'Still reading the bike…' : 'Not connected');
    return { offered: false, recovery: false, hmiFirst: false, sameVersion: false, checks };
  }
  add('confirmed', 'Bike confirmed', i.confirmed, i.confirmed ? 'Confirmed against the bike\'s screen' : 'Confirm the bike first');

  const p = s.power;
  add('unlocked', 'Awake and unlocked', p ? !p.locked && !p.suspended : null,
    !p ? 'Status not reported yet'
      : p.locked ? 'The bike is PIN-locked. This app has no unlock, and updates are blocked while locked.'
        : p.suspended ? 'The display is in standby' : 'OK');

  const recovery = s.ctype === CTYPE && controllerSilent(s);
  const speed = typeof s.live.speed_kmh === 'number' ? s.live.speed_kmh : null;
  add('stopped', 'Bike stopped (speed 0)',
    speed === null ? (recovery ? true : null) : speed === 0,
    speed === null ? (recovery ? 'No speed (the controller isn\'t answering): keep the wheel still' : 'Speed not reported yet')
      : speed === 0 ? '0 km/h' : `The bike is moving (${speed.toFixed(1)} km/h)`);

  const block = s.gatt.blockChar;
  add('block-char', 'Display has the firmware-block characteristic (…0011)', block !== null,
    block ? `…0011 present (${block.writeWithoutResponse ? 'write without response' : ''}${block.writeWithoutResponse && block.write ? ' + ' : ''}${block.write ? 'write with response' : ''})`
      : '…0011 not found on this display; the blocks can\'t be sent');

  add('ctype', 'Controller type is sbc', s.ctype === CTYPE,
    s.ctype === CTYPE ? 'sbc (from the HMI version)' : 'Couldn\'t confirm an sbc controller from the HMI version; controller updates are disabled');

  const hmi = hmiVersion(s.dis.sw_rev, s.dis.fw_rev);
  const hmiCmp = hmi === null ? null : compareVersions(hmi, RELAY_VERIFIED_HMI);
  const hmiFirst = hmiCmp === -1;
  add('hmi', `HMI is ${RELAY_VERIFIED_HMI}`, hmi === null ? null : hmiCmp === 0,
    hmi === null ? 'HMI version not read'
      : hmiCmp === 0 ? `HMI ${hmi}`
        : hmiFirst ? `HMI ${hmi}: update the HMI first (the controller update is verified on HMI ${RELAY_VERIFIED_HMI} only)`
          : `HMI ${hmi}: the controller update is verified on HMI ${RELAY_VERIFIED_HMI} only`);

  const fileT = fileType(image.fileName);
  let sameVersion = false;
  if (recovery) {
    add('recovery', 'Recovery mode', true,
      `The display is up but the controller answered none of its identity pages (read twice). Like the stock app, type ${RECOVERY_TYPE} is assumed so a bricked controller can be reflashed.`);
    add('type', 'Controller type matches the file', fileT === RECOVERY_TYPE,
      fileT === RECOVERY_TYPE ? `Assumed ${RECOVERY_TYPE} (recovery) = file type ${fileT}` : `Recovery assumes type ${RECOVERY_TYPE}; this file is type ${fileT}`);
    add('need', 'Update needed', true, 'Recovery: the controller isn\'t answering, so reflashing is the repair');
  } else {
    const blank = CONTROLLER_IDENTITY_KEYS.every((k) => !s.identity[k]);
    const model = s.identity.ctrl_model || null;
    add('model', 'Controller model matches the file', model === null ? (blank && s.identityReads < 2 ? null : false) : model === image.model,
      model === null ? (blank && s.identityReads < 2 ? 'Controller identity blank: reading it once more…' : 'Controller model not reported')
        : model === image.model ? `Model ${model}` : `This file is for model ${image.model}; the controller is ${model}`);
    const sw = s.identity.ctrl_sw || null;
    const have = swType(sw);
    add('type', 'Controller type matches the file', have === null ? (blank && s.identityReads < 2 ? null : false) : have === fileT,
      have === null ? 'Controller SW version (page 19) not read'
        : have === fileT ? `File type ${fileT} = controller ${sw}`
          : `This file is type ${fileT}; the controller is ${sw} (type ${have}). The stock app wouldn't offer it either.`);
    const e031 = e031Active(s);
    const cmp = versionCmp(image.version, sw);
    sameVersion = !e031 && cmp === 0 && have === fileT;
    add('need', 'Update needed', ...needCheck(image.version, sw, e031, cmp, sameVersion && i.reflashSameVersion === true));
  }

  const offered = checks.every((c) => c.ok === true);
  return { offered, recovery, hmiFirst, sameVersion, checks };
}

/** file vs controller on the first two numeric fields: > 0 the file is newer; null if either is unreadable. */
function versionCmp(fileVersion: string, ctrlSw: string | null): number | null {
  const file = versionNumbers(fileVersion);
  const bike = versionNumbers(ctrlSw);
  if (!file || !bike) return null;
  return file[0] - bike[0] || file[1] - bike[1];
}

/**
 * Offered when the file is newer than the controller, or controller_e031 is live (a failed update), or
 * (docs/DECISIONS.md) the versions are equal and the mechanic chose a same-version reflash.
 */
function needCheck(fileVersion: string, ctrlSw: string | null, e031: boolean, cmp: number | null, reflash: boolean): [boolean | null, string] {
  if (e031) return [true, `${E031_CODE} (failed update) is active: reflashing is allowed`];
  if (!versionNumbers(fileVersion)) return [false, `Can't read the file's version ${fileVersion}`];
  if (cmp === null) return [null, 'Controller version not read yet'];
  if (cmp > 0) return [true, `${fileVersion} is newer than ${ctrlSw}`];
  if (cmp === 0) {
    return reflash
      ? [true, `Same-version reflash chosen: the controller runs ${ctrlSw}; the official ${fileVersion} image is written again as a repair`]
      : [false, `The controller already runs ${ctrlSw}. Tick "Reflash the same version" to flash it again as a repair.`];
  }
  return [false, `${fileVersion} is older than the controller's ${ctrlSw}. Older firmware is never flashed.`];
}
