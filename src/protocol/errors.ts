/**
 * Errors (PROTOCOL.md "Error sources"): the 32-bit bitmask (page 40 bytes 4-7, page 55 bytes 8-11)
 * through the SBC table is the ONLY real error source. The raw u16 codes on page 55 are sentinels
 * on this hardware and are never shown as errors.
 *
 * SBC_TABLE is globe_tables.py ERROR_TABLES['sbc'] verbatim (com.xplova.ebikeutility.connect.ErrorCode,
 * Globe app build 411), typos included. Only the sbc table is ported: this bike is sbc.
 */

export const SBC_TABLE: Readonly<Record<number, readonly [code: string, description: string]>> = {
  0: ['hmi_e032', 'HMI- Cmmunication Error'],
  1: ['bms_e032', 'Battery - Cmmunication Error'],
  2: ['bms_e000', 'Battery - Over Discharging Current'],
  3: ['bms_e001', 'Battery - Short Circuit'],
  4: ['bms_e002', 'Battery - Cell Over Voltage'],
  5: ['bms_e003', 'Battery - Cell Under Voltage'],
  6: ['bms_e004', 'Battery - Over Charging Current'],
  7: ['bms_e005', 'Battery - Cell Over Temperature'],
  8: ['bms_e006', 'Battery - Cell Under Temperature'],
  9: ['bms_e015', 'Battery - Charge/Discharge OT/UT'],
  10: ['controller_e003', 'Ctrl - Instantaneous Phase Over Current'],
  11: ['controller_e005', 'Ctrl - Motor Hall Sensor Abnormal'],
  12: ['controller_e006', 'Ctrl - Motor - Blocked Rotor'],
  13: ['controller_e007', 'Ctrl - TS Over Limit'],
  14: ['controller_e008', 'Ctrl - TS Under Limit'],
  15: ['controller_e009', 'Ctrl - Throttle Over'],
  16: ['controller_e010', 'Ctrl - Throttle Under'],
  17: ['controller_e011', 'Ctrl - FET Over Temperature'],
  18: ['controller_e012', 'Ctrl - Motor Over Temperature'],
  19: ['controller_e014', 'Ctrl - Regen Error'],
  20: ['controller_e021', 'Ctrl - Constant Voltage Error'],
  21: ['controller_e031', 'Ctrl - Update FW  Error'],
  22: ['controller_e027', 'Ctrl - Light Error'],
  23: ['controller_e022', 'Ctrl - EEPROM Error'],
};

export const CTYPE = 'sbc';

export interface DecodedError {
  bit: number;
  code: string;
  description: string;
}

/** decode_errors(bits, "sbc"): every set bit 0-31, with the Python's "unmapped" fallback. */
export function decodeErrors(bits: number): DecodedError[] {
  const v = bits >>> 0;
  const out: DecodedError[] = [];
  for (let i = 0; i < 32; i++) {
    if ((v >>> i) & 1) {
      const [code, description] = SBC_TABLE[i] ?? [`bit${i}`, 'unmapped in app table'];
      out.push({ bit: i, code, description });
    }
  }
  return out;
}

/** Bit of an SBC code, looked up in the table (never hard-coded). */
export function bitOf(code: string): number {
  for (const [bit, [c]] of Object.entries(SBC_TABLE)) if (c === code) return Number(bit);
  throw new Error(`No SBC code ${code}`);
}

/** "Update FW Error": the controller's bootloader reports it when it has no application. */
export const E031_CODE = 'controller_e031';
export const E031_BIT = bitOf(E031_CODE);

export function hasBit(bits: number | null | undefined, bit: number): boolean {
  return bits != null && ((bits >>> 0) >>> bit) % 2 === 1;
}

/** All bits the SBC table defines (0-23). */
export const DEFINED_ERROR_MASK = Object.keys(SBC_TABLE).reduce((m, b) => (m | (1 << Number(b))) >>> 0, 0);

/**
 * Page 55 raw u16 codes (controller @12, battery @14, motor @16): sentinels on this hardware
 * (0xFF00 / 0xFF0F / 0xBBFF / 0xFFFF = none). Returns the code only if it is nonzero, has no 0xFF
 * byte and isn't 0xBBFF, to be shown labelled "raw, undecoded". Null = no fault.
 */
export function rawErrorCode(v: number | null | undefined): number | null {
  if (v == null || v === 0 || v === 0xbbff) return null;
  if ((v & 0xff) === 0xff || ((v >>> 8) & 0xff) === 0xff) return null;
  return v;
}

/** Documented hints (PROTOCOL.md "First live error"), keyed by SBC code. */
export const ERROR_HINTS: Readonly<Record<string, string>> = {
  controller_e010:
    'Throttle Activation is on but the throttle signal is low or missing. Check the throttle connection, or turn Throttle Activation off.',
};
