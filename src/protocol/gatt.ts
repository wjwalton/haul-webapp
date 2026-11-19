/**
 * GATT layout (globe_capture.py "GATT layout", BLEUUID.java) plus the standard services the
 * shop tool reads. All UUIDs are full lowercase 128-bit strings.
 */

/** ASCII tail "E-BikeXplova". GATT-only: NOT in the advert, so never a scan filter (PROTOCOL.md). */
export const SVC_EBIKE = '00010000-452d-4269-6b65-58706c6f7661';
/** notify: data pages (1..n 20-byte pages per notification in MTU page mode), page 0x3C, log dumps. */
export const CH_READ = '00010001-452d-4269-6b65-58706c6f7661';
/** write with response + indicate: commands; acks come back as [0x10, opcode, status]. */
export const CH_WRITE = '00010010-452d-4269-6b65-58706c6f7661';
/** The stock app's "continue bypass mode" characteristic: controller firmware blocks (0x47) only. */
export const CH_BYPASS = '00010011-452d-4269-6b65-58706c6f7661';
/** notify: [awake, locked, charging, units], repeated ~55x/s. */
export const CH_POWER = '00010004-452d-4269-6b65-58706c6f7661';

/** The short service UUID the HMI advertises (SCAN_UUID in globe_capture.py). */
export const SCAN_UUID = '00005800-0000-1000-8000-41564f4c5058';
/** Advertised name is EH02_<digits>. */
export const NAME_PREFIX = 'EH02_';

export const SVC_DIS = '0000180a-0000-1000-8000-00805f9b34fb';
export const SVC_BATTERY = '0000180f-0000-1000-8000-00805f9b34fb';
export const CH_BATTERY_LEVEL = '00002a19-0000-1000-8000-00805f9b34fb';
/** Nordic Secure DFU service (buttonless entry). Whether this HMI exposes it is checked, never assumed. */
export const SVC_SECURE_DFU = '0000fe59-0000-1000-8000-00805f9b34fb';

/**
 * DIS characteristics the app reads (globe_capture.py DIS). The Serial Number String 0x2A25 is
 * deliberately absent: it is on Chrome's GATT blocklist (docs/SPEC.md), so it is never read.
 */
export const DIS_CHARS = {
  manufacturer: '00002a29-0000-1000-8000-00805f9b34fb',
  model: '00002a24-0000-1000-8000-00805f9b34fb',
  hw_rev: '00002a27-0000-1000-8000-00805f9b34fb',
  fw_rev: '00002a26-0000-1000-8000-00805f9b34fb',
  sw_rev: '00002a28-0000-1000-8000-00805f9b34fb',
} as const;
export type DisField = keyof typeof DIS_CHARS;

/** Chrome blocklists this one (reading it throws SecurityError). Listed so a test can assert it's never read. */
export const DIS_SERIAL_BLOCKLISTED = '00002a25-0000-1000-8000-00805f9b34fb';

/** Services the bike chooser asks permission for (docs/SPEC.md "Picking a bike"). */
export const OPTIONAL_SERVICES = [SVC_EBIKE, SVC_DIS, SVC_BATTERY, SVC_SECURE_DFU] as const;

/** Expand a 16-bit SIG UUID ("2a19" / 0x2a19) to the full lowercase 128-bit form. */
export function uuid16(short: number): string {
  return `0000${short.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`;
}

export function normalizeUuid(u: string | number): string {
  return typeof u === 'number' ? uuid16(u) : u.toLowerCase();
}
