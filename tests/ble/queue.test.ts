import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GattQueue, GattTimeoutError, OpCancelledError, QueueClosedError, type QueueOpInfo } from '../../src/ble/queue';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('GattQueue', () => {
  it('runs one op at a time, in order', async () => {
    const q = new GattQueue();
    const log: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const op = (name: string, ms: number) => async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      log.push(`start ${name}`);
      await sleep(ms);
      log.push(`end ${name}`);
      inFlight--;
      return name;
    };
    const all = Promise.all([q.run('a', op('a', 30)), q.run('b', op('b', 5)), q.run('c', op('c', 10))]);
    await vi.advanceTimersByTimeAsync(100);
    expect(await all).toEqual(['a', 'b', 'c']);
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
    expect(maxInFlight).toBe(1);
  });

  it('cancelPending drops only ops that have not been issued', async () => {
    const q = new GattQueue();
    const issued: string[] = [];
    const op = (n: string) => async () => {
      issued.push(n);
      await sleep(10);
    };
    const first = q.run('b1', op('b1'), { tag: 'block' });
    const rest = [2, 3, 4].map((i) => q.run(`b${i}`, op(`b${i}`), { tag: 'block' }).catch((e: unknown) => e));
    const cmd = q.run('cmd', op('cmd'), { tag: 'command' });
    await vi.advanceTimersByTimeAsync(1);
    expect(q.cancelPending((_l, tag) => tag === 'block', 'resend requested')).toBe(3);
    await vi.advanceTimersByTimeAsync(50);
    await first;
    await cmd;
    for (const r of await Promise.all(rest)) expect(r).toBeInstanceOf(OpCancelledError);
    expect(issued).toEqual(['b1', 'cmd']);
  });

  it('a timeout rejects the caller, but the next op waits until the hung one settles', async () => {
    const infos: QueueOpInfo[] = [];
    const q = new GattQueue({ opTimeoutMs: 100, onOp: (i) => infos.push(i) });
    let secondStartedAt = -1;
    const t0 = Date.now();
    const hung = q.run('hung', () => sleep(500)).catch((e: unknown) => e);
    const next = q.run('next', async () => {
      secondStartedAt = Date.now() - t0;
    });
    await vi.advanceTimersByTimeAsync(150);
    expect(await hung).toBeInstanceOf(GattTimeoutError);
    expect(secondStartedAt).toBe(-1); // still waiting on the hung op: no overlapping GATT ops
    await vi.advanceTimersByTimeAsync(400);
    await next;
    expect(secondStartedAt).toBeGreaterThanOrEqual(500);
    expect(infos[0]).toMatchObject({ label: 'hung', timedOut: true, ok: false });
  });

  it('close() rejects pending and new ops', async () => {
    const q = new GattQueue();
    const a = q.run('a', () => sleep(10));
    const b = q.run('b', () => sleep(10)).catch((e: unknown) => e);
    q.close('link lost');
    expect(await b).toBeInstanceOf(QueueClosedError);
    await expect(q.run('c', async () => 1)).rejects.toBeInstanceOf(QueueClosedError);
    await vi.advanceTimersByTimeAsync(20);
    await a; // the op in flight runs to completion
    await q.idle();
  });

  it('reports per-op timings (used for per-block write times)', async () => {
    const infos: QueueOpInfo[] = [];
    const q = new GattQueue({ onOp: (i) => infos.push(i) });
    const p = Promise.all([q.run('w1', () => sleep(3)), q.run('w2', () => sleep(7))]);
    await vi.advanceTimersByTimeAsync(20);
    await p;
    expect(infos.map((i) => [i.label, i.ranMs, i.ok])).toEqual([['w1', 3, true], ['w2', 7, true]]);
    expect(infos[1]!.waitedMs).toBe(3);
  });
});
