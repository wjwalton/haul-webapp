/**
 * MockBms: the battery's BMS on the simulated bike's CAN bus (PROTOCOL.md "Battery (BMS) firmware
 * update over BLE", sections 1-2). MockHmi puts every `52` frame on this bus and mirrors the replies
 * back while bus access is on. Timings default to the 2026-11-20 measurements; anything PROTOCOL.md
 * doesn't say is a MOCK ASSUMPTION and a knob.
 *
 *   application   0x280 → 8 ASCII ("010009RC"), 0x281 → `01 00 <hw> 01 b0 48 00 00`
 *   0x045 "....EAGO"  → leaves the application (bootloader), 0x046 after ~4 ms (data[1] = 1: erase error)
 *   0x047         → one 0x048 (all zero) per block, < 2 ms (30-60 ms at some record ends)
 *   0x049         → 0x04A after 1.75 s: all zero = the image was received whole, else failure
 *   success       → the new application answers ~12.5 s later; ~13.5 s after 0x04A the whole bike
 *                   restarts (system power cut ~8 s): MockHmi.restartSystem()
 */
import { BMS_RECORD_LEN } from '../../analysis/bmsFirmware';

export interface MockBmsTiming {
  /** 0x280 / 0x281 replies. */
  replyMs: number;
  /** 0x048 after a block (same connection event as the echo when ≤ 2). */
  ackMs: number;
  /** 0x048 for a block that ends a 139-byte record. */
  recordEndAckMs: number;
  /** 0x045 → 0x046. */
  eraseMs: number;
  /** 0x049 → 0x04A. */
  resultMs: number;
  /** 0x04A → the new application answers. */
  appUpMs: number;
  /** 0x04A → the bike's system power is cut (the display reboots, the link drops). */
  restartMs: number;
  /** How long the bike is off. */
  offlineMs: number;
}

export interface MockBmsScript {
  /** 0-based blocks whose 0x048 is never sent (each once): the updater must restart from 0x045. */
  missAckAt: number[];
  /** 0x046 reports an erase error (each start, this many times). */
  eraseErrors: number;
  /** 0x04A reports failure this many times. */
  resultFailures: number;
  /** After success the bike does NOT restart (the link stays up). */
  noRestart: boolean;
  /** If set, the received stream must equal this image, or 0x04A reports failure. */
  expectImage: Uint8Array | null;
  /** The version (trailer form, "010012RC") the new application reports. */
  flashedVersion: string;
}

export interface MockBmsOptions {
  /** The application's 0x280 answer, e.g. "010009RC". '' = no application (stuck in its bootloader). */
  version?: string;
  /** 0x281 byte 2: 1 = SC, 2 = RC. Default from the version's line. */
  hwType?: number;
  timing?: Partial<MockBmsTiming>;
  script?: Partial<MockBmsScript>;
}

const DEFAULT_TIMING: MockBmsTiming = {
  replyMs: 2, ackMs: 1, recordEndAckMs: 40, eraseMs: 4, resultMs: 1_750, appUpMs: 12_500, restartMs: 13_500, offlineMs: 8_000,
};

export interface BmsBus {
  /** A frame the BMS (or another node) puts on the bus after [delayMs]. */
  reply(id: number, data: Uint8Array, delayMs: number): void;
  schedule(delayMs: number, fn: () => void): void;
  /** Cut system power for [offlineMs] (the display reboots, the link drops). */
  restartSystem(offlineMs: number): void;
  note(msg: string): void;
}

export class MockBms {
  /** The application is running (answers 0x280 / 0x281). False = in its bootloader. */
  app: boolean;
  version: string;
  hwType: number;
  timing: MockBmsTiming;
  script: MockBmsScript;
  /** The bootloader is receiving an image (after a 0x045). */
  receiving = false;
  receivedBytes = 0;
  mismatch = false;
  starts = 0;
  blocksAcked = 0;
  completed = 0;
  private readonly missed = new Set<number>();

  constructor(o: MockBmsOptions = {}) {
    this.version = o.version ?? '010012RC';
    this.app = this.version !== '';
    const line = this.version.slice(6);
    this.hwType = o.hwType ?? (line === 'SC' ? 1 : 2);
    this.timing = { ...DEFAULT_TIMING, ...o.timing };
    this.script = {
      missAckAt: [], eraseErrors: 0, resultFailures: 0, noRestart: false, expectImage: null, flashedVersion: '010012RC', ...o.script,
    };
  }

  /** The line from the version ("RC" / "SC"), or null without an application. */
  get line(): string | null {
    return this.version ? this.version.slice(6) : null;
  }

  /** A frame put on the bus by the display (from a `52`). */
  onFrame(id: number, data: Uint8Array, bus: BmsBus): void {
    const t = this.timing;
    switch (id) {
      case 0x280:
        if (this.app && this.version) bus.reply(0x280, new TextEncoder().encode(this.version.padEnd(8).slice(0, 8)), t.replyMs);
        return;
      case 0x281:
        if (this.app) bus.reply(0x281, Uint8Array.of(0x01, 0x00, this.hwType, 0x01, 0xb0, 0x48, 0x00, 0x00), t.replyMs);
        return;
      case 0x10f:
        // MOCK ASSUMPTION: something on the bus (the controller, PROTOCOL.md) answers "T0070014".
        bus.reply(0x10f, new TextEncoder().encode('T0070014'), t.replyMs);
        return;
      case 0x101:
        return;
      case 0x045: {
        // Start: the application stops (main output off); the bootloader erases and answers.
        this.starts++;
        this.app = false;
        this.receiving = true;
        this.receivedBytes = 0;
        this.mismatch = false;
        const err = this.script.eraseErrors > 0;
        if (err) this.script.eraseErrors--;
        bus.note(`BMS: start #${this.starts}${err ? ' (erase error scripted)' : ''}`);
        bus.reply(0x046, Uint8Array.of(0, err ? 1 : 0, 0, 0, 0, 0, 0, 0), t.eraseMs);
        if (err) this.receiving = false;
        return;
      }
      case 0x047: {
        if (!this.receiving) return;
        const index = this.receivedBytes / 8;
        const img = this.script.expectImage;
        if (img) {
          const want = img.subarray(this.receivedBytes, this.receivedBytes + 8);
          if (want.length !== 8 || want.some((x, i) => x !== data[i])) this.mismatch = true;
        }
        this.receivedBytes += 8;
        if (this.script.missAckAt.includes(index) && !this.missed.has(index)) {
          this.missed.add(index);
          bus.note(`BMS: block ${index} received, its 0x048 is lost (scripted)`);
          return;
        }
        this.blocksAcked++;
        const recordEnd = this.receivedBytes % BMS_RECORD_LEN < 8;
        bus.reply(0x048, new Uint8Array(8), recordEnd ? t.recordEndAckMs : t.ackMs);
        return;
      }
      case 0x049: {
        if (!this.receiving) return;
        this.receiving = false;
        const img = this.script.expectImage;
        const whole = img ? this.receivedBytes === img.length && !this.mismatch : this.receivedBytes > 0;
        const fail = !whole || this.script.resultFailures > 0;
        if (this.script.resultFailures > 0 && whole) this.script.resultFailures--;
        bus.reply(0x04a, fail ? Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 0) : new Uint8Array(8), t.resultMs);
        if (fail) {
          bus.note(`BMS: image rejected (${this.receivedBytes} bytes${this.mismatch ? ', mismatch' : ''})`);
          return;
        }
        this.completed++;
        const next = this.script.flashedVersion;
        bus.schedule(t.resultMs + t.appUpMs, () => {
          this.version = next;
          this.hwType = next.slice(6) === 'SC' ? 1 : 2;
          this.app = true;
          bus.note(`BMS: new application ${next} running`);
        });
        if (!this.script.noRestart) bus.schedule(t.resultMs + t.restartMs, () => bus.restartSystem(t.offlineMs));
        return;
      }
      default:
        return;
    }
  }
}

/** The display's page-24 form of a BMS version: each 2-digit group nibble-swapped ("010012RC" → "10.00.21.RC"). */
export function page24Form(version: string): string {
  if (!/^\d{6}[A-Z]{2}$/.test(version)) return '';
  const g = [version.slice(0, 2), version.slice(2, 4), version.slice(4, 6)].map((x) => x[1]! + x[0]!);
  return `${g.join('.')}.${version.slice(6)}`;
}
