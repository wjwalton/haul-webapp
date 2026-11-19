/**
 * The simulated HMI behaves as PROTOCOL.md describes, including the controller-update variants the
 * spec asks for. The update here is driven by a minimal test driver through BikeLink (the real
 * state machine, update/controller.ts, is milestone 3 and gets its own tests against this mock).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BikeLink } from '../../src/ble/link';
import { CAPTURED, ChooserCancelledError, MockHmi, MockTransport, type MockHmiOptions } from '../../src/ble/mock';
import type { WriteMode } from '../../src/ble/transport';
import { LinkLostError } from '../../src/ble/transport';
import type { VerifiedFirmware } from '../../src/analysis/firmware';
import { hex } from '../../src/protocol/bytes';
import { dumpLog, fwBlock, fwStart, liveLoop, mtuPageMode, oncePages, PAGES_IDENTITY } from '../../src/protocol/frames';
import { CH_POWER, CH_READ, CH_WRITE, DIS_CHARS, DIS_SERIAL_BLOCKLISTED, NAME_PREFIX, SCAN_UUID, SVC_DIS, SVC_EBIKE } from '../../src/protocol/gatt';
import { decodeFwStatus, decodePage, splitPages, stripNa } from '../../src/protocol/pages';
import { bundledBytes, bundledController, HAS_FIRMWARE } from '../helpers';

let img: VerifiedFirmware;
let imgBytes: Uint8Array;
beforeAll(async () => {
  if (!HAS_FIRMWARE) return;
  img = await bundledController();
  imgBytes = bundledBytes('M1B0306s0.bin');
});
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function connect(opts: MockHmiOptions = {}) {
  const hmi = new MockHmi(opts);
  const gattP = hmi.device.connect();
  const gatt = await gattP;
  const link = new BikeLink(gatt);
  const reads: Uint8Array[] = [];
  const acks: string[] = [];
  const power: string[] = [];
  const statuses: { status: number; seq: number | null }[] = [];
  const subs = Promise.all([
    link.subscribe(SVC_EBIKE, CH_WRITE, (v) => acks.push(hex(v))),
    link.subscribe(SVC_EBIKE, CH_POWER, (v) => power.push(hex(v))),
    link.subscribe(SVC_EBIKE, CH_READ, (v) => {
      reads.push(v);
      const st = decodeFwStatus(v);
      if (st) statuses.push(st);
    }),
  ]);
  await vi.advanceTimersByTimeAsync(50);
  await subs;
  return { hmi, gatt, link, reads, acks, power, statuses };
}

const pagesOf = (reads: Uint8Array[]) => reads.flatMap((r) => (r[0] === 0x3c ? [] : splitPages(r)));

describe('MockHmi: opening sequence', () => {
  it('acks 3C 01, answers identity pages packed 12 per notification, streams the live loop at ~10 Hz', async () => {
    const { hmi, link, reads, acks } = await connect();
    expect(hmi.advertising).toBe(false);
    void link.command(mtuPageMode(), 'mtu-page-mode');
    await vi.advanceTimersByTimeAsync(100);
    expect(acks).toEqual(['103c01']);

    void link.command(oncePages(PAGES_IDENTITY), 'identity');
    await vi.advanceTimersByTimeAsync(200);
    expect(acks).toEqual(['103c01', '103d01']);
    expect(reads.map((r) => r.length)).toEqual([240, 120]);
    const ids = Object.assign({}, ...pagesOf(reads).map((p) => stripNa(decodePage(p))));
    expect(ids).toMatchObject({ ctrl_serial1: '200000001', ctrl_model: '1B', ctrl_sw: '03.06.s0', ctrl_hw: 'AS.03', batt_sw: '10.00.21.RC', motor_model: '' });

    reads.length = 0;
    void link.command(liveLoop(), 'loop');
    await vi.advanceTimersByTimeAsync(1_060);
    expect(reads.length).toBe(10);
    expect(reads.every((r) => r.length === 100)).toBe(true);
    // the default simulated bike sends exactly the captured pages
    const pages = splitPages(reads[0]!).map(hex);
    expect(pages).toEqual([40, 7, 8, 9, 10].map((p) => CAPTURED[p]));

    // a one-shot request replaces the loop (stock update trace: 3D 37 pauses the stream)
    void link.command(oncePages([55]), 'err page');
    await vi.advanceTimersByTimeAsync(200);
    reads.length = 0;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reads.length).toBe(0);
    expect(hmi.violations).toEqual([]);
  });

  it('pages 54, 55, 56 are the captured ones', async () => {
    const { link, reads } = await connect();
    void link.command(mtuPageMode(), 'mtu');
    void link.command(oncePages([54, 55, 56]), 'config');
    await vi.advanceTimersByTimeAsync(300);
    expect(pagesOf(reads).map(hex)).toEqual([CAPTURED[54], CAPTURED[55], CAPTURED[56]]);
  });

  it('records anything outside the expected set as a violation and acks it "not supported"', async () => {
    const { hmi, gatt, acks } = await connect();
    // bypassing BikeLink on purpose: the mock must catch it independently of frames.ts
    void gatt.write(SVC_EBIKE, CH_WRITE, Uint8Array.of(0x2a, 1), 'with-response');
    await vi.advanceTimersByTimeAsync(100);
    expect(hmi.violations).toEqual(['unexpected command 2a01']);
    expect(acks).toEqual(['102a02']);
  });

  it('reading the blocklisted DIS serial is a violation (Chrome would throw)', async () => {
    const { hmi, gatt } = await connect();
    const r = gatt.read(SVC_DIS, DIS_SERIAL_BLOCKLISTED).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10);
    expect(((await r) as Error).name).toBe('SecurityError');
    expect(hmi.violations[0]).toMatch(/2A25/);
    const sw = gatt.read(SVC_DIS, DIS_CHARS.sw_rev);
    await vi.advanceTimersByTimeAsync(10);
    expect(new TextDecoder().decode(await sw)).toBe('5.19');
  });

  it('status changes are notified on …0004', async () => {
    const { hmi, power } = await connect();
    hmi.setStatus({ charging: true });
    hmi.setStatus({ locked: true });
    expect(power).toEqual(['01000101', '01010101']);
  });

  it('log dump: BE, the bytes, ED', async () => {
    const log = Uint8Array.from({ length: 1000 }, (_, i) => i & 0xff);
    const { link, reads } = await connect({ logs: { 1: log } });
    void link.command(mtuPageMode(), 'mtu');
    void link.command(dumpLog(1), 'dump');
    await vi.advanceTimersByTimeAsync(500);
    expect(reads[0]).toEqual(Uint8Array.of(0xbe));
    expect(reads[reads.length - 1]).toEqual(Uint8Array.of(0xed));
    const body = reads.slice(1, -1);
    expect(body.reduce((n, r) => n + r.length, 0)).toBe(1000);
    expect(Math.max(...body.map((r) => r.length))).toBe(240);
  });
});

describe('MockTransport chooser', () => {
  it('lists every advertising EH02_ bike; a connected one disappears; cancel rejects', async () => {
    const a = new MockHmi({ name: 'EH02_00001' });
    const b = new MockHmi({ name: 'EH02_00002' });
    const t = new MockTransport([a, b]);
    const req = { namePrefix: NAME_PREFIX, advertisedServices: [SCAN_UUID], optionalServices: [] };
    expect(t.listed(req).map((x) => x.name)).toEqual(['EH02_00001', 'EH02_00002']);
    await a.device.connect();
    expect(t.listed(req).map((x) => x.name)).toEqual(['EH02_00002']);
    t.choose = () => null;
    await expect(t.requestDevice(req)).rejects.toBeInstanceOf(ChooserCancelledError);
    a.dropLink();
    expect(t.listed(req).length).toBe(2);
  });
});

/** Minimal update driver for exercising the mock (NOT the milestone-3 implementation). */
async function drive(
  c: Awaited<ReturnType<typeof connect>>,
  o: { mode?: WriteMode; stopAfter?: number } = {},
): Promise<{ result: string; t46: number; tReady: number | null; tEnd: number | null }> {
  const ctx = { firmware: img };
  const mode = o.mode ?? 'without-response';
  const t0 = Date.now();
  let tReady: number | null = null;
  let resendFrom: number | null = null;
  let final: number | null = null;
  let next = c.statuses.length;
  const poll = () => {
    while (next < c.statuses.length) {
      const st = c.statuses[next++]!;
      if (st.status === 2 && tReady === null) tReady = Date.now() - t0;
      else if (st.status === 2) resendFrom = st.seq;
      else final = st.status;
    }
  };
  await c.link.command(fwStart(img), 'fw start', ctx);
  while (tReady === null) {
    await new Promise((r) => setTimeout(r, 10));
    poll();
    if (Date.now() - t0 > 30_000) return { result: 'no ready', t46: t0, tReady, tEnd: null };
  }
  let seq = 1;
  try {
    while (final === null) {
      poll();
      if (resendFrom !== null) {
        seq = resendFrom;
        resendFrom = null;
        c.link.cancelPendingBlocks('resend');
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      if (seq > img.blockCount || (o.stopAfter !== undefined && seq > o.stopAfter)) {
        await new Promise((r) => setTimeout(r, 10));
        if (Date.now() - t0 > 900_000) return { result: 'stalled', t46: t0, tReady, tEnd: null };
        continue;
      }
      await c.link.block(fwBlock(img, seq), mode, ctx, `block ${seq}`);
      seq++;
    }
  } catch (e) {
    return { result: e instanceof LinkLostError || (e as Error).name === 'QueueClosedError' ? 'link lost' : `error ${(e as Error).message}`, t46: t0, tReady, tEnd: null };
  }
  return { result: final === 0 ? 'success' : 'failed', t46: t0, tReady, tEnd: Date.now() - t0 };
}

async function runDrive(c: Awaited<ReturnType<typeof connect>>, o?: Parameters<typeof drive>[1], ms = 120_000) {
  const p = drive(c, o);
  await vi.advanceTimersByTimeAsync(ms);
  return p;
}

describe.runIf(HAS_FIRMWARE)('MockHmi: controller update (PROTOCOL.md + stock trace timing)', () => {
  it('46 → 10 46 01 → 3C 02 01 00 after ~4.57 s → all 10,240 blocks → 3C 00 00 00', async () => {
    const c = await connect({ update: { expectImage: imgBytes } });
    const r = await runDrive(c);
    expect(r.result).toBe('success');
    expect(c.acks).toContain('104601');
    expect(r.tReady).toBeGreaterThanOrEqual(4_570);
    expect(r.tReady).toBeLessThan(4_700);
    expect(c.hmi.fwStatusesSent()).toEqual(['3c020100', '3c000000']);
    expect(c.hmi.blocksAccepted).toBe(10_240);
    expect(c.hmi.identity.ctrl_sw).toBe('03.06.s0');
    expect(c.hmi.inUpdateMode).toBe(false);
    expect(c.hmi.violations).toEqual([]);
    expect(hex(c.hmi.commands()[0]!)).toBe('46000028314273');
  });

  it('live pages stop in update mode', async () => {
    const c = await connect({ update: { neverReady: true } });
    void c.link.command(liveLoop(), 'loop');
    await vi.advanceTimersByTimeAsync(500);
    expect(c.reads.length).toBeGreaterThan(0);
    void c.link.command(fwStart(img), 'start', { firmware: img });
    await vi.advanceTimersByTimeAsync(300);
    c.reads.length = 0;
    void c.link.command(liveLoop(), 'loop again');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(c.reads.length).toBe(0);
  });

  it('resend mid-stream: 3C 02 <k>; stale blocks ignored; the restarted stream completes', async () => {
    const c = await connect({ update: { resendAt: [5_000], expectImage: imgBytes } });
    const r = await runDrive(c);
    expect(r.result).toBe('success');
    expect(c.hmi.fwStatusesSent()).toEqual(['3c020100', '3c028813', '3c000000']); // 5000 = 0x1388
    expect(c.hmi.blocksAccepted).toBe(10_240);
  });

  it('failure: 3C 01; the controller is left erased and reports e031', async () => {
    const c = await connect({ update: { failAt: 700 } });
    const r = await runDrive(c);
    expect(r.result).toBe('failed');
    expect(c.hmi.fwStatusesSent()).toEqual(['3c020100', '3c010000']);
    expect(c.hmi.controllerErased).toBe(true);
    expect(c.hmi.errorBits() & (1 << 21)).not.toBe(0);
  });

  it('disconnect mid-stream; after a power cycle the controller is the recovery case', async () => {
    const c = await connect({ update: { disconnectAt: 1_234 } });
    let disconnected = 0;
    c.hmi.device.onDisconnected(() => disconnected++);
    const r = await runDrive(c);
    expect(r.result).toBe('link lost');
    expect(disconnected).toBe(1);
    expect(c.hmi.advertising).toBe(true);
    c.hmi.powerCycle();
    const gatt = await c.hmi.device.connect();
    const link = new BikeLink(gatt);
    const reads: Uint8Array[] = [];
    const sub = link.subscribe(SVC_EBIKE, CH_READ, (v) => reads.push(v));
    await vi.advanceTimersByTimeAsync(20);
    await sub;
    void link.command(mtuPageMode(), 'mtu');
    void link.command(oncePages([16, 17, 18, 19, 20, 40]), 'ctrl identity');
    await vi.advanceTimersByTimeAsync(300);
    const d = Object.assign({}, ...pagesOf(reads).map((p) => stripNa(decodePage(p))));
    expect(d).toMatchObject({ ctrl_serial1: '', ctrl_model: '', ctrl_sw: '', ctrl_hw: '' });
    expect((d.error_bits as number) & (1 << 21)).not.toBe(0);
  });

  it('bootloader never answers: no 3C at all, the display stays in update mode', async () => {
    const c = await connect({ update: { neverReady: true } });
    const r = await runDrive(c, {}, 60_000);
    expect(r.result).toBe('no ready');
    expect(c.hmi.fwStatusesSent()).toEqual([]);
    expect(c.hmi.inUpdateMode).toBe(true);
  });

  it('slow host (50 ms per block write) still completes; the mock measures nothing itself', async () => {
    const c = await connect({ timing: { blockWriteMs: 50 }, update: { expectImage: imgBytes } });
    const r = await runDrive(c, {}, 700_000);
    expect(r.result).toBe('success');
    expect(r.tEnd! - r.tReady!).toBeGreaterThanOrEqual(10_240 * 50);
  });

  it('HMI streaming timeout (mock assumption): 3C 02 <expected> on a stall, then 3C 01', async () => {
    const c = await connect({ update: { streamTimeoutMs: 1_000, streamRetries: 3 } });
    const r = drive(c, { stopAfter: 10 });
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await r).result).toBe('failed');
    // driver resends from 11 each time, but stops again after block 10; so the HMI keeps asking for 11
    expect(c.hmi.fwStatusesSent()[0]).toBe('3c020100');
    expect(c.hmi.fwStatusesSent().slice(-1)).toEqual(['3c010000']);
    expect(c.hmi.fwStatusesSent().filter((s) => s === '3c020b00').length).toBe(3);
  });

  it('…0011 reporting only write-with-response: without-response is refused, with-response works', async () => {
    const c = await connect({ blockCharProps: { write: true, writeWithoutResponse: false } });
    const props = c.hmi.services()[0]!.characteristics[2]!.properties;
    expect(props).toMatchObject({ write: true, writeWithoutResponse: false });
    const bad = await runDrive(c, { mode: 'without-response' });
    expect(bad.result).toMatch(/NotSupportedError/);
    expect(c.hmi.violations[0]).toMatch(/without-response/);

    const c2 = await connect({ blockCharProps: { write: true, writeWithoutResponse: false }, update: { expectImage: imgBytes } });
    const ok = await runDrive(c2, { mode: 'with-response' });
    expect(ok.result).toBe('success');
    expect(c2.hmi.violations).toEqual([]);
  });
});
