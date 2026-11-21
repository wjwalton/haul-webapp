/** Download names: the bike's advertised name comes over the air, so only safe characters reach the file system. */
import { describe, expect, it } from 'vitest';
import { safeFileName } from '../../src/ui/download';

describe('safeFileName', () => {
  it('keeps ordinary names', () => {
    expect(safeFileName('battery_update_EH02_00001_2026-11-21_0930.txt')).toBe('battery_update_EH02_00001_2026-11-21_0930.txt');
    expect(safeFileName('raw_EH02_00001_x.jsonl')).toBe('raw_EH02_00001_x.jsonl');
  });

  it('removes path separators, control characters, quotes and leading dots', () => {
    expect(safeFileName('update_EH02_../../evil_x.txt')).toBe('update_EH02_.._.._evil_x.txt');
    expect(safeFileName(String.raw`update_EH02_a\b:c"d<e>|f?*.txt`)).toBe('update_EH02_a_b_c_d_e_f_.txt');
    // NUL, a right-to-left override (U+202E, disguises extensions) and a newline: one run of unsafe characters
    expect(safeFileName('update_EH02_\u0000\u202e\nx.txt')).toBe('update_EH02__x.txt');
    expect(safeFileName('...hidden')).toBe('hidden');
    expect(safeFileName('')).toBe('download.txt');
    expect(safeFileName('a'.repeat(300) + '.txt').length).toBe(120);
  });
});
