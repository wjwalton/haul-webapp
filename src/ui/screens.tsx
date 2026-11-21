import type { ReactNode } from 'react';
import type { ChipInfo } from '../analysis/firmware';
import type { ShopState } from '../app/shop';
import type { SessionState } from '../protocol/session';
import type { PlatformInfo } from '../platform/detect';
import { connectBlocker } from '../platform/detect';
import { distance, num, otherDistance, pct, type Units } from './format';

export function Card({ title, children, tone }: { title?: ReactNode; children: ReactNode; tone?: 'warn' | 'bad' | 'ok' }) {
  return (
    <section className={`card${tone ? ` card-${tone}` : ''}`}>
      {title ? <h2>{title}</h2> : null}
      {children}
    </section>
  );
}

/** A part's chip (analysis/firmware.ts KnownChips) with its qualifier underneath. */
export function Chip({ chip, unknown = 'not known' }: { chip: ChipInfo | null; unknown?: string }) {
  if (chip === null) return <span className="muted">{unknown}</span>;
  return (
    <>
      {chip.chip}
      {chip.note ? <div className="muted small">{chip.note}</div> : null}
    </>
  );
}

// ---- connect ------------------------------------------------------------------------------------

export function ConnectScreen(props: {
  platform: PlatformInfo;
  state: ShopState;
  onChoose: () => void;
  devTools?: ReactNode;
  firmware: ReactNode;
}) {
  const { platform, state } = props;
  const blocker = connectBlocker(platform);
  const choosing = state.phase === 'choosing';
  return (
    <>
      {state.message ? <p className="notice">{state.message}</p> : null}
      {blocker ? (
        <Card title={blocker.title} tone="bad">
          <ol>
            {blocker.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        </Card>
      ) : (
        <Card title="Connect to a bike">
          <p>
            Switch the bike on. The browser then lists every Globe Haul display nearby (<span className="mono">EH02_xxxxx</span>).
            Pick the one in front of you: the next screen asks you to check it against the bike's own screen.
          </p>
          <button className="primary big" onClick={props.onChoose} disabled={choosing}>
            {choosing ? 'Waiting for the chooser…' : 'Choose bike…'}
          </button>
          <ul className="hints">
            {platform.os === 'windows' ? (
              <li>
                <strong>Don't pair the bike in Windows Bluetooth settings.</strong> If it was paired before, remove it there first.
              </li>
            ) : null}
            <li>
              <strong>Bike missing?</strong> Close any other app, tab or phone connected to it. A connected display stops advertising.
            </li>
            <li>One bike per tab. Use another tab for a second bike.</li>
          </ul>
        </Card>
      )}
      {props.devTools}
      {props.firmware}
    </>
  );
}

// ---- opening ------------------------------------------------------------------------------------

const STEPS = [
  'Connecting',
  'GATT services',
  'Display information (DIS)',
  'Status and acks',
  'MTU page mode',
  'Identity pages 11-28',
  'Config pages 54, 55, 56',
  'Live loop',
];

function stepIndex(state: ShopState): number {
  const s = state.session?.step ?? '';
  if (state.phase === 'connecting' || !state.session) return 0;
  if (s.startsWith('GATT')) return 1;
  if (s.startsWith('DIS') || s.startsWith('BLE battery')) return 2;
  if (s.startsWith('indications') || s.includes('…0004')) return 3;
  if (s.startsWith('MTU') || s.includes('…0001')) return 4;
  if (s.startsWith('identity')) return 5;
  if (s.startsWith('config')) return 6;
  if (s.startsWith('live')) return 7;
  return state.session.phase === 'live' ? STEPS.length : 1;
}

export function OpeningView({ state, onCancel }: { state: ShopState; onCancel: () => void }) {
  const at = stepIndex(state);
  return (
    <Card title={`Reading ${state.device?.name ?? 'the bike'}…`}>
      <ol className="steps">
        {STEPS.map((s, i) => (
          <li key={s} className={i < at ? 'done' : i === at ? 'now' : ''}>
            {s}
          </li>
        ))}
      </ol>
      {state.message ? <p className="notice">{state.message}</p> : null}
      <p className="muted">Nothing is written to the bike: these are read-only requests.</p>
      <button onClick={onCancel}>Cancel</button>
    </Card>
  );
}

// ---- confirm ------------------------------------------------------------------------------------

/** After this long with live data and no odometer, say so (recovery: the controller isn't answering). */
const ODOMETER_GRACE_MS = 3_000;

export function ConfirmBike(props: {
  state: ShopState;
  session: SessionState;
  units: Units;
  now: number;
  onConfirm: () => void;
  onWrong: () => void;
}) {
  const { session: s, units } = props;
  const battery = num(s.live.batt_pct);
  const odo = num(s.live.odometer_m);
  const waited = s.liveSince !== null && props.now - s.liveSince > ODOMETER_GRACE_MS && s.liveAt !== null;
  const noOdometer = odo === null && waited;
  return (
    <Card title="Is this the bike in front of you?">
      <p className="bike-name">{props.state.device?.name ?? '(no name)'}</p>
      <div className="confirm-grid">
        <div>
          <div className="label">Battery (page 10)</div>
          <div className="value">{battery === null ? <span className="muted">waiting…</span> : pct(battery)}</div>
        </div>
        <div>
          <div className="label">Controller odometer (page 7)</div>
          <div className="value">
            {odo !== null ? distance(odo, units) : noOdometer ? <span className="muted">not reported</span> : <span className="muted">waiting…</span>}
          </div>
          {odo !== null ? <div className="muted small">= {otherDistance(odo, units)}</div> : null}
        </div>
      </div>
      <p>
        <strong>Check the bike's screen shows the same.</strong>
      </p>
      {noOdometer ? (
        <p className="notice">
          The controller isn't reporting an odometer (it may not be answering: recovery mode). Confirm using the name and battery % only.
        </p>
      ) : null}
      {s.power?.locked ? <p className="notice">This bike is PIN-locked. Reading works; updates stay blocked while it is locked.</p> : null}
      <div className="row">
        <button className="primary big" onClick={props.onConfirm} disabled={s.phase !== 'live'}>
          Confirm: this is the bike
        </button>
        <button className="danger" onClick={props.onWrong}>
          Wrong bike (disconnect)
        </button>
      </div>
    </Card>
  );
}

// ---- lost / failed ------------------------------------------------------------------------------

export function LinkProblem(props: {
  state: ShopState;
  onReconnect: () => void;
  /** Open the chooser again (keeps the confirmation and update result if the same bike is picked). */
  onChooseAgain: () => void;
  onDisconnect: () => void;
  extra?: ReactNode;
}) {
  const lost = props.state.phase === 'lost';
  const recent = props.state.events.slice(-8);
  return (
    <Card title={lost ? 'Connection lost' : 'Couldn\'t connect to the bike'} tone="bad">
      <p>{props.state.message}</p>
      <div className="row">
        <button className="primary" onClick={props.onReconnect}>
          {lost ? `Reconnect to ${props.state.device?.name ?? 'the bike'}` : 'Try again'}
        </button>
        <button onClick={props.onChooseAgain}>Choose the bike again</button>
        <button onClick={props.onDisconnect}>Disconnect / choose another bike</button>
      </div>
      <p className="muted small">
        If Reconnect keeps failing, switch the bike off and on, then use <strong>Choose the bike again</strong> and pick the same bike: it keeps the
        confirmation and any update result. Reloading the page also works, but download the logs first: a reload clears them.
      </p>
      {recent.length ? (
        <details>
          <summary>What happened (connection log)</summary>
          <pre className="mono small">{recent.join('\n')}</pre>
        </details>
      ) : null}
      {props.extra}
    </Card>
  );
}
