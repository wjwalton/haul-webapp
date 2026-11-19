/**
 * Little-endian byte readers with the Python's semantics (globe_capture.py u8/u16/s16/u32):
 * a field that runs past the end of the buffer reads as null, never throws.
 */

export function u8(b: Uint8Array, o: number): number | null {
  return o >= 0 && o < b.length ? b[o]! : null;
}

export function u16(b: Uint8Array, o: number): number | null {
  return o >= 0 && o + 2 <= b.length ? b[o]! | (b[o + 1]! << 8) : null;
}

export function s16(b: Uint8Array, o: number): number | null {
  const v = u16(b, o);
  return v === null ? null : v > 32767 ? v - 65536 : v;
}

export function u32(b: Uint8Array, o: number): number | null {
  return o >= 0 && o + 4 <= b.length
    ? (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0
    : null;
}

/** Lowercase hex, no separators (the raw.jsonl `hex` field, Python `bytes.hex()`). */
export function hex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

/** "46 00 00 28 31 42 73": for logs and the update session trace. */
export function hexSpaced(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

/** Parse hex; spaces are ignored. Throws on anything that isn't whole bytes of hex. */
export function fromHex(s: string): Uint8Array {
  const clean = s.replace(/\s+/g, '');
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) throw new Error(`Not hex: "${s}"`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Number of set bits in a 32-bit value. */
export function popcount32(v: number): number {
  let x = v >>> 0;
  let n = 0;
  while (x) {
    x &= x - 1;
    n++;
  }
  return n;
}
