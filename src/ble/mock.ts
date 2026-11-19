/**
 * Test / dev transports (docs/SPEC.md "ble/mock.ts"):
 * - MockTransport: one or more scriptable MockHmi bikes behind a fake chooser.
 * - ReplayTransport: plays a raw.jsonl capture back.
 */
import { SCAN_UUID } from '../protocol/gatt';
import type { BleDevice, DeviceRequest, GattTransport } from './transport';
import type { MockHmi } from './mock/hmi';

export { DEMO_BIKE, MockHmi } from './mock/hmi';
export type { MockEvent, MockHmiOptions, MockStatus, MockTiming, UpdateScript } from './mock/hmi';
export { ReplayDevice, ReplayTransport } from './mock/replay';
export type { ReplayOptions } from './mock/replay';
export { CAPTURED } from './mock/pages';
export type { MockConfig, MockLive } from './mock/pages';

/** What the user does in the chooser: pick one of the listed bikes, or cancel (null). */
export type ChooserScript = (listed: readonly MockHmi[]) => MockHmi | null;

export class ChooserCancelledError extends Error {
  constructor() {
    super('User cancelled the requestDevice() chooser.');
    this.name = 'NotFoundError';
  }
}

export class MockTransport implements GattTransport {
  readonly id = 'mock' as const;
  /** How many times the chooser was opened (the HMI DFU needs a second one). */
  requests = 0;

  constructor(
    readonly bikes: MockHmi[],
    public choose: ChooserScript = (listed) => listed[0] ?? null,
  ) {}

  async availability(): Promise<boolean> {
    return true;
  }

  /** Lists every advertising bike that matches the filter, like the browser chooser does. */
  listed(req: DeviceRequest): MockHmi[] {
    return this.bikes.filter(
      (b) =>
        b.advertising &&
        ((req.namePrefix !== undefined && b.name.startsWith(req.namePrefix)) ||
          (req.advertisedServices ?? []).some((s) => s === SCAN_UUID && b.advertisedServices.includes(s))),
    );
  }

  async requestDevice(req: DeviceRequest): Promise<BleDevice> {
    this.requests++;
    const pick = this.choose(this.listed(req));
    if (!pick) throw new ChooserCancelledError();
    return pick.device;
  }
}
