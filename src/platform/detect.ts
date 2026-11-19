/**
 * Which OS / browser this is, whether Web Bluetooth is there, and whether updates are allowed here
 * (docs/SPEC.md "Update gate per platform"). classifyPlatform() is pure (tested); detectPlatform()
 * reads navigator, which only platform/ and ble/webBluetooth.ts may do.
 */

export type OsId = 'windows' | 'linux' | 'android' | 'macos' | 'chromeos' | 'ios' | 'other';
export type BrowserId = 'chrome' | 'edge' | 'chromium' | 'opera' | 'brave' | 'samsung' | 'firefox' | 'safari' | 'other';
export type PlatformId = `${OsId}-${BrowserId}`;

/** Updates are enabled only here. A platform is added only after it passes docs/HARDWARE_TEST.md on the test bike. */
export const VERIFIED_UPDATE_PLATFORMS: readonly PlatformId[] = Object.freeze(['windows-chrome', 'windows-edge']);

export interface PlatformInfo {
  id: PlatformId;
  os: OsId;
  browser: BrowserId;
  label: string;
  /** In VERIFIED_UPDATE_PLATFORMS. */
  updatesVerified: boolean;
  /** navigator.bluetooth exists. */
  bluetoothApi: boolean;
  /** https or localhost: Web Bluetooth needs it. */
  secureContext: boolean;
}

export interface UaInput {
  userAgent: string;
  /** navigator.userAgentData.brands, when the browser has it. */
  brands?: readonly { brand: string }[];
  /** navigator.userAgentData.platform, when the browser has it. */
  uaPlatform?: string;
  maxTouchPoints?: number;
}

const OS_LABEL: Record<OsId, string> = {
  windows: 'Windows', linux: 'Linux', android: 'Android', macos: 'macOS', chromeos: 'ChromeOS', ios: 'iOS / iPadOS', other: 'Unknown OS',
};
const BROWSER_LABEL: Record<BrowserId, string> = {
  chrome: 'Chrome', edge: 'Edge', chromium: 'Chromium', opera: 'Opera', brave: 'Brave', samsung: 'Samsung Internet',
  firefox: 'Firefox', safari: 'Safari', other: 'unknown browser',
};

export function classifyPlatform(u: UaInput): { os: OsId; browser: BrowserId } {
  const ua = u.userAgent;
  let os: OsId = 'other';
  const p = u.uaPlatform?.toLowerCase();
  if (/iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && (u.maxTouchPoints ?? 0) > 1)) os = 'ios';
  else if (p === 'windows' || /windows nt/i.test(ua)) os = 'windows';
  else if (p === 'android' || /android/i.test(ua)) os = 'android';
  else if (p === 'chrome os' || p === 'chromeos' || /\bcros\b/i.test(ua)) os = 'chromeos';
  else if (p === 'macos' || /mac os x|macintosh/i.test(ua)) os = 'macos';
  else if (p === 'linux' || /linux|x11/i.test(ua)) os = 'linux';

  let browser: BrowserId = 'other';
  const brands = (u.brands ?? []).map((b) => b.brand.toLowerCase());
  if (brands.some((b) => b.includes('edge'))) browser = 'edge';
  else if (brands.some((b) => b.includes('opera'))) browser = 'opera';
  else if (brands.some((b) => b.includes('brave'))) browser = 'brave';
  else if (brands.includes('google chrome')) browser = 'chrome';
  else if (/edg(e|a|ios)?\//i.test(ua)) browser = 'edge';
  else if (/opr\/|opera/i.test(ua)) browser = 'opera';
  else if (/samsungbrowser/i.test(ua)) browser = 'samsung';
  else if (/firefox|fxios/i.test(ua)) browser = 'firefox';
  else if (/crios|chrome\//i.test(ua)) browser = brands.includes('chromium') && !brands.includes('google chrome') ? 'chromium' : 'chrome';
  else if (brands.includes('chromium')) browser = 'chromium';
  else if (/safari/i.test(ua)) browser = 'safari';
  return { os, browser };
}

export function platformInfo(u: UaInput, bluetoothApi: boolean, secureContext: boolean): PlatformInfo {
  const { os, browser } = classifyPlatform(u);
  const id: PlatformId = `${os}-${browser}`;
  return {
    id, os, browser,
    label: `${BROWSER_LABEL[browser]} on ${OS_LABEL[os]}`,
    updatesVerified: VERIFIED_UPDATE_PLATFORMS.includes(id),
    bluetoothApi, secureContext,
  };
}

interface NavigatorUAData {
  brands?: { brand: string; version: string }[];
  platform?: string;
}

export function detectPlatform(): PlatformInfo {
  const nav = navigator as Navigator & { userAgentData?: NavigatorUAData; bluetooth?: unknown };
  return platformInfo(
    { userAgent: nav.userAgent, brands: nav.userAgentData?.brands, uaPlatform: nav.userAgentData?.platform, maxTouchPoints: nav.maxTouchPoints },
    typeof nav.bluetooth === 'object' && nav.bluetooth !== null,
    globalThis.isSecureContext === true,
  );
}

/** Why this browser can't connect, with the fix, or null if it can (docs/SPEC.md "Platforms"). */
export function connectBlocker(p: PlatformInfo): { title: string; steps: string[] } | null {
  if (!p.secureContext) {
    return { title: 'This page must be opened over HTTPS or from localhost', steps: ['Web Bluetooth only works in a secure context. Open the app from http://localhost or an https:// address.'] };
  }
  if (p.bluetoothApi) return null;
  if (p.os === 'linux' && ['chrome', 'chromium', 'edge', 'brave', 'opera'].includes(p.browser)) {
    return {
      title: 'Web Bluetooth is off by default on Linux',
      steps: [
        'Open chrome://flags/#enable-experimental-web-platform-features, set it to Enabled, and relaunch the browser.',
        'Make sure BlueZ is running (systemctl status bluetooth).',
        'Snap-packaged Chromium also needs: snap connect chromium:bluez',
      ],
    };
  }
  if (p.os === 'ios') {
    return { title: 'Safari has no Web Bluetooth', steps: ['iPhone and iPad support (the WebBLE Safari extension) comes in a later milestone.'] };
  }
  if (p.browser === 'firefox') {
    return {
      title: `${p.label} has no Web Bluetooth`,
      steps: [
        'Firefox doesn\'t support Web Bluetooth, and no setting turns it on.',
        p.os === 'linux'
          ? 'Open this page in Chrome or Chromium instead (the laptop launcher, start-shop-tool.sh, opens it there).'
          : 'Open this page in Chrome or Edge instead.',
      ],
    };
  }
  return { title: `${p.label} has no Web Bluetooth`, steps: ['Use Chrome or Edge on Windows (the verified platform), or Chrome on Linux / Android / macOS for reading.'] };
}
