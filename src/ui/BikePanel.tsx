import type { ReactNode } from 'react';
import { batteryReading, controllerReading, hmiReading, swType, type Verdict } from '../analysis/firmware';
import { bitOf, ERROR_HINTS, hasBit, rawErrorCode } from '../protocol/errors';
import type { SessionState } from '../protocol/session';
import { amps, distance, duration, hex32, num, pct, rangeKm, speed, volts, type Units } from './format';
import { Card, Chip } from './screens';

/** "Battery - Communication Error": the display can't reach the BMS application. */
const BMS_E032_BIT = bitOf('bms_e032');

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="field">
      <div className="label">{label}</div>
      <div className="value">{children}</div>
      {hint ? <div className="muted small">{hint}</div> : null}
    </div>
  );
}

const nr = <span className="muted">not reported</span>;

function text(v: string | undefined): ReactNode {
  return v ? <span className="mono">{v}</span> : nr;
}

export function StatusBar(props: {
  name: string;
  session: SessionState;
  now: number;
  units: Units;
  bikeUnits: Units;
  /** An update is running: no reconnect / disconnect. */
  busy?: boolean;
  onUnits: (u: Units) => void;
  onReconnect: () => void;
  onDisconnect: () => void;
}) {
  const { session: s } = props;
  const p = s.power;
  return (
    <div className="statusbar">
      <div>
        <span className="bike-name-small">{props.name}</span>
        <span className="chip ok">connected {s.liveSince ? duration(props.now - s.liveSince) : ''}</span>
        {p?.locked ? <span className="chip bad">PIN-locked</span> : null}
        {p?.charging ? <span className="chip">charging</span> : null}
        {p?.suspended ? <span className="chip warn">standby</span> : null}
      </div>
      <div className="row">
        <label className="units">
          Units{' '}
          <select value={props.units} onChange={(e) => props.onUnits(e.target.value as Units)}>
            <option value="metric">km{props.bikeUnits === 'metric' ? ' (bike setting)' : ''}</option>
            <option value="imperial">miles{props.bikeUnits === 'imperial' ? ' (bike setting)' : ''}</option>
          </select>
        </label>
        <button onClick={props.onReconnect} disabled={props.busy}>Reconnect</button>
        <button onClick={props.onDisconnect} disabled={props.busy}>Disconnect / connect another bike</button>
      </div>
    </div>
  );
}

export function Warnings({ session: s, onReconnect }: { session: SessionState; onReconnect: () => void }) {
  return (
    <>
      {s.lateFwStatus !== null ? (
        <p className={`notice${s.lateFwStatus === 0 ? '' : ' bad'}`}>
          {s.lateFwStatus === 0
            ? 'The display has now reported that the controller update SUCCEEDED (after the app had stopped waiting). Power-cycle the bike, then reconnect: the app reads the controller version.'
            : 'The display has now reported that the controller update FAILED. Power-cycle the bike, reconnect, then do the recovery flash.'}
        </p>
      ) : null}
      {s.stale ? (
        <p className="notice bad">
          No {s.stale.what} for {Math.round(s.stale.quietMs / 1000)} s while the link claims to be up.{' '}
          {s.displayInUpdateMode && s.lateFwStatus === null ? 'The display is still in update mode: power-cycle the bike, then reconnect. ' : ''}
          <button onClick={onReconnect}>Reconnect</button>
        </p>
      ) : null}
      {s.displayInUpdateMode && !s.stale && s.lateFwStatus === null ? (
        <p className="notice bad">The display is still in update mode. Power-cycle the bike, then reconnect.</p>
      ) : null}
      {s.canFrames > 0 ? (
        <p className="notice bad">
          CAN-analysis frames are arriving: another app left CAN analysis on, so the display sends those instead of data pages. Power-cycle the bike, then
          reconnect. (This app never sends the CAN-analysis command.)
        </p>
      ) : null}
      {s.power?.locked ? <p className="notice">This bike is PIN-locked. There is no unlock in this app. Reading works; updates are blocked while locked.</p> : null}
    </>
  );
}

export function LivePanel({ session: s, units }: { session: SessionState; units: Units }) {
  const l = s.live;
  const fresh = s.liveAt !== null;
  return (
    <Card title="Live">
      {!fresh ? <p className="muted">Waiting for live pages…</p> : null}
      <div className="grid">
        <Field label="Speed">{speed(num(l.speed_kmh), units)}</Field>
        <Field label="Battery (page 10)">{pct(num(l.batt_pct))}</Field>
        <Field label="Battery voltage">{volts(num(l.batt_mv))}</Field>
        <Field label="Battery current" hint="signed; negative = charging">{amps(num(l.batt_current_ma))}</Field>
        <Field label="Battery temperature">{num(l.batt_temp_c) === null ? '—' : `${num(l.batt_temp_c)} °C`}</Field>
        <Field label="Assist level">{num(l.assist) === null ? '—' : `${num(l.assist)} of ${num(l.assist_levels) ?? '?'}`}</Field>
        <Field label="Controller odometer (page 7)">{distance(num(l.odometer_m), units)}</Field>
        <Field label="Trip (page 7)">{distance(num(l.trip_m), units)}</Field>
        <Field label="Range estimate">{rangeKm(num(l.range_km), units)}</Field>
        <Field label="Motor rpm">{num(l.motor_rpm) ?? '—'}</Field>
        <Field label="Cadence">{num(l.cadence_rpm) === null ? '—' : `${num(l.cadence_rpm)} rpm`}</Field>
        <Field label="Motor temperature">{num(l.motor_temp_c) === null ? '—' : `${num(l.motor_temp_c)} °C`}</Field>
      </div>
    </Card>
  );
}

export function ErrorsPanel({ session: s }: { session: SessionState }) {
  const raw = (['ctrl_err_code', 'batt_err_code', 'motor_err_code'] as const)
    .map((k) => [k, rawErrorCode(num(s.settings?.[k]))] as const)
    .filter(([, v]) => v !== null);
  return (
    <Card title="Active errors" tone={s.errors.length ? 'bad' : undefined}>
      {s.errorBits === null ? (
        <p className="muted">Waiting for a stable error bitmask (3 identical frames)…</p>
      ) : s.errors.length === 0 ? (
        <p className="ok">No active errors <span className="muted mono">({hex32(s.errorBits)})</span></p>
      ) : (
        <>
          <p className="muted mono">bitmask {hex32(s.errorBits)} · sbc table</p>
          <table>
            <thead>
              <tr>
                <th>Code</th>
                <th>Description</th>
                <th>Bit</th>
              </tr>
            </thead>
            <tbody>
              {s.errors.map((e) => (
                <tr key={e.bit}>
                  <td className="mono">{e.code}</td>
                  <td>
                    {e.description}
                    {ERROR_HINTS[e.code] ? <div className="muted small">{ERROR_HINTS[e.code]}</div> : null}
                  </td>
                  <td>{e.bit}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {raw.length ? (
        <p className="small">
          Page 55 raw codes (raw, undecoded):{' '}
          {raw.map(([k, v]) => (
            <span key={k} className="mono">
              {k}=0x{v!.toString(16).padStart(4, '0')}{' '}
            </span>
          ))}
        </p>
      ) : null}
    </Card>
  );
}

const VERDICT_CLASS: Record<Verdict, string> = { latest: 'ok', newer: 'ok', older: 'bad', unknown: 'muted' };

export function IdentityPanel({ session: s }: { session: SessionState }) {
  const id = s.identity;
  const hmi = hmiReading(s.dis.sw_rev, s.dis.fw_rev);
  const ctrl = controllerReading(id.ctrl_sw);
  const batt = batteryReading(id.batt_sw);
  const battUnreachable = batt.raw === null && hasBit(s.errorBits, BMS_E032_BIT);
  const serial = (a?: string, b?: string) => [a, b].filter(Boolean).join(' ') || undefined;
  return (
    <Card title="Identity">
      <div className="grid3">
        <div>
          <h3>Display (HMI)</h3>
          <Field label="Model">{text(s.dis.model)}</Field>
          <Field label="Software (DIS)">
            {text(s.dis.sw_rev)} <span className={VERDICT_CLASS[hmi.verdict]}>{hmi.verdict === 'unknown' ? '' : hmi.label}</span>
          </Field>
          <Field label="Chip">
            <Chip chip={hmi.chip} />
          </Field>
          <Field label="Firmware / hardware rev">{text([s.dis.fw_rev, s.dis.hw_rev].filter(Boolean).join(' / '))}</Field>
          <Field label="Manufacturer">{text(s.dis.manufacturer)}</Field>
          <Field label="Build date (page 56)">{text(s.production.buildDate ?? undefined)}</Field>
          <Field label="Unit id (page 56)">{s.production.prodId === null ? nr : <span className="mono">{s.production.prodId}</span>}</Field>
        </div>
        <div>
          <h3>Controller</h3>
          <Field label="Serial (pages 16/17)">{text(serial(id.ctrl_serial1, id.ctrl_serial2))}</Field>
          <Field label="Model (page 18)">{text(id.ctrl_model)}</Field>
          <Field label="Software (page 19)">
            {text(id.ctrl_sw)} <span className={VERDICT_CLASS[ctrl.verdict]}>{ctrl.verdict === 'unknown' ? '' : ctrl.label}</span>
          </Field>
          <Field label={ctrl.chip ? `Chip (type ${swType(ctrl.version)})` : 'Chip'}>
            <Chip chip={ctrl.chip} unknown={ctrl.version ? 'not known for this type' : 'not known (no version reported)'} />
          </Field>
          <Field label="Hardware (page 20)">{text(id.ctrl_hw)}</Field>
          <Field label="Manufacturer (page 27)">{text(id.ctrl_mfr)}</Field>
        </div>
        <div>
          <h3>Battery</h3>
          <Field label="Serial (pages 21/22)">{text(serial(id.batt_serial1, id.batt_serial2))}</Field>
          <Field label="Model (page 23)">{text(id.batt_model)}</Field>
          <Field label="Software (page 24)" hint="as the display read it at power-on; see Battery firmware update">
            {batt.raw ? (
              <>
                <span className="mono">{batt.corrected ?? batt.raw}</span>{' '}
                {batt.corrected ? <span className="muted small">(reported {batt.raw})</span> : null}{' '}
                <span className={VERDICT_CLASS[batt.verdict]}>{batt.verdict === 'unknown' ? '' : batt.label}</span>
              </>
            ) : nr}
          </Field>
          <Field label={batt.line ? `Chip (${batt.line} line)` : 'Chip'}>
            <Chip chip={batt.chip} unknown={batt.raw ? 'not known (the version names no RC / SC line)' : 'not known (no version reported)'} />
          </Field>
          <Field label="Hardware (page 25)">{text(id.batt_hw)}</Field>
          <Field label="Manufacturer (page 28)">{text(id.batt_mfr)}</Field>
        </div>
      </div>
      {battUnreachable ? (
        <p className="notice">
          <strong>The battery reports no version and bms_e032 (Battery - Communication Error) is active,</strong> so its chip can't be shown: the
          display can't reach the battery's BMS. A pack whose firmware update failed looks exactly like this: it waits in its bootloader, still powers
          the display, and the display shows E032. If so, the battery firmware update below repairs it: read the battery (it won't answer), then
          choose its line (RC or SC) from the pack's label, never a guess: the two lines are different chips.
        </p>
      ) : null}
      <p className="muted small">
        Chips aren't reported by the bike: each is the processor that part's official firmware is built for. The battery's follows from the RC / SC
        line at the end of its version.
      </p>
      {s.identityMissing.length ? <p className="muted small">Identity pages that didn't come back: {s.identityMissing.join(', ')}</p> : null}
    </Card>
  );
}
