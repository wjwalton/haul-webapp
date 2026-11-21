/**
 * Keep the screen on during an update (docs/SPEC.md "Tier 1"). A Screen Wake Lock is released by the
 * browser when the tab is hidden, so it is re-requested when the tab comes back. It does NOT stop a
 * lid-close sleep: the screen says "keep the laptop plugged in, lid open".
 */
interface WakeLockSentinelLike {
  release(): Promise<void>;
  addEventListener?(type: 'release', listener: () => void): void;
}

export function holdScreenAwake(): () => void {
  const nav = navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> } };
  if (!nav.wakeLock) return () => undefined;
  let sentinel: WakeLockSentinelLike | null = null;
  let active = true;
  const acquire = () => {
    if (!active || sentinel !== null || document.visibilityState !== 'visible') return;
    nav.wakeLock!.request('screen').then(
      (s) => {
        if (!active) {
          void s.release();
          return;
        }
        sentinel = s;
        // Released by the system (not by us): take it again while the tab is visible.
        s.addEventListener?.('release', () => {
          if (sentinel === s) sentinel = null;
          if (active) setTimeout(acquire, 1_000);
        });
      },
      () => undefined,
    );
  };
  const onVisible = () => acquire();
  document.addEventListener('visibilitychange', onVisible);
  acquire();
  return () => {
    active = false;
    document.removeEventListener('visibilitychange', onVisible);
    void sentinel?.release().catch(() => undefined);
    sentinel = null;
  };
}
