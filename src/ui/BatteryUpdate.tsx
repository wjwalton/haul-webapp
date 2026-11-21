import { useEffect, useRef, useState } from 'react';
import { batteryReading, BMS_ALLOWLIST, KnownChips, MAX_FIRMWARE_BYTES, type BmsLine } from '../analysis/firmware';
import { verifyBmsFirmware, type VerifiedBmsFirmware } from '../analysis/bmsFirmware';
import type { BatteryAfter, BatteryEnv, ShopState } from '../app/shop';
import type { SessionState } from '../protocol/session';
import { describeIdentity, type BatteryProgress, type BatteryUpdateResult } from '../update/battery';
import { batteryChecks } from '../update/batteryGate';
import { isArmed } from '../update/preflight';
import { Checklist } from './ControllerUpdate';
import { hasBundledBms, loadBundledBms } from './firmwareAssets';
import { duration } from './format';
import { Card } from './screens';

type FileChoice =
  | { kind: 'none' }
  | { kind: 'loading'; what: string }
  | { kind: 'ok'; fw: VerifiedBmsFirmware }
  | { kind: 'rejected'; what: string; detail: string };

/** The built-in image for [line] (null line = none yet). */
function useBuiltIn(line: BmsLine | null): FileChoice {
  const [c, setC] = useState<FileChoice>({ kind: 'none' });
  useEffect(() => {
    if (line === null || !hasBundledBms(line)) {
      setC({ kind: 'none' });
      return;
    }
    let live = true;
    setC({ kind: 'loading', what: `the built-in ${line} image` });
    loadBundledBms(line).then(
      (r) => live && setC(r === null ? { kind: 'none' } : r.ok ? { kind: 'ok', fw: r.firmware } : { kind: 'rejected', what: 'built-in file', detail: r.reason }),
      (e: unknown) => live && setC({ kind: 'rejected', what: 'built-in file', detail: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      live = false;
    };
  }, [line]);
  return c;
}

const asLine = (l: string | null | undefined): BmsLine | null => (l === 'RC' || l === 'SC' ? l : null);

/**
 * Above this round trip the link is slow: at the display's 7.5-15 ms connection interval one block takes
 * ~15-35 ms; BlueZ's default (~60 ms) gave ~118 ms on the first real update (PROTOCOL.md "Speed").
 */
export const SLOW_RTT_MS = 50;

export interface BatteryPanelProps {
  state: ShopState;
  session: SessionState;
  platformVerified: boolean;
  platformLabel: string;
  /** Linux: the fast-Bluetooth hint applies (BlueZ's connection interval can be shortened). */
  linux?: boolean;
  now: number;
  onRead: () => void;
  onStart: (fw: VerifiedBmsFirmware, env: Omit<BatteryEnv, 'platformVerified' | 'platformLabel'>) => string | null;
}

/** Before the update: read the battery, the file, the checks, the typed name, Start. */
export function BatteryUpdatePanel(p: BatteryPanelProps) {
  const b = p.state.battery;
  const read = b.read;
  const id = read?.identity ?? null;
  const page24 = batteryReading(p.session.identity.batt_sw);
  const [chosenLine, setChosenLine] = useState<BmsLine | null>(null);
  const [picked, setPicked] = useState<FileChoice>({ kind: 'none' });
  const [typed, setTyped] = useState('');
  const [reflash, setReflash] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const recovery = id !== null && id.echo && !id.responding;
  const line: BmsLine | null = id?.responding ? asLine(id.line) : recovery ? chosenLine : asLine(page24.line);
  const builtIn = useBuiltIn(line);
  const choice = picked.kind !== 'none' ? picked : builtIn;
  const fw = choice.kind === 'ok' ? choice.fw : null;
  const name = p.state.device?.name ?? null;
  const checks = batteryChecks({
    session: p.session, confirmed: p.state.confirmed, platformVerified: p.platformVerified, platformLabel: p.platformLabel,
    firmware: fw, read, chosenLine, reflashSameVersion: reflash, updateRunning: b.running, now: p.now,
  });
  const armed = isArmed(typed, name);
  // Every block costs one round trip (the battery answers each one): measured when the battery was read.
  const blocks = fw?.blockCount ?? (line ? Math.ceil((BMS_ALLOWLIST.find((e) => e.line === line)?.size ?? 107_336) / 8) : 13_417);
  const rtt = id?.rttMs ?? null;
  const etaMs = rtt !== null ? blocks * rtt : null;
  const slowLink = rtt !== null && rtt > SLOW_RTT_MS;

  async function pick(file: File) {
    setRefusal(null);
    if (file.size > MAX_FIRMWARE_BYTES) {
      setPicked({ kind: 'rejected', what: file.name, detail: `The file is ${file.size.toLocaleString()} bytes: far too large to be firmware. It wasn't read.` });
      return;
    }
    setPicked({ kind: 'loading', what: file.name });
    try {
      const r = await verifyBmsFirmware(new Uint8Array(await file.arrayBuffer()), { source: `disk:${file.name}`, pickedName: file.name });
      setPicked(r.ok ? { kind: 'ok', fw: r.firmware } : { kind: 'rejected', what: file.name, detail: `${r.reason}\nSHA-256: ${r.sha256 ?? '-'}` });
    } catch (e) {
      setPicked({ kind: 'rejected', what: file.name, detail: `Couldn't read the file (${e instanceof Error ? e.message : String(e)})` });
    }
  }

  return (
    <Card title="Battery firmware update" tone={recovery ? 'warn' : undefined}>
      <h3>The battery</h3>
      <p>
        The display reports{' '}
        {page24.raw ? (
          <>
            <span className="mono">{page24.corrected ?? page24.raw}</span> <span className="muted small">(page 24, read at power-on)</span>
          </>
        ) : (
          <span className="muted">no battery version (page 24)</span>
        )}
        . Reading the battery asks its BMS directly on the bus: bus access on for a few seconds, version and hardware type, bus access off. It
        changes nothing.
      </p>
      <div className="row">
        <button onClick={p.onRead} disabled={b.reading || b.running}>
          {b.reading ? 'Reading the battery…' : read ? 'Read the battery again' : 'Read the battery'}
        </button>
        {read && !b.reading ? <span className="muted small">read {duration(Math.max(0, p.now - read.at))} ago</span> : null}
      </div>
      {read?.problem ? <p className="notice bad">{read.problem}</p> : null}
      {id?.responding ? (
        <p>
          <span className="ok">✓</span> The battery answers: <span className="mono">{describeIdentity(id)}</span>.{' '}
          {asLine(id.line) ? `Chip: ${KnownChips.batteryByLine[id.line!]!.chip} (${KnownChips.batteryByLine[id.line!]!.note}).` : null}
        </p>
      ) : null}
      {etaMs !== null ? (
        <p className={slowLink ? 'notice' : 'small'}>
          Bluetooth round trip: about {Math.round(rtt!)} ms per frame, so the update takes at least <strong>{duration(etaMs)}</strong> (
          {blocks.toLocaleString()} blocks, each waits for the battery's answer).
          {slowLink && p.linux ? (
            <>
              {' '}
              That's a slow link. On Linux it can be about 4 times faster: stop the shop tool, start it again with{' '}
              <span className="mono">sh start-shop-tool.sh</span> and answer yes to "Fast Bluetooth", then click Reconnect and read the battery
              again. (Or, as root, before connecting: <span className="mono">echo 6 &gt; /sys/kernel/debug/bluetooth/hci0/conn_min_interval</span>{' '}
              then <span className="mono">echo 12 &gt; /sys/kernel/debug/bluetooth/hci0/conn_max_interval</span>.)
            </>
          ) : slowLink ? (
            ' That\'s a slow link (the computer\'s Bluetooth sets the speed; a browser can\'t change it). Keep the laptop close to the bike.'
          ) : null}
        </p>
      ) : null}
      {recovery ? (
        <div className="notice">
          <p>
            <strong>The battery's BMS doesn't answer.</strong> It is most likely waiting in its bootloader after a failed update (the display shows
            E032), and then writing the official image again is the repair. Its line can't be read from the bus, so choose it from the pack's
            label. Never guess: the RC and SC lines are different chips.
            {page24.line ? ` The display last read a ${page24.line} battery (page 24); that only counts if the pack wasn't swapped.` : ''}
          </p>
          <div className="row">
            {(['RC', 'SC'] as const).map((l) => (
              <label key={l} className="radio">
                <input
                  type="radio"
                  name="bms-line"
                  checked={chosenLine === l}
                  onChange={() => {
                    setChosenLine(l);
                    setPicked({ kind: 'none' });
                    setRefusal(null);
                  }}
                />{' '}
                {l} line ({KnownChips.batteryByLine[l]!.chip})
              </label>
            ))}
          </div>
        </div>
      ) : null}

      <h3>File</h3>
      <div className="file-choice">
        {choice.kind === 'ok' ? (
          <p>
            <span className="ok">✓ {choice.fw.entry.fileName}</span>: {choice.fw.info.version} {choice.fw.info.line} from the file itself (
            {KnownChips.batteryByLine[choice.fw.info.line]?.chip}), {choice.fw.blockCount.toLocaleString()} blocks, built {choice.fw.info.buildDate}
            {choice.fw.bundled ? ', built in' : ', loaded from disk'}
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
          <p className="muted">
            {line === null
              ? 'Read the battery first: the file must match its line.'
              : `No built-in ${line} image in this build. Load the official ${line} file from disk; only the two official battery files (by full SHA-256) are accepted.`}
          </p>
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

      {checks.sameVersion ? (
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
            <strong>Re-flash the same version.</strong> The battery already runs {id?.version} {id?.line}. Tick it to write the official image
            again as a repair.
          </span>
        </label>
      ) : null}

      <h3>Checks</h3>
      <Checklist checks={checks.checks} />
      {checks.warnings.map((w) => (
        <p key={w} className="notice">
          {w}
        </p>
      ))}

      <div className="notice bad">
        <strong>Point of no return.</strong> Right after Start the battery leaves its firmware for its bootloader and switches the motor power off;
        the display stays on. The transfer takes {etaMs !== null ? <>at least {duration(etaMs)} on this link</> : 'up to about 30 minutes'}: every
        one of the {blocks.toLocaleString()} blocks waits for the battery's answer. If it fails or the link drops, the battery waits in
        its bootloader (the display shows E032) and can be flashed again. At the end the bike restarts by itself and the app reconnects. Keep the
        laptop <strong>plugged in, lid open</strong>, close to the bike, and keep this tab in front.
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
          onClick={() => fw && setRefusal(p.onStart(fw, { typedName: typed, chosenLine: recovery ? chosenLine : null, reflashSameVersion: reflash && checks.sameVersion }))}
        >
          Start battery update
        </button>
        {!checks.ready ? <span className="muted">Every check must pass first.</span> : !armed ? <span className="muted">Type the name exactly as shown.</span> : null}
      </div>
      {refusal ? <p className="notice bad">Not started: {refusal}</p> : null}
      <p className="muted small">
        Once it starts there is no stop button. Every frame goes into the update log, offered for download afterwards.
      </p>
    </Card>
  );
}

/** While the battery update runs. */
export function BatteryUpdateRunning({ progress: pr, now }: { progress: BatteryProgress | null; now: number }) {
  const f = pr?.flash ?? null;
  const pct = f && f.total ? Math.floor((f.block / f.total) * 100) : 0;
  return (
    <Card title="Updating the battery" tone="warn">
      <p className="big-status">{pr?.text ?? 'Starting…'}</p>
      {f && (f.phase === 'sending' || f.phase === 'finishing') ? (
        <>
          <progress className="bar" max={f.total} value={f.block} />
          <p>
            Block {f.block.toLocaleString()} of {f.total.toLocaleString()} ({pct} %) ·{' '}
            {f.phase === 'finishing' ? 'waiting for the battery to check the image' : f.etaMs === null ? 'measuring…' : `about ${duration(f.etaMs)} left`} · elapsed{' '}
            {duration(now - (pr?.startedAt ?? now))}
          </p>
          <p className="muted small">
            {f.blocksPerSecond.toFixed(1)} blocks/s, each acknowledged by the battery{f.attempts > 1 ? ` · attempt ${f.attempt} of ${f.attempts}` : ''}
          </p>
        </>
      ) : (
        <p className="muted">Elapsed {duration(now - (pr?.startedAt ?? now))}</p>
      )}
      <p className="notice">
        {pr?.pastPointOfNoReturn ? 'The battery is being reprogrammed: the motor has no power and the display stays on. That is normal. ' : ''}
        <strong>Don't switch the bike off</strong> or close this tab until this card says it has finished. At the end the bike restarts by itself.
        Keep the laptop plugged in, lid open, next to the bike.
      </p>
    </Card>
  );
}

function afterText(a: BatteryAfter, now: number): { cls: string; text: string } {
  switch (a.status) {
    case 'reconnecting':
      return {
        cls: 'notice',
        text: `The bike is restarting (the battery cuts power to start its new firmware). Reconnecting by itself… ${duration(now - a.startedAt)}` +
          (a.powerButtonHint ? '. If the display stays off, press the bike\'s power button.' : ''),
      };
    case 'checking':
      return { cls: 'notice', text: 'Reconnected. Checking the new version and restoring the auto-off timer…' };
    case 'verified':
      return { cls: 'ok', text: `Verified after the restart: the battery reports ${a.reported}.${a.e032 ? ' bms_e032 is still active: read the battery to check it.' : ''}` };
    case 'mismatch':
      return { cls: 'notice bad', text: `After the restart the display reports ${a.reported}, not ${a.target}. Read the battery to check it before the bike is ridden.` };
    case 'silent':
      return { cls: 'notice bad', text: 'After the restart the display reports no battery version. Read the battery; if it doesn\'t answer, run the update again (recovery).' };
    case 'gave-up':
      return { cls: 'notice bad', text: 'The bike didn\'t come back within 3 minutes. Switch it on and click Reconnect: the version is checked on that connection.' };
    case 'stopped':
      return { cls: 'notice', text: 'Automatic reconnect stopped. Click Reconnect when the bike is on: the version is checked on that connection.' };
  }
}

/** After any battery update attempt: what happened, the restart, the log. */
export function BatteryResultCard(props: {
  result: BatteryUpdateResult;
  after: BatteryAfter | null;
  now: number;
  onDownloadLog: (r: BatteryUpdateResult) => void;
  onDismiss: () => void;
  onStopReconnect?: () => void;
}) {
  const r = props.result;
  const a = props.after;
  const done = r.ok && (a?.status === 'verified' || (!r.restarting && r.after?.responding && r.after.version + ' ' + r.after.line === r.target));
  const at = afterText;
  return (
    <Card title={r.ok ? 'Battery update finished' : 'Battery update failed'} tone={done ? 'ok' : r.ok ? 'warn' : 'bad'}>
      <p className={r.ok ? '' : 'bad'}>{r.message}</p>
      <table className="compact">
        <tbody>
          <tr>
            <th>Before</th>
            <td className="mono">{r.before ?? 'not answering'}</td>
          </tr>
          <tr>
            <th>Target</th>
            <td className="mono">
              {r.target} ({KnownChips.batteryByLine[r.line]?.chip})
            </td>
          </tr>
          <tr>
            <th>Attempts</th>
            <td>{r.attempts}</td>
          </tr>
          {r.ackTiming ? (
            <tr>
              <th>Block round trip</th>
              <td>
                min {r.ackTiming.minMs.toFixed(0)} ms · avg {r.ackTiming.avgMs.toFixed(1)} ms · max {r.ackTiming.maxMs.toFixed(0)} ms (
                {r.ackTiming.count.toLocaleString()} blocks)
              </td>
            </tr>
          ) : null}
          {r.autoOff.changed ? (
            <tr>
              <th>Auto-off timer</th>
              <td>
                {r.autoOff.before} s, set to 0 for the update;{' '}
                {(a?.autoOffRestored ?? r.autoOff.restored) === null ? 'to be restored once the bike is back' : (a?.autoOffRestored ?? r.autoOff.restored) ? 'restored' : 'NOT restored: set it again on the bike'}
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
      {a ? <p className={at(a, props.now).cls}>{at(a, props.now).text}</p> : null}
      <div className="row">
        <button className="primary" onClick={() => props.onDownloadLog(r)}>
          Download update log ({r.logName})
        </button>
        {a?.status === 'reconnecting' && props.onStopReconnect ? <button onClick={props.onStopReconnect}>Stop reconnecting</button> : null}
        {a?.status !== 'reconnecting' && a?.status !== 'checking' ? <button onClick={props.onDismiss}>Close</button> : null}
      </div>
    </Card>
  );
}
