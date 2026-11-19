/**
 * ShopApp against the simulated bikes: chooser filter, confirm step, wrong bike, link loss and
 * reconnect without the chooser, and "disconnect / connect another bike" wiping everything.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BIKE_REQUEST, ShopApp } from '../../src/app/shop';
import { MockHmi, MockTransport } from '../../src/ble/mock';
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
