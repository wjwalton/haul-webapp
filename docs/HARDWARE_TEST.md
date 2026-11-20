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

First run (2026-11-19, beta 8ec276b) failed and is fixed in 0.1.1: see docs/DECISIONS.md "controller
update over Chrome on Windows". Check the header says **0.1.1** or later before flashing. On that laptop
the transfer takes **about 4 minutes**, not the phone's 28 s: the Bluetooth link to the display carries
about 44 blocks per second.

Only after step 1 passes on the same laptop and browser. Laptop plugged in, lid open, next to the bike.
Bike battery at least 30 % (the charger may stay connected). Have the Android app at hand: it can do the
recovery flash if this one fails. On a bike that already runs 03.06.s0 this is a **same-version reflash**
(docs/DECISIONS.md): tick "Reflash the same version". If `controller_e031` is active or the controller
isn't answering (recovery), the update is offered without the tick.

1. Connect, confirm, and wait for the checklist. Check every line, especially "…0011 present (write
   without response …)" and "HMI is 5.19". On a 03.06.s0 bike, tick "Reflash the same version":
   "Update needed" turns ✓ ("Same-version reflash chosen").
2. File: the built-in M1B0306s0.bin (laptop build) shows ✓ with the full SHA-256. On the public site, use
   **Load file from disk…** and pick the official file. Also pick any other `.bin` once: it must be
   rejected with the reason and both hashes.
3. Read the point-of-no-return warning. Type the bike's name exactly. **Start controller update**.
   From here there is no stop button, and Reconnect / Disconnect are disabled until it ends.
4. Watch, and note the times: "Pausing live data", "Sending the start frame", "erasing (about 4.5 s)",
   then the progress bar. The bike's display shows **bypass** the whole time: that is normal. The
   "blocks/s reaching the bike" figure should be about 40-45 and the ETA about 4 minutes. **Don't switch
   the bike off or close the tab** until the card says it has finished, however long it takes.
5. After the last block the card says "Every block has been sent… keep waiting" with a timer. The
   display should confirm within a second or two. It may take longer only if the barrier reads
   overtake the queue (see 6); the app keeps waiting up to about 8 minutes.
6. Expected end: "The controller reported success …". On a same-version reflash: power-cycle the bike,
   click Reconnect: "Verified after the power-cycle: the controller reports 03.06.s0". On an older
   controller: "Verified: it now reports 03.06.s0", or the same power-cycle step.
7. **Download update log** every time (success or not) and keep it. Check its summary:
   - "Barrier (read 0004 behind the blocks, every 32): min / avg / max": **about 700 ms each means the
     pacing works on Windows**; a few tens of ms means the reads overtake the queue (send the log).
   - "Delivery rate: … blocks/s" (about 44 on that laptop), the write method, the block write time,
     "Ready (3C 02) … ms after the start frame", one `3c020100` and one `3c000000`, and no other page
     0x3C unless the display asked for a resend.
8. After the power-cycle: live data and the controller identity are back, no `controller_e031`, and the
   bike rides normally.
9. Repeat in Edge.

If anything fails, don't retry blindly. Download the update log and the connection log, then:
- No `3C 02` ("No answer from the controller bootloader"): power-cycle the bike, reconnect, and flash
  again (recovery). It stays reflashable.
- Link lost mid-stream: reconnect (power-cycle the bike first if no live data comes back) and flash again.
- The card says it stopped and the display still shows **bypass**: power-cycle the bike, reconnect, then
  do the recovery flash.
- Reconnect keeps failing: switch the bike off and on, then **Choose the bike again** and pick the same
  bike (it keeps the update result). Reload the page only after downloading the logs.

Bring back (copy into `logs/` on the dev PC):
- Every update log (`update_<bike>_<time>.txt`), successful or not.
- The connection log (`connection_<bike>_<time>.txt`, debug panel or the "connection lost" card).
- The `raw.jsonl` from step 1 and one from the session with the flash (download it after the
  power-cycle and Reconnect: it holds both connections).
- A CAN capture of the update if the logger is on the bike: it shows what the display really received.
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
