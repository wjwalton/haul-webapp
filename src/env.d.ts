/**
 * Build-time switch (vite.config.ts `define`): the simulated-bike developer tools are compiled in for
 * `npm run dev` and the shop-laptop build, and compiled OUT of the public build (dead code, not shipped).
 */
declare const __DEV_TOOLS__: boolean;

/**
 * Which build this is (vite.config.ts `define`), so a log can be matched to the code that wrote it.
 * channel: "beta" on the GitHub Pages test site (VITE_CHANNEL), "" otherwise. commit: the first 7
 * characters of GITHUB_SHA in CI, "local" otherwise. date: UTC build day.
 */
declare const __BUILD__: { version: string; channel: string; commit: string; date: string };
