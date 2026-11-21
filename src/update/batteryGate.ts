/**
 * When the battery (BMS) update may start (docs/DECISIONS.md 2026-11-20; PROTOCOL.md "Battery (BMS)
 * firmware update over BLE" section 5, guardrails). Pure: it reads a SessionState snapshot, the last
 * "Read the battery" result and the mechanic's choices, and returns a checklist. ShopApp re-runs it
 * when Start is pressed; runBatteryUpdate() re-reads the battery and checks the same rules again.
 */
import { BMS_ALLOWLIST, compareVersions, hmiVersion, type BmsLine } from '../analysis/firmware';
import type { VerifiedBmsFirmware } from '../analysis/bmsFirmware';
import { batteryReading } from '../analysis/firmware';
import type { SessionState } from '../protocol/session';
import { describeIdentity, lineProblem, MIN_BATTERY_PCT, versionProblem, WARN_BATTERY_PCT, type BatteryReadResult } from './battery';
import type { GateCheck } from './gate';
import { FRESH_MS, MIN_STABLE_MS } from './preflight';

/** The bus relay (`50` / `52`) was analysed and proven on this HMI version (PROTOCOL.md guardrail 6: warn otherwise). */
export const BUS_VERIFIED_HMI = '5.19';
/** A battery read older than this is read again before Start. */
export const READ_MAX_AGE_MS = 10 * 60_000;

export interface BatteryGateInput {
  session: SessionState | null;
  confirmed: boolean;
  platformVerified: boolean;
  platformLabel: string;
  firmware: VerifiedBmsFirmware | null;
  /** The last "Read the battery" on THIS connection (null = not read yet). */
  read: BatteryReadResult | null;
  /** Recovery: the line the mechanic took from the pack label. */
  chosenLine: BmsLine | null;
  /** "Re-flash the same version" ticked. */
  reflashSameVersion: boolean;
  updateRunning: boolean;
  now: number;
}

export interface BatteryChecks {
  checks: GateCheck[];
  /** Every check passes: Start may be armed. */
  ready: boolean;
  /** The battery answered with exactly the file's version: offer "Re-flash the same version". */
  sameVersion: boolean;
  /** The battery was read and didn't answer: recovery (the mechanic picks the line). */
  recovery: boolean;
  /** Not blocking, but shown: HMI not 5.19, battery below 40 %. */
  warnings: string[];
}

export function batteryChecks(i: BatteryGateInput): BatteryChecks {
  const checks: GateCheck[] = [];
  const warnings: string[] = [];
  const add = (id: string, label: string, ok: boolean | null, detail: string) => checks.push({ id, label, ok, detail });
  const s = i.session;
  const fw = i.firmware;
  const id = i.read?.identity ?? null;
  const recovery = id !== null && id.echo && !id.responding;
  let sameVersion = false;

  add('platform', 'Verified browser for the battery update', i.platformVerified,
    i.platformVerified ? i.platformLabel : `${i.platformLabel}: the battery update is enabled only on Chrome or Edge on Windows and Chrome or Chromium on Linux. Reading works.`);

  if (!s || s.phase !== 'live') {
    add('connected', 'Connected, live data', false, s?.phase === 'opening' ? 'Still reading the bike…' : 'Not connected');
    return { checks, ready: false, sameVersion, recovery, warnings };
  }
  add('confirmed', 'Bike confirmed', i.confirmed, i.confirmed ? 'Confirmed against the bike\'s screen' : 'Confirm the bike first');

  const since = s.liveSince;
  const fresh = s.liveAt !== null && i.now - s.liveAt < FRESH_MS;
  add('live', 'Connected, live data arriving',
    since !== null && fresh && i.now - since >= MIN_STABLE_MS ? true : since !== null && fresh ? null : false,
    !fresh ? `No live data in the last ${FRESH_MS / 1000} s` : since !== null && i.now - since < MIN_STABLE_MS ? `Connected ${Math.floor((i.now - since) / 1000)} s ago; wait ${MIN_STABLE_MS / 1000} s` : 'Live pages arriving');

  const p = s.power;
  add('unlocked', 'Awake and unlocked', p ? !p.locked && !p.suspended : null,
    !p ? 'Status not reported yet' : p.locked ? 'The bike is PIN-locked. This app has no unlock, and updates are blocked while locked.' : p.suspended ? 'The display is in standby' : 'OK');

  const speed = typeof s.live.speed_kmh === 'number' ? s.live.speed_kmh : null;
  add('stopped', 'Bike stopped (speed 0)', speed === null ? (recovery ? true : null) : speed === 0,
    speed === null ? (recovery ? 'No speed reported (the battery isn\'t answering): keep the wheel still' : 'Speed not reported yet')
      : speed === 0 ? '0 km/h. The motor has no power during the update.' : `The bike is moving (${speed.toFixed(1)} km/h)`);

  const hmi = hmiVersion(s.dis.sw_rev, s.dis.fw_rev);
  if (hmi === null || compareVersions(hmi, BUS_VERIFIED_HMI) !== 0) {
    warnings.push(`The display runs ${hmi ?? 'an unknown version'}; the battery update was proven on HMI ${BUS_VERIFIED_HMI}. The bus-access check before the start frame still has to pass.`);
  }

  add('file', 'File SHA-256 verified', fw !== null,
    fw ? `${fw.entry.fileName}: ${fw.info.version} ${fw.info.line} (from the file), ${fw.blockCount.toLocaleString('en-US')} blocks, SHA-256 ${fw.sha256}`
      : `Choose the built-in file or load one of the two official battery images (${BMS_ALLOWLIST.map((e) => `${e.version} ${e.line}`).join(', ')}) from disk`);

  const read = i.read;
  const age = read ? i.now - read.at : null;
  add('read', 'Battery read on this connection', read === null ? false : read.problem === null && age !== null && age <= READ_MAX_AGE_MS,
    read === null ? 'Click "Read the battery" (bus access on, version and hardware type, bus access off)'
      : read.problem ? read.problem
        : age !== null && age > READ_MAX_AGE_MS ? `Read ${Math.round(age / 60_000)} min ago: read it again`
          : describeIdentity(id));

  const page24 = batteryReading(s.identity.batt_sw);
  if (id && id.echo && fw) {
    const lp = lineProblem(id, i.chosenLine, fw.info.line, page24.line);
    add('line', 'Battery line matches the file', lp === null,
      lp ?? (id.responding
        ? `${fw.info.line}: the battery reports ${id.version} ${id.line}, hardware type ${id.hwType}`
        : `${fw.info.line}: chosen from the pack label (the battery doesn't answer)`));
    const vp = versionProblem(id, fw.info.version, fw.info.line, i.reflashSameVersion);
    sameVersion = id.responding && id.version === fw.info.version;
    add('version', 'Update needed', vp === null,
      vp ?? (!id.responding ? 'Recovery: the battery doesn\'t answer, so writing the official image is the repair'
        : sameVersion ? `Same-version re-flash chosen: the official ${fw.info.version} image is written again as a repair`
          : `${fw.info.version} is newer than the battery's ${id.version}`));
  }

  const pct = typeof s.live.batt_pct === 'number' ? s.live.batt_pct : null;
  if (recovery) {
    add('bike-battery', `Bike battery ≥ ${MIN_BATTERY_PCT} %`, true, 'Unknown: a battery that doesn\'t answer reports no charge. Charge it first if you can.');
  } else {
    add('bike-battery', `Bike battery ≥ ${MIN_BATTERY_PCT} %`, pct === null ? false : pct >= MIN_BATTERY_PCT,
      pct === null ? 'Battery level not reported' : pct < MIN_BATTERY_PCT ? `The battery is at ${pct} %; charge it first` : `${pct} %${s.power?.charging ? ' (charging)' : ''}`);
    if (pct !== null && pct >= MIN_BATTERY_PCT && pct < WARN_BATTERY_PCT) warnings.push(`The bike battery is at ${pct} %: better above ${WARN_BATTERY_PCT} % for a battery update.`);
  }

  add('idle', 'Nothing else running', !i.updateRunning, i.updateRunning ? 'An update is already running' : 'OK');
  return { checks, ready: checks.every((c) => c.ok === true), sameVersion, recovery, warnings };
}
