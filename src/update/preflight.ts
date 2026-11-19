/**
 * Everything that must hold at the moment a controller update starts: the offer rule (gate.ts) plus
 * the Android FirmwarePreflight checks that the gate doesn't cover. The screen shows the list; ShopApp
 * re-runs it when Start is pressed. Pure: the caller passes the clock.
 *
 * There is no laptop-battery check (docs/DECISIONS.md: removed, because a browser without the Battery
 * Status API would block every update with no way past it). The screen tells the mechanic to keep the
 * laptop plugged in.
 */
import type { VerifiedFirmware } from '../analysis/firmware';
import type { SessionState } from '../protocol/session';
import { controllerUpdateGate, type ControllerGate, type GateCheck } from './gate';

/** Bike battery (page 10). The charger may stay connected. */
export const MIN_BIKE_BATTERY_PCT = 30;
/** Connected this long before an update may start (the opening sequence is done and pages flow). */
export const MIN_STABLE_MS = 5_000;
/** Live pages must have arrived this recently. */
export const FRESH_MS = 3_000;

export interface PreflightInput {
  session: SessionState | null;
  confirmed: boolean;
  platformVerified: boolean;
  platformLabel: string;
  firmware: VerifiedFirmware | null;
  /** The mechanic ticked "Reflash the same version" (gate.ts). */
  reflashSameVersion?: boolean;
  /** An update is running already. */
  updateRunning: boolean;
  now: number;
}

export interface ControllerChecks {
  gate: ControllerGate;
  /** The rest of the pre-flight (only meaningful once the gate passes). */
  preflight: GateCheck[];
  /** Every check passes: Start may be armed. */
  ready: boolean;
}

export function controllerChecks(i: PreflightInput): ControllerChecks {
  const gate = controllerUpdateGate({
    session: i.session,
    confirmed: i.confirmed,
    platformVerified: i.platformVerified,
    platformLabel: i.platformLabel,
    reflashSameVersion: i.reflashSameVersion,
  }, i.firmware?.entry);
  const s = i.session;
  const pre: GateCheck[] = [];
  const add = (id: string, label: string, ok: boolean | null, detail: string) => pre.push({ id, label, ok, detail });

  const fw = i.firmware;
  add('file', 'File SHA-256 verified', fw !== null && fw.entry.component === 'controller',
    fw ? `${fw.entry.fileName} (${fw.entry.version}) matches the allowlist: ${fw.sha256}` : 'Choose the built-in file or load M1B0306s0.bin from disk');

  if (s && s.phase === 'live') {
    const since = s.liveSince;
    const fresh = s.liveAt !== null && i.now - s.liveAt < FRESH_MS;
    add('live', 'Connected, live data arriving',
      since !== null && fresh && i.now - since >= MIN_STABLE_MS ? true : since !== null && fresh ? null : false,
      !fresh
        ? `No live data in the last ${FRESH_MS / 1000} s. If this persists, the display may still be in update mode: power-cycle the bike and reconnect.`
        : since !== null && i.now - since < MIN_STABLE_MS
          ? `Connected ${Math.floor((i.now - since) / 1000)} s ago; wait ${MIN_STABLE_MS / 1000} s`
          : `Connected ${Math.floor((i.now - (since ?? i.now)) / 1000)} s, live pages arriving`);
    const pct = typeof s.live.batt_pct === 'number' ? s.live.batt_pct : null;
    add('bike-battery', `Bike battery ≥ ${MIN_BIKE_BATTERY_PCT} %`, pct === null ? false : pct >= MIN_BIKE_BATTERY_PCT,
      pct === null ? 'Battery level not reported'
        : pct < MIN_BIKE_BATTERY_PCT ? `The battery is at ${pct} %; charge it first (the charger may stay connected)`
          : `${pct} %${s.power?.charging ? ' (charging)' : ''}`);
  }

  add('idle', 'Nothing else running', !i.updateRunning, i.updateRunning ? 'An update is already running' : 'OK');

  const ready = gate.offered && pre.every((c) => c.ok === true);
  return { gate, preflight: pre, ready };
}

/** The mechanic typed the bike's name to arm the update (case and surrounding spaces don't matter). */
export function isArmed(typed: string, deviceName: string | null): boolean {
  return deviceName !== null && deviceName.trim() !== '' && typed.trim().toUpperCase() === deviceName.trim().toUpperCase();
}
