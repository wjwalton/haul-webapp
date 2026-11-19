import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BikeLink } from '../../src/ble/link';
import { MockHmi, ReplayTransport } from '../../src/ble/mock';
import { RawRecorder } from '../../src/export/rawJsonl';
import type { VerifiedFirmware } from '../../src/analysis/firmware';
import { fromHex, hex } from '../../src/protocol/bytes';
import { ForbiddenFrameError, fwBlock, fwStart, liveLoop, mtuPageMode, NEVER_SEND, oncePages, PAGES_CONFIG, PAGES_IDENTITY } from '../../src/protocol/frames';
import { CH_POWER, CH_READ, CH_WRITE, DIS_SERIAL_BLOCKLISTED, SVC_DIS, SVC_EBIKE } from '../../src/protocol/gatt';
import { bundledController, capture, HAS_CAPTURES, HAS_FIRMWARE } from '../helpers';

let img: VerifiedFirmware;
beforeAll(async () => {
  if (HAS_FIRMWARE) img = await bundledController();
});
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('BikeLink: the only write path', () => {
  it('refuses every never-send opcode before anything reaches the bike', async () => {
    const hmi = new MockHmi();
    const link = new BikeLink(await hmi.device.connect());
    for (const op of Object.keys(NEVER_SEND).map(Number)) {
      expect(() => link.command(Uint8Array.of(op, 1, 0, 0), 'x')).toThrow(ForbiddenFrameError);
      expect(() => link.block(Uint8Array.of(op, 1, 0, 0), 'without-response', {}, 'x')).toThrow(ForbiddenFrameError);
      if (HAS_FIRMWARE) expect(() => link.block(Uint8Array.of(op, 1, 0, 0), 'without-response', { firmware: img }, 'x')).toThrow(ForbiddenFrameError);
    }
    if (HAS_FIRMWARE) {
      expect(() => link.command(fwStart(img), 'no ctx')).toThrow(/controller update/);
      expect(() => link.block(fwBlock(img, 1), 'without-response', {}, 'no ctx')).toThrow(/controller update/);
    }
    await vi.advanceTimersByTimeAsync(100);
    expect(hmi.writes).toEqual([]);
    expect(hmi.violations).toEqual([]);
  });

  it('refuses to read the blocklisted DIS serial', async () => {
    const hmi = new MockHmi();
    const link = new BikeLink(await hmi.device.connect());
    await expect(link.read(SVC_DIS, DIS_SERIAL_BLOCKLISTED)).rejects.toThrow(/blocklist/);
    expect(hmi.violations).toEqual([]);
  });

  it('allowed frames go out in order through the queue, and raw.jsonl records the traffic', async () => {
    let now = 0;
    vi.setSystemTime(0);
    const rec = new RawRecorder(() => now);
    const hmi = new MockHmi();
    const link = new BikeLink(await hmi.device.connect(), { recorder: rec });
    const subs = Promise.all([
      link.subscribe(SVC_EBIKE, CH_WRITE, () => {}),
      link.subscribe(SVC_EBIKE, CH_POWER, () => {}),
      link.subscribe(SVC_EBIKE, CH_READ, () => {}),
    ]);
    await vi.advanceTimersByTimeAsync(50);
    await subs;
    const sent = [mtuPageMode(), oncePages(PAGES_IDENTITY), oncePages(PAGES_CONFIG), liveLoop()];
    const done = Promise.all(sent.map((f, i) => link.command(f, `cmd ${i}`)));
    await vi.advanceTimersByTimeAsync(300);
    await done;
    now = 500;
    hmi.setStatus({ charging: true });
    expect(hmi.commands().map(hex)).toEqual(sent.map(hex));
    const lines = rec.text().trim().split('\n').map((l) => JSON.parse(l) as { ch: string; hex: string });
    expect(lines.filter((l) => l.ch === 'tx').map((l) => l.hex)).toEqual(sent.map(hex));
    expect(lines.filter((l) => l.ch === 'ack').map((l) => l.hex)).toEqual(['103c01', '103d01', '103d01', '103e01']);
    expect(lines.filter((l) => l.ch === 'read').length).toBeGreaterThan(0);
    expect(lines.filter((l) => l.ch === 'power').map((l) => l.hex)).toEqual(['01000101']);
  });
});

describe.runIf(HAS_CAPTURES)('ReplayTransport (raw.jsonl playback)', () => {
  it('lockstep: sending the same frames as the Python client gives no mismatches and the same reads', async () => {
    const recs = capture('2026-10-25_1205_short_ride_raw.jsonl');
    const t = new ReplayTransport(recs, { pace: 'lockstep', speed: Infinity });
    const dev = await t.requestDevice({ optionalServices: [] });
    const link = new BikeLink(await dev.connect());
    const reads: string[] = [];
    const subs = Promise.all([
      link.subscribe(SVC_EBIKE, CH_WRITE, () => {}),
      link.subscribe(SVC_EBIKE, CH_POWER, () => {}),
      link.subscribe(SVC_EBIKE, CH_READ, (v) => reads.push(hex(v))),
    ]);
    await vi.advanceTimersByTimeAsync(10);
    await subs;
    for (const r of recs.filter((x) => x.ch === 'tx')) {
      const p = link.command(fromHex(r.hex), 'replayed tx');
      await vi.advanceTimersByTimeAsync(10);
      await p;
    }
    await vi.advanceTimersByTimeAsync(10);
    expect(t.device.mismatches).toEqual([]);
    expect(reads).toEqual(recs.filter((x) => x.ch === 'read').map((x) => x.hex));
  });

  it('lockstep: a different frame is reported as a mismatch', async () => {
    const recs = capture('2026-10-25_1016_short_connect_raw.jsonl');
    const t = new ReplayTransport(recs, { pace: 'lockstep', speed: Infinity });
    const link = new BikeLink(await (await t.requestDevice({ optionalServices: [] })).connect());
    const p = link.command(oncePages([55]), 'not what the capture sent');
    await vi.advanceTimersByTimeAsync(10);
    await p;
    expect(t.device.mismatches).toEqual([{ expected: '3c01', got: hex(oncePages([55])) }]);
  });
});
