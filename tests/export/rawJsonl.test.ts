import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { formatRawLine, parseRawJsonl, pyFloat, RawRecorder } from '../../src/export/rawJsonl';
import { CAPTURES, captureNames, fixture, HAS_CAPTURES } from '../helpers';

const { cases } = fixture<{ cases: { t: number; ch: string; hex: string; line: string }[] }>('py_rawjsonl.json');

describe('raw.jsonl is byte-identical to json.dumps', () => {
  it.each(cases.map((c) => [c.line, c] as const))('%s', (_l, c) => {
    expect(formatRawLine(c)).toBe(c.line);
  });

  it.runIf(HAS_CAPTURES)('every line of every Python-written capture re-formats identically', () => {
    let n = 0;
    for (const f of captureNames()) {
      const lines = readFileSync(join(CAPTURES, f), 'utf8').split('\n').filter(Boolean);
      const recs = parseRawJsonl(lines.join('\n'));
      recs.forEach((r, i) => expect(formatRawLine(r)).toBe(lines[i]));
      n += recs.length;
    }
    expect(n).toBeGreaterThan(1000);
  });

  it('integral times keep ".0"', () => {
    expect(pyFloat(2)).toBe('2.0');
    expect(pyFloat(0)).toBe('0.0');
    expect(pyFloat(0.696)).toBe('0.696');
  });
});

describe('RawRecorder', () => {
  it('stamps seconds since start (3 dp) and logs power on change only', () => {
    let now = 1_000_000;
    const rec = new RawRecorder(() => now);
    now += 696;
    rec.log('power', Uint8Array.of(1, 0, 0, 1));
    rec.log('power', Uint8Array.of(1, 0, 0, 1));
    now += 1000;
    rec.log('tx', Uint8Array.of(0x3c, 1));
    rec.log('power', Uint8Array.of(1, 0, 1, 1));
    expect(rec.text()).toBe(
      '{"t": 0.696, "ch": "power", "hex": "01000001"}\n' +
        '{"t": 1.696, "ch": "tx", "hex": "3c01"}\n' +
        '{"t": 1.696, "ch": "power", "hex": "01000101"}\n',
    );
    expect(rec.count).toBe(3);
    vi.restoreAllMocks();
  });

  it('rejects lines that are not {"t","ch","hex"}', () => {
    expect(() => parseRawJsonl('{"t": 1, "ch": "read"}')).toThrow(/line 1/);
  });
});
