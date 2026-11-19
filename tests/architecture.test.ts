/**
 * Structural rules from docs/SPEC.md, enforced on the source tree:
 * - protocol/, analysis/, update/, export/ (and app/, the UI-free controller) are free of DOM and navigator;
 * - only ble/webBluetooth.ts and platform/ touch navigator.bluetooth;
 * - 46/47 frames are only built by frames.ts and update/ (and tests / the mock driver);
 * - nothing references reference/firmware or any firmware file except the two allowlisted images;
 * - the Android CLAUDE.md is never named CLAUDE.md in this repo.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from './helpers';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
  });
}
const SRC = join(ROOT, 'src');
const rel = (p: string) => relative(SRC, p).split(sep).join('/');
const sources = files(SRC).map((p) => ({ path: rel(p), text: stripComments(readFileSync(p, 'utf8')) }));

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

describe('architecture rules', () => {
  it('core folders use no DOM or navigator', () => {
    const core = sources.filter((s) => /^(protocol|analysis|update|export|app)\//.test(s.path));
    expect(core.length).toBeGreaterThan(5);
    for (const s of core) {
      expect(s.text, s.path).not.toMatch(/\b(window|document|navigator|localStorage|sessionStorage|indexedDB|fetch)\b/);
    }
  });

  it('only ble/webBluetooth.ts and platform/ touch navigator.bluetooth', () => {
    for (const s of sources) {
      if (s.path === 'ble/webBluetooth.ts' || s.path.startsWith('platform/')) continue;
      expect(s.text, s.path).not.toMatch(/navigator\s*\.\s*bluetooth|navigator\s*\[\s*['"]bluetooth/);
    }
  });

  it('only frames.ts and update/ build controller-update frames', () => {
    for (const s of sources) {
      if (s.path === 'protocol/frames.ts' || s.path.startsWith('update/')) continue;
      expect(s.text, s.path).not.toMatch(/\bfw(Start|Block)\s*\(/);
    }
  });

  it('the raw GattLink write is only used inside ble/', () => {
    for (const s of sources) {
      if (s.path.startsWith('ble/')) continue;
      expect(s.text, s.path).not.toMatch(/\bGattLink\b/);
    }
  });

  it('no firmware file other than the two allowlisted images is referenced', () => {
    for (const s of sources) {
      expect(s.text, s.path).not.toMatch(/reference\/firmware|M1B0260|BMS\.zip|Globe BMS Firmware|S_Link|S-Link|\.apk\b|F\.00\.00G1/i);
      for (const m of s.text.matchAll(/assets\/firmware\/([^'"?]+)/g)) {
        expect(['M1B0306s0.bin', 'EH02_Eagotech_5.19.zip'], s.path).toContain(m[1]);
      }
    }
  });

  it('the Android CLAUDE.md lives only as reference/ANDROID_CLAUDE.md', () => {
    const root = readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8');
    expect(root).toMatch(/Globe Haul Shop Tool/);
    expect(root).not.toMatch(/custom Android app/);
    // reference/ is local-only (git-ignored); when it's there, the Android file must not be named CLAUDE.md.
    if (existsSync(join(ROOT, 'reference'))) {
      expect(readdirSync(join(ROOT, 'reference'))).toContain('ANDROID_CLAUDE.md');
      expect(readdirSync(join(ROOT, 'reference'))).not.toContain('CLAUDE.md');
    }
  });
});
