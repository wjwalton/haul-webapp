# Decisions

Rulings made after `docs/SPEC.md` was written. Each one amends the spec where it says so; otherwise
the spec stands. Newest last.

## 2026-11-18: firmware, captures and logs stay out of the repo

The two official images are Specialized's files, and captures/logs come from a real bike (serials,
odometer, rides). None of them are committed.

- `src/assets/firmware/` is git-ignored. The images are supplied separately and copied in locally
  before a build that should include them. A build without them works: the update screens use "Load
  file from disk", which accepts only the two allowlisted files (full SHA-256).
- Real captures (`tests/fixtures/captures/`) and everything derived from them are git-ignored.
  Tests that need them, or the firmware, skip when they're absent.
- Amends the spec's "Add the binaries to `.gitignore`, except the two app images copied into
  `src/assets/firmware/`": the two app images are ignored too.

## 2026-11-18: reference/ stays out of the repo; public hosting on GitHub Pages

- `reference/` (PROTOCOL.md, the Python client, the error tables, the Android rules, the firmware folder)
  is git-ignored: it holds real bike names and serials. It stays the local source of truth. The
  committed parity fixtures were generated from it.
- The public build is published to GitHub Pages by `.github/workflows/pages.yml`. It is built without
  firmware (the workflow refuses to publish a `.bin` / `.zip`) and without the simulated-bike tools.
  On that site, the controller update loads the official file from disk (allowlist, full SHA-256).
- For testing on the shop laptop without publishing: `npm run laptop` builds `laptop/` (git-ignored)
  with the firmware built in, the simulated bike, and a double-click local server
  (`Start Shop Tool.cmd`, http://localhost:8173, nothing to install).
- Amends the spec's Deployment section, which suggested a private host for iOS: the iOS milestone will
  revisit this.

## 2026-11-18: HMI update (milestone 4) is deferred

No HMI is available to test on. The HMI DFU is left tentative and will be built and hardware-tested
later. The controller update (milestone 3) is the priority. The protocol in PROTOCOL.md and the
Android app's implementation are proven on real bikes.

## 2026-11-18: laptop battery check before a controller update (milestone 3; removed, see below)

Port of the Android pre-flight "phone battery ≥ 30 %". The laptop equivalent uses the Battery Status
API (`navigator.getBattery()`, available in Chrome and Edge): an update may start only if the laptop is
**charging, or at 20 % or more**. The threshold is 20 %, not the Android app's 30 %.

## 2026-11-18: no laptop-battery check (replaces the entry above)

The laptop-battery check is removed. A browser without the Battery Status API would have blocked every
update with no way past it. The pre-flight keeps the bike battery ≥ 30 % (read from the bike). The
screen still says to keep the laptop plugged in with the lid open, and holds a Screen Wake Lock during the
update.

## 2026-11-18: same-version reflash (amends "When it is offered")

When the controller already runs exactly the file's version (03.06.s0 = 03.06.s0, same type suffix,
no `controller_e031`), the update screen shows a **"Reflash the same version"** checkbox. Ticking it
counts as "update needed", so the official image is written again as a repair. Everything else is
unchanged: every other check, the typed bike name, the point-of-no-return warning, and no stop button once
it starts. It never allows an older file (no downgrade) or another type. The session log records why the
update was offered. Afterwards the version can't show a change, so the app asks for a power-cycle and
Reconnect, then checks that the controller answers with that version again.

## 2026-11-18: laptop copy for Windows and Linux

`npm run laptop` builds one folder for both: `Start Shop Tool.cmd` (Windows, PowerShell, nothing to
install) and `start-shop-tool.sh` (Linux, Python 3 standard library). Both serve the app on
http://localhost:8173 to this computer only, and open it in a Chromium-based browser (Chrome / Edge on
Windows, Chrome / Chromium / Edge / Brave on Linux), never Firefox. Linux still needs the Chrome flag
from the spec ("Tier 1b"), set once by the user. Updates on Linux stay gated by
`VERIFIED_UPDATE_PLATFORMS` (spec, unchanged).

Firefox: it has no Web Bluetooth and no setting turns it on. Supporting it would need a separate native
helper program on the laptop, so it isn't planned; the app tells Firefox users to switch browsers.

## 2026-11-19: public beta on GitHub Pages; logs stay on the laptop

- The repo `haul-webapp` is public (free GitHub Pages needs that). The site,
  https://wjwalton.github.io/haul-webapp/, is built as **beta** (`VITE_CHANNEL=beta` in the workflow): the
  header and every update log show the version, the commit and the build date.
- Real bike names were replaced in published files: the simulated bike is `EH02_00001` (and
  `EH02_00002` in two-bike tests), and the docs say "the test bike". Real names, serials, captures and
  logs stay in git-ignored files only. Commits use the GitHub noreply address.
- Test logs aren't uploaded anywhere by the app (no network at runtime, and an upload would need a key
  in a public page). They download to the laptop; the user copies them into `logs/` (git-ignored) for
  review.
