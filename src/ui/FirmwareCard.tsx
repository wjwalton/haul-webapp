import { useEffect, useState } from 'react';
import { ALLOWLIST, BMS_ALLOWLIST, fileType, KnownChips, reasonText, type BmsLine, type FirmwareComponent, type VerifyResult } from '../analysis/firmware';
import type { BmsVerifyResult } from '../analysis/bmsFirmware';
import { loadBundledBms, loadBundledFirmware } from './firmwareAssets';
import { Card, Chip } from './screens';

type Check<T> = { state: 'checking' } | { state: 'done'; result: T | null } | { state: 'error'; message: string };

function useBundledCheck<T>(load: () => Promise<T | null>, key: string): Check<T> {
  const [check, setCheck] = useState<Check<T>>({ state: 'checking' });
  useEffect(() => {
    let live = true;
    load()
      .then((result) => live && setCheck({ state: 'done', result }))
      .catch((e: unknown) => live && setCheck({ state: 'error', message: e instanceof Error ? e.message : String(e) }));
    return () => {
      live = false;
    };
  }, [key]);
  return check;
}

/** Status / detail cells for a built-in file check. */
function verdict<T>(check: Check<T>, describe: (r: T) => { ok: boolean; detail: string }): { status: string; detail: string; cls: string } {
  if (check.state === 'checking') return { status: 'Checking…', detail: '', cls: '' };
  if (check.state === 'error') return { status: 'Not loaded', detail: check.message, cls: 'bad' };
  if (check.result === null) {
    return {
      status: 'Not built in',
      detail: 'This build has no copy. The update screen will ask for the file from disk; only the official file (full SHA-256) is accepted.',
      cls: 'muted',
    };
  }
  const d = describe(check.result);
  return d.ok ? { status: 'Verified', detail: d.detail, cls: 'ok' } : { status: 'REJECTED', detail: d.detail, cls: 'bad' };
}

function Row({ component }: { component: FirmwareComponent }) {
  const check = useBundledCheck<VerifyResult>(() => loadBundledFirmware(component), component);
  const entry = ALLOWLIST.find((e) => e.component === component)!;
  const chip = component === 'hmi' ? KnownChips.hmi : KnownChips.controllerByType[fileType(entry.fileName) ?? ''] ?? null;
  const v = verdict(check, (r) => (r.ok ? { ok: true, detail: `${r.firmware.size.toLocaleString()} B · SHA-256 ${r.firmware.sha256}` } : { ok: false, detail: reasonText(r.report) }));
  return (
    <tr>
      <th scope="row">{component === 'controller' ? 'Controller' : 'Display (HMI)'}</th>
      <td>
        <Chip chip={chip} />
      </td>
      <td>{entry.fileName}</td>
      <td>{entry.version}</td>
      <td className={v.cls}>{v.status}</td>
      <td className="mono small">{v.detail}</td>
    </tr>
  );
}

/** One battery line: its official image, chip and check. */
function BatteryRow({ line }: { line: BmsLine }) {
  const check = useBundledCheck<BmsVerifyResult>(() => loadBundledBms(line), line);
  const entry = BMS_ALLOWLIST.find((e) => e.line === line)!;
  const v = verdict(check, (r) =>
    r.ok
      ? { ok: true, detail: `${r.firmware.size.toLocaleString()} B · ${r.firmware.info.records} records · SHA-256 ${r.firmware.sha256}` }
      : { ok: false, detail: `${r.reason}\nSHA-256: ${r.sha256 ?? '-'}` },
  );
  return (
    <tr>
      <th scope="row">Battery, {line} line</th>
      <td>
        <Chip chip={KnownChips.batteryByLine[line] ?? null} />
      </td>
      <td>{entry.fileName}</td>
      <td>
        {entry.version} {line}
      </td>
      <td className={v.cls}>{v.status}</td>
      <td className="mono small">{v.detail}</td>
    </tr>
  );
}

export function FirmwareCard() {
  return (
    <Card title="Official firmware">
      <table>
        <thead>
          <tr>
            <th>Part</th>
            <th>Chip</th>
            <th>File</th>
            <th>Version</th>
            <th>Check</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          <Row component="controller" />
          <Row component="hmi" />
          {BMS_ALLOWLIST.map((e) => (
            <BatteryRow key={e.line} line={e.line} />
          ))}
        </tbody>
      </table>
      <p className="muted small">
        The bike reports versions, not chips: each chip is the processor that part's official firmware is built for. The battery comes in two lines
        (RC and SC, the end of its version) with different chips, so one line's firmware never fits the other: the app checks the battery's line
        before it sends anything.
      </p>
    </Card>
  );
}
