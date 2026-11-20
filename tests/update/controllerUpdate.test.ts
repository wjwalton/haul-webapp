/**
 * Controller update end to end: runControllerUpdate (and ShopApp's Start) with the real M1B0306s0.bin
 * through BikeSession → BikeLink (the send whitelist) → the simulated HMI, with the stock trace's timing.
 * The spec's simulator variants: resend mid-stream, failure, disconnect mid-stream, bootloader never
 * answers, slow host (50 ms per write), …0011 write-with-response only. Needs the firmware file
 * (git-ignored), so it skips on a clean clone; flasher.test.ts covers the state machine everywhere.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VerifiedFirmware } from '../../src/analysis/firmware';
import { ShopApp } from '../../src/app/shop';
import { BikeLink } from '../../src/ble/link';
import { MockHmi, MockTransport, type MockHmiOptions } from '../../src/ble/mock';
import { hex } from '../../src/protocol/bytes';
import { liveLoop, oncePages } from '../../src/protocol/frames';
import { CH_BYPASS, CH_READ } from '../../src/protocol/gatt';
import { BikeSession } from '../../src/protocol/session';
import { FLASH_TIMING, runControllerUpdate, type FlashTiming, type UpdateProgress, type UpdateResult } from '../../src/update/controller';
import { controllerChecks } from '../../src/update/preflight';
import { bundledBytes, bundledController, HAS_FIRMWARE } from '../helpers';

let img: VerifiedFirmware;
let bytes: Uint8Array;
beforeAll(async () => {
  if (!HAS_FIRMWARE) return;
  img = await bundledController();
  bytes = bundledBytes('M1B0306s0.bin');
});
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function live(opts: MockHmiOptions = {}, errorPoll = false) {
  const hmi = new MockHmi({ ...opts, update: { expectImage: bytes, ...opts.update } });
  const link = new BikeLink(await hmi.device.connect());
  const session = new BikeSession(link, { errorPoll });
  const started = session.start();
  await vi.advanceTimersByTimeAsync(2_000);
  await started;
  return { hmi, link, session };
}

async function update(
  c: Awaited<ReturnType<typeof live>>, ms = 200_000, timing: Partial<FlashTiming> = {},
): Promise<{ r: UpdateResult; progress: UpdateProgress[] }> {
  const progress: UpdateProgress[] = [];
  const p = runControllerUpdate({
    session: c.session, link: c.link, firmware: img, deviceName: 'EH02_00001', platformLabel: 'Chrome on Windows',
    onProgress: (x) => progress.push(x), stamp: 'test', timing,
  });
  await vi.advanceTimersByTimeAsync(ms);
  return { r: await p, progress };
}

const lines = (log: string, re: RegExp) => log.split('\n').filter((l) => re.test(l));

describe.runIf(HAS_FIRMWARE)('controller update against the simulated HMI', () => {
  it('the stock sequence: 3D 37, 46 00 00 28 31 42 73, 3C 02 01 00, 10,240 blocks, 3C 00 00 00, page 19, loop', async () => {
    const c = await live({ identity: { ctrl_sw: '03.05.s0' } });
    const { r, progress } = await update(c);
    expect(r.ok).toBe(true);
    expect(c.hmi.blocksAccepted).toBe(10_240);
    expect(c.hmi.fwStatusesSent()).toEqual(['3c020100', '3c000000']);
    expect(c.hmi.violations).toEqual([]);
    // …0010 commands after the opening four, in order
    expect(c.hmi.commands().slice(4).map(hex)).toEqual([hex(oncePages([55])), '46000028314273', hex(oncePages([19])), hex(liveLoop())]);
    // every block went to …0011, written without response (the stock method), never to …0010
    const blockWrites = c.hmi.writes.filter((w) => w.char === CH_BYPASS);
    expect(blockWrites.length).toBe(10_240);
    expect(new Set(blockWrites.map((w) => w.mode))).toEqual(new Set(['without-response']));
    expect(r.writeMode).toBe('without-response');
    // verified straight away: page 19 now reports the new version
    expect(r).toMatchObject({ before: '03.05.s0', after: '03.06.s0', target: '03.06.s0', verified: true, awaitingPowerCycle: false, controllerErased: false });
    expect(r.message).toMatch(/Verified: it now reports 03\.06\.s0/);
    // progress went through the steps, past the point of no return
    expect(progress.map((p) => p.step)).toEqual(expect.arrayContaining(['pausing live data', 'starting', 'erasing', 'sending', 'reading version', 'done']));
    expect(progress.find((p) => p.step === 'sending')!.pastPointOfNoReturn).toBe(true);
    // the live loop is back
    expect(c.session.state.livePaused).toBe(false);
    const before = c.session.state.liveAt!;
    await vi.advanceTimersByTimeAsync(500);
    expect(c.session.state.liveAt!).toBeGreaterThan(before);
  });

  it('the session log has every frame, per-block timing, every page 0x3C and the summary', async () => {
    const c = await live({ identity: { ctrl_sw: '03.05.s0' } });
    const { r } = await update(c);
    expect(r.logName).toBe('update_EH02_00001_test.txt');
    expect(r.log).toMatch(/^Globe Haul Shop Tool controller update: M1B0306s0\.bin \(03\.06\.s0\), sha256 e7e308034972da1604a72676acc05fdb45bbbdbb15947ef88d99052a71e9f6e4/);
    expect(lines(r.log, /TX 0011 +47[0-9a-f]{22} +\d+\.\d ms$/).length).toBe(10_240);
    expect(lines(r.log, /TX 0010 +46000028314273/).length).toBe(1);
    expect(lines(r.log, /RX 0001 +3c020100/).length).toBe(1);
    expect(lines(r.log, /RX 0001 +3c000000/).length).toBe(1);
    expect(lines(r.log, /RX 0010 +104601/).length).toBe(1);
    expect(r.log).toMatch(/Block write time: min [\d.]+ ms, avg [\d.]+ ms, max [\d.]+ ms over 10240 writes/);
    expect(r.log).toMatch(/Write method on …0011: without-response/);
    expect(r.log).toMatch(/Result: SUCCESS/);
    expect(r.timing!.count).toBe(10_240);
  });

  it('no data pages arrive while the controller is being updated (the display is in update mode)', async () => {
    const c = await live({ recordNotifications: true, identity: { ctrl_sw: '03.05.s0' } });
    const { r } = await update(c);
    expect(r.ok).toBe(true);
    const ev = c.hmi.events;
    const start = ev.findIndex((e) => e.kind === 'write' && e.hex?.startsWith('46'));
    const end = ev.findIndex((e) => e.kind === 'notify' && e.hex === '3c000000');
    expect(ev.slice(0, start).filter((e) => e.kind === 'notify' && e.char === CH_READ && e.hex?.startsWith('28')).length).toBeGreaterThan(3); // the loop ran before
    const pagesDuring = ev.slice(start, end).filter((e) => e.kind === 'notify' && e.char === CH_READ && e.hex && !e.hex.startsWith('3c'));
    expect(pagesDuring.map((e) => `${e.t} ${e.char} ${e.hex}`)).toEqual([]);
  });

  it('same version already: the display may still show it, so the new version is checked after a power-cycle', async () => {
    const c = await live();
    const { r } = await update(c);
    expect(r).toMatchObject({ ok: true, before: '03.06.s0', after: '03.06.s0', verified: false, awaitingPowerCycle: true });
    expect(r.message).toMatch(/Power-cycle the bike/);
  });

  it('resend mid-stream (status 2 at block 5,000): pause, resend from 5,000, success', async () => {
    const c = await live({ identity: { ctrl_sw: '03.05.s0' }, update: { resendAt: [5_000] } });
    const { r } = await update(c);
    expect(r).toMatchObject({ ok: true, resends: 1 });
    expect(c.hmi.fwStatusesSent()).toEqual(['3c020100', '3c028813', '3c000000']);
    expect(r.log).toMatch(/Resend requested from block 5000/);
  });

  it('failure (status 1 at block 700): the controller is erased, the message says how to recover', async () => {
    const c = await live({ update: { failAt: 700 } });
    const { r } = await update(c);
    expect(r).toMatchObject({ ok: false, kind: 'controller-failed', controllerErased: true });
    expect(r.message).toMatch(/won't drive until an update completes/);
    expect(r.message).toMatch(/recovery flash/);
    expect(r.log).toMatch(/Result: FAILED \(controller-failed\)/);
    expect(c.hmi.commands().filter((f) => f[0] === 0x46).length).toBe(1); // never re-sent
  });

  it('disconnect mid-stream (block 1,234): link lost; after a power-cycle the controller is the recovery case', async () => {
    const c = await live({ update: { disconnectAt: 1_234 } });
    c.hmi.device.onDisconnected(() => {
      c.session.end('link lost');
      c.link.lost();
    });
    const { r } = await update(c);
    expect(r).toMatchObject({ ok: false, kind: 'link-lost', controllerErased: true });
    expect(r.message).toMatch(/Reconnect and flash again\. The controller stays in its bootloader \(e031\) and is reflashable/);
    c.hmi.powerCycle();
    expect(c.hmi.controllerSilent).toBe(true);
  });

  it('bootloader never answers: no blocks, "power-cycle and retry" after 20 s', async () => {
    const c = await live({ update: { neverReady: true } });
    const { r } = await update(c, 30_000);
    expect(r).toMatchObject({ ok: false, kind: 'start-timeout', controllerErased: true });
    expect(r.message).toMatch(/No answer from the controller bootloader\. Power-cycle the bike and retry; it stays reflashable/);
    expect(c.hmi.writes.filter((w) => w.char === CH_BYPASS)).toEqual([]);
    expect(c.session.state.displayInUpdateMode).toBe(true);
  });

  it('slow host (50 ms per block write): completes, and the log records the measured times', async () => {
    const c = await live({ identity: { ctrl_sw: '03.05.s0' }, timing: { blockWriteMs: 50 } });
    const { r, progress } = await update(c, 700_000);
    expect(r.ok).toBe(true);
    expect(r.timing!.avgMs).toBeGreaterThanOrEqual(50);
    const mid = progress.find((p) => p.flash && p.flash.position > 5_000 && p.flash.etaMs !== null)!;
    // ~5,000 blocks left at ~50 ms each: about 4 minutes
    expect(mid.flash!.etaMs!).toBeGreaterThan(200_000);
    expect(mid.flash!.etaMs!).toBeLessThan(300_000);
  });

  it('…0011 reporting only write-with-response: the blocks are written with response', async () => {
    const c = await live({ identity: { ctrl_sw: '03.05.s0' }, blockCharProps: { write: true, writeWithoutResponse: false } });
    const { r } = await update(c);
    expect(r).toMatchObject({ ok: true, writeMode: 'with-response' });
    expect(c.hmi.violations).toEqual([]);
    expect(r.log).toMatch(/Write method on …0011: with-response/);
  });

  it('the HMI\'s streaming timeout (mock assumption): its resend requests are followed, then its failure reported', async () => {
    const c = await live({ update: { streamTimeoutMs: 2_000, streamRetries: 2 } });
    // a host that stops writing: make every block write hang after block 100
    const orig = c.link.block.bind(c.link);
    let n = 0;
    c.link.block = (frame, mode, ctx, label) => (++n > 100 ? new Promise(() => undefined) : orig(frame, mode, ctx, label));
    const { r } = await update(c, 120_000);
    expect(r.ok).toBe(false);
    expect(['controller-failed', 'stalled']).toContain(r.kind);
  });
});

/**
 * The 2026-11-19 failure, rebuilt: Chrome on Windows reports a write without response done as soon as
 * Windows has queued it (the app "wrote" 10,240 blocks in 29 s), while the display received 44 blocks/s
 * (CAN capture: 0x007 relays, in order, no gaps). The app then gave up 30 s after its last write and the
 * bike was power-cycled with most of the image still queued.
 */
describe.runIf(HAS_FIRMWARE)('Chrome on Windows: writes complete when queued; the radio carries ~44 blocks/s', () => {
  const WINDOWS = { airMsPerPacket: 23, hostQueuesWrites: true, blockWriteMs: 3 };
  const commandsAfterStart = (hmi: MockHmi) => {
    const all = hmi.commands().map(hex);
    return all.slice(all.indexOf('46000028314273') + 1);
  };

  it('without barriers and the long final wait (the old flasher): "all written", then stalled with the image half-delivered', async () => {
    const c = await live({ identity: { ctrl_sw: '03.05.s0' }, timing: WINDOWS });
    const { r } = await update(c, 120_000, { barrierEvery: 0, drainFloorBlocksPerS: 1e9 });
    expect(r).toMatchObject({ ok: false, kind: 'stalled', controllerErased: true });
    expect(c.hmi.blocksAccepted).toBeGreaterThan(1_000);
    expect(c.hmi.blocksAccepted).toBeLessThan(10_240);
    expect(c.hmi.airPeak).toBeGreaterThan(5_000); // thousands of blocks waiting in "Windows"
  });

  it('with barriers: progress follows what reached the display; all 10,240 arrive in order; status 0 after ~4 min', async () => {
    const c = await live({ identity: { ctrl_sw: '03.05.s0' }, timing: WINDOWS });
    const { r, progress } = await update(c, 400_000);
    expect(r).toMatchObject({ ok: true, after: '03.06.s0', verified: true });
    expect(c.hmi.blocksAccepted).toBe(10_240);
    expect(c.hmi.blocksIgnored).toBe(0);
    expect(c.hmi.violations).toEqual([]);
    expect(c.hmi.fwStatusesSent()).toEqual(['3c020100', '3c000000']);
    // never more than one barrier's worth of blocks waiting in the computer
    expect(c.hmi.airPeak).toBeLessThanOrEqual(FLASH_TIMING.barrierEvery + 1);
    expect(lines(r.log, /BARRIER +read 0004 after block \d+: \d+ ms$/).length).toBe(10_240 / FLASH_TIMING.barrierEvery);
    expect(r.log).toMatch(/Barrier \(read 0004 behind the blocks, every 32\): min \d+ ms, avg \d+ ms, max \d+ ms over 320/);
    const rate = Number(/Delivery rate: ([\d.]+) blocks\/s/.exec(r.log)![1]);
    expect(rate).toBeGreaterThan(35);
    expect(rate).toBeLessThan(45);
    // the ETA was measured on the real rate: about 4 minutes when a quarter was done
    const q = progress.find((x) => x.flash && x.flash.position >= 2_560 && x.flash.etaMs !== null)!;
    expect(q.flash!.etaMs!).toBeGreaterThan(150_000);
    expect(q.flash!.etaMs!).toBeLessThan(220_000);
    expect(c.session.state.livePaused).toBe(false);
  });

  it('even if reads overtook the queued blocks (barriers useless), the final wait sees it through', async () => {
    const c = await live({ identity: { ctrl_sw: '03.05.s0' }, timing: { ...WINDOWS, requestsJumpAir: true } });
    const { r } = await update(c, 600_000);
    expect(r).toMatchObject({ ok: true, verified: true });
    expect(c.hmi.blocksAccepted).toBe(10_240);
    expect(c.hmi.airPeak).toBeGreaterThan(5_000);
    expect(r.log).toMatch(/All blocks written \(10240 writes\); waiting up to \d+ s for the controller to confirm/);
  });

  it('a display that never confirms: "stalled" only after the full wait; then nothing more is sent until a power-cycle', async () => {
    const c = await live({ identity: { ctrl_sw: '03.05.s0' }, update: { silentEnd: true } }, true); // 30 s error poll on
    let result: UpdateResult | null = null;
    void runControllerUpdate({
      session: c.session, link: c.link, firmware: img, deviceName: 'EH02_00001', platformLabel: 'Chrome on Windows',
      onProgress: () => undefined, stamp: 'test',
    }).then((x) => {
      result = x;
    });
    // Every block is in after ~11 s; a minute later it is still waiting (blocks could still be on their way).
    await vi.advanceTimersByTimeAsync(75_000);
    expect(c.hmi.blocksAccepted).toBe(10_240);
    expect(result).toBeNull();
    // 10,240 blocks at the 20 blocks/s floor: up to 512 s from the first block.
    await vi.advanceTimersByTimeAsync(460_000);
    const r = result as UpdateResult | null;
    expect(r).toMatchObject({ ok: false, kind: 'stalled', controllerErased: true });
    expect(r!.message).toMatch(/power-cycle the bike \(off, then on\), reconnect, then do the recovery flash/);
    expect(r!.message).toMatch(/"bypass" while an update runs; that alone is not a fault/);
    expect(r!.log).toMatch(/not restarting the live loop/);
    // nothing sent to the display after the start frame: no live loop, no polls, even minutes later
    await vi.advanceTimersByTimeAsync(120_000);
    expect(commandsAfterStart(c.hmi)).toEqual([]);
    expect(c.session.state).toMatchObject({ livePaused: true, displayInUpdateMode: true });
  });

  it('a verdict that comes after the app stopped waiting is reported as such, not as "still in update mode"', async () => {
    const c = await live({ identity: { ctrl_sw: '03.05.s0' }, update: { silentEnd: true } });
    const { r } = await update(c, 600_000);
    expect(r).toMatchObject({ ok: false, kind: 'stalled' });
    c.hmi.finishNow(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(c.session.state.lateFwStatus).toBe(0);
    expect(c.session.state.log.some((l) => /3c000000 after the app stopped waiting: the display reports the update SUCCEEDED/.test(l))).toBe(true);
  });
});

describe.runIf(HAS_FIRMWARE)('ShopApp: Start re-checks everything; the new version is verified after the power-cycle', () => {
  const env = (typedName: string, extra: Partial<Parameters<ShopApp['startControllerUpdate']>[1]> = {}) => ({
    platformVerified: true, platformLabel: 'Chrome on Windows', typedName, ...extra,
  });

  async function shopWith(opts: MockHmiOptions) {
    const hmi = new MockHmi({ ...opts, update: { expectImage: bytes, ...opts.update } });
    const shop = new ShopApp(new MockTransport([hmi]), { errorPoll: false });
    const p = shop.chooseBike();
    await vi.advanceTimersByTimeAsync(2_000);
    await p;
    return { hmi, shop };
  }

  it('refuses until every check passes and the name is typed', async () => {
    const { hmi, shop } = await shopWith({ identity: { ctrl_sw: '03.05.s0' } });
    expect(shop.startControllerUpdate(img, env('EH02_00001'))).toMatch(/Bike confirmed/);
    shop.confirm();
    expect(shop.startControllerUpdate(img, env('EH02_00001'))).toMatch(/wait 5 s/);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(shop.startControllerUpdate(img, env('EH02_00001', { platformVerified: false }))).toMatch(/Verified browser/);
    expect(shop.startControllerUpdate(img, env('EH02_0000'))).toMatch(/Type the bike's name/);
    hmi.setLive({ batt_pct: 25 });
    await vi.advanceTimersByTimeAsync(500);
    expect(shop.startControllerUpdate(img, env('EH02_00001'))).toMatch(/Bike battery ≥ 30 %/);
    hmi.setLive({ batt_pct: 81, speed_x10: 120 });
    await vi.advanceTimersByTimeAsync(500);
    expect(shop.startControllerUpdate(img, env('EH02_00001'))).toMatch(/Bike stopped/);
    hmi.setLive({ speed_x10: 0 });
    hmi.setStatus({ locked: true });
    await vi.advanceTimersByTimeAsync(500);
    expect(shop.startControllerUpdate(img, env('EH02_00001'))).toMatch(/PIN-locked/);
    expect(hmi.commands().some((f) => f[0] === 0x46)).toBe(false);
    hmi.setStatus({ locked: false });
    await vi.advanceTimersByTimeAsync(500);
    expect(shop.startControllerUpdate(img, env(' eh02_00001 '))).toBeNull(); // case and spaces don't matter
    await vi.advanceTimersByTimeAsync(100);
    expect(shop.updateRunning).toBe(true);
    await shop.disconnect(); // ignored while updating
    expect(shop.getSnapshot().phase).toBe('connected');
    await vi.advanceTimersByTimeAsync(200_000);
    await shop.whenUpdateDone();
    expect(shop.getSnapshot().update?.result).toMatchObject({ ok: true, verified: true });
  });

  it('not offered on a bike that already runs 03.06.s0 without e031; offered in recovery', async () => {
    let { shop } = await shopWith({});
    shop.confirm();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(shop.startControllerUpdate(img, env('EH02_00001'))).toMatch(/Update needed: The controller already runs 03\.06\.s0\. Tick "Reflash the same version"/);
    ({ shop } = await shopWith({ controllerSilent: true }));
    shop.confirm();
    await vi.advanceTimersByTimeAsync(7_000); // the identity re-read decides "silent"
    const s = shop.getSnapshot().session!;
    expect(controllerChecks({
      session: s, confirmed: true, platformVerified: true, platformLabel: 'x', firmware: img, updateRunning: false, now: Date.now(),
    }).gate.recovery).toBe(true);
    expect(shop.startControllerUpdate(img, env('EH02_00001'))).toBeNull();
    await vi.advanceTimersByTimeAsync(200_000);
    await shop.whenUpdateDone();
    expect(shop.getSnapshot().update?.result).toMatchObject({ ok: true, before: null });
  });

  it('same-version reflash (docs/DECISIONS.md): ticked, it flashes 03.06.s0 again; verified after the power-cycle', async () => {
    const { hmi, shop } = await shopWith({});
    shop.confirm();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(shop.startControllerUpdate(img, env('EH02_00001', { reflashSameVersion: false }))).toMatch(/already runs 03\.06\.s0/);
    expect(hmi.commands().some((f) => f[0] === 0x46)).toBe(false);
    expect(shop.startControllerUpdate(img, env('EH02_00001', { reflashSameVersion: true }))).toBeNull();
    await vi.advanceTimersByTimeAsync(200_000);
    await shop.whenUpdateDone();
    let u = shop.getSnapshot().update!;
    expect(hmi.violations).toEqual([]);
    expect(u.result).toMatchObject({ ok: true, verified: false, awaitingPowerCycle: true, before: '03.06.s0', target: '03.06.s0' });
    expect(u.result!.message).toMatch(/same-version reflash/);
    expect(u.result!.log).toMatch(/offered: Same-version reflash chosen: the controller runs 03\.06\.s0/);
    expect(u.verify).toMatchObject({ status: 'waiting' });
    hmi.powerCycle();
    const p = shop.reconnect();
    await vi.advanceTimersByTimeAsync(2_000);
    await p;
    u = shop.getSnapshot().update!;
    expect(u.verify).toMatchObject({ status: 'verified', reported: '03.06.s0' });
  });

  it('display still shows the old version: power-cycle, reconnect, and the new version is verified', async () => {
    const { hmi, shop } = await shopWith({ live: { error_bits: 1 << 21 } }); // e031 on 03.06.s0: reflash allowed
    shop.confirm();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(shop.startControllerUpdate(img, env('EH02_00001'))).toBeNull();
    await vi.advanceTimersByTimeAsync(200_000);
    await shop.whenUpdateDone();
    let u = shop.getSnapshot().update!;
    expect(u.result).toMatchObject({ ok: true, awaitingPowerCycle: true });
    expect(u.verify).toMatchObject({ status: 'waiting', target: '03.06.s0' });
    hmi.setLive({ error_bits: 0 });
    hmi.powerCycle();
    expect(shop.getSnapshot().phase).toBe('lost');
    const p = shop.reconnect();
    await vi.advanceTimersByTimeAsync(2_000);
    await p;
    u = shop.getSnapshot().update!;
    expect(u.verify).toMatchObject({ status: 'verified', reported: '03.06.s0' });
    expect(shop.getSnapshot().confirmed).toBe(true);
  });

  it('if Reconnect won\'t do it, choosing the same bike again keeps the result and still verifies after the power-cycle', async () => {
    const { hmi, shop } = await shopWith({ live: { error_bits: 1 << 21 } });
    shop.confirm();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(shop.startControllerUpdate(img, env('EH02_00001'))).toBeNull();
    await vi.advanceTimersByTimeAsync(200_000);
    await shop.whenUpdateDone();
    expect(shop.getSnapshot().update!.verify).toMatchObject({ status: 'waiting' });
    hmi.setLive({ error_bits: 0 });
    hmi.powerCycle();
    const p = shop.chooseBike(); // the same bike in the chooser
    await vi.advanceTimersByTimeAsync(5_000);
    await p;
    const s = shop.getSnapshot();
    expect(s).toMatchObject({ phase: 'connected', confirmed: true });
    expect(s.update?.result).toMatchObject({ ok: true });
    expect(s.update?.verify).toMatchObject({ status: 'verified', reported: '03.06.s0' });
    expect(s.events.some((e) => /Controller update finished: success/.test(e))).toBe(true);
  });

  it('a link drop mid-update ends in "lost" with the result and log kept', async () => {
    const { shop } = await shopWith({ identity: { ctrl_sw: '03.05.s0' }, update: { disconnectAt: 3_000 } });
    shop.confirm();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(shop.startControllerUpdate(img, env('EH02_00001'))).toBeNull();
    await vi.advanceTimersByTimeAsync(200_000);
    await shop.whenUpdateDone();
    const st = shop.getSnapshot();
    expect(st.phase).toBe('lost');
    expect(st.update?.result).toMatchObject({ ok: false, kind: 'link-lost', controllerErased: true });
    expect(st.update?.result?.log).toMatch(/Result: FAILED \(link-lost\)/);
  });
});
