/**
 * Smoke test for the screens: each one renders (server-side, no browser) from a real session against
 * the simulated bike, and shows what the spec asks for. Catches render-time crashes the type checker
 * can't see.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NO_BATTERY, ShopApp, type BatteryAfter, type ShopState } from '../../src/app/shop';
import type { BatteryUpdateResult } from '../../src/update/battery';
import { BatteryResultCard, BatteryUpdatePanel, BatteryUpdateRunning } from '../../src/ui/BatteryUpdate';
import { MockHmi, MockTransport, type MockHmiOptions } from '../../src/ble/mock';
import { platformInfo } from '../../src/platform/detect';
import { TIMING } from '../../src/protocol/session';
import { ErrorsPanel, IdentityPanel, LivePanel, StatusBar, Warnings } from '../../src/ui/BikePanel';
import { ControllerUpdatePanel, UpdateResultCard, UpdateRunning } from '../../src/ui/ControllerUpdate';
import { DebugPanel } from '../../src/ui/DebugPanel';
import { FirmwareCard } from '../../src/ui/FirmwareCard';
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
  html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

describe('screens render', () => {
  it('connect screen: chooser button, the Windows pairing warning and the "bike missing" hint', () => {
    const html = text(renderToStaticMarkup(
      <ConnectScreen platform={WIN} state={{ phase: 'idle', device: null, confirmed: false, session: null, message: 'Disconnected from EH02_1.', connections: 0, update: null, events: [], battery: NO_BATTERY }} onChoose={noop} firmware={null} />,
    ));
    expect(html).toMatch(/Choose bike…/);
    expect(html).toMatch(/Don't pair the bike in Windows Bluetooth settings/);
    expect(html).toMatch(/Close any other app, tab or phone connected to it/);
    expect(html).toMatch(/Disconnected from EH02_1\./);
  });

  it('connect screen on Linux without Web Bluetooth: the flag steps instead of the button', () => {
    const html = text(renderToStaticMarkup(
      <ConnectScreen platform={LINUX_NO_BT} state={{ phase: 'idle', device: null, confirmed: false, session: null, message: null, connections: 0, update: null, events: [], battery: NO_BATTERY }} onChoose={noop} firmware={null} />,
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
    expect(html).toMatch(/as the display read it at power-on/);
    expect(html).toMatch(/Chip Nordic nRF52832/);
    expect(html).toMatch(/Chip \(type s0\) TI C2000 \(C28x\) most likely a TMS320F2803x/);
    expect(html).toMatch(/Chip \(RC line\) Renesas RL78 BMS hardware type 2/);
    expect(html).toMatch(/Chips aren't reported by the bike/);
    expect(html).not.toMatch(/bms_e032 \(Battery - Communication Error\) is active/);
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

  it('identity: an SC pack shows its line\'s chip, judged against the SC latest', async () => {
    const { shop, state } = await connected({ identity: { batt_sw: '10.00.50.SC' } });
    shop.confirm();
    const t = text(renderToStaticMarkup(<IdentityPanel session={state().session!} />));
    expect(t).toMatch(/01\.00\.05 SC/);
    expect(t).toMatch(/older than latest for SC \(01\.00\.08\)/);
    expect(t).toMatch(/Chip \(SC line\) ARM Cortex-M BMS hardware type 1/);
    expect(t).not.toMatch(/Renesas/);
  });

  it('identity: no battery version with bms_e032 active says why there is no chip, and never guesses one', async () => {
    const { shop, hmi, state } = await connected({ identity: { batt_sw: '' }, live: { error_bits: 1 << 1 } });
    shop.confirm();
    await vi.advanceTimersByTimeAsync(500);
    const t = text(renderToStaticMarkup(<IdentityPanel session={state().session!} />));
    expect(state().session!.errors.map((e) => e.code)).toEqual(['bms_e032']);
    expect(t).toMatch(/Chip not known \(no version reported\)/);
    expect(t).toMatch(/The battery reports no version and bms_e032 \(Battery - Communication Error\) is active/);
    expect(t).toMatch(/choose its line \(RC or SC\) from the pack's label, never a guess/);
    expect(t).not.toMatch(/Renesas|Cortex/);
    expect(hmi.violations).toEqual([]);
  });

  it('firmware card: controller, HMI and both battery lines with their files and chips', () => {
    const t = text(renderToStaticMarkup(<FirmwareCard />));
    expect(t).toMatch(/Official firmware/);
    expect(t).toMatch(/Controller TI C2000 \(C28x\) most likely a TMS320F2803x M1B0306s0\.bin 03\.06\.s0/);
    expect(t).toMatch(/Display \(HMI\) Nordic nRF52832 EH02_Eagotech_5\.19\.zip 5\.19/);
    expect(t).toMatch(/Battery, RC line Renesas RL78 BMS hardware type 2 F\.00\.00G1\.B\.02\.A12_V01\.00\.12\.bin 01\.00\.12 RC Checking…/);
    expect(t).toMatch(/Battery, SC line ARM Cortex-M BMS hardware type 1 F\.00\.00G1\.B\.01\.A08_V01\.00\.08\.bin 01\.00\.08 SC Checking…/);
    expect(t).toMatch(/checks the battery's line before it sends anything/);
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

describe('battery update screens render', () => {
  const win = { platformVerified: true, platformLabel: WIN.label };

  it('before reading: the page-24 version, "Read the battery", and the checks waiting for the read', async () => {
    const { shop, state } = await connected();
    shop.confirm();
    await vi.advanceTimersByTimeAsync(6_000);
    const st = state();
    const t = text(renderToStaticMarkup(<BatteryUpdatePanel state={st} session={st.session!} {...win} now={Date.now()} onRead={noop} onStart={() => null} />));
    expect(t).toMatch(/Battery firmware update/);
    expect(t).toMatch(/The display reports 01\.00\.12 RC \(page 24, read at power-on\)/);
    expect(t).toMatch(/Read the battery/);
    expect(t).toMatch(/Battery read on this connection/);
    expect(t).toMatch(/Point of no return/);
    expect(t).toMatch(/Type the bike's name to arm the update/);
  });

  it('after reading an older RC pack: what it answered, its chip, the line and version checks', async () => {
    const { shop, state } = await connected({ identity: { batt_sw: '10.00.90.RC' }, timing: { ackMs: 5 } });
    shop.confirm();
    await vi.advanceTimersByTimeAsync(6_000);
    const p = shop.readBattery();
    await vi.advanceTimersByTimeAsync(10_000);
    await p;
    const st = state();
    const t = text(renderToStaticMarkup(<BatteryUpdatePanel state={st} session={st.session!} {...win} now={Date.now()} onRead={noop} onStart={() => null} />));
    expect(t).toMatch(/The battery answers: firmware 01\.00\.09 RC, hardware type 2 \(RC line\)/);
    expect(t).toMatch(/Chip: Renesas RL78/);
    expect(t).toMatch(/Read the battery again/);
    // a fast link (the simulated bike answers in a few ms): the estimate, no "slow link" hint
    expect(t).toMatch(/Bluetooth round trip: about \d+ ms per frame, so the update takes at least/);
    expect(t).not.toMatch(/slow link/);
  });

  it('a slow link (about 60 ms connection interval): the measured estimate and, on Linux, how to make it faster', async () => {
    const { shop, state } = await connected({ identity: { batt_sw: '10.00.90.RC' }, timing: { ackMs: 60 } });
    shop.confirm();
    await vi.advanceTimersByTimeAsync(6_000);
    const p = shop.readBattery();
    await vi.advanceTimersByTimeAsync(10_000);
    await p;
    const st = state();
    const rtt = st.battery.read!.identity!.rttMs!;
    expect(rtt).toBeGreaterThan(50);
    const linux = text(renderToStaticMarkup(<BatteryUpdatePanel state={st} session={st.session!} {...win} linux now={Date.now()} onRead={noop} onStart={() => null} />));
    expect(linux).toMatch(/so the update takes at least \d+ min/);
    expect(linux).toMatch(/That's a slow link\. On Linux it can be about 4 times faster/);
    expect(linux).toMatch(/sh start-shop-tool\.sh/);
    expect(linux).toMatch(/echo 6 > \/sys\/kernel\/debug\/bluetooth\/hci0\/conn_min_interval/);
    expect(linux).toMatch(/The transfer takes at least \d+ min \d+ s on this link/);
    const win10 = text(renderToStaticMarkup(<BatteryUpdatePanel state={st} session={st.session!} {...win} now={Date.now()} onRead={noop} onStart={() => null} />));
    expect(win10).toMatch(/a browser can't change it/);
    expect(win10).not.toMatch(/start-shop-tool/);
  });

  it('a pack that does not answer: the recovery notice and the RC / SC choice', async () => {
    const { shop, state } = await connected({ bms: { version: '' }, identity: { batt_sw: '' } });
    shop.confirm();
    await vi.advanceTimersByTimeAsync(6_000);
    const p = shop.readBattery();
    await vi.advanceTimersByTimeAsync(10_000);
    await p;
    const st = state();
    const t = text(renderToStaticMarkup(<BatteryUpdatePanel state={st} session={st.session!} {...win} now={Date.now()} onRead={noop} onStart={() => null} />));
    expect(t).toMatch(/The battery's BMS doesn't answer\./);
    expect(t).toMatch(/choose it from the pack's label\. Never guess/);
    expect(t).toMatch(/RC line \(Renesas RL78\)/);
    expect(t).toMatch(/SC line \(ARM Cortex-M\)/);
  });

  it('running: progress, rate, attempt, "the motor has no power", don\'t switch off', () => {
    const t = text(renderToStaticMarkup(
      <BatteryUpdateRunning
        now={Date.now()}
        progress={{
          step: 'sending', text: 'Sending firmware (attempt 2 of 3)…', pastPointOfNoReturn: true, startedAt: Date.now() - 600_000,
          flash: { attempt: 2, attempts: 3, phase: 'sending', block: 6_708, total: 13_417, elapsedMs: 590_000, blocksPerSecond: 11.4, etaMs: 588_000 },
        }}
      />,
    ));
    expect(t).toMatch(/Block 6,708 of 13,417 \(49 %\)/);
    expect(t).toMatch(/about 9 min 48 s left|about 9 min/);
    expect(t).toMatch(/attempt 2 of 3/);
    expect(t).toMatch(/the motor has no power and the display stays on/);
    expect(t).toMatch(/Don't switch the bike off/);
  });

  const base: BatteryUpdateResult = {
    ok: true, kind: null, message: 'The battery accepted the new firmware (13,417 blocks in 26.1 min). The bike then restarted by itself, as expected; the new version is checked on the next connection (below).',
    before: '01.00.09 RC', target: '01.00.12 RC', line: 'RC', packInBootloader: false, restarting: true, after: null,
    autoOff: { before: 600, changed: true, restored: null }, attempts: 1, ackTiming: { count: 13_417, minMs: 98, avgMs: 116.7, maxMs: 410 },
    log: 'log', logName: 'battery_update_EH02_00001_test.txt',
  };
  const after: BatteryAfter = {
    status: 'reconnecting', target: '01.00.12 RC', reported: null, autoOffBefore: 600, autoOffRestored: null, startedAt: Date.now() - 50_000, powerButtonHint: true, e032: false,
  };

  it('result while the bike restarts: reconnecting, the power-button hint, Stop, no Close', () => {
    const t = text(renderToStaticMarkup(<BatteryResultCard result={base} after={after} now={Date.now()} onDownloadLog={noop} onDismiss={noop} onStopReconnect={noop} />));
    expect(t).toMatch(/Battery update finished/);
    expect(t).toMatch(/Target 01\.00\.12 RC \(Renesas RL78\)/);
    expect(t).toMatch(/Reconnecting by itself/);
    expect(t).toMatch(/press the bike's power button/);
    expect(t).toMatch(/Stop reconnecting/);
    expect(t).not.toMatch(/Close/);
    expect(t).toMatch(/600 s, set to 0 for the update; to be restored once the bike is back/);
    expect(t).toMatch(/Download update log \(battery_update_EH02_00001_test\.txt\)/);
  });

  it('result: verified after the restart; and a failure that leaves the pack in its bootloader', () => {
    let t = text(renderToStaticMarkup(
      <BatteryResultCard result={base} after={{ ...after, status: 'verified', reported: '01.00.12 RC', autoOffRestored: true }} now={Date.now()} onDownloadLog={noop} onDismiss={noop} />,
    ));
    expect(t).toMatch(/Verified after the restart: the battery reports 01\.00\.12 RC/);
    expect(t).toMatch(/restored/);
    expect(t).toMatch(/Close/);
    const failed: BatteryUpdateResult = {
      ...base, ok: false, kind: 'result-failed', restarting: false, packInBootloader: true, attempts: 3, autoOff: { before: 600, changed: true, restored: true },
      message: 'The battery reported failure. Stopped at block 13,417 of 13,417 after 3 attempt(s). The pack waits in its bootloader, the display shows E032.',
    };
    t = text(renderToStaticMarkup(<BatteryResultCard result={failed} after={null} now={Date.now()} onDownloadLog={noop} onDismiss={noop} />));
    expect(t).toMatch(/Battery update failed/);
    expect(t).toMatch(/waits in its bootloader/);
    expect(t).toMatch(/Attempts 3/);
  });
});
