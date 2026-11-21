/**
 * The battery update's CAN-level state machine (update/battery.ts flashBms / identifyBms) against the
 * simulated BMS (ble/mock/bms.ts), through a minimal channel: no display, no whitelist (that's
 * batteryUpdate.test.ts). Synthetic images, so it runs everywhere. PROTOCOL.md's rules: src 0 only as
 * replies, stop-and-wait, a missed / extra ack or a wrong echo ends the attempt, the next attempt starts
 * again from 0x045, up to 3.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bytesEqual } from '../../src/protocol/bytes';
import { bmsEnd, bmsRead, bmsStart, bmsWake } from '../../src/protocol/frames';
import type { CanFrame } from '../../src/protocol/pages';
import { MockBms, type BmsBus, type MockBmsOptions } from '../../src/ble/mock/bms';
import { CanQueue, flashBms, identifyBms, type BmsChannel, type BmsFlashFrames, type BmsFlashProgress, type BmsTiming } from '../../src/update/battery';
import { syntheticBmsImage } from '../helpers';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const frame = (canId: number, data: Uint8Array, src: 0 | 1): CanFrame => ({ canId, len: 8, data: data.slice(0, 8), src: src === 0 ? 'HMI_RX' : 'HMI_TX', hmiTs: 0 });

interface Rig {
  ch: BmsChannel;
  bms: MockBms;
  sent: { id: number; data: Uint8Array }[];
  drop: () => void;
  /** Mutate the next echo of block [i]. */
  corruptEchoAt: Set<number>;
  /** Send a second 0x048 for block [i]. */
  doubleAckAt: Set<number>;
  /** After block [i], the bootloader announces a restart (0x046) instead of acking. */
  restartAt: Set<number>;
  /** Push a frame onto the mirror, as if seen on the bus. */
  inject: (f: CanFrame) => void;
  /**
   * The Nth 0x047 write (0-based, retries counted) fails: 'lost' = never reached the bus, 'sent' = reached
   * the bus but the write still reported an error, 'timeout' = the queue gave up on it (not on the bus).
   */
  failWrites: Map<number, 'lost' | 'sent' | 'timeout'>;
}

function rig(opts: MockBmsOptions = {}, img?: Uint8Array): Rig {
  const bms = new MockBms({ version: '010009RC', ...opts, script: { expectImage: img ?? null, ...opts.script } });
  const q = new CanQueue();
  let connected = true;
  const sent: Rig['sent'] = [];
  const corruptEchoAt = new Set<number>();
  const doubleAckAt = new Set<number>();
  const restartAt = new Set<number>();
  const failWrites: Rig['failWrites'] = new Map();
  let blocks = 0;
  let writes47 = 0;
  const tick = (ms = 2) => new Promise((r) => setTimeout(r, ms));
  const netErr = () => Object.assign(new Error('GATT operation failed for unknown reason.'), { name: 'NetworkError' });
  const bus: BmsBus = {
    reply: (id, data, ms) => setTimeout(() => connected && q.push(frame(id, data, 0)), ms + 1),
    schedule: (ms, fn) => setTimeout(fn, ms),
    restartSystem: () => undefined,
    note: () => undefined,
  };
  const ch: BmsChannel = {
    get connected() {
      return connected;
    },
    async send(f) {
      if (!connected) throw Object.assign(new Error('GATT Server is disconnected'), { name: 'NetworkError' });
      const id = f[1]! | (f[2]! << 8);
      const data = f.slice(6, 14);
      const how = id === 0x47 ? failWrites.get(writes47++) : undefined;
      if (how === 'lost') {
        await tick();
        throw netErr();
      }
      if (how === 'timeout') {
        await tick();
        throw Object.assign(new Error('block: no completion within 10000 ms'), { name: 'GattTimeoutError' });
      }
      sent.push({ id, data });
      const echo = data.slice();
      if (id === 0x47) {
        const i = blocks++;
        if (corruptEchoAt.has(i)) {
          corruptEchoAt.delete(i);
          echo[0] ^= 0xff;
        }
        if (restartAt.has(i)) {
          restartAt.delete(i);
          setTimeout(() => q.push(frame(0x46, new Uint8Array(8), 0)), 2);
          setTimeout(() => connected && q.push(frame(id, echo, 1)), 1);
          await new Promise((r) => setTimeout(r, 2));
          return 1;
        }
        if (doubleAckAt.has(i)) {
          doubleAckAt.delete(i);
          setTimeout(() => q.push(frame(0x48, new Uint8Array(8), 0)), 3);
        }
      }
      if (id === 0x45) blocks = 0;
      setTimeout(() => connected && q.push(frame(id, echo, 1)), 1);
      bms.onFrame(id, data, bus);
      await tick();
      if (how === 'sent') throw netErr();
      return 1;
    },
    next: (ms) => q.next(ms),
    take: () => q.take(),
    putBack: (frames) => q.putBack(frames),
    clear: () => q.clear(),
  };
  return {
    ch, bms, sent, corruptEchoAt, doubleAckAt, restartAt, failWrites,
    drop: () => {
      connected = false;
    },
    inject: (f) => q.push(f),
  };
}

function framesFor(img: Uint8Array): BmsFlashFrames {
  const total = img.length / 8;
  return {
    total,
    wake: bmsWake,
    read: bmsRead,
    start: bmsStart,
    end: bmsEnd,
    block: (i) => Uint8Array.of(0x52, 0x47, 0, 0, 0, 8, ...img.subarray(i * 8, i * 8 + 8)),
    blockData: (i) => img.slice(i * 8, i * 8 + 8),
  };
}

const IMG = syntheticBmsImage(4);
const fast: Partial<BmsTiming> = { retryPauseMs: 100 };

async function run(r: Rig, img = IMG, timing: Partial<BmsTiming> = fast, ms = 200_000) {
  const progress: BmsFlashProgress[] = [];
  const log: string[] = [];
  const p = flashBms(r.ch, framesFor(img), { timing, onProgress: (x) => progress.push(x), log: (m) => log.push(m) });
  await vi.advanceTimersByTimeAsync(ms);
  return { res: await p, progress, log };
}

describe('flashBms: the stop-and-wait transfer', () => {
  it('a clean run: (0x10F), 0x101, 0x045, every block once in file order, 0x049, success on attempt 1', async () => {
    const r = rig({}, IMG);
    const { res, progress } = await run(r);
    expect(res).toMatchObject({ ok: true, attempts: 1 });
    expect(r.bms.completed).toBe(1);
    expect(r.bms.receivedBytes).toBe(IMG.length);
    const ids = r.sent.map((s) => s.id);
    expect(ids.slice(0, 3)).toEqual([0x10f, 0x101, 0x045]);
    expect(ids.slice(-1)).toEqual([0x049]);
    const data = r.sent.filter((s) => s.id === 0x47);
    expect(data.length).toBe(IMG.length / 8);
    data.forEach((s, i) => expect(bytesEqual(s.data, IMG.subarray(i * 8, i * 8 + 8)), `block ${i}`).toBe(true));
    expect(progress.some((p) => p.phase === 'erasing')).toBe(true);
    expect(progress.at(-1)).toMatchObject({ phase: 'finishing', block: IMG.length / 8 });
  });

  it('a lost 0x048: the attempt ends after 5 s and the next starts again from 0x045 (never one block resent)', async () => {
    const r = rig({ script: { missAckAt: [10] } }, IMG);
    const { res, log } = await run(r);
    expect(res).toMatchObject({ ok: true, attempts: 2 });
    expect(r.bms.starts).toBe(2);
    expect(log.join('\n')).toMatch(/No acknowledgement \(0x048\) for block 11 .* within 5 s/);
    // the second pass is the whole file again, from block 0
    const starts = r.sent.map((s, k) => (s.id === 0x45 ? k : -1)).filter((k) => k >= 0);
    const second = r.sent.slice(starts[1]! + 1).filter((s) => s.id === 0x47);
    expect(second.length).toBe(IMG.length / 8);
    expect(bytesEqual(second[0]!.data, IMG.subarray(0, 8))).toBe(true);
  });

  it('an erase error (0x046 data[1] = 1) ends the attempt; the next one succeeds', async () => {
    const r = rig({ script: { eraseErrors: 1 } }, IMG);
    const { res, log } = await run(r);
    expect(res).toMatchObject({ ok: true, attempts: 2 });
    expect(log.join('\n')).toMatch(/erase error/);
  });

  it('0x04A not all zero, three times: failed after 3 attempts, the pack left in its bootloader', async () => {
    const r = rig({ script: { resultFailures: 3 } }, IMG);
    const { res } = await run(r);
    expect(res).toMatchObject({ ok: false, kind: 'result-failed', attempts: 3, startSent: true });
    expect(r.bms.starts).toBe(3);
    expect(r.bms.app).toBe(false);
  });

  it('an echo that is not the block just sent: out of order, attempt over', async () => {
    const r = rig({}, IMG);
    r.corruptEchoAt.add(7);
    const { res, log } = await run(r);
    expect(res).toMatchObject({ ok: true, attempts: 2 });
    expect(log.join('\n')).toMatch(/out of order/);
  });

  it('an extra 0x048 (two acks for one block): attempt over', async () => {
    const r = rig({}, IMG);
    r.doubleAckAt.add(3);
    const { res, log } = await run(r);
    expect(res).toMatchObject({ ok: true, attempts: 2 });
    expect(log.join('\n')).toMatch(/extra acknowledgement/);
  });

  it('a 0x046 in the middle of the transfer: the bootloader restarted, attempt over at once', async () => {
    const r = rig({}, IMG);
    r.restartAt.add(5);
    const { res, log } = await run(r);
    expect(res).toMatchObject({ ok: true, attempts: 2 });
    const text = log.join(' | ');
    expect(text).toMatch(/0x046 .* in the middle of the transfer \(block 6\): it restarted/);
    expect(text).not.toMatch(/within 5 s/);
  });

  it('no erase reply: each attempt waits 30 s; after 3 the pack is reported in its bootloader', async () => {
    const r = rig({}, IMG);
    r.bms.onFrame = () => undefined; // nothing on the bus answers
    const { res } = await run(r, IMG, fast, 200_000);
    expect(res).toMatchObject({ ok: false, kind: 'no-erase-reply', attempts: 3, startSent: true });
  });

  it('a write that failed and never reached the bus is sent again (no echo), once: the attempt carries on', async () => {
    const r = rig({}, IMG);
    r.failWrites.set(7, 'lost');
    const { res, log } = await run(r);
    expect(res).toMatchObject({ ok: true, attempts: 1 });
    expect(r.bms.starts).toBe(1);
    expect(r.bms.receivedBytes).toBe(IMG.length); // every block on the bus exactly once
    expect(r.bms.mismatch).toBe(false);
    expect(log.join(' | ')).toMatch(/write of block 8 failed .* isn't on the bus: sending it again \(1 of 3\)/);
  });

  it('a write that reported an error but did reach the bus (its echo came back) is NOT sent again', async () => {
    const r = rig({}, IMG);
    r.failWrites.set(7, 'sent');
    const { res, log } = await run(r);
    expect(res).toMatchObject({ ok: true, attempts: 1 });
    expect(r.sent.filter((s) => s.id === 0x47).length).toBe(IMG.length / 8); // no duplicate block
    expect(r.bms.mismatch).toBe(false);
    expect(log.join(' | ')).toMatch(/its echo shows it reached the bus: carrying on/);
  });

  it('a write that keeps failing: the attempt ends after 3 resends and the next attempt starts from 0x045', async () => {
    const r = rig({}, IMG);
    for (const k of [7, 8, 9, 10]) r.failWrites.set(k, 'lost');
    const { res, log } = await run(r);
    expect(res).toMatchObject({ ok: true, attempts: 2 });
    expect(log.join(' | ')).toMatch(/attempt failed \(write-failed\): Couldn't send block 8 after 4 tries/);
  });

  it('a write that timed out is never sent again (it may still go out): next attempt from 0x045', async () => {
    const r = rig({}, IMG);
    r.failWrites.set(7, 'timeout');
    const { res, log } = await run(r);
    expect(res).toMatchObject({ ok: true, attempts: 2 });
    expect(log.join(' | ')).toMatch(/GattTimeoutError.*not sent again/);
    expect(log.join(' | ')).not.toMatch(/sending it again/);
  });

  it('the link drops mid-stream: stopped at once, no further attempts', async () => {
    const r = rig({}, IMG);
    const p = flashBms(r.ch, framesFor(IMG), { timing: fast });
    await vi.advanceTimersByTimeAsync(150);
    r.drop();
    await vi.advanceTimersByTimeAsync(60_000);
    const res = await p;
    expect(res).toMatchObject({ ok: false, kind: 'link-lost', attempts: 1, startSent: true });
  });

  it('bus noise (display polls, BMS telemetry, echoes of other IDs) is ignored', async () => {
    const r = rig({}, IMG);
    const noise = setInterval(() => {
      r.inject(frame(0x2c1, new Uint8Array(8), 1));
      r.inject(frame(0x283, Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8), 0));
    }, 3);
    const { res } = await run(r);
    clearInterval(noise);
    expect(res).toMatchObject({ ok: true, attempts: 1 });
  });
});

describe('identifyBms', () => {
  async function ident(r: Rig, timing: Partial<BmsTiming> = {}) {
    const p = identifyBms(r.ch, { wake: bmsWake, read: bmsRead }, { timing });
    await vi.advanceTimersByTimeAsync(20_000);
    return p;
  }

  it('the application answers: version, line, hardware type, and the measured round trip', async () => {
    const r = rig({ version: '010009RC' });
    const id = await ident(r);
    expect(id).toMatchObject({ echo: true, responding: true, version: '01.00.09', line: 'RC', hwType: 2 });
    expect(id.rttMs).toBeGreaterThan(0);
    expect(id.rttMs).toBeLessThan(50);
    const sc = rig({ version: '010005SC' });
    expect(await ident(sc)).toMatchObject({ version: '01.00.05', line: 'SC', hwType: 1 });
  });

  it('a pack in its bootloader answers nothing: echo yes, responding no (3 + 2 tries)', async () => {
    const r = rig({ version: '' });
    const id = await ident(r);
    expect(id).toMatchObject({ echo: true, responding: false, version: null, hwType: null });
    expect(r.sent.filter((s) => s.id === 0x280).length).toBe(4); // the probe + 3 tries
    expect(r.sent.filter((s) => s.id === 0x281).length).toBe(2);
  });

  it('the echo of our own 0x280 (src 1, 8 zero bytes) is never taken as the version', async () => {
    const r = rig({ version: '' });
    const id = await ident(r);
    expect(id.versionRaw).toBeNull();
  });

  it('no echo: bus access does not work, nothing more is sent', async () => {
    const r = rig({ version: '010009RC' });
    // a display that acks the 52 but never puts the frame on the bus
    const silent: BmsChannel = {
      connected: true,
      send: async (f) => {
        r.sent.push({ id: f[1]! | (f[2]! << 8), data: f.slice(6) });
        return 1;
      },
      next: (ms) => r.ch.next(ms),
      take: () => r.ch.take(),
      putBack: (frames) => r.ch.putBack(frames),
      clear: () => r.ch.clear(),
    };
    const p = identifyBms(silent, { wake: bmsWake, read: bmsRead });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await p).toMatchObject({ echo: false, responding: false });
    expect(r.sent.length).toBe(1);
  });
});
