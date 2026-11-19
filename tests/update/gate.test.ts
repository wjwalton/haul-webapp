/**
 * The controller-update offer rule (docs/SPEC.md "When it is offered" + recovery + the Android checks
 * that need only the session), on real sessions against the simulated bike.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BikeLink } from '../../src/ble/link';
import { MockHmi, type MockHmiOptions } from '../../src/ble/mock';
import { BikeSession, TIMING, type SessionState } from '../../src/protocol/session';
import { controllerUpdateGate, versionNumbers, type GateInput } from '../../src/update/gate';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function live(opts: MockHmiOptions = {}, wait = 1_000): Promise<{ hmi: MockHmi; state: () => SessionState }> {
  const hmi = new MockHmi(opts);
  const session = new BikeSession(new BikeLink(await hmi.device.connect()), { errorPoll: false });
  const p = session.start();
  await vi.advanceTimersByTimeAsync(wait);
  await p;
  return { hmi, state: () => session.state };
}

const verified = (session: SessionState, extra: Partial<GateInput> = {}): GateInput => ({
  session, confirmed: true, platformVerified: true, platformLabel: 'Chrome on Windows', ...extra,
});
const failing = (g: ReturnType<typeof controllerUpdateGate>) => g.checks.filter((c) => c.ok !== true).map((c) => c.id);

describe('controller update gate', () => {
  it('a bike already on 03.06.s0: everything passes except "update needed" (the stock rule)', async () => {
    const { state } = await live();
    const g = controllerUpdateGate(verified(state()));
    expect(g.offered).toBe(false);
    expect(failing(g)).toEqual(['need']);
    expect(g.checks.find((c) => c.id === 'need')!.detail).toMatch(/already runs 03\.06\.s0/);
  });

  it('same-version reflash (docs/DECISIONS.md): offered only when ticked and the versions are equal', async () => {
    const { state } = await live();
    let g = controllerUpdateGate(verified(state()));
    expect(g.sameVersion).toBe(true);
    expect(g.offered).toBe(false);
    expect(g.checks.find((c) => c.id === 'need')!.detail).toMatch(/Tick "Reflash the same version"/);
    g = controllerUpdateGate(verified(state(), { reflashSameVersion: true }));
    expect(failing(g)).toEqual([]);
    expect(g.offered).toBe(true);
    expect(g.checks.find((c) => c.id === 'need')!.detail).toMatch(/Same-version reflash chosen/);
  });

  it('the reflash tick never allows a downgrade or another type, and skips no other check', async () => {
    let g = controllerUpdateGate(verified((await live({ identity: { ctrl_sw: '03.07.s0' } })).state(), { reflashSameVersion: true }));
    expect(g.sameVersion).toBe(false);
    expect(failing(g)).toEqual(['need']);
    expect(g.checks.find((c) => c.id === 'need')!.detail).toMatch(/older than the controller's 03\.07\.s0/);
    g = controllerUpdateGate(verified((await live({ identity: { ctrl_sw: '03.06.s1' } })).state(), { reflashSameVersion: true }));
    expect(g.sameVersion).toBe(false);
    expect(failing(g)).toEqual(['type', 'need']);
    g = controllerUpdateGate(verified((await live({ status: { locked: true } })).state(), { reflashSameVersion: true }));
    expect(failing(g)).toEqual(['unlocked']);
    g = controllerUpdateGate(verified((await live({ dis: { sw_rev: '5.17' } })).state(), { reflashSameVersion: true }));
    expect(failing(g)).toEqual(['hmi']);
    g = controllerUpdateGate({ session: (await live()).state(), confirmed: true, platformVerified: false, platformLabel: 'Chrome on Linux', reflashSameVersion: true });
    expect(failing(g)).toEqual(['platform']);
    // e031 is its own reason: no tick needed there
    g = controllerUpdateGate(verified((await live({ live: { error_bits: 1 << 21 } })).state()));
    expect(g.sameVersion).toBe(false);
    expect(g.offered).toBe(true);
  });

  it('an older controller (03.05.s0) is offered', async () => {
    const { state } = await live({ identity: { ctrl_sw: '03.05.s0' } });
    const g = controllerUpdateGate(verified(state()));
    expect(failing(g)).toEqual([]);
    expect(g.offered).toBe(true);
  });

  it('controller_e031 live: offered even on the same version', async () => {
    const { state } = await live({ live: { error_bits: 1 << 21 } });
    const g = controllerUpdateGate(verified(state()));
    expect(g.offered).toBe(true);
    expect(g.checks.find((c) => c.id === 'need')!.detail).toMatch(/controller_e031/);
  });

  it('a different type suffix (s1) is never offered; the model must be 1B', async () => {
    let g = controllerUpdateGate(verified((await live({ identity: { ctrl_sw: '03.05.s1' } })).state()));
    expect(failing(g)).toEqual(['type']);
    g = controllerUpdateGate(verified((await live({ identity: { ctrl_sw: '03.05.s0', ctrl_model: '2A' } })).state()));
    expect(failing(g)).toEqual(['model']);
  });

  it('never gates on HW rev (AS.03 and AL.03 both qualify)', async () => {
    const { state } = await live({ identity: { ctrl_sw: '03.05.s0', ctrl_hw: 'AL.03' } });
    expect(controllerUpdateGate(verified(state())).offered).toBe(true);
  });

  it('PIN-locked, moving, unconfirmed, or an unverified browser: not offered', async () => {
    let { state } = await live({ identity: { ctrl_sw: '03.05.s0' }, status: { locked: true } });
    expect(failing(controllerUpdateGate(verified(state())))).toEqual(['unlocked']);
    ({ state } = await live({ identity: { ctrl_sw: '03.05.s0' }, live: { speed_x10: 125 } }));
    expect(failing(controllerUpdateGate(verified(state())))).toEqual(['stopped']);
    expect(failing(controllerUpdateGate(verified(state(), { confirmed: false })))).toEqual(['confirmed', 'stopped']);
    const g = controllerUpdateGate({ session: state(), confirmed: true, platformVerified: false, platformLabel: 'Chrome on Linux' });
    expect(g.checks[0]).toMatchObject({ id: 'platform', ok: false });
    expect(g.checks[0]!.detail).toMatch(/Windows Chrome and Edge/);
  });

  it('HMI must be 5.19: older says "update the HMI first"; newer is not verified', async () => {
    let g = controllerUpdateGate(verified((await live({ identity: { ctrl_sw: '03.05.s0' }, dis: { sw_rev: '5.17' } })).state()));
    expect(failing(g)).toEqual(['hmi']);
    expect(g.hmiFirst).toBe(true);
    g = controllerUpdateGate(verified((await live({ identity: { ctrl_sw: '03.05.s0' }, dis: { sw_rev: '5.20' } })).state()));
    expect(failing(g)).toEqual(['hmi']);
    expect(g.hmiFirst).toBe(false);
  });

  it('a display that isn\'t confirmed sbc gets no controller update', async () => {
    const { state } = await live({ identity: { ctrl_sw: '03.05.s0' }, dis: { sw_rev: '4.2', fw_rev: '1.0' } });
    expect(failing(controllerUpdateGate(verified(state())))).toEqual(expect.arrayContaining(['ctype']));
  });

  it('…0011 missing: not offered', async () => {
    const { state } = await live({ identity: { ctrl_sw: '03.05.s0' } });
    const s = { ...state(), gatt: { ...state().gatt, blockChar: null } };
    expect(failing(controllerUpdateGate(verified(s)))).toEqual(['block-char']);
  });

  it('recovery: after the second blank identity read, the bundled s0 image is offered with a banner', async () => {
    const { state } = await live({ controllerSilent: true });
    let g = controllerUpdateGate(verified(state()));
    expect(g.recovery).toBe(false);
    expect(g.offered).toBe(false);
    expect(g.checks.find((c) => c.id === 'type')!.ok).toBeNull(); // still re-reading
    await vi.advanceTimersByTimeAsync(TIMING.identityRecheckMs + 1_000);
    g = controllerUpdateGate(verified(state()));
    expect(g.recovery).toBe(true);
    expect(failing(g)).toEqual([]);
    expect(g.offered).toBe(true);
    expect(g.checks.map((c) => c.id)).toEqual(['platform', 'confirmed', 'unlocked', 'stopped', 'block-char', 'ctype', 'hmi', 'recovery', 'type', 'need']);
  });

  it('not connected / still reading: never offered', () => {
    expect(controllerUpdateGate({ session: null, confirmed: false, platformVerified: true, platformLabel: 'x' }).offered).toBe(false);
  });

  it('version numbers are the first two numeric fields', () => {
    expect(versionNumbers('03.06.s0')).toEqual([3, 6]);
    expect(versionNumbers('3.6')).toEqual([3, 6]);
    expect(versionNumbers('03.x.s0')).toBeNull();
    expect(versionNumbers(null)).toBeNull();
  });
});
