/**
 * The connect/read sequence (protocol/session.ts) against the simulated HMI: the cmd_capture order,
 * what ends up in the state, the Android additions (identity re-check, page-55 poll, stale watchdog,
 * validation gate), and that nothing outside the whitelist is ever written.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BikeLink } from '../../src/ble/link';
import { MockHmi, type MockHmiOptions } from '../../src/ble/mock';
import type { GattServiceInfo } from '../../src/ble/transport';
import { hex } from '../../src/protocol/bytes';
import { dumpLog, liveLoop, mtuPageMode, oncePages, PAGES_CONFIG, PAGES_IDENTITY } from '../../src/protocol/frames';
import { CH_POWER, CH_READ, CH_WRITE, DIS_SERIAL_BLOCKLISTED } from '../../src/protocol/gatt';
import { BikeSession, OpeningFailed, TIMING, type SessionLink, type SessionOptions } from '../../src/protocol/session';
import { controllerSilent } from '../../src/update/gate';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function open(opts: MockHmiOptions = {}, sOpts: SessionOptions = { errorPoll: false }) {
  const hmi = new MockHmi(opts);
  const link = new BikeLink(await hmi.device.connect());
  const session = new BikeSession(link, sOpts);
  const started = session.start();
  await vi.advanceTimersByTimeAsync(2_000);
  await started;
  return { hmi, link, session };
}

describe('opening sequence (cmd_capture order)', () => {
  it('sends exactly 3C 01, identity, 54 55 56, the loop, in that order, and nothing else', async () => {
    const { hmi, session } = await open();
    expect(session.state.phase).toBe('live');
    expect(hmi.commands().map(hex)).toEqual([mtuPageMode(), oncePages(PAGES_IDENTITY), oncePages(PAGES_CONFIG), liveLoop()].map(hex));
    expect(hmi.violations).toEqual([]);
  });

  it('acks/status first, 3C 01 before data notifications, never the blocklisted DIS serial', async () => {
    const { hmi } = await open();
    const order = hmi.events
      .filter((e) => e.kind === 'subscribe' || (e.kind === 'write' && e.char === CH_WRITE) || (e.kind === 'read' && e.char === CH_POWER))
      .map((e) => `${e.kind} ${e.char?.slice(4, 8)}${e.hex ? ' ' + e.hex.slice(0, 4) : ''}`);
    expect(order.slice(0, 5)).toEqual(['subscribe 0010', 'subscribe 0004', 'read 0004', 'write 0010 3c01', 'subscribe 0001']);
    expect(hmi.events.some((e) => e.char === DIS_SERIAL_BLOCKLISTED)).toBe(false);
  });

  it('fills DIS, ctype, status, identity, config, settings, production and live data', async () => {
    const { session } = await open();
    await vi.advanceTimersByTimeAsync(500);
    const s = session.state;
    expect(s.dis).toMatchObject({ manufacturer: 'Eagotech', model: 'EH2CG0B071', sw_rev: '5.19', fw_rev: '1.0', hw_rev: '1.2' });
    expect(s.disMissing).toEqual([]);
    expect(s.ctype).toBe('sbc');
    expect(s.power).toMatchObject({ locked: false, charging: false, suspended: false, units: 'imperial' });
    expect(s.identity).toMatchObject({ ctrl_serial1: '200000001', ctrl_model: '1B', ctrl_sw: '03.06.s0', ctrl_hw: 'AS.03', batt_sw: '10.00.21.RC', motor_model: '' });
    expect(s.identityMissing).toEqual([]);
    expect(s.identityReads).toBe(1);
    expect(s.config).toMatchObject({ assist_levels: 5, wheel_circ_mm: 2235 });
    expect(s.settings).toMatchObject({ headlight: 1, shutdown_timer_s: 0 });
    expect(s.settings).not.toHaveProperty('sensitivity');
    expect(s.production.buildDate).toMatch(/^20\d\d-\d\d$/);
    expect(s.live).toMatchObject({ batt_pct: 81, odometer_m: 814_000, speed_kmh: 0, batt_mv: 52_192 });
    expect(s.errorBits).toBe(0);
    expect(s.errors).toEqual([]);
    expect(s.gatt.blockChar).toMatchObject({ writeWithoutResponse: true, write: false });
    expect(s.gatt.dfuService).toBe(false);
    expect(s.bleBatteryPct).toBe(81);
    // MTU page mode: identity arrives 12 pages per notification, the loop 5
    expect(Object.keys(s.sizes).map(Number)).toEqual(expect.arrayContaining([240, 100]));
    expect(s.quality).toEqual({ dropped: 0, rejectedByPid: {}, lastReject: null });
  });

  it('a missing e-bike service fails the opening with a plain reason', async () => {
    const fake: SessionLink = {
      connected: true,
      command: async () => undefined,
      read: async () => new Uint8Array(0),
      subscribe: async () => undefined,
      services: async (): Promise<GattServiceInfo[]> => [],
    };
    const session = new BikeSession(fake, { errorPoll: false });
    await expect(session.start()).rejects.toThrow(/not a Globe Haul display/);
    expect(session.state.phase).toBe('failed');
  });

  it('a link that drops mid-opening fails it (no hang)', async () => {
    const hmi = new MockHmi();
    const link = new BikeLink(await hmi.device.connect());
    const session = new BikeSession(link, { errorPoll: false });
    const started = session.start();
    const result = started.then(() => 'ok', (e: Error) => e);
    await vi.advanceTimersByTimeAsync(20);
    hmi.dropLink('test');
    link.lost();
    await vi.advanceTimersByTimeAsync(TIMING.openTotalMs);
    expect(await result).toBeInstanceOf(OpeningFailed);
  });

  it('a step that never completes times out after 10 s; the whole opening is capped', async () => {
    const fake: SessionLink = {
      connected: true,
      command: () => new Promise(() => undefined),
      read: async () => new Uint8Array([1, 0, 0, 0]),
      subscribe: async () => undefined,
      services: async () => new MockHmi().services(),
    };
    const session = new BikeSession(fake, { errorPoll: false });
    const result = session.start().then(() => 'ok', (e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(TIMING.openStepMs + 100);
    expect(await result).toMatch(/MTU page mode timed out after 10 s/);
  });
});

describe('live', () => {
  it('the error bitmask changes only after 3 identical frames, and decodes through sbc', async () => {
    const { hmi, session } = await open();
    hmi.setLive({ error_bits: 1 << 16 });
    await vi.advanceTimersByTimeAsync(150); // one or two loop rounds: not yet
    expect(session.state.errorBits).toBe(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(session.state.errorBits).toBe(1 << 16);
    expect(session.state.errors.map((e) => e.code)).toEqual(['controller_e010']);
  });

  it('status changes are acted on; repeats are not', async () => {
    const { hmi, session } = await open({ timing: { statusIntervalMs: 20 } });
    let changes = 0;
    let last = session.state.power;
    session.subscribe((s) => {
      if (s.power !== last) {
        changes++;
        last = s.power;
      }
    });
    await vi.advanceTimersByTimeAsync(200); // ~10 identical repeats
    expect(changes).toBe(0);
    expect(session.lastStatusNotificationAt).toBeGreaterThan(session.state.startedAt);
    hmi.setStatus({ charging: true, locked: true });
    await vi.advanceTimersByTimeAsync(10);
    expect(changes).toBe(1);
    expect(session.state.power).toMatchObject({ charging: true, locked: true });
    expect(session.state.log.some((l) => l.includes('PIN-locked'))).toBe(true);
  });

  it('polls page 55 every 30 s and restarts the loop after it', async () => {
    const { hmi } = await open({}, { errorPoll: true });
    await vi.advanceTimersByTimeAsync(TIMING.errorPollMs + 1_000);
    expect(hmi.commands().slice(4).map(hex)).toEqual([hex(oncePages([55])), hex(liveLoop())]);
    expect(hmi.violations).toEqual([]);
  });

  it('a quiet stream is flagged stale after 5 s, and clears when pages return', async () => {
    const { hmi, session } = await open();
    hmi.unsubscribe(CH_READ); // the display stops sending pages
    await vi.advanceTimersByTimeAsync(TIMING.staleAfterMs + 1_000);
    expect(session.state.stale).toMatchObject({ what: 'data page' });
    const quiet = session.state.stale!.quietMs;
    expect(quiet).toBeGreaterThan(TIMING.staleAfterMs);
  });

  it('a log dump nobody asked for never reaches identity or live data', async () => {
    const junk = Uint8Array.from({ length: 480 }, (_, i) => (i % 20 === 0 ? 16 : 0x41 + (i % 7)));
    const { hmi, link, session } = await open({ logs: { 1: junk } });
    const before = { ...session.state.identity };
    const sent = link.command(dumpLog(1), 'test: someone else\'s dump'); // as if another app asked for it
    await vi.advanceTimersByTimeAsync(1_000);
    await sent;
    expect(session.state.identity).toEqual(before);
    expect(session.state.log.some((l) => l.includes('did not ask for'))).toBe(true);
    expect(session.state.log.some((l) => l.includes('ended (0xED)'))).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(session.state.liveAt).toBeGreaterThan(0);
    expect(hmi.violations).toEqual([]);
  });

  it('page 0x3C outside an update marks the display as still in update mode', async () => {
    const { hmi, session } = await open();
    (hmi as unknown as { emit: (c: string, b: Uint8Array, a?: boolean) => void }).emit(CH_READ, Uint8Array.of(0x3c, 0x02, 0x01, 0x00), true);
    await vi.advanceTimersByTimeAsync(10);
    expect(session.state.displayInUpdateMode).toBe(true);
  });
});

describe('the recovery case (controller not answering)', () => {
  it('blank controller identity is read once more after 5 s; then the controller counts as silent', async () => {
    const { hmi, session } = await open({ controllerSilent: true });
    expect(session.state.identityReads).toBe(1);
    expect(controllerSilent(session.state)).toBe(false); // one blank read isn't enough
    await vi.advanceTimersByTimeAsync(TIMING.identityRecheckMs + 1_000);
    expect(session.state.identityReads).toBe(2);
    expect(controllerSilent(session.state)).toBe(true);
    // the re-read restarted the loop afterwards
    expect(hmi.commands().slice(4).map(hex)).toEqual([hex(oncePages(PAGES_IDENTITY)), hex(liveLoop())]);
    // the controller-sourced live fields read "not reported", not as numbers
    expect(session.state.live.odometer_m).toBeUndefined();
    expect(session.state.live.speed_kmh).toBeUndefined();
    expect(session.state.errors.map((e) => e.code)).toContain('controller_e031');
  });

  it('a normal bike is never re-read and never silent', async () => {
    const { hmi, session } = await open();
    await vi.advanceTimersByTimeAsync(TIMING.identityRecheckMs + 1_000);
    expect(session.state.identityReads).toBe(1);
    expect(controllerSilent(session.state)).toBe(false);
    expect(hmi.commands().length).toBe(4);
  });
});

describe('end', () => {
  it('ending the session stops its timers and polls', async () => {
    const { hmi, session } = await open({}, { errorPoll: true });
    session.end('test');
    await vi.advanceTimersByTimeAsync(TIMING.errorPollMs * 2);
    expect(hmi.commands().length).toBe(4);
    expect(session.state.phase).toBe('ended');
  });
});
