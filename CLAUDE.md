# Globe Haul Shop Tool (Web Bluetooth)

Static TypeScript + Vite + React app for a bike shop: connect to ONE Globe Haul display (EH02_xxxxx),
flash the two OFFICIAL images as a repair, read everything, print a report, download logs. No backend,
no storage, no network at runtime.

- **The spec is `docs/SPEC.md`. Read it first; it wins over everything else here.** `docs/DECISIONS.md`
  holds the user's later rulings; each one amends the spec where it says so.
- `reference/` (git-ignored, local only: it holds real bike serials) is the source of truth for the
  protocol and is never edited: `PROTOCOL.md` (authoritative),
  `globe_capture.py` (reference client), `globe_tables.py` (use the `sbc` table), `ANDROID_CLAUDE.md` (the
  Android app's rules: it ALLOWS MORE than this app may do; the spec wins). The Android source is at
  `%USERPROFILE%\AndroidStudioProjects\GlobeHaulApp` (read-only reference; never edit it).
- Never fabricate protocol details. Not in PROTOCOL.md / the Python / the Android source → ask.
- Sendable frames are whitelisted in `src/protocol/frames.ts` (`checkFrame`). Never add an opcode there
  without the spec allowing it. Never send: 2A 2B 1E 20 0B 08 0C 01 02 04 05 06 07 09 2C 52 50.
- `protocol/`, `analysis/`, `update/`, `export/` stay free of DOM and `navigator` (a test enforces it).
  Only `src/ble/webBluetooth.ts` / `src/platform/` may touch `navigator.bluetooth`.
- Firmware: only the two allowlisted images (`src/analysis/firmware.ts`, full SHA-256). Nothing from
  `reference/firmware/` other than those two is ever bundled, loaded or parsed.
- **Never commit firmware, captures, logs or anything from a real bike** (see `.gitignore`). The two
  images and the captures exist only locally; tests that need them skip when they're absent.
- Decoder deviations from the Python are listed in ONE place: `DEVIATIONS` in `src/protocol/pages.ts`.
- Parity fixtures: `python tools/make_fixtures.py` regenerates `tests/fixtures/py_*.json` (synthetic,
  committed) and `tests/fixtures/captures/py_capture_*.json` (from real captures, ignored). Never hand-edit.
- Node is a portable install (not on PATH): `%USERPROFILE%\.tools\node-v24.22.2-win-x64`.
  In bash: `export PATH="$HOME/.tools/node-v24.22.2-win-x64:$PATH"`. Then `npm test`,
  `npm run typecheck`, `npm run dev`, `npm run build` (public / GitHub Pages: no firmware, no dev tools),
  `npm run laptop` (offline copy in `laptop/` with firmware + simulated bike + local server).
- This PC has no Bluetooth: the user tests on their Linux laptop (laptop build: `start-shop-tool.sh`; or the Pages site). The simulated
  bike (`src/ui/devMock.ts`, `MockHmi`) is how changes are checked here.
- Work goes by the spec's milestones; stop after each one and show the user.
