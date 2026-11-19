/**
 * The transport boundary. Protocol, analysis and update code only ever see these interfaces, never
 * navigator.bluetooth, so a native transport (iOS Safari extension polyfill, Capacitor) is a new file
 * implementing GattTransport, not a refactor. UUIDs are full lowercase 128-bit strings.
 */

export type WriteMode = 'with-response' | 'without-response';

export interface CharProperties {
  read: boolean;
  write: boolean;
  writeWithoutResponse: boolean;
  notify: boolean;
  indicate: boolean;
}

export interface GattCharacteristicInfo {
  uuid: string;
  properties: CharProperties;
}

export interface GattServiceInfo {
  uuid: string;
  characteristics: GattCharacteristicInfo[];
}

/** The bike chooser's filter (docs/SPEC.md "Picking a bike"). */
export interface DeviceRequest {
  /** Matches any of: name starting with namePrefix, or advertising one of advertisedServices. */
  namePrefix?: string;
  advertisedServices?: string[];
  /** Services the page may use after connecting (Web Bluetooth only grants access to these). */
  optionalServices: string[];
}

export type TransportId = 'web-bluetooth' | 'ios-extension' | 'capacitor' | 'mock' | 'replay';

export interface GattTransport {
  readonly id: TransportId;
  /** Adapter present and usable, if the platform can tell (null = can't tell). */
  availability(): Promise<boolean | null>;
  /**
   * Show the platform's device chooser. MUST be called synchronously from a user-gesture handler
   * (a click): browsers refuse otherwise. Rejects with a NotFoundError-like error if the user cancels.
   */
  requestDevice(req: DeviceRequest): Promise<BleDevice>;
}

export interface BleDevice {
  /** Opaque, per-site id (Web Bluetooth never exposes the MAC address). */
  readonly id: string;
  /** Advertised name, e.g. EH02_00001. */
  readonly name: string | null;
  /** Connect (or reconnect, without a chooser) and return the GATT link. */
  connect(): Promise<GattLink>;
  /** Every disconnection, whoever caused it (gattserverdisconnected). Returns an unsubscribe. */
  onDisconnected(listener: () => void): () => void;
}

export interface GattLink {
  readonly connected: boolean;
  /** The GATT table the page has access to (for the debug panel and the capability report). */
  services(): Promise<GattServiceInfo[]>;
  /** Properties of one characteristic, or null if it isn't there. */
  properties(service: string, characteristic: string): Promise<CharProperties | null>;
  read(service: string, characteristic: string): Promise<Uint8Array>;
  /** One write. Resolves when the stack reports it done; an issued write can't be recalled. */
  write(service: string, characteristic: string, value: Uint8Array, mode: WriteMode): Promise<void>;
  /** startNotifications + listener. Indications and notifications look the same from here. */
  subscribe(service: string, characteristic: string, onValue: (value: Uint8Array) => void): Promise<void>;
  unsubscribe(service: string, characteristic: string): Promise<void>;
  disconnect(): Promise<void>;
}

/** One capability, as the capability panel shows it. null = not checked yet / can't be checked. */
export interface Capability {
  ok: boolean | null;
  detail: string;
}

/**
 * Runtime feature detection (docs/SPEC.md "Tier 2"): what this browser + transport can actually do.
 * Static items are known before connecting; the rest are filled in on the first connection.
 */
export interface CapabilityReport {
  transport: TransportId | null;
  bluetoothApi: Capability;
  requestDevice: Capability;
  getPrimaryServices: Capability;
  characteristicProperties: Capability;
  notifications: Capability;
  writeWithResponse: Capability;
  writeWithoutResponse: Capability;
  disconnectEvent: Capability;
  secondRequestDevice: Capability;
}

/** Error shape every transport uses for "the link is gone". */
export class LinkLostError extends Error {
  constructor(message = 'The Bluetooth connection was lost') {
    super(message);
    this.name = 'LinkLostError';
  }
}
