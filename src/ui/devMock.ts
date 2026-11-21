/**
 * Developer tools: a simulated bike to click through the screens without hardware (npm run dev and the
 * shop-laptop build). Loaded with a dynamic import behind __DEV_TOOLS__, so the public build doesn't contain it.
 */
import { MockHmi, MockTransport } from '../ble/mock';

export type MockVariant =
  | 'normal' | 'old-controller' | 'slow-link' | 'recovery' | 'locked' | 'old-hmi' | 'e031'
  | 'old-battery' | 'sc-battery' | 'bms-e032';

export const MOCK_VARIANTS: readonly { id: MockVariant; label: string }[] = [
  { id: 'normal', label: 'Normal bike (already 03.06.s0)' },
  { id: 'old-controller', label: 'Older controller (03.05.s0)' },
  { id: 'slow-link', label: 'Older controller, slow Windows link (44 blocks/s, ~4 min)' },
  { id: 'recovery', label: 'Controller not answering (recovery)' },
  { id: 'locked', label: 'PIN-locked bike' },
  { id: 'old-hmi', label: 'Older HMI (5.17)' },
  { id: 'e031', label: 'Failed update (e031)' },
  { id: 'old-battery', label: 'Older RC battery (01.00.09 RC), auto-off 600 s' },
  { id: 'sc-battery', label: 'Older SC battery (01.00.05 SC)' },
  { id: 'bms-e032', label: 'Battery stuck in its bootloader (bms_e032)' },
];

/** The battery as the HMI reports it (page 24, nibble-swapped), per variant. '' = page 24 blank (no answer). */
const BATT_SW: Partial<Record<MockVariant, string>> = { 'old-battery': '10.00.90.RC', 'sc-battery': '10.00.50.SC', 'bms-e032': '' };
/** sbc bit 21 = controller_e031. (bms_e032, bit 1, follows from the simulated BMS having no application.) */
const ERROR_BITS: Partial<Record<MockVariant, number>> = { e031: 1 << 21 };
/** The battery variants: a fast link, so the 13,000+ acknowledged blocks take minutes, not half an hour. */
const BATTERY: ReadonlySet<MockVariant> = new Set(['old-battery', 'sc-battery', 'bms-e032']);

export function createMock(variant: MockVariant): { transport: MockTransport; bike: MockHmi } {
  const bike = new MockHmi({
    // The real HMI repeats …0004 ~55x/s; 5x/s is enough for the locked-bike watchdog.
    timing: {
      statusIntervalMs: 200,
      // 2026-11-19 on Windows: writes "done" when queued, the display receives ~44 blocks/s.
      ...(variant === 'slow-link' ? { airMsPerPacket: 23, hostQueuesWrites: true, blockWriteMs: 3 } : {}),
      ...(BATTERY.has(variant) ? { ackMs: 2, writeMs: 1 } : {}),
    },
    controllerSilent: variant === 'recovery',
    status: variant === 'locked' ? { locked: true } : undefined,
    dis: variant === 'old-hmi' ? { sw_rev: '5.17' } : undefined,
    identity: {
      ...(variant === 'old-controller' || variant === 'slow-link' ? { ctrl_sw: '03.05.s0' } : {}),
      ...(BATT_SW[variant] !== undefined ? { batt_sw: BATT_SW[variant] } : {}),
    },
    // The SC pack is updated to the SC line's image.
    bms: variant === 'sc-battery' ? { script: { flashedVersion: '010008SC' } } : undefined,
    config: variant === 'old-battery' ? { shutdown_timer_s: 600 } : undefined,
    live: ERROR_BITS[variant] !== undefined ? { error_bits: ERROR_BITS[variant] } : undefined,
  });
  return { transport: new MockTransport([bike]), bike };
}
