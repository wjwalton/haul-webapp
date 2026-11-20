import { useEffect, useRef, useState } from 'react';
import { reasonText, verifyFirmware, type VerifiedFirmware } from '../analysis/firmware';
import type { ShopState, UpdateState } from '../app/shop';
import type { SessionState } from '../protocol/session';
import type { UpdateResult } from '../update/controller';
import { controllerChecks, isArmed } from '../update/preflight';
import type { GateCheck } from '../update/gate';
import { hasBundledFirmware, loadBundledFirmware } from './firmwareAssets';
import { duration } from './format';
import { Card } from './screens';

export function Checklist({ checks }: { checks: readonly GateCheck[] }) {
  return (
    <ul className="checks">
      {checks.map((c) => (
        <li key={c.id} className={c.ok === null ? 'pending' : c.ok ? 'pass' : 'fail'}>
          <span className="mark">{c.ok === null ? '…' : c.ok ? '✓' : '✗'}</span>
          <span>
            <strong>{c.label}</strong> <span className="muted">{c.detail}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

type FileChoice =
  | { kind: 'none' }
  | { kind: 'loading'; what: string }
  | { kind: 'ok'; fw: VerifiedFirmware }
  | { kind: 'rejected'; what: string; detail: string };

function useBuiltIn(): FileChoice {
  const [c, setC] = useState<FileChoice>(() => (hasBundledFirmware('controller') ? { kind: 'loading', what: 'built-in M1B0306s0.bin' } : { kind: 'none' }));
  useEffect(() => {
    if (!hasBundledFirmware('controller')) return;
    let live = true;
    loadBundledFirmware('controller').then(
      (r) => live && setC(r === null ? { kind: 'none' } : r.ok ? { kind: 'ok', fw: r.firmware } : { kind: 'rejected', what: 'built-in file', detail: reasonText(r.report) }),
      (e: unknown) => live && setC({ kind: 'rejected', what: 'built-in file', detail: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      live = false;
    };
  }, []);
  return c;
}

export interface UpdatePanelProps {
  state: ShopState;
  session: SessionState;
  platformVerified: boolean;
  platformLabel: string;
  now: number;
  onStart: (fw: VerifiedFirmware, typedName: string, reflashSameVersion: boolean) => string | null;
  onDismiss: () => void;
  onDownloadLog: (r: UpdateResult) => void;
}

/** Before the update: file, checklist, warning, typed name, Start. */
export function ControllerUpdatePanel(p: UpdatePanelProps) {
  const builtIn = useBuiltIn();
  const [picked, setPicked] = useState<FileChoice>({ kind: 'none' });
  const [typed, setTyped] = useState('');
  const [reflash, setReflash] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const choice = picked.kind !== 'none' ? picked : builtIn;
  const fw = choice.kind === 'ok' ? choice.fw : null;
  const name = p.state.device?.name ?? null;
  const checks = controllerChecks({
    session: p.session, confirmed: p.state.confirmed, platformVerified: p.platformVerified, platformLabel: p.platformLabel,
    firmware: fw, reflashSameVersion: reflash, updateRunning: p.state.update?.running === true, now: p.now,
  });
  const armed = isArmed(typed, name);

  async function pick(file: File) {
    setPicked({ kind: 'loading', what: file.name });
    const bytes = new Uint8Array(await file.arrayBuffer());
    const r = await verifyFirmware(bytes, 'controller', { source: `disk:${file.name}`, pickedName: file.name });
    setPicked(r.ok ? { kind: 'ok', fw: r.firmware } : { kind: 'rejected', what: file.name, detail: reasonText(r.report) });
  }

  return (
    <Card title="Controller firmware update" tone={checks.gate.recovery ? 'warn' : undefined}>
      {checks.gate.recovery ? (
        <p className="notice bad">
          <strong>Recovery:</strong> the controller isn't answering (no identity on two reads). Reflashing the official image is the repair; type s0 is
          assumed, as the stock app does.
        </p>
      ) : null}
      {checks.gate.hmiFirst ? <p className="notice">The HMI is older than 5.19: update the HMI first (the controller update is verified on 5.19 only).</p> : null}

      <h3>File</h3>
      <div className="file-choice">
        {choice.kind === 'ok' ? (
          <p>
            <span className="ok">✓ {choice.fw.entry.fileName}</span> ({choice.fw.entry.version}, {choice.fw.size.toLocaleString()} bytes,{' '}
            {choice.fw.blockCount.toLocaleString()} blocks){choice.fw.bundled ? ', built in' : `, loaded from disk`}
            <br />
            <span className="mono small">SHA-256 {choice.fw.sha256}</span>
            {choice.fw.notes.map((n) => (
              <span key={n} className="muted small">
                <br />
                {n}
              </span>
            ))}
          </p>
        ) : choice.kind === 'loading' ? (
          <p className="muted">Checking {choice.what}…</p>
        ) : choice.kind === 'rejected' ? (
          <div className="notice bad">
            <strong>{choice.what} was rejected.</strong>
            <pre className="mono small">{choice.detail}</pre>
          </div>
        ) : (
          <p className="muted">No built-in copy in this build. Load the official M1B0306s0.bin from disk; only that file (by full SHA-256) is accepted.</p>
        )}
        <button onClick={() => fileInput.current?.click()}>Load file from disk…</button>
        <input
          ref={fileInput}
          type="file"
          accept=".bin"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void pick(f);
          }}
        />
      </div>

      {checks.gate.sameVersion ? (
        <label className="notice reflash">
          <input
            type="checkbox"
            checked={reflash}
            onChange={(e) => {
              setReflash(e.target.checked);
              setRefusal(null);
            }}
          />
          <span>
            <strong>Reflash the same version.</strong> The controller already runs {p.session.identity.ctrl_sw}, so the stock app wouldn't offer this.
            Tick it to write the official image again as a repair. It erases and rewrites the controller exactly like an update.
          </span>
        </label>
      ) : null}

      <h3>Checks</h3>
      <Checklist checks={[...checks.gate.checks, ...checks.preflight]} />

      <div className="notice bad">
        <strong>Point of no return.</strong> About 4.5 s after the start, the controller erases its program. From then on the bike won't drive
        until an update completes. If the update fails or the link drops, the controller waits in its bootloader and can be flashed again
        (recovery). Keep the laptop <strong>plugged in, lid open</strong>, close to the bike, and don't close this tab.
      </div>

      <label className="arm">
        Type the bike's name to arm the update: <span className="mono">{name}</span>
        <input
          className="mono"
          value={typed}
          onChange={(e) => {
            setTyped(e.target.value);
            setRefusal(null);
          }}
          placeholder={name ?? ''}
          autoComplete="off"
          spellCheck={false}
          disabled={!checks.ready}
        />
      </label>
      <div className="row">
        <button
          className="primary big danger-fill"
          disabled={!checks.ready || !armed || fw === null}
          onClick={() => fw && setRefusal(p.onStart(fw, typed, reflash && checks.gate.sameVersion))}
        >
          Start controller update
        </button>
        {!checks.ready ? <span className="muted">Every check must pass first.</span> : !armed ? <span className="muted">Type the name exactly as shown.</span> : null}
      </div>
      {refusal ? <p className="notice bad">Not started: {refusal}</p> : null}
      <p className="muted small">
        Once it starts there is no stop button: stopping halfway would leave the controller erased. The flash time is measured on this laptop; the
        stock phone app took about 28 s.
      </p>
    </Card>
  );
}

/** While the update runs: plain status, progress, measured ETA, elapsed. */
export function UpdateRunning({ update, now }: { update: UpdateState; now: number }) {
  const pr = update.progress;
  const f = pr?.flash ?? null;
  const pct = f ? Math.floor((f.position / f.total) * 100) : 0;
  const c = f?.confirming ?? null;
  return (
    <Card title="Updating the controller" tone="warn">
      <p className="big-status">{pr?.text ?? 'Starting…'}</p>
      {f ? (
        <>
          <progress className="bar" max={f.total} value={f.position} />
          <p>
            Block {f.position.toLocaleString()} of {f.total.toLocaleString()} ({pct} %) ·{' '}
            {c ? `waiting ${duration(c.waitedMs)} (up to ${duration(c.maxMs)})` : f.etaMs === null ? 'measuring…' : `about ${duration(f.etaMs)} left`} ·
            elapsed {duration(now - (pr?.startedAt ?? now))}
          </p>
          <p className="muted small">
            {f.blocksPerSecond.toFixed(0)} blocks/s reaching the bike · …0011 written {pr?.writeMode ?? '?'}
            {f.resends ? ` · resend requests: ${f.resends}` : ''}
          </p>
          {c ? (
            <p className="notice">
              Every block has been sent. The display passes the last ones to the controller and then confirms. Over a slow Bluetooth link this can take a
              few minutes: keep waiting.
            </p>
          ) : null}
        </>
      ) : (
        <p className="muted">Elapsed {duration(now - (pr?.startedAt ?? now))}</p>
      )}
      <p className="notice">
        {pr?.pastPointOfNoReturn ? 'The controller is being reprogrammed. The bike\'s display shows "bypass" while this runs; that is normal. ' : ''}
        <strong>Don't switch the bike off</strong> or close this tab until this card says it has finished. Keep the laptop plugged in, lid open, next
        to the bike.
      </p>
    </Card>
  );
}

/** After any attempt: what happened, what to do next, and the session log. */
export function UpdateResultCard(props: { update: UpdateState; onDownloadLog: (r: UpdateResult) => void; onDismiss: () => void; onReconnect?: () => void }) {
  const r = props.update.result!;
  const v = props.update.verify;
  const done = r.ok && (r.verified || v?.status === 'verified');
  return (
    <Card title={r.ok ? 'Controller update finished' : 'Controller update failed'} tone={done ? 'ok' : r.ok ? 'warn' : 'bad'}>
      <p className={r.ok ? '' : 'bad'}>{r.message}</p>
      <table className="compact">
        <tbody>
          <tr>
            <th>Before</th>
            <td className="mono">{r.before ?? 'not answering'}</td>
          </tr>
          <tr>
            <th>Target</th>
            <td className="mono">{r.target}</td>
          </tr>
          <tr>
            <th>Page 19 after</th>
            <td className="mono">{r.after ?? '—'}</td>
          </tr>
          {r.timing ? (
            <tr>
              <th>Block write time</th>
              <td>
                min {r.timing.minMs.toFixed(1)} ms · avg {r.timing.avgMs.toFixed(2)} ms · max {r.timing.maxMs.toFixed(1)} ms ({r.timing.count.toLocaleString()} writes,{' '}
                {r.writeMode})
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
      {v ? (
        <p className={v.status === 'verified' ? 'ok' : v.status === 'waiting' ? 'notice' : 'notice bad'}>
          {v.status === 'waiting'
            ? 'Next: power-cycle the bike (off, then on), then click Reconnect. The new version is checked on that connection.'
            : v.status === 'verified'
              ? `Verified after the power-cycle: the controller reports ${v.reported}.`
              : v.status === 'mismatch'
                ? `After the power-cycle the controller reports ${v.reported}, not ${v.target}. Check it before the bike is ridden.`
                : 'After the power-cycle the controller isn\'t answering: the update did not take. Flash it again (recovery).'}
        </p>
      ) : null}
      <div className="row">
        <button className="primary" onClick={() => props.onDownloadLog(r)}>
          Download update log ({r.logName})
        </button>
        {props.onReconnect && v?.status === 'waiting' ? <button onClick={props.onReconnect}>Reconnect</button> : null}
        <button onClick={props.onDismiss}>Close</button>
      </div>
    </Card>
  );
}
