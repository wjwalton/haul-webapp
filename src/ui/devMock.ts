/**
 * Developer tools: a simulated bike to click through the screens without hardware (npm run dev and the
 * shop-laptop build). Loaded with a dynamic import behind __DEV_TOOLS__, so the public build doesn't contain it.
 */
import { MockHmi, MockTransport } from '../ble/mock';

export type MockVariant = 'normal' | 'old-controller' | 'slow-link' | 'recovery' | 'locked' | 'old-hmi' | 'e031';

export const MOCK_VARIANTS: readonly { id: MockVariant; label: string }[] = [
  { id: 'normal', label: 'Normal bike (already 03.06.s0)' },
  { id: 'old-controller', label: 'Older controller (03.05.s0)' },
  { id: 'slow-link', label: 'Older controller, slow Windows link (44 blocks/s, ~4 min)' },
  { id: 'recovery', label: 'Controller not answering (recovery)' },
  { id: 'locked', label: 'PIN-locked bike' },
  { id: 'old-hmi', label: 'Older HMI (5.17)' },
  { id: 'e031', label: 'Failed update (e031)' },
];

export function createMock(variant: MockVariant): { transport: MockTransport; bike: MockHmi } {
  const bike = new MockHmi({
    // The real HMI repeats …0004 ~55x/s; 5x/s is enough for the locked-bike watchdog.
    timing: {
      statusIntervalMs: 200,
      // 2026-11-19 on Windows: writes "done" when queued, the display receives ~44 blocks/s.
      ...(variant === 'slow-link' ? { airMsPerPacket: 23, hostQueuesWrites: true, blockWriteMs: 3 } : {}),
    },
    controllerSilent: variant === 'recovery',
    status: variant === 'locked' ? { locked: true } : undefined,
    dis: variant === 'old-hmi' ? { sw_rev: '5.17' } : undefined,
    identity: variant === 'old-controller' || variant === 'slow-link' ? { ctrl_sw: '03.05.s0' } : undefined,
    live: variant === 'e031' ? { error_bits: 1 << 21 } : undefined,
  });
  return { transport: new MockTransport([bike]), bike };
}
