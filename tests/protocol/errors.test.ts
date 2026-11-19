import { describe, expect, it } from 'vitest';
import {
  decodeErrors, DEFINED_ERROR_MASK, E031_BIT, E031_CODE, ERROR_HINTS, hasBit, rawErrorCode, SBC_TABLE,
} from '../../src/protocol/errors';
import { fixture } from '../helpers';

const { cases } = fixture<{ cases: { bits: number; decoded: [number, string, string][] }[] }>('py_errors.json');

describe('decode_errors parity (sbc)', () => {
  it.each(cases.map((c) => [`0x${c.bits.toString(16).padStart(8, '0')}`, c] as const))('%s', (_n, c) => {
    expect(decodeErrors(c.bits).map((e) => [e.bit, e.code, e.description])).toEqual(c.decoded);
  });
});

describe('error rules (PROTOCOL.md "Error sources")', () => {
  it('the sbc table is the full 24-entry table, verbatim', () => {
    expect(Object.keys(SBC_TABLE).length).toBe(24);
    expect(SBC_TABLE[16]).toEqual(['controller_e010', 'Ctrl - Throttle Under']);
    expect(SBC_TABLE[21]).toEqual(['controller_e031', 'Ctrl - Update FW  Error']);
    expect(DEFINED_ERROR_MASK).toBe(0x00ffffff);
  });

  it('controller_e031 is bit 21 (from the table)', () => {
    expect(E031_CODE).toBe('controller_e031');
    expect(E031_BIT).toBe(21);
    expect(hasBit(0x00200000, E031_BIT)).toBe(true);
    expect(hasBit(0x80000000, 31)).toBe(true);
    expect(hasBit(0x00010000, E031_BIT)).toBe(false);
    expect(hasBit(null, E031_BIT)).toBe(false);
  });

  it('C101 on the display is bit 16, controller_e010, with the documented hint', () => {
    expect(decodeErrors(0x00010000)).toEqual([{ bit: 16, code: 'controller_e010', description: 'Ctrl - Throttle Under' }]);
    expect(ERROR_HINTS.controller_e010).toMatch(/Throttle Activation is on/);
  });

  it('raw page-55 codes: sentinels are no fault; a real value is kept', () => {
    for (const s of [null, undefined, 0, 0xff00, 0xff0f, 0xbbff, 0xffff, 0x00ff, 0x12ff, 0xff12]) expect(rawErrorCode(s)).toBeNull();
    expect(rawErrorCode(0x0101)).toBe(0x0101);
    expect(rawErrorCode(0x1234)).toBe(0x1234);
  });
});
