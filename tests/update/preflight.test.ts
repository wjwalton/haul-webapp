/** Pre-flight rules that need no firmware file (they run everywhere, CI included). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BikeLink } from '../../src/ble/link';
import { MockHmi, type MockHmiOptions } from '../../src/ble/mock';
import { BikeSession, type SessionState } from '../../src/protocol/session';
import { blockWriteMode } from '../../src/update/controller';
import { controllerChecks, isArmed, MIN_BIKE_BATTERY_PCT } from '../../src/update/preflight';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function live(opts: MockHmiOptions = {}): Promise<SessionState> {
  const hmi = new MockHmi(opts);
  const session = new BikeSession(new BikeLink(await hmi.device.connect()), { errorPoll: false });
  const p = session.start();
  await vi.advanceTimersByTimeAsync(1_000);
  await p;
  await vi.advanceTimersByTimeAsync(6_000);
  return session.state;
}

const check = (s: SessionState, now = Date.now()) =>
  Object.fromEntries(
    controllerChecks({ session: s, confirmed: true, platformVerified: true, platformLabel: 'x', firmware: null, updateRunning: false, now })
      .preflight.map((c) => [c.id, c.ok]),
  );

describe('pre-flight', () => {
  it('no laptop-battery check (docs/DECISIONS.md: removed)', async () => {
    const s = await live();
    const ids = controllerChecks({ session: s, confirmed: true, platformVerified: true, platformLabel: 'x', firmware: null, updateRunning: false, now: Date.now() })
      .preflight.map((c) => c.id);
    expect(ids).toEqual(['file', 'live', 'bike-battery', 'idle']);
  });

  it('bike battery ≥ 30 % (the charger may stay connected), live data fresh, connected ≥ 5 s, a verified file', async () => {
    expect(MIN_BIKE_BATTERY_PCT).toBe(30);
    expect(check(await live({ live: { batt_pct: 29 } }))['bike-battery']).toBe(false);
    const s = await live({ live: { batt_pct: 30 } });
    const c = check(s);
    expect(c['bike-battery']).toBe(true);
    expect(c.live).toBe(true);
    expect(c.file).toBe(false); // no file chosen
    expect(check(s, s.liveAt! + 3_500).live).toBe(false); // stale data
    expect(check(s, s.liveSince! + 2_000).live).toBeNull(); // just connected: wait
  });

  it('typing the name arms it: exact name, any case, surrounding spaces ignored', () => {
    expect(isArmed('EH02_00001', 'EH02_00001')).toBe(true);
    expect(isArmed('  eh02_00001 ', 'EH02_00001')).toBe(true);
    expect(isArmed('EH02_0000', 'EH02_00001')).toBe(false);
    expect(isArmed('', 'EH02_00001')).toBe(false);
    expect(isArmed('x', null)).toBe(false);
  });

  it('…0011 write method: without response when allowed (the stock app), else with response, else none', () => {
    const p = (o: Partial<{ write: boolean; writeWithoutResponse: boolean }>) => ({ write: false, writeWithoutResponse: false, ...o });
    expect(blockWriteMode(p({ writeWithoutResponse: true, write: true }))).toBe('without-response');
    expect(blockWriteMode(p({ write: true }))).toBe('with-response');
    expect(blockWriteMode(p({}))).toBeNull();
    expect(blockWriteMode(null)).toBeNull();
  });
});
