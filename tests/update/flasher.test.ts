/**
 * The block stream (update/controller.ts flashController, the Android ControllerFlasher port) against a
 * scripted fake display and a synthetic image. No real firmware needed, so these run everywhere (CI
 * included). The end-to-end runs with the real image and the simulated HMI are in controllerUpdate.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FwStatus } from '../../src/protocol/pages';
import { FLASH_TIMING, flashController, StatusQueue, type FirmwareChannel, type FirmwareFrames, type FlashProgress } from '../../src/update/controller';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const TOTAL = 100;
const frames: FirmwareFrames = {
  total: TOTAL,
  start: () => Uint8Array.of(0x46, 0, TOTAL & 0xff, TOTAL >> 8, 0x31, 0x42, 0x73),
  block: (seq) => Uint8Array.of(0x47, seq & 0xff, seq >> 8, 8, 1, 2, 3, 4, 5, 6, 7, 8),
};

interface Script {
  /** Ack for 0x46 (null = none arrives). */
  ack?: number | null;
  /** First page 0x3C after the start frame (null = never). */
  ready?: FwStatus | null;
  readyAfterMs?: number;
  writeMs?: number;
  /** Final status after the last block; null = never. */
  finish?: FwStatus | null;
  finishAfterMs?: number;
  /** Hook per written block: push statuses, drop the link, hang. */
  onBlock?: (seq: number, d: FakeDisplay) => void;
}

class FakeDisplay implements FirmwareChannel {
  connected = true;
  readonly q = new StatusQueue();
  readonly written: number[] = [];
  readonly writeTimes: number[] = [];
  starts = 0;
  hang = false;

  constructor(private readonly sc: Script = {}) {}

  get finalSent(): boolean {
    return this.written.length > 0;
  }

  push(status: number, seq: number | null = 0): void {
    this.q.push({ status, seq });
  }

  async sendStart(): Promise<number | null> {
    this.starts++;
    const ready = this.sc.ready === undefined ? { status: 2, seq: 1 } : this.sc.ready;
    if (ready) setTimeout(() => this.q.push(ready), this.sc.readyAfterMs ?? 4_570);
    await new Promise((r) => setTimeout(r, 150));
    return this.sc.ack === undefined ? 1 : this.sc.ack;
  }

  async writeBlock(_frame: Uint8Array, seq: number): Promise<void> {
    if (!this.connected) throw Object.assign(new Error('GATT Server is disconnected'), { name: 'NetworkError' });
    if (this.hang) return new Promise(() => undefined);
    await new Promise((r) => setTimeout(r, this.sc.writeMs ?? 3));
    this.written.push(seq);
    this.writeTimes.push(Date.now());
    this.sc.onBlock?.(seq, this);
    if (seq === TOTAL) {
      const fin = this.sc.finish === undefined ? { status: 0, seq: 0 } : this.sc.finish;
      if (fin) setTimeout(() => this.q.push(fin), this.sc.finishAfterMs ?? 148);
    }
  }

  nextStatus(ms: number) {
    return this.q.next(ms);
  }

  takeStatus() {
    return this.q.take();
  }

  clearStatus() {
    this.q.clear();
  }
}

async function run(d: FakeDisplay, ms = 200_000, opts: Parameters<typeof flashController>[2] = {}) {
  const progress: FlashProgress[] = [];
  const log: string[] = [];
  const p = flashController(d, frames, { onProgress: (x) => progress.push(x), log: (m) => log.push(m), ...opts });
  await vi.advanceTimersByTimeAsync(ms);
  return { r: await p, progress, log };
}

describe('flashController: the stock sequence', () => {
  it('start → ready after ~4.57 s → every block once, in order → status 0', async () => {
    const d = new FakeDisplay();
    const { r, progress } = await run(d);
    expect(r).toMatchObject({ ok: true, writes: TOTAL, resends: 0 });
    if (r.ok) {
      expect(r.readyAfterMs).toBeGreaterThanOrEqual(4_570);
      expect(r.timing).toMatchObject({ count: TOTAL });
    }
    expect(d.written).toEqual(Array.from({ length: TOTAL }, (_, i) => i + 1));
    expect(d.starts).toBe(1);
    expect(progress.at(-1)).toMatchObject({ position: TOTAL, total: TOTAL, writes: TOTAL });
  });

  it('no blocks before the ready status (the erase), however long it takes', async () => {
    const d = new FakeDisplay({ readyAfterMs: 15_000 });
    const p = flashController(d, frames);
    await vi.advanceTimersByTimeAsync(14_900);
    expect(d.written).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await p).ok).toBe(true);
  });

  it('an ack is not required (the stock app doesn\'t wait for one)', async () => {
    const { r } = await run(new FakeDisplay({ ack: null }));
    expect(r.ok).toBe(true);
  });

  it('ready "status 2 seq 0" (or no seq) starts from block 1', async () => {
    const d = new FakeDisplay({ ready: { status: 2, seq: 0 } });
    const { r } = await run(d);
    expect(r.ok).toBe(true);
    expect(d.written[0]).toBe(1);
  });

  it('success reported before every block is written is success (the display counts acks)', async () => {
    const d = new FakeDisplay({ onBlock: (seq, x) => seq === 90 && x.push(0) });
    const { r } = await run(d);
    expect(r.ok).toBe(true);
    expect(d.written.at(-1)).toBe(90);
  });
});

describe('flashController: failures (0x46 is never re-sent)', () => {
  it('a refused start (ack ≠ 1): nothing changed, no blocks', async () => {
    const d = new FakeDisplay({ ack: 2, ready: null });
    const { r } = await run(d);
    expect(r).toMatchObject({ ok: false, kind: 'refused', startSent: false, stoppedAt: 0 });
    expect(d.written).toEqual([]);
  });

  it('bootloader never answers: start-timeout after 20 s, no blocks, start counted as sent', async () => {
    const d = new FakeDisplay({ ready: null });
    const p = flashController(d, frames);
    await vi.advanceTimersByTimeAsync(FLASH_TIMING.startTimeoutMs - 500);
    let settled = false;
    void p.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await p).toMatchObject({ ok: false, kind: 'start-timeout', startSent: true, stoppedAt: 0 });
    expect(d.written).toEqual([]);
    expect(d.starts).toBe(1);
  });

  it('status 1 or 0 instead of "ready": failure / protocol error, no blocks', async () => {
    let d = new FakeDisplay({ ready: { status: 1, seq: 0 } });
    expect((await run(d)).r).toMatchObject({ ok: false, kind: 'controller-failed', startSent: true });
    d = new FakeDisplay({ ready: { status: 0, seq: 0 } });
    expect((await run(d)).r).toMatchObject({ ok: false, kind: 'protocol' });
    d = new FakeDisplay({ ready: { status: 2, seq: TOTAL + 1 } });
    expect((await run(d)).r).toMatchObject({ ok: false, kind: 'protocol' });
    expect(d.written).toEqual([]);
  });

  it('status 1 mid-stream: controller-failed at that block', async () => {
    const d = new FakeDisplay({ onBlock: (seq, x) => seq === 40 && x.push(1) });
    const { r } = await run(d);
    expect(r).toMatchObject({ ok: false, kind: 'controller-failed', stoppedAt: 40, startSent: true });
    expect(d.written.at(-1)).toBe(40);
    expect(d.starts).toBe(1);
  });

  it('link lost mid-stream: link-lost, stopped at the last block written', async () => {
    const d = new FakeDisplay({ onBlock: (seq, x) => { if (seq === 33) x.connected = false; } });
    const { r } = await run(d);
    expect(r).toMatchObject({ ok: false, kind: 'link-lost', stoppedAt: 33, startSent: true });
    expect(d.starts).toBe(1);
  });

  it('a write that never completes: stalled after 30 s', async () => {
    const d = new FakeDisplay({ onBlock: (seq, x) => { if (seq === 10) x.hang = true; } });
    const { r } = await run(d, FLASH_TIMING.stallMs + 10_000);
    expect(r).toMatchObject({ ok: false, kind: 'stalled', stoppedAt: 10 });
  });

  it('all blocks written but no final status: stalled after 30 s', async () => {
    const d = new FakeDisplay({ finish: null });
    const { r } = await run(d, 100_000);
    expect(r).toMatchObject({ ok: false, kind: 'stalled', stoppedAt: TOTAL });
  });

  it('endless resend requests stop after the limit', async () => {
    const d = new FakeDisplay({ onBlock: (seq, x) => seq === 5 && x.push(2, 1) });
    const { r } = await run(d, 200_000, { timing: { maxResends: 3 } });
    expect(r).toMatchObject({ ok: false, kind: 'protocol' });
  });
});

describe('flashController: resend requests', () => {
  it('status 2 at block k: pause 500 ms, then resend from k to the end', async () => {
    let asked = false;
    const d = new FakeDisplay({ onBlock: (seq, x) => { if (seq === 50 && !asked) { asked = true; x.push(2, 50); } } });
    const { r, log } = await run(d);
    expect(r).toMatchObject({ ok: true, resends: 1, writes: TOTAL + 1 });
    const i = d.written.indexOf(50);
    expect(d.written.slice(i, i + 3)).toEqual([50, 50, 51]);
    expect(d.writeTimes[i + 1]! - d.writeTimes[i]!).toBeGreaterThanOrEqual(FLASH_TIMING.resendPauseMs);
    expect(log.some((l) => /Resend requested from block 50/.test(l))).toBe(true);
  });

  it('a newer resend request during the pause wins', async () => {
    let asked = false;
    const d = new FakeDisplay({
      onBlock: (seq, x) => {
        if (seq === 60 && !asked) {
          asked = true;
          x.push(2, 58);
          setTimeout(() => x.push(2, 55), 100); // during the 500 ms pause
        }
      },
    });
    const { r } = await run(d);
    expect(r.ok).toBe(true);
    const i = d.written.indexOf(60);
    expect(d.written[i + 1]).toBe(55);
  });
});

describe('flashController: slow host (50 ms per write)', () => {
  it('completes; the ETA is measured from the real write rate and counts down', async () => {
    const d = new FakeDisplay({ writeMs: 50 });
    const { r, progress } = await run(d, 100_000);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.timing!.avgMs).toBeGreaterThanOrEqual(50);
      expect(r.elapsedMs).toBeGreaterThanOrEqual(TOTAL * 50);
    }
    const at20 = progress.find((x) => x.position === 20)!;
    expect(at20.etaMs).not.toBeNull();
    // 80 blocks left at ~50 ms each
    expect(at20.etaMs!).toBeGreaterThan(80 * 45);
    expect(at20.etaMs!).toBeLessThan(80 * 60);
    expect(progress.at(-1)!.etaMs).toBe(0);
    expect(progress[0]!.etaMs).toBeNull(); // not enough to measure yet
  });

  it('slow host + a resend: the resend logic still holds', async () => {
    let asked = false;
    const d = new FakeDisplay({ writeMs: 50, onBlock: (seq, x) => { if (seq === 30 && !asked) { asked = true; x.push(2, 25); } } });
    const { r } = await run(d, 100_000);
    expect(r).toMatchObject({ ok: true, resends: 1, writes: TOTAL + 6 });
  });
});
