import { describe, expect, it } from 'vitest';
import { classifyPlatform, connectBlocker, platformInfo, VERIFIED_BATTERY_UPDATE_PLATFORMS, VERIFIED_UPDATE_PLATFORMS } from '../../src/platform/detect';

const UA = {
  winChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  winEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
  linuxChrome: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  android: 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
  winFirefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0',
  winOpera: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 OPR/120.0.0.0',
  cros: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
};

describe('platform detection', () => {
  it('classifies the browsers the spec names', () => {
    expect(classifyPlatform({ userAgent: UA.winChrome })).toEqual({ os: 'windows', browser: 'chrome' });
    expect(classifyPlatform({ userAgent: UA.winEdge })).toEqual({ os: 'windows', browser: 'edge' });
    expect(classifyPlatform({ userAgent: UA.linuxChrome })).toEqual({ os: 'linux', browser: 'chrome' });
    expect(classifyPlatform({ userAgent: UA.android })).toEqual({ os: 'android', browser: 'chrome' });
    expect(classifyPlatform({ userAgent: UA.macSafari })).toEqual({ os: 'macos', browser: 'safari' });
    expect(classifyPlatform({ userAgent: UA.iphone })).toEqual({ os: 'ios', browser: 'safari' });
    expect(classifyPlatform({ userAgent: UA.macSafari, maxTouchPoints: 5 })).toEqual({ os: 'ios', browser: 'safari' }); // iPad
    expect(classifyPlatform({ userAgent: UA.winFirefox })).toEqual({ os: 'windows', browser: 'firefox' });
    expect(classifyPlatform({ userAgent: UA.winOpera })).toEqual({ os: 'windows', browser: 'opera' });
    expect(classifyPlatform({ userAgent: UA.cros })).toEqual({ os: 'chromeos', browser: 'chrome' });
  });

  it('prefers userAgentData brands when present (Edge, Brave and Chromium look like Chrome in the UA)', () => {
    const brands = (...b: string[]) => b.map((brand) => ({ brand }));
    expect(classifyPlatform({ userAgent: UA.winChrome, brands: brands('Chromium', 'Microsoft Edge', 'Not=A?Brand'), uaPlatform: 'Windows' }).browser).toBe('edge');
    expect(classifyPlatform({ userAgent: UA.winChrome, brands: brands('Chromium', 'Google Chrome', 'Not=A?Brand'), uaPlatform: 'Windows' }).browser).toBe('chrome');
    expect(classifyPlatform({ userAgent: UA.winChrome, brands: brands('Brave', 'Chromium'), uaPlatform: 'Windows' }).browser).toBe('brave');
    expect(classifyPlatform({ userAgent: UA.linuxChrome, brands: brands('Chromium', 'Not=A?Brand'), uaPlatform: 'Linux' }).browser).toBe('chromium');
  });

  it('updates are verified only on Windows Chrome and Edge', () => {
    expect(VERIFIED_UPDATE_PLATFORMS).toEqual(['windows-chrome', 'windows-edge']);
    expect(Object.isFrozen(VERIFIED_UPDATE_PLATFORMS)).toBe(true);
    expect(platformInfo({ userAgent: UA.winChrome }, true, true).updatesVerified).toBe(true);
    expect(platformInfo({ userAgent: UA.winEdge }, true, true).updatesVerified).toBe(true);
    for (const ua of [UA.linuxChrome, UA.android, UA.winOpera, UA.cros, UA.macSafari]) {
      expect(platformInfo({ userAgent: ua }, true, true).updatesVerified, ua).toBe(false);
    }
  });

  it('the battery update: also Linux Chrome and Chromium (docs/DECISIONS.md), nothing else', () => {
    expect(VERIFIED_BATTERY_UPDATE_PLATFORMS).toEqual(['windows-chrome', 'windows-edge', 'linux-chrome', 'linux-chromium']);
    expect(Object.isFrozen(VERIFIED_BATTERY_UPDATE_PLATFORMS)).toBe(true);
    const linuxChromium = { userAgent: UA.linuxChrome, brands: [{ brand: 'Chromium' }], uaPlatform: 'Linux' };
    for (const u of [{ userAgent: UA.winChrome }, { userAgent: UA.winEdge }, { userAgent: UA.linuxChrome }, linuxChromium]) {
      expect(platformInfo(u, true, true).batteryUpdatesVerified, u.userAgent).toBe(true);
    }
    const linuxEdge = { userAgent: UA.linuxChrome, brands: [{ brand: 'Microsoft Edge' }], uaPlatform: 'Linux' };
    const linuxBrave = { userAgent: UA.linuxChrome, brands: [{ brand: 'Brave' }], uaPlatform: 'Linux' };
    for (const u of [{ userAgent: UA.android }, { userAgent: UA.winOpera }, { userAgent: UA.cros }, { userAgent: UA.macSafari }, linuxEdge, linuxBrave]) {
      expect(platformInfo(u, true, true).batteryUpdatesVerified, JSON.stringify(u)).toBe(false);
    }
    // the controller update stays Windows-only
    expect(platformInfo({ userAgent: UA.linuxChrome }, true, true).updatesVerified).toBe(false);
  });

  it('Linux without navigator.bluetooth gets exactly the flag steps', () => {
    const b = connectBlocker(platformInfo({ userAgent: UA.linuxChrome }, false, true))!;
    expect(b.title).toMatch(/off by default on Linux/);
    expect(b.steps.join('\n')).toMatch(/chrome:\/\/flags\/#enable-experimental-web-platform-features/);
    expect(b.steps.join('\n')).toMatch(/BlueZ/);
    expect(b.steps.join('\n')).toMatch(/snap connect chromium:bluez/);
    expect(connectBlocker(platformInfo({ userAgent: UA.winChrome }, true, true))).toBeNull();
    expect(connectBlocker(platformInfo({ userAgent: UA.winChrome }, true, false))!.title).toMatch(/HTTPS or from localhost/);
    expect(connectBlocker(platformInfo({ userAgent: UA.winFirefox }, false, true))!.title).toMatch(/Firefox on Windows has no Web Bluetooth/);
  });

  it('Firefox: no Web Bluetooth and nothing turns it on; points to Chrome / Chromium (Linux) or Chrome / Edge', () => {
    const linuxFirefox = 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0';
    const l = connectBlocker(platformInfo({ userAgent: linuxFirefox }, false, true))!;
    expect(l.title).toMatch(/Firefox on Linux has no Web Bluetooth/);
    expect(l.steps.join('\n')).toMatch(/no setting turns it on/);
    expect(l.steps.join('\n')).toMatch(/Chrome or Chromium/);
    expect(connectBlocker(platformInfo({ userAgent: UA.winFirefox }, false, true))!.steps.join('\n')).toMatch(/Chrome or Edge/);
  });
});
