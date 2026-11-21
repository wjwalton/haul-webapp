/**
 * Battery (BMS) update end to end: ShopApp → BikeSession → BikeLink (the send whitelist) → the simulated
 * display (50 / 52 / 09, mirrored bus) → the simulated BMS, with the real official image. Covers the
 * guardrails of PROTOCOL.md section 5, the restart after a success (the link drops, the app reconnects
 * by itself, restores auto-off, checks page 24), recovery of a pack stuck in its bootloader, and
 * failures. Needs the battery images (git-ignored), so it skips on a clean clone; batteryFlasher.test.ts
 * covers the state machine everywhere.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VerifiedBmsFirmware } from '../../src/analysis/bmsFirmware';
import { ShopApp, type BatteryEnv } from '../../src/app/shop';
import { MockHmi, MockTransport, type MockHmiOptions } from '../../src/ble/mock';
import { hex } from '../../src/protocol/bytes';
import { batteryChecks } from '../../src/update/batteryGate';
import { bmsBytes, bundledBms, HAS_BMS_FIRMWARE } from '../helpers';

let rc: VerifiedBmsFirmware;
let sc: VerifiedBmsFirmware;
beforeAll(async () => {
  if (!HAS_BMS_FIRMWARE) return;
  rc = await bundledBms('RC');
  sc = await bundledBms('SC');
});
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const env = (o: Partial<BatteryEnv> = {}): BatteryEnv => ({
  platformVerified: true, platformLabel: 'Chrome on Windows', typedName: 'EH02_00001', chosenLine: null, reflashSameVersion: false, stamp: 'test', ...o,
});

async function connected(opts: MockHmiOptions = {}) {
  const hmi = new MockHmi({
    timing: { ackMs: 5, writeMs: 1, pagesMs: 10 },
    identity: { batt_sw: '10.00.90.RC' }, // 01.00.09 RC, as on the first real update
    ...opts,
    bms: { ...opts.bms, script: { expectImage: bmsBytes(opts.bms?.version?.endsWith('SC') ? 'SC' : 'RC'), ...opts.bms?.script } },
  });
  const shop = new ShopApp(new MockTransport([hmi]), { errorPoll: false });
  const p = shop.chooseBike();
  await vi.advanceTimersByTimeAsync(1_000);
  await p;
  shop.confirm();
  await vi.advanceTimersByTimeAsync(6_000); // connected ≥ 5 s
  return { hmi, shop, st: () => shop.getSnapshot() };
}

async function read(shop: ShopApp) {
  const p = shop.readBattery();
  await vi.advanceTimersByTimeAsync(10_000);
  await p;
  return shop.getSnapshot().battery.read!;
}

/** The frames the display received on …0010, as hex, from a point on. */
const cmds = (hmi: MockHmi, from = 0) => hmi.commands().slice(from).map(hex);

describe.runIf(HAS_BMS_FIRMWARE)('battery update against the simulated bike', () => {
  it('"Read the battery": 50 01, the 0x280 probe (echo), wake, 0x280, 0x281, 50 00, live loop back; nothing else', async () => {
    const { hmi, shop, st } = await connected();
    const n = hmi.commands().length;
    const r = await read(shop);
    expect(r.problem).toBeNull();
    expect(r.identity).toMatchObject({ echo: true, responding: true, version: '01.00.09', line: 'RC', hwType: 2 });
    expect(r.autoOffS).toBe(0);
    const sent = cmds(hmi, n);
    expect(sent[0]).toBe('3d050a' + '00'.repeat(16)); // pages 5 + 10 (pauses the loop)
    expect(sent[1]).toBe('5001');
    expect(sent.slice(-2)).toEqual(['5000', '3e280708090a' + '00'.repeat(13)]);
    expect(hmi.busFrames.map((f) => f.id)).toEqual([0x280, 0x101, 0x280, 0x281]);
    expect(hmi.bms.starts).toBe(0);
    expect(hmi.violations).toEqual([]);
    expect(st().session!.canFrames).toBe(0); // the mirrored frames went to the update, not the "another app" warning
    await vi.advanceTimersByTimeAsync(1_000);
    expect(st().session!.livePaused).toBe(false);
    expect(Date.now() - (st().session!.liveAt ?? 0)).toBeLessThan(500);
  });

  it('the whole update: 01.00.09 RC → 01.00.12 RC, every block once in file order, 50 00, the bike restarts, the app reconnects and verifies', async () => {
    const { hmi, shop, st } = await connected();
    await read(shop);
    const checks = batteryChecks({
      session: st().session, confirmed: true, platformVerified: true, platformLabel: 'x', firmware: rc, read: st().battery.read,
      chosenLine: null, reflashSameVersion: false, updateRunning: false, now: Date.now(),
    });
    expect(checks.checks.filter((c) => c.ok !== true)).toEqual([]);
    const n = hmi.commands().length;
    expect(shop.startBatteryUpdate(rc, env())).toBeNull();
    await vi.advanceTimersByTimeAsync(400_000);
    await shop.whenBatteryDone();
    const res = st().battery.result!;
    expect(res).toMatchObject({ ok: true, restarting: true, before: '01.00.09 RC', target: '01.00.12 RC', attempts: 1 });
    expect(hmi.bms.completed).toBe(1);
    expect(hmi.bms.receivedBytes).toBe(107_336);
    expect(hmi.bms.mismatch).toBe(false);
    const ids = hmi.busFrames.map((f) => f.id);
    const start = ids.indexOf(0x045);
    expect(ids.slice(start - 2, start)).toEqual([0x10f, 0x101]);
    expect(ids.filter((i) => i === 0x047).length).toBe(13_417);
    expect(ids.at(-1)).toBe(0x049);
    // bus access was turned off again before the bike restarted
    const ops = cmds(hmi, n).filter((h) => h.startsWith('50'));
    expect(ops).toEqual(['5001', '5000']);
    expect(hmi.violations).toEqual([]);
    expect(hmi.systemRestarts).toBe(1);
    // the reconnect and the check
    await vi.advanceTimersByTimeAsync(60_000);
    const after = st().battery.after!;
    expect(st().phase).toBe('connected');
    expect(after).toMatchObject({ status: 'verified', reported: '01.00.12 RC', e032: false });
    expect(st().confirmed).toBe(true);
    expect(st().session!.identity.batt_sw).toBe('10.00.21.RC');
    expect(res.log).toMatch(/Result: SUCCESS/);
    expect(res.log).toMatch(/Block round trip/);
    expect(res.logName).toBe('battery_update_EH02_00001_test.txt');
  });

  it('auto-off: set to 0 before the update (read back), restored after the restart', async () => {
    const { hmi, shop, st } = await connected({ config: { shutdown_timer_s: 600 } });
    const r = await read(shop);
    expect(r.autoOffS).toBe(600);
    expect(shop.startBatteryUpdate(rc, env())).toBeNull();
    await vi.advanceTimersByTimeAsync(400_000);
    await shop.whenBatteryDone();
    expect(st().battery.result!.autoOff).toMatchObject({ before: 600, changed: true });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(st().battery.after).toMatchObject({ status: 'verified', autoOffRestored: true });
    expect(hmi.config.shutdown_timer_s).toBe(600);
    expect(hmi.commands().map(hex).filter((h) => h.startsWith('09'))).toEqual(['0900000000', '0958020000']);
    expect(hmi.violations).toEqual([]);
  });

  it('recovery: a pack stuck in its bootloader (E032) answers nothing; Start needs the line from the pack label', async () => {
    const { hmi, shop, st } = await connected({ bms: { version: '' }, identity: { batt_sw: '' } });
    const r = await read(shop);
    expect(r.identity).toMatchObject({ echo: true, responding: false });
    expect(shop.startBatteryUpdate(rc, env())).toMatch(/choose its line/);
    expect(shop.startBatteryUpdate(rc, env({ chosenLine: 'SC' }))).toMatch(/You chose the SC line; this file is for the RC line/);
    expect(shop.startBatteryUpdate(rc, env({ chosenLine: 'RC' }))).toBeNull();
    await vi.advanceTimersByTimeAsync(400_000);
    await shop.whenBatteryDone();
    expect(st().battery.result).toMatchObject({ ok: true, before: null });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(st().battery.after).toMatchObject({ status: 'verified', reported: '01.00.12 RC' });
    expect(hmi.violations).toEqual([]);
  });

  it('a lost acknowledgement: attempt 2 starts again from 0x045 and succeeds', async () => {
    const { hmi, shop, st } = await connected({ bms: { script: { missAckAt: [5_000] } } });
    await read(shop);
    expect(shop.startBatteryUpdate(rc, env())).toBeNull();
    await vi.advanceTimersByTimeAsync(600_000);
    await shop.whenBatteryDone();
    expect(st().battery.result).toMatchObject({ ok: true, attempts: 2 });
    expect(hmi.bms.starts).toBe(2);
    expect(hmi.violations).toEqual([]);
  });

  it('three failed attempts: the pack waits in its bootloader; bus access off, auto-off restored, live data back', async () => {
    const { hmi, shop, st } = await connected({ bms: { script: { resultFailures: 3 } }, config: { shutdown_timer_s: 300 } });
    await read(shop);
    expect(shop.startBatteryUpdate(rc, env())).toBeNull();
    await vi.advanceTimersByTimeAsync(1_200_000);
    await shop.whenBatteryDone();
    const res = st().battery.result!;
    expect(res).toMatchObject({ ok: false, kind: 'result-failed', packInBootloader: true, attempts: 3, restarting: false });
    expect(res.autoOff).toMatchObject({ before: 300, changed: true, restored: true });
    expect(res.message).toMatch(/waits in its bootloader, the display shows E032/);
    expect(hmi.commands().map(hex).filter((h) => h.startsWith('50')).slice(-1)).toEqual(['5000']);
    expect(hmi.canBus).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(st().session!.livePaused).toBe(false);
    expect(st().session!.errors.map((e) => e.code)).toContain('bms_e032');
    expect(hmi.violations).toEqual([]);
  });

  it('refused before anything is sent: the wrong line, a downgrade, the same version without the tick', async () => {
    const { hmi, shop } = await connected();
    await read(shop);
    expect(shop.startBatteryUpdate(sc, env())).toMatch(/The display reports a RC battery \(page 24\); this file is for the SC line/);
    const newer = await connected({ identity: { batt_sw: '10.00.31.RC' } }); // 01.00.13 RC
    await read(newer.shop);
    expect(newer.shop.startBatteryUpdate(rc, env())).toMatch(/older than the battery's 01\.00\.13\. Older firmware is never flashed/);
    const same = await connected({ identity: { batt_sw: '10.00.21.RC' } });
    await read(same.shop);
    expect(same.shop.startBatteryUpdate(rc, env())).toMatch(/Tick "Re-flash the same version"/);
    expect(same.shop.startBatteryUpdate(rc, env({ reflashSameVersion: true }))).toBeNull();
    await vi.advanceTimersByTimeAsync(400_000);
    await same.shop.whenBatteryDone();
    expect(same.shop.getSnapshot().battery.result).toMatchObject({ ok: true });
    expect(hmi.bms.starts).toBe(0);
    for (const m of [hmi, newer.hmi, same.hmi]) expect(m.violations).toEqual([]);
  });

  it('the typed name, a locked bike, an unverified browser and a stale read all refuse Start', async () => {
    const { shop } = await connected();
    expect(shop.startBatteryUpdate(rc, env())).toMatch(/Battery read on this connection/);
    await read(shop);
    expect(shop.startBatteryUpdate(rc, env({ typedName: 'EH02_9' }))).toMatch(/Type the bike's name/);
    expect(shop.startBatteryUpdate(rc, env({ platformVerified: false }))).toMatch(/Verified browser/);
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    expect(shop.startBatteryUpdate(rc, env())).toMatch(/read it again/);
    const locked = await connected({ status: { locked: true } });
    await read(locked.shop);
    expect(locked.shop.startBatteryUpdate(rc, env())).toMatch(/PIN-locked/);
  });

  it('a battery that changed between the read and Start is not flashed', async () => {
    const { hmi, shop, st } = await connected();
    await read(shop);
    hmi.bms.version = '010010RC'; // a different pack answers now
    expect(shop.startBatteryUpdate(rc, env())).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    await shop.whenBatteryDone();
    expect(st().battery.result).toMatchObject({ ok: false, kind: 'not-started', packInBootloader: false });
    expect(st().battery.result!.message).toMatch(/not what was read before/);
    expect(hmi.bms.starts).toBe(0);
    expect(hmi.canBus).toBe(false);
  });

  it('the link drops mid-transfer: stopped, the pack waits in its bootloader; reconnect + recovery works', async () => {
    const { hmi, shop, st } = await connected();
    await read(shop);
    expect(shop.startBatteryUpdate(rc, env())).toBeNull();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(st().battery.progress?.step).toBe('sending');
    hmi.dropLink('out of range');
    await vi.advanceTimersByTimeAsync(10_000);
    await shop.whenBatteryDone();
    expect(st().battery.result).toMatchObject({ ok: false, kind: 'link-lost', packInBootloader: true });
    expect(st().battery.result!.message).toMatch(/Reconnect, read the battery/);
    // reconnect, read (no answer), choose RC, flash
    const p = shop.reconnect();
    await vi.advanceTimersByTimeAsync(10_000);
    await p;
    await vi.advanceTimersByTimeAsync(6_000);
    const r = await read(shop);
    expect(r.identity?.responding).toBe(false);
    expect(shop.startBatteryUpdate(rc, env({ chosenLine: 'RC' }))).toBeNull();
    await vi.advanceTimersByTimeAsync(400_000);
    await shop.whenBatteryDone();
    expect(st().battery.result).toMatchObject({ ok: true });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(st().battery.after?.status).toBe('verified');
  });
});

describe.runIf(HAS_BMS_FIRMWARE)('battery update: transient write errors through the whole stack', () => {
  it('a failed block write (never on the bus) is sent again once; a failed 50 00 is retried: bus access ends off', async () => {
    const { hmi, shop, st } = await connected();
    await read(shop);
    // block 1001's frame fails once on its way to the display; the first 50 00 fails too
    const block = bmsBytes('RC').subarray(1_000 * 8, 1_001 * 8);
    hmi.failWrites('5247000000' + '08' + hex(block), 1);
    hmi.failWrites('5000', 1);
    const n = hmi.commands().length;
    expect(shop.startBatteryUpdate(rc, env())).toBeNull();
    await vi.advanceTimersByTimeAsync(400_000);
    await shop.whenBatteryDone();
    const res = st().battery.result!;
    expect(res).toMatchObject({ ok: true, attempts: 1 });
    expect(hmi.bms.receivedBytes).toBe(107_336); // every block on the bus exactly once
    expect(hmi.bms.mismatch).toBe(false);
    expect(hmi.canBus).toBe(false);
    expect(res.log).toMatch(/isn't on the bus: sending it again/);
    // the update's own bus access: on, then off (the failed first 50 00 never reached the display; its retry did)
    expect(hmi.commands().slice(n).map(hex).filter((h) => h.startsWith('50'))).toEqual(['5001', '5000']);
    expect(hmi.violations).toEqual([]);
  });

  it('"Read the battery" measures the round trip (each block costs about that)', async () => {
    const { shop } = await connected({ timing: { ackMs: 60, writeMs: 1, pagesMs: 10 } });
    const r = await read(shop);
    expect(r.identity?.rttMs).toBeGreaterThanOrEqual(60);
    expect(r.identity?.rttMs).toBeLessThan(120);
  });
});
