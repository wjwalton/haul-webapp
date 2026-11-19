import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { ShopApp } from '../app/shop';
import type { MockHmi } from '../ble/mock';
import { WebBluetoothTransport } from '../ble/webBluetooth';
import { BUILD, BUILD_LABEL } from '../build';
import { detectPlatform } from '../platform/detect';
import { holdScreenAwake } from '../platform/wakeLock';
import type { UpdateResult } from '../update/controller';
import { ErrorsPanel, IdentityPanel, LivePanel, StatusBar, Warnings } from './BikePanel';
import { ControllerUpdatePanel, UpdateResultCard, UpdateRunning } from './ControllerUpdate';
import { DebugPanel } from './DebugPanel';
import type { MockVariant } from './devMock';
import { saveText } from './download';
import { FirmwareCard } from './FirmwareCard';
import { stamp, type Units } from './format';
import { Card, ConfirmBike, ConnectScreen, LinkProblem, OpeningView } from './screens';

interface DevMock {
  variant: MockVariant;
  bike: MockHmi;
}

function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function App() {
  const platform = useMemo(() => detectPlatform(), []);
  const [shop, setShop] = useState(() => new ShopApp(new WebBluetoothTransport()));
  const [dev, setDev] = useState<DevMock | null>(null);
  const state = useSyncExternalStore(shop.subscribe, shop.getSnapshot);
  const [unitsOverride, setUnitsOverride] = useState<{ device: string; units: Units } | null>(null);
  const now = useNow();
  const updating = state.update?.running === true;

  // During an update: keep the screen on and warn before the tab is closed or reloaded.
  useEffect(() => {
    if (!updating) return;
    const release = holdScreenAwake();
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      release();
      window.removeEventListener('beforeunload', warn);
    };
  }, [updating]);

  const s = state.session;
  const bikeUnits: Units = s?.power?.units === 'imperial' ? 'imperial' : 'metric';
  const units = unitsOverride && unitsOverride.device === state.device?.id ? unitsOverride.units : bikeUnits;

  const choose = () => {
    // Straight from the click: the chooser needs the user gesture.
    void shop.chooseBike();
  };
  const reconnect = () => void shop.reconnect();
  const disconnect = () => void shop.disconnect();
  const downloadRaw = () => saveText(`raw_${state.device?.name ?? 'bike'}_${stamp()}.jsonl`, shop.rawJsonl(), 'application/x-ndjson');
  const downloadLog = (r: UpdateResult) => saveText(r.logName, r.log);
  const rawLines = shop.rawLineCount;

  async function startMock(variant: MockVariant) {
    if (__DEV_TOOLS__) {
      const m = await import('./devMock');
      await shop.disconnect();
      const { transport, bike } = m.createMock(variant);
      const next = new ShopApp(transport);
      setShop(next);
      setDev({ variant, bike });
      void next.chooseBike();
    }
  }
  async function stopMock() {
    await shop.disconnect();
    setDev(null);
    setShop(new ShopApp(new WebBluetoothTransport()));
  }

  const devTools = __DEV_TOOLS__ && !updating ? (
    <DevTools dev={dev} onStart={(v) => void startMock(v)} onStop={() => void stopMock()} />
  ) : null;

  const updateCard = state.update ? (
    state.update.running ? (
      <UpdateRunning update={state.update} now={now} />
    ) : state.update.result ? (
      <UpdateResultCard update={state.update} onDownloadLog={downloadLog} onDismiss={() => shop.dismissUpdate()} onReconnect={state.phase === 'lost' ? reconnect : undefined} />
    ) : null
  ) : null;

  let body;
  if (state.phase === 'idle' || state.phase === 'choosing') {
    body = <ConnectScreen platform={platform} state={state} onChoose={choose} devTools={devTools} firmware={<FirmwareCard />} />;
  } else if (state.phase === 'lost' || state.phase === 'failed') {
    body = (
      <>
        {updateCard}
        <LinkProblem
          state={state}
          onReconnect={reconnect}
          onDisconnect={disconnect}
          extra={
            <p>
              <button onClick={downloadRaw} disabled={rawLines === 0}>
                Download raw.jsonl
              </button>
            </p>
          }
        />
        {devTools}
        {s ? <DebugPanel session={s} rawLines={rawLines} onDownloadRaw={downloadRaw} /> : null}
      </>
    );
  } else if (!s || s.phase !== 'live') {
    body = (
      <>
        {updateCard}
        <OpeningView state={state} onCancel={disconnect} />
        {devTools}
        {s ? <DebugPanel session={s} rawLines={rawLines} onDownloadRaw={downloadRaw} /> : null}
      </>
    );
  } else if (!state.confirmed) {
    body = (
      <>
        {updateCard}
        <ConfirmBike state={state} session={s} units={units} now={now} onConfirm={() => shop.confirm()} onWrong={() => void shop.wrongBike()} />
        {devTools}
      </>
    );
  } else {
    body = (
      <>
        <StatusBar
          name={state.device?.name ?? '(no name)'}
          session={s}
          now={now}
          units={units}
          bikeUnits={bikeUnits}
          busy={updating}
          onUnits={(u) => setUnitsOverride({ device: state.device?.id ?? '', units: u })}
          onReconnect={reconnect}
          onDisconnect={disconnect}
        />
        {updateCard}
        {!updating ? <Warnings session={s} onReconnect={reconnect} /> : null}
        <div className="two-col">
          <LivePanel session={s} units={units} />
          <ErrorsPanel session={s} />
        </div>
        {!state.update ? (
          <ControllerUpdatePanel
            state={state}
            session={s}
            platformVerified={platform.updatesVerified}
            platformLabel={platform.label}
            now={now}
            onStart={(fw, typedName, reflashSameVersion) =>
              shop.startControllerUpdate(fw, {
                platformVerified: platform.updatesVerified, platformLabel: platform.label, reflashSameVersion, typedName, stamp: stamp(),
              })
            }
            onDismiss={() => shop.dismissUpdate()}
            onDownloadLog={downloadLog}
          />
        ) : null}
        <IdentityPanel session={s} />
        {devTools}
        <DebugPanel session={s} rawLines={rawLines} onDownloadRaw={downloadRaw} />
      </>
    );
  }

  return (
    <main>
      <header className="top">
        <div>
          <h1>Globe Haul Shop Tool</h1>
          <p className="sub">Connect, confirm the bike, read it, and update the controller firmware.</p>
        </div>
        <div className="platform">
          <span className="chip">{platform.label}</span>
          <span className={`chip ${platform.updatesVerified ? 'ok' : 'warn'}`}>
            {platform.updatesVerified ? 'updates: verified browser' : 'updates: not on this browser'}
          </span>
          {__DEV_TOOLS__ && dev ? <span className="chip warn">SIMULATED BIKE</span> : null}
          <span className={`chip${BUILD.channel === 'beta' ? ' warn' : ''}`} title="This build (also written into every update log)">
            {BUILD.channel === 'beta' ? 'BETA ' : ''}
            {BUILD_LABEL}
          </span>
        </div>
      </header>
      {body}
    </main>
  );
}

/** Developer tools: start a simulated bike and poke it. Only in builds with __DEV_TOOLS__ (dev, laptop). */
function DevTools(props: { dev: DevMock | null; onStart: (v: MockVariant) => void; onStop: () => void }) {
  const [variants, setVariants] = useState<readonly { id: MockVariant; label: string }[]>([]);
  useEffect(() => {
    if (__DEV_TOOLS__) void import('./devMock').then((m) => setVariants(m.MOCK_VARIANTS));
  }, []);
  const b = props.dev?.bike;
  return (
    <Card title="Developer: simulated bike" tone="warn">
      <p className="muted small">
        Try the screens without a bike. A simulated bike never touches Bluetooth. Its firmware update is simulated too (the 4.5 s erase, then under a minute of blocks).
      </p>
      <div className="row">
        {variants.map((v) => (
          <button key={v.id} onClick={() => props.onStart(v.id)}>
            {v.label}
          </button>
        ))}
        {props.dev ? <button onClick={props.onStop}>Back to real Bluetooth</button> : null}
      </div>
      {b ? (
        <div className="row">
          <button onClick={() => b.dropLink('dev: link dropped')}>Drop link</button>
          <button onClick={() => b.powerCycle()}>Power-cycle</button>
          <button onClick={() => b.setStatus({ locked: !b.status.locked })}>Toggle lock</button>
          <button onClick={() => b.setStatus({ charging: !b.status.charging })}>Toggle charging</button>
          <button onClick={() => b.setStatus({ imperial: !b.status.imperial })}>Toggle units</button>
          <button onClick={() => b.setLive({ speed_x10: b.live.speed_x10 ? 0 : 152 })}>Ride / stop</button>
          <button onClick={() => b.setLive({ error_bits: b.live.error_bits ^ (1 << 16) })}>Toggle e010</button>
        </div>
      ) : null}
    </Card>
  );
}
