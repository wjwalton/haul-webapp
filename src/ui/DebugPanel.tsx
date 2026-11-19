import type { CharProperties } from '../ble/transport';
import type { SessionState } from '../protocol/session';
import { CH_BATTERY_LEVEL, CH_BYPASS, CH_POWER, CH_READ, CH_WRITE, DIS_CHARS, SVC_BATTERY, SVC_DIS, SVC_EBIKE, SVC_SECURE_DFU } from '../protocol/gatt';

const NAMES: Record<string, string> = {
  [SVC_EBIKE]: 'Globe e-bike service',
  [CH_READ]: '…0001 data pages',
  [CH_WRITE]: '…0010 commands + acks',
  [CH_BYPASS]: '…0011 firmware blocks',
  [CH_POWER]: '…0004 status',
  [SVC_DIS]: 'Device Information',
  [SVC_BATTERY]: 'Battery service',
  [CH_BATTERY_LEVEL]: 'Battery level',
  [SVC_SECURE_DFU]: 'Nordic Secure DFU (0xFE59)',
  ...Object.fromEntries(Object.entries(DIS_CHARS).map(([k, u]) => [u, `DIS ${k}`])),
};

function props(p: CharProperties): string {
  return Object.entries(p).filter(([, v]) => v).map(([k]) => k).join(', ') || '—';
}

export function DebugPanel(props_: { session: SessionState; rawLines: number; onDownloadRaw: () => void }) {
  const s = props_.session;
  const sizes = Object.entries(s.sizes).sort((a, b) => Number(a[0]) - Number(b[0]));
  const rejected = Object.entries(s.quality.rejectedByPid);
  return (
    <details className="card debug">
      <summary>Debug: GATT table, notification sizes, connection log</summary>
      <div className="row">
        <button onClick={props_.onDownloadRaw} disabled={props_.rawLines === 0}>
          Download raw.jsonl ({props_.rawLines} lines)
        </button>
        <span className="muted small">Python format: <span className="mono">globe_capture.py replay raw.jsonl</span> reads it.</span>
      </div>
      <h3>GATT table</h3>
      {s.gatt.services ? (
        <table className="compact">
          <tbody>
            {s.gatt.services.map((svc) => (
              <tr key={svc.uuid}>
                <td>
                  <div className="mono">{svc.uuid}</div>
                  <div className="muted small">{NAMES[svc.uuid] ?? ''}</div>
                </td>
                <td>
                  {svc.characteristics.length === 0 ? <span className="muted">no characteristics visible</span> : null}
                  {svc.characteristics.map((c) => (
                    <div key={c.uuid}>
                      <span className="mono">{c.uuid}</span> <span className="muted small">{NAMES[c.uuid] ?? ''} · {props(c.properties)}</span>
                    </div>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">Not read yet.</p>
      )}
      <p className="small">
        …0011: <span className="mono">{s.gatt.blockChar ? props(s.gatt.blockChar) : 'absent'}</span> · Nordic Secure DFU 0xFE59:{' '}
        <strong>{s.gatt.dfuService ? 'present' : 'not visible'}</strong> · BLE battery level: {s.bleBatteryPct ?? '—'}
        {s.bleBatteryPct !== null ? ' %' : ''} · Status: <span className="mono">{s.power?.raw ?? '—'}</span>
      </p>
      <h3>…0001 notification sizes</h3>
      <p className="mono small">{sizes.length ? sizes.map(([n, c]) => `${n} B × ${c}`).join(' · ') : '—'}</p>
      <p className="small">
        Pages accepted: {s.pagesReceived} · notifications dropped: {s.quality.dropped} · pages rejected:{' '}
        {rejected.length ? rejected.map(([p, n]) => `page ${p} × ${n}`).join(', ') : 'none'}
        {s.quality.lastReject ? <span className="muted"> (last: {s.quality.lastReject})</span> : null}
      </p>
      <h3>Connection log</h3>
      <pre className="log">{s.log.join('\n')}</pre>
    </details>
  );
}
