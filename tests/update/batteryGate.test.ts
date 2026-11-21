/**
 * The battery update's checklist (update/batteryGate.ts) and the shared rules in update/battery.ts:
 * line and hardware type, version (no downgrade), recovery, warnings. Pure: no bike, no files.
 */
import { describe, expect, it } from 'vitest';
import type { VerifiedBmsFirmware } from '../../src/analysis/bmsFirmware';
import type { SessionState } from '../../src/protocol/session';
import { bmsVersionCmp, lineProblem, versionProblem, type BatteryReadResult, type BmsIdentity } from '../../src/update/battery';
import { batteryChecks } from '../../src/update/batteryGate';

const NOW = 1_000_000;
const id = (o: Partial<BmsIdentity> = {}): BmsIdentity => ({
  echo: true, versionRaw: '3031303030395243', version: '01.00.09', line: 'RC', hwRaw: '0100020', hwType: 2, responding: true, rttMs: 118, ...o,
});
const bricked = id({ versionRaw: null, version: null, line: null, hwRaw: null, hwType: null, responding: false });
const read = (identity: BmsIdentity | null, o: Partial<BatteryReadResult> = {}): BatteryReadResult => ({
  at: NOW - 1_000, busAck: 1, identity, problem: null, autoOffS: 0, batteryPct: 80, log: [], ...o,
});
/** Only what batteryChecks reads. */
const fw = (line: 'RC' | 'SC' = 'RC', version = '01.00.12') =>
  ({ entry: { fileName: `x_${line}.bin` }, info: { line, version }, blockCount: 13_417, sha256: 'ab' } as unknown as VerifiedBmsFirmware);
const session = (o: Partial<SessionState> = {}, live: Record<string, unknown> = {}): SessionState => ({
  phase: 'live', liveSince: NOW - 60_000, liveAt: NOW - 100, power: { awake: true, locked: false, charging: false, units: 'metric', suspended: false },
  live: { speed_kmh: 0, batt_pct: 80, ...live }, dis: { sw_rev: '5.19' }, identity: { batt_sw: '10.00.90.RC' }, errorBits: 0, ...o,
} as unknown as SessionState);
const checks = (o: Partial<Parameters<typeof batteryChecks>[0]> = {}) => batteryChecks({
  session: session(), confirmed: true, platformVerified: true, platformLabel: 'Chrome on Windows', firmware: fw(), read: read(id()),
  chosenLine: null, reflashSameVersion: false, updateRunning: false, now: NOW, ...o,
});
const failing = (c: ReturnType<typeof batteryChecks>) => c.checks.filter((x) => x.ok !== true).map((x) => `${x.id}: ${x.detail}`);

describe('battery checklist', () => {
  it('an older RC pack with the RC file: every check passes, no warnings', () => {
    const c = checks();
    expect(failing(c)).toEqual([]);
    expect(c).toMatchObject({ ready: true, sameVersion: false, recovery: false, warnings: [] });
  });

  it('not read, read with a problem, or read long ago: refused', () => {
    expect(failing(checks({ read: null }))).toEqual([expect.stringMatching(/^read: Click "Read the battery"/)]);
    expect(failing(checks({ read: read(id(), { problem: 'The display didn\'t turn bus access on (no answer)' }) }))).toEqual(['read: The display didn\'t turn bus access on (no answer)']);
    expect(failing(checks({ read: read(id(), { at: NOW - 11 * 60_000 }) }))).toEqual([expect.stringMatching(/read it again/)]);
  });

  it('the wrong line, by the battery\'s answer, its hardware type, or page 24', () => {
    expect(failing(checks({ firmware: fw('SC', '01.00.08'), session: session({ identity: { batt_sw: '' } }) }))).toEqual([
      'line: The battery runs the RC line; this file is for the SC line',
    ]);
    expect(failing(checks({ read: read(id({ hwType: 1 })) }))).toEqual(['line: The battery reports hardware type 1; the RC line is type 2']);
    expect(failing(checks({ read: read(id({ hwType: null })) }))).toEqual([expect.stringMatching(/didn't report its hardware type/)]);
    expect(failing(checks({ firmware: fw('SC', '01.00.08') }))[0]).toMatch(/page 24/);
  });

  it('versions: no downgrade; the same version only with the tick', () => {
    expect(failing(checks({ read: read(id({ version: '01.00.13' })) }))).toEqual([expect.stringMatching(/older than the battery's 01\.00\.13/)]);
    const same = checks({ read: read(id({ version: '01.00.12' })) });
    expect(same.sameVersion).toBe(true);
    expect(failing(same)).toEqual([expect.stringMatching(/Tick "Re-flash the same version"/)]);
    expect(failing(checks({ read: read(id({ version: '01.00.12' })), reflashSameVersion: true }))).toEqual([]);
  });

  it('recovery: no answer → the line must be chosen, and match the file and page 24; battery % unknown is allowed', () => {
    const base = { read: read(bricked), session: session({ identity: { batt_sw: '' } }, { batt_pct: undefined, speed_kmh: undefined }) };
    const none = checks(base);
    expect(none.recovery).toBe(true);
    expect(failing(none)).toEqual([expect.stringMatching(/choose its line \(RC or SC\) from the pack label/)]);
    expect(failing(checks({ ...base, chosenLine: 'SC' }))).toEqual(['line: You chose the SC line; this file is for the RC line']);
    expect(failing(checks({ ...base, chosenLine: 'RC' }))).toEqual([]);
    expect(failing(checks({ ...base, chosenLine: 'RC', session: session({ identity: { batt_sw: '10.00.50.SC' } }) }))[0]).toMatch(/page 24/);
  });

  it('bike battery below 20 % refuses, below 40 % warns; HMI not 5.19 warns', () => {
    expect(failing(checks({ session: session({}, { batt_pct: 15 }) }))).toEqual([expect.stringMatching(/15 %; charge it first/)]);
    const low = checks({ session: session({}, { batt_pct: 30 }) });
    expect(low.ready).toBe(true);
    expect(low.warnings).toEqual([expect.stringMatching(/30 %: better above 40 %/)]);
    const hmi = checks({ session: session({ dis: { sw_rev: '5.17' } }) });
    expect(hmi.ready).toBe(true);
    expect(hmi.warnings).toEqual([expect.stringMatching(/display runs 5\.17/)]);
  });

  it('the platform, confirmation, lock, a moving bike, a running update', () => {
    expect(failing(checks({ platformVerified: false }))[0]).toMatch(/^platform: Chrome on Windows: the battery update is enabled only on Chrome or Edge on Windows and Chrome or Chromium on Linux/);
    expect(failing(checks({ confirmed: false }))).toEqual(['confirmed: Confirm the bike first']);
    expect(failing(checks({ session: session({ power: { awake: true, locked: true, charging: false, units: 'metric', suspended: false } } as unknown as Partial<SessionState>) }))[0]).toMatch(/PIN-locked/);
    expect(failing(checks({ session: session({}, { speed_kmh: 12 }) }))).toEqual(['stopped: The bike is moving (12.0 km/h)']);
    expect(failing(checks({ updateRunning: true }))).toEqual(['idle: An update is already running']);
  });
});

describe('shared rules', () => {
  it('bmsVersionCmp: dd.dd.dd only', () => {
    expect(bmsVersionCmp('01.00.12', '01.00.09')).toBeGreaterThan(0);
    expect(bmsVersionCmp('01.00.12', '01.00.12')).toBe(0);
    expect(bmsVersionCmp('01.00.08', '01.00.12')).toBeLessThan(0);
    expect(bmsVersionCmp('01.00.12', null)).toBeNull();
    expect(bmsVersionCmp('01.00.12', '1.0.12')).toBeNull();
  });

  it('lineProblem / versionProblem', () => {
    expect(lineProblem(id(), null, 'RC', 'RC')).toBeNull();
    expect(lineProblem(bricked, 'RC', 'RC', null)).toBeNull();
    expect(lineProblem(bricked, null, 'RC', null)).toMatch(/choose its line/);
    expect(versionProblem(bricked, '01.00.12', 'RC', false)).toBeNull();
    expect(versionProblem(id({ version: null, versionRaw: '00' }), '01.00.12', 'RC', false)).toMatch(/Can't compare/);
    expect(versionProblem(id({ version: null, versionRaw: '00', line: null }), '01.00.12', 'RC', false)).toBeNull();
    expect(versionProblem(id({ version: '01.00.09', line: 'RC' }), '01.00.08', 'SC', false)).toBeNull();
  });
});
