/**
 * WebBluetoothTransport: GattTransport on navigator.bluetooth (Windows / Linux / Android / macOS Chrome
 * and Edge; also Bluefy / WebBLE browsers). The only file outside platform/ that touches
 * navigator.bluetooth. docs/SPEC.md "Web Bluetooth specifics":
 *
 * - requestDevice: name prefix EH02_ OR the advertised SCAN_UUID; the 128-bit Globe service is GATT-only
 *   and never a scan filter, so it goes in optionalServices with DIS, Battery and 0xFE59.
 * - Reconnect = device.gatt.connect() again on the same BluetoothDevice (no chooser).
 * - Writes use writeValueWithResponse / writeValueWithoutResponse explicitly; the caller picks by the
 *   characteristic's runtime properties.
 * - Notification values are copied out of the DataView at once.
 * - Every call here is issued one at a time by the caller's GattQueue (Chrome rejects overlapping GATT ops).
 */
import { normalizeUuid } from '../protocol/gatt';
import {
  LinkLostError, type BleDevice, type CharProperties, type DeviceRequest, type GattLink, type GattServiceInfo,
  type GattTransport, type WriteMode,
} from './transport';

// ---- the slice of the Web Bluetooth API this file uses (no @types dependency) -----------------

interface WbCharacteristicProperties {
  read: boolean;
  write: boolean;
  writeWithoutResponse: boolean;
  notify: boolean;
  indicate: boolean;
}
interface WbCharacteristic extends EventTarget {
  readonly uuid: string;
  readonly properties: WbCharacteristicProperties;
  readonly value?: DataView;
  readValue(): Promise<DataView>;
  writeValueWithResponse?(value: BufferSource): Promise<void>;
  writeValueWithoutResponse?(value: BufferSource): Promise<void>;
  startNotifications(): Promise<WbCharacteristic>;
  stopNotifications(): Promise<WbCharacteristic>;
}
interface WbService {
  readonly uuid: string;
  getCharacteristic(uuid: string): Promise<WbCharacteristic>;
  getCharacteristics(): Promise<WbCharacteristic[]>;
}
interface WbServer {
  readonly connected: boolean;
  connect(): Promise<WbServer>;
  disconnect(): void;
  getPrimaryService(uuid: string): Promise<WbService>;
  getPrimaryServices(): Promise<WbService[]>;
}
interface WbDevice extends EventTarget {
  readonly id: string;
  readonly name?: string;
  readonly gatt?: WbServer;
}
interface WbFilter {
  namePrefix?: string;
  services?: string[];
}
interface WbBluetooth {
  getAvailability?(): Promise<boolean>;
  requestDevice(o: { filters: WbFilter[]; optionalServices: string[] }): Promise<WbDevice>;
}

function bluetooth(): WbBluetooth | null {
  const b = (navigator as Navigator & { bluetooth?: WbBluetooth }).bluetooth;
  return b ?? null;
}

/** gatt.connect() can hang on Windows; Chrome's own timeout is long. */
export const CONNECT_TIMEOUT_MS = 20_000;

export class WebBluetoothTransport implements GattTransport {
  readonly id = 'web-bluetooth' as const;

  static available(): boolean {
    return bluetooth() !== null;
  }

  async availability(): Promise<boolean | null> {
    const b = bluetooth();
    if (!b) return false;
    try {
      return b.getAvailability ? await b.getAvailability() : null;
    } catch {
      return null;
    }
  }

  /** Must be called straight from a click handler (no await before it). */
  requestDevice(req: DeviceRequest): Promise<BleDevice> {
    const b = bluetooth();
    if (!b) return Promise.reject(new Error('Web Bluetooth is not available in this browser'));
    const filters: WbFilter[] = [];
    if (req.namePrefix) filters.push({ namePrefix: req.namePrefix });
    for (const s of req.advertisedServices ?? []) filters.push({ services: [s] });
    return b.requestDevice({ filters, optionalServices: [...req.optionalServices] }).then((d) => new WebBleDevice(d));
  }
}

class WebBleDevice implements BleDevice {
  readonly id: string;
  readonly name: string | null;

  constructor(private readonly dev: WbDevice) {
    this.id = dev.id;
    this.name = dev.name ?? null;
  }

  async connect(): Promise<GattLink> {
    const gatt = this.dev.gatt;
    if (!gatt) throw new Error('This device has no GATT server');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        gatt.connect(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            gatt.disconnect(); // cancels the pending connect
            reject(new Error(`No connection within ${CONNECT_TIMEOUT_MS / 1000} s`));
          }, CONNECT_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    return new WebGattLink(this.dev, gatt);
  }

  onDisconnected(listener: () => void): () => void {
    const h = () => listener();
    this.dev.addEventListener('gattserverdisconnected', h);
    return () => this.dev.removeEventListener('gattserverdisconnected', h);
  }
}

const NO_PROPS: CharProperties = { read: false, write: false, writeWithoutResponse: false, notify: false, indicate: false };

class WebGattLink implements GattLink {
  /** Cache per connection (a reconnect makes a new link, so stale handles are never reused). */
  private readonly svc = new Map<string, Promise<WbService>>();
  private readonly chr = new Map<string, Promise<WbCharacteristic>>();
  private readonly handlers = new Map<string, EventListener>();

  constructor(private readonly dev: WbDevice, private readonly gatt: WbServer) {}

  get connected(): boolean {
    return this.gatt.connected;
  }

  private service(uuid: string): Promise<WbService> {
    let p = this.svc.get(uuid);
    if (!p) {
      p = this.gatt.getPrimaryService(uuid);
      p.catch(() => this.svc.delete(uuid));
      this.svc.set(uuid, p);
    }
    return p;
  }

  private char(service: string, characteristic: string): Promise<WbCharacteristic> {
    const key = `${service}/${characteristic}`;
    let p = this.chr.get(key);
    if (!p) {
      p = this.service(service).then((s) => s.getCharacteristic(characteristic));
      p.catch(() => this.chr.delete(key));
      this.chr.set(key, p);
    }
    return p;
  }

  /** Map "GATT Server is disconnected" & co. to LinkLostError once the link is really down. */
  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (!this.gatt.connected) throw new LinkLostError();
      throw e;
    }
  }

  services(): Promise<GattServiceInfo[]> {
    return this.guard(async () => {
      const out: GattServiceInfo[] = [];
      for (const s of await this.gatt.getPrimaryServices()) {
        let chars: WbCharacteristic[] = [];
        try {
          chars = await s.getCharacteristics();
        } catch {
          // a service whose characteristics are all blocklisted
        }
        out.push({
          uuid: normalizeUuid(s.uuid),
          characteristics: chars.map((c) => ({ uuid: normalizeUuid(c.uuid), properties: copyProps(c.properties) })),
        });
      }
      return out;
    });
  }

  properties(service: string, characteristic: string): Promise<CharProperties | null> {
    return this.guard(async () => {
      try {
        return copyProps((await this.char(service, characteristic)).properties);
      } catch (e) {
        if (!this.gatt.connected) throw e;
        return null;
      }
    });
  }

  read(service: string, characteristic: string): Promise<Uint8Array> {
    return this.guard(async () => copyView(await (await this.char(service, characteristic)).readValue()));
  }

  write(service: string, characteristic: string, value: Uint8Array, mode: WriteMode): Promise<void> {
    return this.guard(async () => {
      const c = await this.char(service, characteristic);
      const buf = value.slice().buffer;
      if (mode === 'with-response') {
        if (!c.writeValueWithResponse) throw new Error('NotSupportedError: writeValueWithResponse is missing in this browser');
        await c.writeValueWithResponse(buf);
      } else {
        if (!c.writeValueWithoutResponse) throw new Error('NotSupportedError: writeValueWithoutResponse is missing in this browser');
        await c.writeValueWithoutResponse(buf);
      }
    });
  }

  subscribe(service: string, characteristic: string, onValue: (value: Uint8Array) => void): Promise<void> {
    return this.guard(async () => {
      const c = await this.char(service, characteristic);
      const key = `${service}/${characteristic}`;
      const old = this.handlers.get(key);
      if (old) c.removeEventListener('characteristicvaluechanged', old);
      const h: EventListener = (ev) => {
        const v = (ev.target as WbCharacteristic).value;
        if (v) onValue(copyView(v));
      };
      // Listener first, so nothing that arrives right after the CCCD write is lost.
      c.addEventListener('characteristicvaluechanged', h);
      this.handlers.set(key, h);
      await c.startNotifications();
    });
  }

  unsubscribe(service: string, characteristic: string): Promise<void> {
    return this.guard(async () => {
      const key = `${service}/${characteristic}`;
      const c = await this.char(service, characteristic);
      const h = this.handlers.get(key);
      if (h) c.removeEventListener('characteristicvaluechanged', h);
      this.handlers.delete(key);
      if (this.gatt.connected) await c.stopNotifications();
    });
  }

  async disconnect(): Promise<void> {
    if (this.dev.gatt?.connected) this.dev.gatt.disconnect();
  }
}

function copyView(v: DataView): Uint8Array {
  return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
}

function copyProps(p: WbCharacteristicProperties | undefined): CharProperties {
  if (!p) return { ...NO_PROPS };
  return { read: !!p.read, write: !!p.write, writeWithoutResponse: !!p.writeWithoutResponse, notify: !!p.notify, indicate: !!p.indicate };
}
