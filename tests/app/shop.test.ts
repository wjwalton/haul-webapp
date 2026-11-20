/**
 * ShopApp against the simulated bikes: chooser filter, confirm step, wrong bike, link loss and
 * reconnect without the chooser, and "disconnect / connect another bike" wiping everything.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BIKE_REQUEST, ShopApp } from '../../src/app/shop';
import { MockHmi, MockTransport } from '../../src/ble/mock';
import type { BleDevice, GattTransport } from '../../src/ble/transport';
import { parseRawJsonl } from '../../src/export/rawJsonl';
import { NAME_PREFIX, OPTIONAL_SERVICES, SCAN_UUID, SVC_EBIKE } from '../../src/protocol/gatt';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup(pick = 0) {
  const a = new MockHmi({ name: 'EH02_00001' });
  const b = new MockHmi({ name: 'EH02_00002' });
  const transport = new MockTransport([a, b], (listed) => listed[pick] ?? null);
  const shop = new ShopApp(transport, { errorPoll: false });
  return { a, b, transport, shop };
}

async function choose(shop: ShopApp) {
  const p = shop.chooseBike();
  await vi.advanceTimersByTimeAsync(2_000);
  await p;
}

describe('picking and confirming a bike', () => {
  it('the chooser filter is the spec\'s: name prefix OR scan UUID; the Globe service only as optional', () => {
    expect(BIKE_REQUEST.namePrefix).toBe(NAME_PREFIX);
    expect(BIKE_REQUEST.advertisedServices).toEqual([SCAN_UUID]);
    expect(BIKE_REQUEST.advertisedServices).not.toContain(SVC_EBIKE);
    expect(BIKE_REQUEST.optionalServices).toEqual([...OPTIONAL_SERVICES]);
  });

  it('connects to the picked bike, reads it, and needs a confirmation', async () => {
    const { b, shop } = setup(1);
    await choose(shop);
    const s = shop.getSnapshot();
    expect(s.phase).toBe('connected');
    expect(s.device?.name).toBe('EH02_00002');
    expect(s.session?.phase).toBe('live');
    expect(s.confirmed).toBe(false);
    expect(b.isConnected).toBe(true);
    shop.confirm();
    expect(shop.getSnapshot().confirmed).toBe(true);
  });

  it('confirm does nothing before the bike has been read', async () => {
    const { shop } = setup();
    const p = shop.chooseBike();
    await vi.advanceTimersByTimeAsync(5);
    shop.confirm();
    expect(shop.getSnapshot().confirmed).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    await p;
  });

  it('wrong bike: disconnects, forgets it, and the bike advertises again', async () => {
    const { a, transport, shop } = setup();
    await choose(shop);
    expect(transport.listed(BIKE_REQUEST).map((x) => x.name)).toEqual(['EH02_00002']);
    const p = shop.wrongBike();
    await vi.advanceTimersByTimeAsync(10);
    await p;
    const s = shop.getSnapshot();
    expect(s).toMatchObject({ phase: 'idle', device: null, confirmed: false, session: null });
    expect(s.message).toMatch(/wrong bike/);
    expect(a.isConnected).toBe(false);
    expect(transport.listed(BIKE_REQUEST).map((x) => x.name)).toEqual(['EH02_00001', 'EH02_00002']);
    expect(shop.rawJsonl()).toBe('');
  });

  it('a cancelled chooser changes nothing', async () => {
    const { shop, transport } = setup();
    transport.choose = () => null;
    await choose(shop);
    expect(shop.getSnapshot()).toMatchObject({ phase: 'idle', device: null, message: null });
  });
});

describe('link loss and reconnect', () => {
  it('a dropped link shows "lost"; reconnect uses the same device (no chooser) and keeps the confirmation', async () => {
    const { a, transport, shop } = setup();
    await choose(shop);
    shop.confirm();
    expect(transport.requests).toBe(1);
    a.dropLink('out of range');
    let s = shop.getSnapshot();
    expect(s.phase).toBe('lost');
    expect(s.message).toMatch(/connection to EH02_00001 was lost/);
    expect(s.session?.phase).toBe('ended');
    const p = shop.reconnect();
    await vi.advanceTimersByTimeAsync(2_000);
    await p;
    s = shop.getSnapshot();
    expect(s.phase).toBe('connected');
    expect(s.session?.phase).toBe('live');
    expect(s.confirmed).toBe(true);
    expect(s.connections).toBe(2);
    expect(transport.requests).toBe(1); // no second chooser
    expect(a.violations).toEqual([]);
  });

  it('raw.jsonl covers both connections, in the Python format', async () => {
    const { a, shop } = setup();
    await choose(shop);
    a.dropLink();
    const p = shop.reconnect();
    await vi.advanceTimersByTimeAsync(2_000);
    await p;
    const recs = parseRawJsonl(shop.rawJsonl());
    const tx = recs.filter((r) => r.ch === 'tx').map((r) => r.hex.slice(0, 2));
    expect(tx).toEqual(['3c', '3d', '3d', '3e', '3c', '3d', '3d', '3e']);
    expect(recs.some((r) => r.ch === 'ack')).toBe(true);
    expect(recs.some((r) => r.ch === 'power')).toBe(true);
    expect(recs.some((r) => r.ch === 'read')).toBe(true);
    expect(shop.rawLineCount).toBe(recs.length);
  });

  it('disconnect wipes everything; the intentional disconnect is not reported as "lost"', async () => {
    const { a, shop } = setup();
    await choose(shop);
    shop.confirm();
    const p = shop.disconnect();
    await vi.advanceTimersByTimeAsync(10);
    await p;
    expect(shop.getSnapshot()).toMatchObject({ phase: 'idle', device: null, confirmed: false, session: null, connections: 0 });
    expect(a.isConnected).toBe(false);
    expect(shop.rawLineCount).toBe(0);
  });

  it('a bike another app grabbed after it was listed fails with advice, and retrying works once it is free', async () => {
    const a = new MockHmi({ name: 'EH02_00001' });
    const transport = new MockTransport([a]);
    transport.requestDevice = async () => a.device; // the chooser listed it a moment before
    const otherApp = await a.device.connect();
    const shop = new ShopApp(transport, { errorPoll: false });
    await choose(shop);
    expect(shop.getSnapshot().phase).toBe('failed');
    expect(shop.getSnapshot().message).toMatch(/nothing else \(another tab, app or phone\) is connected to it/);
    await otherApp.disconnect();
    const p = shop.reconnect();
    await vi.advanceTimersByTimeAsync(2_000);
    await p;
    expect(shop.getSnapshot().session?.phase).toBe('live');
  });
});

/**
 * 2026-11-19: on Windows a reconnect after a stale link needed a page reload. Reconnect now closes the
 * old link, lets the OS settle, retries, ignores a disconnect event from an earlier connection, and
 * falls back to picking the same bike again (which keeps its confirmation). Every step is logged.
 */
describe('reconnect robustness', () => {
  /** A device whose next connects fail, and whose disconnect event can be fired by hand (a late one). */
  function flaky(hmi: MockHmi) {
    const listeners = new Set<() => void>();
    hmi.device.onDisconnected(() => {
      for (const l of [...listeners]) l();
    });
    const ctl = { failNext: 0 };
    const device: BleDevice = {
      id: hmi.device.id,
      name: hmi.device.name,
      async connect() {
        if (ctl.failNext > 0) {
          ctl.failNext--;
          await new Promise((r) => setTimeout(r, 300));
          throw new Error('NetworkError: Connection attempt failed.');
        }
        return hmi.device.connect();
      },
      onDisconnected(l) {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    };
    const transport: GattTransport = { id: 'mock', availability: async () => true, requestDevice: async () => device };
    const fireLateDisconnect = () => {
      for (const l of [...listeners]) l();
    };
    return { ctl, transport, fireLateDisconnect };
  }

  async function connected(hmi = new MockHmi()) {
    const f = flaky(hmi);
    const shop = new ShopApp(f.transport, { errorPoll: false });
    await choose(shop);
    shop.confirm();
    return { hmi, shop, ...f };
  }

  it('a disconnect event while the current link still reports connected is an earlier connection\'s: ignored', async () => {
    const { hmi, shop, fireLateDisconnect } = await connected();
    fireLateDisconnect();
    expect(shop.getSnapshot().phase).toBe('connected');
    expect(shop.getSnapshot().events.at(-1)).toMatch(/Disconnect event ignored: the current link still reports connected/);
    hmi.dropLink('out of range'); // a real one still counts
    expect(shop.getSnapshot().phase).toBe('lost');
    expect(shop.getSnapshot().events.at(-1)).toMatch(/Disconnect event: the link was lost/);
  });

  it('bike switched off and on without the computer noticing: stale; Reconnect closes, settles and reads it again', async () => {
    const { hmi, shop } = await connected();
    hmi.powerCycleUnnoticed();
    await vi.advanceTimersByTimeAsync(7_000);
    expect(shop.getSnapshot().session?.stale).not.toBeNull();
    expect(shop.getSnapshot().events.some((e) => /\(stale\)/.test(e))).toBe(true);
    const p = shop.reconnect();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(shop.getSnapshot().phase).toBe('connecting'); // settling: the old link is closed first
    await vi.advanceTimersByTimeAsync(3_000);
    await p;
    const s = shop.getSnapshot();
    expect(s).toMatchObject({ phase: 'connected', confirmed: true });
    expect(s.session?.phase).toBe('live');
    expect(s.session?.stale).toBeNull();
    expect(s.events.some((e) => /Reconnect requested \(connected, no data for \d+ s\)/.test(e))).toBe(true);
    expect(hmi.violations).toEqual([]);
  });

  it('a reconnect whose first two attempts fail succeeds on the third, all logged', async () => {
    const { hmi, shop, ctl } = await connected();
    hmi.dropLink('switched off');
    ctl.failNext = 2;
    const p = shop.reconnect();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(shop.getSnapshot().message).toMatch(/Trying again: attempt \d of 3/);
    await vi.advanceTimersByTimeAsync(10_000);
    await p;
    const s = shop.getSnapshot();
    expect(s).toMatchObject({ phase: 'connected', confirmed: true });
    expect(s.events.filter((e) => /Connect failed after \d+ ms: NetworkError/.test(e)).length).toBe(2);
    expect(s.events.some((e) => /Connecting \(attempt 3 of 3\)/.test(e))).toBe(true);
    expect(shop.connectionLog()).toMatch(/^Globe Haul Shop Tool connection log: EH02_00001\n/);
  });

  it('all attempts fail: "failed" with the advice; picking the same bike again keeps its confirmation and logs', async () => {
    const { hmi, shop, ctl } = await connected();
    const lines = shop.rawLineCount;
    hmi.dropLink('switched off');
    ctl.failNext = 3;
    const p = shop.reconnect();
    await vi.advanceTimersByTimeAsync(15_000);
    await p;
    expect(shop.getSnapshot().phase).toBe('failed');
    expect(shop.getSnapshot().message).toMatch(/3 attempts.*choose the bike again/);
    await choose(shop); // same device id
    const s = shop.getSnapshot();
    expect(s).toMatchObject({ phase: 'connected', confirmed: true });
    expect(s.events.some((e) => /picked EH02_00001 again \(same bike/.test(e))).toBe(true);
    expect(shop.rawLineCount).toBeGreaterThan(lines); // raw.jsonl kept and extended
  });

  it('Disconnect during the retries stops them', async () => {
    const { hmi, shop, ctl } = await connected();
    hmi.dropLink('switched off');
    ctl.failNext = 3;
    const p = shop.reconnect();
    await vi.advanceTimersByTimeAsync(2_000);
    await shop.disconnect();
    await vi.advanceTimersByTimeAsync(15_000);
    await p;
    expect(shop.getSnapshot()).toMatchObject({ phase: 'idle', device: null });
    expect(hmi.isConnected).toBe(false);
  });
});
