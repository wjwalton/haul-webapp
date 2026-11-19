# Hardware test

Run on **one test bike only** until every step passes. A platform joins `VERIFIED_UPDATE_PLATFORMS`
(`src/platform/detect.ts`) only after it passes the steps that apply to it. Record the date, the
browser version and the result of each step. Download the `raw.jsonl` from the debug panel for any
failure and keep it with the notes.

Setup, either:
- **The beta site**: https://wjwalton.github.io/haul-webapp/ in Chrome. Nothing to install. The header
  shows "BETA" and the commit; every update log records the same. It has no firmware: the laptop needs
  the official `M1B0306s0.bin`, picked with **Load file from disk…**.
- **The laptop folder**: `npm run laptop`, copy `laptop/` to the laptop, then start it: Windows,
  double-click `Start Shop Tool.cmd`; Linux, `sh start-shop-tool.sh` in that folder. Both serve
  http://localhost:8173 with the firmware built in.

Logs: the update log and `raw.jsonl` download to the laptop's Downloads folder. Copy them into `logs/` in
the project on the dev PC (git-ignored; they hold the bike's serials) for review.

Before going to the bike:
- On the laptop: Chrome up to date (note the version from `chrome://version`), the beta site opens, and
  `M1B0306s0.bin` is on the laptop for step 2.
- The laptop is charged and its charger is with you. The bike battery is at least 30 %.
- The bike isn't paired in Windows Bluetooth settings, and no phone app is connected to it.
- You know how to power-cycle the bike (off, then on) quickly: step 2 needs it.

## 1. Read-only connect (milestone 2): Windows, and Linux

Windows: Chrome first, then Edge. The bike must **not** be paired in Windows Bluetooth settings (remove it
if it is).

Linux: Chrome or Chromium. Bluetooth on (`systemctl status bluetooth` says active). The first time, the app
shows "Web Bluetooth is off by default on Linux" with the steps: enable
`chrome://flags/#enable-experimental-web-platform-features`, relaunch, reload the app. Note the
distribution, the browser and its version, and how it was installed (deb / rpm / snap / flatpak).

1. Open the app. The header says "Chrome on Windows · updates: verified browser" (or Edge). On Linux it
   says "Chrome on Linux · updates: not on this browser" (or Chromium), which is expected.
2. Switch the bike on. Click **Choose bike…**. The chooser lists the bike (`EH02_` and five digits). If a second
   bike is on, it is listed too. Pick the test bike.
3. The reading steps run through to "Live loop" within a few seconds.
4. Confirm screen: the name is shown large. **Battery %** matches the bike's screen. **Controller
   odometer** matches the screen's odometer in the bike's unit setting (miles if the bike is set to imperial).
5. Click **Wrong bike** once: the app disconnects and the bike shows up in the chooser again. Choose it
   again and **Confirm** this time.
6. Check the panel against the bike:
   - Live: speed 0 at rest, then a plausible speed with the wheel spun. Battery %, V and A are plausible.
     The assist level follows the + / − buttons.
   - Identity: HMI 5.19, controller `1B`, `03.06.s0`, `AS.03`, battery `01.00.12 RC` (reported
     `10.00.21.RC`). The serials are the bike's.
   - Active errors: "No active errors" (or the real ones).
   - The controller update checklist: everything ✓ except "Update needed" ("already runs 03.06.s0"),
     and a "Reflash the same version" checkbox above it. Don't tick it in this step. On Linux, "Verified
     browser for updates" is ✗ as well.
7. Debug panel: note the …0001 notification sizes (MTU page mode), whether **0xFE59** is listed, and
   **…0011's properties** (write without response / with response). Download `raw.jsonl`. Later, on the
   dev PC: `python3 reference/globe_capture.py replay <the downloaded .jsonl>` must read it.
8. If a PIN-locked bike is to hand (locked earlier with another app; this app never sends PIN
   commands): connect to it. Reading works, the panel shows "PIN-locked", and the checklist's "Awake and
   unlocked" is ✗.
9. Switch the bike off while connected: "Connection lost" within a few seconds. Switch it on and click
   **Reconnect** (no chooser): live data returns and the bike stays confirmed.
10. Leave it connected for 2 minutes: no stale warning, and live data keeps flowing. The raw.jsonl shows
    the page-55 poll every 30 s (a `tx` line `3d37…`, then `3e28…`).
11. **Disconnect / connect another bike**: everything is cleared and you're back at the connect screen.

## 2. Controller flash on Windows Chrome, then Edge (milestone 3)

Windows only for now: on Linux the update stays disabled (see step 6).

Only after step 1 passes on the same laptop and browser. Laptop plugged in, lid open, next to the bike.
Bike battery at least 30 % (the charger may stay connected). The bike already runs 03.06.s0, so this is a
**same-version reflash** (docs/DECISIONS.md): tick "Reflash the same version". If `controller_e031` is
active or the controller isn't answering (recovery), the update is offered without the tick.

1. Connect, confirm, and wait for the checklist. Check every line, especially "…0011 present (write
   without response …)" and "HMI is 5.19". Tick "Reflash the same version": "Update needed" turns ✓
   ("Same-version reflash chosen").
2. File: the built-in M1B0306s0.bin (laptop build) shows ✓ with the full SHA-256. On the public site, use
   **Load file from disk…** and pick the official file. Also pick any other `.bin` once: it must be
   rejected with the reason and both hashes.
3. Read the point-of-no-return warning. Type the bike's name exactly. **Start controller update**.
   From here there is no stop button, and Reconnect / Disconnect are disabled until it ends.
4. Watch, and note the times: "Pausing live data", "Sending the start frame", "erasing (about 4.5 s)".
   Then the progress bar and the measured ETA. The phone app took ~28 s for 10,240 blocks; Windows may
   be slower. That's fine as long as it completes.
5. Expected end: "The controller reported success … This was a same-version reflash". Power-cycle the
   bike, click Reconnect: "Verified after the power-cycle: the controller reports 03.06.s0".
6. **Download update log** every time (success or not) and keep it. Its first lines say why it was
   offered ("Same-version reflash chosen …"). Check its summary: write method,
   block write time min / avg / max, "Ready (3C 02) … ms after the start frame", one `3c020100` and one
   `3c000000`, and no other page 0x3C unless the HMI asked for a resend.
7. After the power-cycle: live data and the controller identity are back, no `controller_e031`, and the
   bike rides normally.
8. Repeat in Edge.

If anything fails, don't retry blindly. Download the log, then:
- No `3C 02` ("No answer from the controller bootloader"): power-cycle the bike, reconnect, and flash
  again (recovery). It stays reflashable.
- Link lost mid-stream: reconnect (power-cycle the bike first if no live data comes back) and flash again.
- Display stuck showing **bypass**: power-cycle the bike, reconnect, then do the recovery flash.

Bring back (copy into `logs/` on the dev PC):
- Every update log (`update_<bike>_<time>.txt`), successful or not.
- The `raw.jsonl` from step 1 and one from the session with the flash (download it after the
  power-cycle and Reconnect: it holds both connections).
- Notes: Windows and Chrome versions; the debug panel's …0011 properties, FE59 yes / no and notification
  sizes; how long the flash took; what the bike's display showed during and after it; anything that
  looked wrong, even if it worked.

## 3. HMI DFU on Windows (milestone 4, deferred: no HMI to test on yet)

## 4. Two-bike chooser and confirm test

## 5. Logs and report (milestone 5)

## 6. Linux Chrome: read-only (step 1 above), then a controller flash (milestone 6)

The flash on Linux needs Linux to be allowed for updates first (`VERIFIED_UPDATE_PLATFORMS`).

## 7. iOS Safari + extension, then Bluefy on iPad (milestone 6)

The capability panel, then read-only, then (only if decided) a flash.
