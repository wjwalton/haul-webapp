/** Display formatting. The bike's own unit setting (…0004 byte 3) is the default; a toggle overrides it, unsaved. */
import type { FieldValue } from '../protocol/pages';

export type Units = 'metric' | 'imperial';
export const KM_PER_MI = 1.609344;

export function num(v: FieldValue | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Metres → "814 km" / "506 mi". Page-7 odometer and trip come in metres (1 km steps). */
export function distance(m: number | null, u: Units, digits = 0): string {
  if (m === null) return '—';
  const km = m / 1000;
  const v = u === 'imperial' ? km / KM_PER_MI : km;
  return `${v.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${u === 'imperial' ? 'mi' : 'km'}`;
}

export function otherDistance(m: number | null, u: Units): string {
  return distance(m, u === 'imperial' ? 'metric' : 'imperial');
}

export function speed(kmh: number | null, u: Units): string {
  if (kmh === null) return '—';
  return u === 'imperial' ? `${(kmh / KM_PER_MI).toFixed(1)} mph` : `${kmh.toFixed(1)} km/h`;
}

/** Page-7 range estimate, whole kilometres. */
export function rangeKm(km: number | null, u: Units): string {
  if (km === null) return '—';
  return u === 'imperial' ? `${Math.round(km / KM_PER_MI)} mi` : `${km} km`;
}

export function volts(mv: number | null): string {
  return mv === null ? '—' : `${(mv / 1000).toFixed(2)} V`;
}

export function amps(ma: number | null): string {
  return ma === null ? '—' : `${(ma / 1000).toFixed(2)} A`;
}

export function pct(v: number | null): string {
  return v === null ? '—' : `${v} %`;
}

export function hex32(v: number | null): string {
  return v === null ? '—' : `0x${(v >>> 0).toString(16).padStart(8, '0')}`;
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return m ? `${m} min ${s % 60} s` : `${s} s`;
}

/** File-name-safe local timestamp: 2026-11-18_1742. */
export function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}
