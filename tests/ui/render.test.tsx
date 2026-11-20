/**
 * Smoke test for the screens: each one renders (server-side, no browser) from a real session against
 * the simulated bike, and shows what the spec asks for. Catches render-time crashes the type checker
 * can't see.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ShopApp, type ShopState } from '../../src/app/shop';
import { MockHmi, MockTransport, type MockHmiOptions } from '../../src/ble/mock';
import { platformInfo } from '../../src/platform/detect';
import { TIMING } from '../../src/protocol/session';
import { ErrorsPanel, IdentityPanel, LivePanel, StatusBar, Warnings } from '../../src/ui/BikePanel';
import { ControllerUpdatePanel, UpdateResultCard, UpdateRunning } from '../../src/ui/ControllerUpdate';
import { DebugPanel } from '../../src/ui/DebugPanel';
import { ConfirmBike, ConnectScreen, LinkProblem, OpeningView } from '../../src/ui/screens';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const WIN = platformInfo({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36' }, true, true);
const LINUX_NO_BT = platformInfo({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36' }, false, true);
const noop = () => undefined;

async function connected(opts: MockHmiOptions = {}, wait = 1_000): Promise<{ shop: ShopApp; hmi: MockHmi; state: () => ShopState }> {
  const hmi = new MockHmi(opts);
  const shop = new ShopApp(new MockTransport([hmi]), { errorPoll: false });
  const p = shop.chooseBike();
  await vi.advanceTimersByTimeAsync(wait);
  await p;
  return { shop, hmi, state: () => shop.getSnapshot() };
}

const text = (html: string) =>
  html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

describe('screens render', () => {
  it('connect screen: chooser button, the Windows pairing warning and the "bike missing" hint', () => {
    const html = text(renderToStaticMarkup(
      <ConnectScreen platform={WIN} state={{ phase: 'idle', device: null, confirmed: false, session: null, message: 'Disconnected from EH02_1.', connections: 0, update: null, events: [] }} onChoose={noop} firmware={null} />,
    ));
    expect(html).toMatch(/Choose bike…/);
    expect(html).toMatch(/Don't pair the bike in Windows Bluetooth settings/);
    expect(html).toMatch(/Close any other app, tab or phone connected to it/);
    expect(html).toMatch(/Disconnected from EH02_1\./);
  });

  it('connect screen on Linux without Web Bluetooth: the flag steps instead of the button', () => {
    const html = text(renderToStaticMarkup(
      <ConnectScreen platform={LINUX_NO_BT} state={{ phase: 'idle', device: null, confirmed: false, session: null, message: null, connections: 0, update: null, events: [] }} onChoose={noop} firmware={null} />,
    ));
    expect(html).toMatch(/enable-experimental-web-platform-features/);
    expect(html).not.toMatch(/Choose bike…/);
  });

  it('opening progress', async () => {
    const hmi = new MockHmi();
    const shop = new ShopApp(new MockTransport([hmi]), { errorPoll: false });
    const p = shop.chooseBike();
    await vi.advanceTimersByTimeAsync(30);
    const html = text(renderToStaticMarkup(<OpeningView state={shop.getSnapshot()} onCancel={noop} />));
    expect(html).toMatch(/Reading EH02_00001…/);
    expect(html).toMatch(/read-only requests/);
    await vi.advanceTimersByTimeAsync(2_000);
    await p;
  });

  it('confirm: the name large, battery % (page 10) and controller odometer (page 7) in the bike\'s units', async () => {
    const { state } = await connected();
    const st = state();
    const html = renderToStaticMarkup(<ConfirmBike state={st} session={st.session!} units="imperial" now={Date.now()} onConfirm={noop} onWrong={noop} />);
    expect(html).toMatch(/<p class="bike-name">EH02_00001<\/p>/);
    const t = text(html);
    expect(t).toMatch(/81 %/);
    expect(t).toMatch(/506 mi/); // 814 km
    expect(t).toMatch(/= 814 km/);
    expect(t).toMatch(/Check the bike's screen shows the same/);
    expect(t).toMatch(/Wrong bike \(disconnect\)/);
  });

  it('confirm in recovery: odometer not reported, confirm by name and battery %', async () => {
    const { state } = await connected({ controllerSilent: true });
    await vi.advanceTimersByTimeAsync(TIMING.identityRecheckMs);
    const st = state();
    const t = text(renderToStaticMarkup(<ConfirmBike state={st} session={st.session!} units="metric" now={Date.now()} onConfirm={noop} onWrong={noop} />));
    expect(t).toMatch(/not reported/);
    expect(t).toMatch(/Confirm using the name and battery % only/);
  });

  it('the live/identity panel, errors with the e010 hint, the gate checklist and the debug panel', async () => {
    const { shop, hmi, state } = await connected({ live: { error_bits: 1 << 16 } });
    shop.confirm();
    await vi.advanceTimersByTimeAsync(500);
    const st = state();
    const s = st.session!;
    const html = text(renderToStaticMarkup(
      <>
        <StatusBar name="EH02_00001" session={s} now={Date.now()} units="metric" bikeUnits="imperial" onUnits={noop} onReconnect={noop} onDisconnect={noop} />
        <Warnings session={s} onReconnect={noop} />
        <LivePanel session={s} units="metric" />
        <ErrorsPanel session={s} />
        <ControllerUpdatePanel
          state={st}
          session={s}
          platformVerified
          platformLabel={WIN.label}
          now={Date.now()}
          onStart={() => null}
          onDismiss={noop}
          onDownloadLog={noop}
        />
        <IdentityPanel session={s} />
        <DebugPanel session={s} rawLines={shop.rawLineCount} onDownloadRaw={noop} />
      </>,
    ));
    expect(html).toMatch(/814 km/);
    expect(html).toMatch(/52\.19 V/);
    expect(html).toMatch(/controller_e010/);
    expect(html).toMatch(/Throttle Activation is on/);
    expect(html).toMatch(/03\.06\.s0/);
    expect(html).toMatch(/01\.00\.12 RC/); // battery corrected
    expect(html).toMatch(/reported 10\.00\.21\.RC/);
    expect(html).toMatch(/dealer update only/);
    expect(html).toMatch(/already runs 03\.06\.s0/);
    expect(html).toMatch(/Point of no return/);
    expect(html).toMatch(/Type the bike's name to arm the update/);
    expect(html).not.toMatch(/Laptop charging/);
    expect(html).toMatch(/Reflash the same version\./); // the controller already runs the file's version
    expect(html).toMatch(/Load file from disk…/);
    expect(html).toMatch(/00010011-452d-4269-6b65-58706c6f7661/);
    expect(html).toMatch(/Download raw\.jsonl/);
    expect(hmi.violations).toEqual([]);
  });

  it('warnings: locked, update mode, CAN analysis', async () => {
    const { state } = await connected({ status: { locked: true } });
    const s = { ...state().session!, displayInUpdateMode: true, canFrames: 3 };
    const t = text(renderToStaticMarkup(<Warnings session={s} onReconnect={noop} />));
    expect(t).toMatch(/PIN-locked\. There is no unlock in this app/);
    expect(t).toMatch(/still in update mode/);
    expect(t).toMatch(/CAN-analysis frames are arriving/);
  });

  it('link lost: reconnect, choose the bike again, disconnect, and what happened', async () => {
    const { hmi, state } = await connected();
    hmi.dropLink();
    const t = text(renderToStaticMarkup(<LinkProblem state={state()} onReconnect={noop} onChooseAgain={noop} onDisconnect={noop} />));
    expect(t).toMatch(/Connection lost/);
    expect(t).toMatch(/Reconnect to EH02_00001/);
    expect(t).toMatch(/Choose the bike again/);
    expect(t).toMatch(/download the logs first: a reload clears them/);
    expect(t).toMatch(/Disconnect \/ choose another bike/);
    expect(t).toMatch(/What happened \(connection log\)/);
    expect(t).toMatch(/Disconnect event: the link was lost/);
  });

  it('update running, waiting for the final status: says so, and that "bypass" is normal', () => {
    const t = text(renderToStaticMarkup(
      <UpdateRunning
        now={Date.now()}
        update={{
          running: true, result: null, verify: null,
          progress: {
            step: 'finishing', text: 'All blocks sent. Waiting for the display to pass the last ones to the controller and confirm…',
            pastPointOfNoReturn: true, writeMode: 'without-response', startedAt: Date.now() - 240_000,
            flash: { position: 10_240, total: 10_240, writes: 10_240, resends: 0, elapsedMs: 235_000, blocksPerSecond: 44, etaMs: null, confirming: { waitedMs: 12_000, maxMs: 300_000 } },
          },
        }}
      />,
    ));
    expect(t).toMatch(/waiting 12 s \(up to 5 min/);
    expect(t).toMatch(/can take a few minutes: keep waiting/);
    expect(t).toMatch(/"bypass" while this runs; that is normal/);
    expect(t).toMatch(/Don't switch the bike off/);
    expect(t).toMatch(/44 blocks\/s reaching the bike/);
  });
});

describe('controller update screens render', () => {
  const base = {
    ok: true, kind: null, before: '03.05.s0', after: '03.06.s0', target: '03.06.s0', controllerErased: false, verified: true,
    awaitingPowerCycle: false, writeMode: 'without-response' as const, timing: { count: 10_240, minMs: 2.1, avgMs: 2.73, maxMs: 40.2 },
    writes: 10_240, resends: 0, log: 'log', logName: 'update_EH02_00001_2026-11-18_1900.txt', message: 'The controller reported success. Verified: it now reports 03.06.s0.',
  };

  it('running: plain status, progress, measured ETA, the keep-plugged-in note', () => {
    const t = text(renderToStaticMarkup(
      <UpdateRunning
        now={Date.now()}
        update={{
          running: true, result: null, verify: null,
          progress: {
            step: 'sending', text: 'Sending firmware…', pastPointOfNoReturn: true, writeMode: 'without-response', startedAt: Date.now() - 12_000,
            flash: { position: 5_120, total: 10_240, writes: 5_120, resends: 0, elapsedMs: 11_000, blocksPerSecond: 465, etaMs: 11_000, confirming: null },
          },
        }}
      />,
    ));
    expect(t).toMatch(/Sending firmware…/);
    expect(t).toMatch(/Block 5,120 of 10,240 \(50 %\)/);
    expect(t).toMatch(/about 11 s left/);
    expect(t).toMatch(/plugged in, lid open/);
  });

  it('result: verified, with the log download', () => {
    const t = text(renderToStaticMarkup(<UpdateResultCard update={{ running: false, progress: null, result: base, verify: null }} onDownloadLog={noop} onDismiss={noop} />));
    expect(t).toMatch(/Controller update finished/);
    expect(t).toMatch(/Verified: it now reports 03\.06\.s0/);
    expect(t).toMatch(/Download update log \(update_EH02_00001_2026-11-18_1900\.txt\)/);
    expect(t).toMatch(/avg 2\.73 ms/);
  });

  it('result: waiting for the power-cycle, then verified', () => {
    const r = { ...base, verified: false, awaitingPowerCycle: true, before: '03.06.s0' };
    let t = text(renderToStaticMarkup(
      <UpdateResultCard update={{ running: false, progress: null, result: r, verify: { target: '03.06.s0', before: '03.06.s0', status: 'waiting', reported: null } }} onDownloadLog={noop} onDismiss={noop} onReconnect={noop} />,
    ));
    expect(t).toMatch(/power-cycle the bike \(off, then on\), then click Reconnect/);
    expect(t).toMatch(/Reconnect/);
    t = text(renderToStaticMarkup(
      <UpdateResultCard update={{ running: false, progress: null, result: r, verify: { target: '03.06.s0', before: '03.06.s0', status: 'verified', reported: '03.06.s0' } }} onDownloadLog={noop} onDismiss={noop} />,
    ));
    expect(t).toMatch(/Verified after the power-cycle: the controller reports 03\.06\.s0/);
  });

  it('result: failed, with the recovery advice and the log', () => {
    const r = { ...base, ok: false, kind: 'link-lost' as const, verified: false, after: null, controllerErased: true, message: 'Connection lost at block 1234/10240. Reconnect and flash again.' };
    const t = text(renderToStaticMarkup(<UpdateResultCard update={{ running: false, progress: null, result: r, verify: null }} onDownloadLog={noop} onDismiss={noop} />));
    expect(t).toMatch(/Controller update failed/);
    expect(t).toMatch(/Reconnect and flash again/);
    expect(t).toMatch(/Download update log/);
  });
});
