/**
 * The update session log (docs/SPEC.md "Downloads": every frame, per-block timing, every page 0x3C),
 * a port of the Android FirmwareTrace. Lines are "ms since start | event | data". …0004 repeats ~55x/s,
 * so identical consecutive status notifications are folded into a count; nothing else is folded.
 * Offered as update_<name>_<time>.txt after any attempt, success or not.
 */
import { hex } from '../protocol/bytes';
import { CH_BYPASS, CH_POWER, CH_READ, CH_WRITE } from '../protocol/gatt';

/** 10,240 blocks + resends + notifications fit easily; a runaway loop can't eat the memory. */
export const TRACE_MAX_LINES = 200_000;

const SHORT: Record<string, string> = { [CH_READ]: '0001', [CH_POWER]: '0004', [CH_WRITE]: '0010', [CH_BYPASS]: '0011' };

export interface BlockTiming {
  count: number;
  minMs: number;
  maxMs: number;
  avgMs: number;
}

export class UpdateTrace {
  private readonly t0: number;
  private readonly lines: string[] = [];
  private readonly summary: string[] = [];
  private lastPowerHex: string | null = null;
  private powerRepeats = 0;
  private truncated = 0;

  constructor(
    readonly title: string,
    private readonly now: () => number = () => Date.now(),
    private readonly startedAt: Date = new Date(),
  ) {
    this.t0 = now();
  }

  add(kind: string, text: string): void {
    this.flushPower();
    this.put(kind, text);
  }

  state(text: string): void {
    this.add('STATE', text);
  }

  timeout(text: string): void {
    this.add('TIMEOUT', text);
  }

  /** A frame from BikeLink's tap. Power repeats are counted, not listed. */
  frame(dir: 'tx' | 'rx', char: string, bytes: Uint8Array, note?: string): void {
    const c = SHORT[char] ?? char;
    const h = hex(bytes);
    if (dir === 'rx' && char === CH_POWER) {
      if (h === this.lastPowerHex) {
        this.powerRepeats++;
        return;
      }
      this.flushPower();
      this.lastPowerHex = h;
      this.put('RX 0004', h);
      return;
    }
    this.add(`${dir.toUpperCase()} ${c}`, note ? `${h}  (${note})` : h);
  }

  /** A line for the summary block written at the end of the file. */
  addSummary(line: string): void {
    this.summary.push(line);
  }

  get lineCount(): number {
    return this.lines.length;
  }

  text(): string {
    const out = [
      this.title,
      `Started: ${this.startedAt.toISOString()} (local ${this.startedAt.toString()})`,
      'Columns: ms since start | event | data. Characteristics: 0001 data / page 0x3C, 0004 status, 0010 commands + acks, 0011 firmware blocks.',
    ];
    if (this.truncated) out.push(`NOTE: ${this.truncated} lines dropped after the ${TRACE_MAX_LINES}-line cap.`);
    if (this.summary.length) out.push('', 'Summary:', ...this.summary.map((s) => `  ${s}`));
    out.push('', ...this.lines);
    if (this.powerRepeats) out.push(`${pad(this.now() - this.t0)} RX 0004  (previous status repeated ${this.powerRepeats} times)`);
    return out.join('\n') + '\n';
  }

  private flushPower(): void {
    if (!this.powerRepeats) return;
    this.put('RX 0004', `(previous status repeated ${this.powerRepeats} times)`);
    this.powerRepeats = 0;
  }

  private put(kind: string, text: string): void {
    if (this.lines.length >= TRACE_MAX_LINES) {
      this.truncated++;
      return;
    }
    this.lines.push(`${pad(this.now() - this.t0)} ${kind.padEnd(8)} ${text}`);
  }
}

function pad(ms: number): string {
  return String(Math.round(ms)).padStart(8);
}
