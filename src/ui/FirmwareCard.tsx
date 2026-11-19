import { useEffect, useState } from 'react';
import { ALLOWLIST, reasonText, type FirmwareComponent, type VerifyResult } from '../analysis/firmware';
import { loadBundledFirmware } from './firmwareAssets';
import { Card } from './screens';

type Check = { state: 'checking' } | { state: 'done'; result: VerifyResult | null } | { state: 'error'; message: string };

function useBundledCheck(component: FirmwareComponent): Check {
  const [check, setCheck] = useState<Check>({ state: 'checking' });
  useEffect(() => {
    let live = true;
    loadBundledFirmware(component)
      .then((result) => live && setCheck({ state: 'done', result }))
      .catch((e: unknown) => live && setCheck({ state: 'error', message: e instanceof Error ? e.message : String(e) }));
    return () => {
      live = false;
    };
  }, [component]);
  return check;
}

function Row({ component }: { component: FirmwareComponent }) {
  const check = useBundledCheck(component);
  const entry = ALLOWLIST.find((e) => e.component === component)!;
  let status: string;
  let detail: string;
  let cls = '';
  if (check.state === 'checking') {
    status = 'Checking…';
    detail = '';
  } else if (check.state === 'error') {
    status = 'Not loaded';
    detail = check.message;
    cls = 'bad';
  } else if (check.result === null) {
    status = 'Not built in';
    detail = 'This build has no copy. The update screen will ask for the file from disk; only the official file (full SHA-256) is accepted.';
    cls = 'muted';
  } else if (check.result.ok) {
    status = 'Verified';
    detail = `${check.result.firmware.size.toLocaleString()} B · SHA-256 ${check.result.firmware.sha256}`;
    cls = 'ok';
  } else {
    status = 'REJECTED';
    detail = reasonText(check.result.report);
    cls = 'bad';
  }
  return (
    <tr>
      <th scope="row">{component === 'controller' ? 'Controller' : 'Display (HMI)'}</th>
      <td>{entry.fileName}</td>
      <td>{entry.version}</td>
      <td className={cls}>{status}</td>
      <td className="mono small">{detail}</td>
    </tr>
  );
}

export function FirmwareCard() {
  return (
    <Card title="Official firmware in this build">
      <table>
        <thead>
          <tr>
            <th>Part</th>
            <th>File</th>
            <th>Version</th>
            <th>Check</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          <Row component="controller" />
          <Row component="hmi" />
        </tbody>
      </table>
    </Card>
  );
}
