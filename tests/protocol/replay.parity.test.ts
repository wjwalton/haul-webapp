/**
 * End-to-end parity with `globe_capture.py replay`: each real capture goes through the TS dispatch
 * (classifyNotification → splitPages → decodePage → stripNa → decodeErrors, decodePower), mirroring
 * Session.on_read / on_power / _record_page / _on_errors, and must give the same page counts, final
 * state and last error bitmask as the Python Session did on the same file.
 */
import { describe, expect, it } from 'vitest';
import { fromHex } from '../../src/protocol/bytes';
import { decodeErrors } from '../../src/protocol/errors';
import { classifyNotification, decodePage, decodePower, stripNa } from '../../src/protocol/pages';
import type { RawRecord } from '../../src/export/rawJsonl';
import { capture, captureFixture, HAS_CAPTURES, pyToTs } from '../helpers';

interface PyReplay {
  page_counts: Record<string, number>;
  state: Record<string, unknown>;
  last_error_bits: number | null;
}
/** Derived from the real captures (git-ignored, personal): the whole suite skips without them. */
const captures = captureFixture<{ captures: Record<string, PyReplay> }>('py_capture_replay.json')?.captures ?? {};

function tsReplay(records: RawRecord[]) {
  const state: Record<string, unknown> = {};
  const counts: Record<string, number> = {};
  let dump: Uint8Array[] | null = null;
  let lastErrorBits: number | null = null;
  let lastPower: string | null = null;

  const record = (p: Uint8Array) => {
    const pid = p[0]!;
    counts[pid] = (counts[pid] ?? 0) + 1;
    if (pid === 56) return; // DEVIATIONS: the reference doesn't decode page 56
    const d = stripNa(decodePage(p));
    for (const [k, v] of Object.entries(d)) if (v !== null) state[k] = v;
    if (typeof d.error_bits === 'number' && d.error_bits !== lastErrorBits) {
      lastErrorBits = d.error_bits;
      state.active_errors = decodeErrors(d.error_bits).map((e) => `${e.code} ${e.description}`);
    }
  };

  for (const r of records) {
    const b = fromHex(r.hex);
    if (r.ch === 'read') {
      if (!b.length) continue;
      if (dump) {
        if (b[0] === 0xed) dump = null;
        else dump.push(b);
        continue;
      }
      const n = classifyNotification(b);
      if (n.kind === 'dump-start') dump = [];
      else if (n.kind === 'fw-status') record(b);
      else if (n.kind === 'bypass-reply') record(b);
      else if (n.kind === 'can') state.can_frames = ((state.can_frames as number | undefined) ?? 0) + 1;
      else if (n.kind === 'pages') n.pages.forEach(record);
    } else if (r.ch === 'power') {
      if (r.hex === lastPower) continue;
      lastPower = r.hex;
      const p = decodePower(b);
      if (p) Object.assign(state, { suspended: p.suspended, locked: p.locked, charging: p.charging, units: p.units });
    }
  }
  return { state, counts, lastErrorBits };
}

describe.runIf(HAS_CAPTURES)('replay parity with the Python Session', () => {
  it.each(Object.entries(captures))('%s', (name, py) => {
    const ts = tsReplay(capture(name));
    expect(ts.counts).toEqual(Object.fromEntries(Object.entries(py.page_counts).map(([k, v]) => [k, v])));
    expect(ts.state).toEqual(pyToTs(py.state));
    expect(ts.lastErrorBits).toBe(py.last_error_bits);
  });

  it('includes a capture with a live fault and one with CAN frames', () => {
    const states = Object.values(captures).map((c) => c.state);
    expect(states.some((s) => (s.active_errors as string[] | undefined)?.includes('controller_e010 Ctrl - Throttle Under'))).toBe(true);
    expect(states.some((s) => typeof s.can_frames === 'number' && s.can_frames > 0)).toBe(true);
  });
});
