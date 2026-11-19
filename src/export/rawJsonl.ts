/**
 * raw.jsonl, exactly as globe_capture.py writes it (Session.log_raw):
 *   json.dumps({"t": <seconds since session start, 3 dp>, "ch": <channel>, "hex": <lowercase hex>})
 * one object per line, so `python3 globe_capture.py replay raw.jsonl` works on our files.
 * Channels: read (…0001), power (…0004, changes only), ack (…0010 indications), tx (frames we wrote).
 */
import { fromHex, hex } from '../protocol/bytes';

export type RawChannel = 'read' | 'power' | 'ack' | 'tx';

export interface RawRecord {
  t: number;
  ch: string;
  hex: string;
}

/** Python float repr after round(x, 3): integral values keep ".0" (2.0, not 2). */
export function pyFloat(x: number): string {
  if (!Number.isFinite(x)) throw new Error(`Not a finite time: ${x}`);
  return Number.isInteger(x) ? x.toFixed(1) : String(x);
}

/** Python round(x, 3) for the non-negative times we write. */
export function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/** One line, byte-identical to json.dumps' default separators. */
export function formatRawLine(r: RawRecord): string {
  return `{"t": ${pyFloat(r.t)}, "ch": ${JSON.stringify(r.ch)}, "hex": ${JSON.stringify(r.hex)}}`;
}

/** Parse a raw.jsonl text (ours or the Python client's). Blank lines are skipped; bad lines throw. */
export function parseRawJsonl(text: string): RawRecord[] {
  const out: RawRecord[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    const r = JSON.parse(line) as Partial<RawRecord>;
    if (typeof r.t !== 'number' || typeof r.ch !== 'string' || typeof r.hex !== 'string') {
      throw new Error(`raw.jsonl line ${i + 1} is not {"t","ch","hex"}`);
    }
    out.push({ t: r.t, ch: r.ch, hex: r.hex });
  });
  return out;
}

export function recordBytes(r: RawRecord): Uint8Array {
  return fromHex(r.hex);
}

/**
 * Collects a session's raw.jsonl in memory (stateless app: it only leaves as a download). Power
 * frames are logged on change only, like Session.on_power.
 */
export class RawRecorder {
  private readonly lines: string[] = [];
  private lastPower: string | null = null;

  constructor(private readonly now: () => number = () => Date.now(), private readonly t0 = now()) {}

  log(ch: RawChannel, data: Uint8Array): void {
    const h = hex(data);
    if (ch === 'power') {
      if (h === this.lastPower) return;
      this.lastPower = h;
    }
    this.lines.push(formatRawLine({ t: round3((this.now() - this.t0) / 1000), ch, hex: h }));
  }

  get count(): number {
    return this.lines.length;
  }

  text(): string {
    return this.lines.length ? this.lines.join('\n') + '\n' : '';
  }
}
