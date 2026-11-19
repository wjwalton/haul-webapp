## What to build

A **shop diagnostic and update web app** for the Specialized Globe Haul (ST and LT) e-cargo bike. The stock
Specialized Globe app and its update servers are dead, so this replaces them at the service counter. A mechanic
opens the page, connects to **one** bike, flashes **official** controller and HMI firmware as a repair, reads
**everything** the bike reports, gets a printable report and downloads the stored logs.

**Priorities, in order:**

1. **Controller firmware update** on a **Windows laptop** (Chrome or Edge).
2. HMI firmware update on Windows.
3. Read-out report and log downloads.
4. **Linux laptop** (Chrome/Chromium, one flag to enable).
5. **iPhone / iPad**: as much of the above as iOS can do reliably, preferably inside Safari via an extension
   (see "Platforms").
6. Android, macOS and ChromeOS. These come for free with Web Bluetooth but are not the focus.

Other requirements:

- Stateless: **no accounts, no database, no saved bikes.** Everything lives in memory for the current
  connection. "Disconnect / connect another bike" wipes all state. Output only leaves through downloads and
  print.
- Several bikes may be powered on nearby (it's a shop). The mechanic must always pick, and then confirm, the
  right bike.
- No network calls of any kind at runtime, and no telemetry.

## Reference material — source of truth

Put these in `reference/`. **Never edit them.** Read all of them in full before writing any BLE code.

**The Android app's `CLAUDE.md` goes in as `reference/ANDROID_CLAUDE.md`. Never name it `CLAUDE.md` anywhere
in this repo.** Its MAY list allows things this app must never do: assist automation, the Expert CAN tool
(`1E`/`20`), the `2B` config card and `08` power-off. Use it for the protocol facts, firmware rules, distance
rules and battery-version rules. **Where it allows more than this spec, this spec wins.**

**`reference/firmware/`** (the whole firmware folder) is reference only. The app bundles and can load **only**
the two allowlisted images below. Never bundle, load, parse for flashing, or write code paths for the BMS
images, the S-Link dealer tool, the older `M1B0260s0.bin`, or the stock APK. Add the binaries to
`.gitignore`, except the two app images copied into `src/assets/firmware/`.

The files:

- `PROTOCOL.md`: the reverse-engineered protocol. It is authoritative and up to date. Where it contradicts
  `globe_capture.py`, PROTOCOL.md wins. For example, page 0x3C is the 4-byte `3C <status> <seq u16 LE>`.
- `globe_capture.py`: the working Python reference client. Use it for the connect sequence, page decoders,
  sentinel stripping, the event-log parser, frame padding (`page_req`) and the `raw.jsonl` format.
- `globe_tables.py`: the error tables. Use the **`sbc` table**; this bike is sbc.
- `ANDROID_CLAUDE.md`: the Android app's rules (see the note above).
- `EH02_Eagotech_5.19.zip` (HMI, Nordic Secure DFU package) and `M1B0306s0.bin` (controller).
- **The GlobeHaul Android project source** (ask me for its path). Its firmware-update code is proven on real
  bikes, so port its logic rather than re-deriving it. That covers the controller pre-flight checks, the
  timeouts, the HMI DFU entry and how it pauses the live loop for log dumps.

**Do not fabricate protocol details.** If a byte layout, opcode, UUID or behaviour isn't in PROTOCOL.md, the
Python script or the Android source, stop and ask me. Don't guess.

## Stack (decided)

- **TypeScript + Vite + React**, static single-page app, no backend.
- **Web Bluetooth** behind our own `GattTransport` interface. The protocol, analysis and update code must never
  touch `navigator.bluetooth` directly, so a native transport can be added later (see "Platforms").
- Vitest for unit tests. SHA-256 with `crypto.subtle.digest`. Unzipping with `fflate`.
- HMI Secure DFU: evaluate `web-bluetooth-dfu` (thegecko) or a maintained fork against Nordic's Secure DFU BLE
  transport spec. Otherwise implement the control-point protocol directly in a small, tested module behind our
  own interface.
- PWA (`vite-plugin-pwa`) for offline use on Windows/Android. Don't rely on it on iOS.

## Platforms

### Tier 1: Windows 10/11, Chrome and Edge

This is the platform everything is built and hardware-tested on first.

- Web Bluetooth works with **unpaired** devices. The UI tells the mechanic **not** to pair the bike in Windows
  Bluetooth settings, and to remove it there if it was paired.
- During an update, hold a Screen Wake Lock and set a `beforeunload` warning. Also show "keep the laptop
  plugged in, lid open". Wake Lock keeps the screen on but doesn't stop a lid-close sleep.
- **Measure, don't assume, controller-flash throughput.** The stock Android trace shows about 2.7 ms per block,
  28 s total. Windows' BLE stack may be slower. Log per-block write times, show a measured ETA, and record
  min/avg/max block time in the session log. If Windows is slow enough that the HMI's streaming timeout fires,
  it will send page 0x3C status 2 (resend) or status 1 (fail). Those must be handled; see the update section.

### Tier 1b: Linux laptop, Chrome or Chromium

- Web Bluetooth on Linux is **off by default**. The user must enable
  `chrome://flags/#enable-experimental-web-platform-features` and have BlueZ running. A Snap-packaged Chromium
  also needs `snap connect chromium:bluez`.
- When the app detects Linux with `navigator.bluetooth` missing, show exactly these steps instead of the
  generic "unsupported" screen.
- Chrome treats Linux support as partial, so it gets the same capability check as iOS. Updates stay gated
  until Linux passes the hardware test.

### Tier 2: iPhone / iPad

There is **no Web Bluetooth in Safari**, and every iOS browser uses WebKit. Routes, in order of preference:

- **Route A1 (preferred): the WebBLE Safari extension**, via the `@ios-web-bluetooth/core` polyfill and
  `@ios-web-bluetooth/detect`. The mechanic stays in Safari.
  - The extension is installed from the App Store (iOS Safari extensions always ship inside an App Store app),
    then enabled in Settings → Apps → Safari → Extensions, then allowed for our site.
  - Its App Store listing says **iPhone only, iOS 26+**. Verify that the npm package and the App Store listing
    (`ioswebble`, id6761301368) are the same project before depending on it.
  - On iOS Safari without the extension, use `@ios-web-bluetooth/detect`, or catch `EXTENSION_NOT_INSTALLED`,
    to show a **guided install card**: an App Store link, the Settings path to enable it, the "allow on this
    site" step, then a "Check again" button.
  - The polyfill is **beta**, and its API differs from Web Bluetooth (for example
    `write(..., { mode: 'without-response' })`, and notification queues with `maxQueueSize` that reject on
    overflow by default). Wrap it in its own `IosExtensionTransport` behind `GattTransport`. Don't let its API
    leak into the core. Size the notification queue for about 50 pages/s live plus log dumps, and treat an
    overflow as a visible error, never a silent drop.
  - `requestDevice` must be called directly from a click handler. That is already required for the HMI DFU
    second pick.
- **Route A2 (fallback, iPad or older iOS): Bluefy or WebBLE browsers.** These are separate apps, so only
  mention them when A1 isn't possible ("iPad: the Safari extension isn't available; use the Bluefy browser").
- For every iOS route, **feature-detect at runtime** before offering any feature. Check: both write modes,
  `characteristic.properties`, notifications, `gattserverdisconnected`, `getPrimaryServices`, and a second
  `requestDevice`. Show a capability panel ("Read ✓, controller update ✗ — missing X").
- All iOS routes need **HTTPS**; there is no localhost on a phone. See Deployment.
- **Route B (if Route A can't flash reliably): a Capacitor iOS wrapper** reusing the same TypeScript core.
  - Add a `CapacitorBleTransport` (`@capacitor-community/bluetooth-le`) for the controller path.
  - Use Nordic's native iOS DFU library (via a Capacitor plugin such as `capacitor-community-nordic-dfu`) for
    the HMI. It handles the bootloader's address change itself.
  - This needs a Mac with Xcode (or a cloud macOS build) and an Apple Developer account for TestFlight. Don't
    build Route B until I ask. **Do** keep the transport boundary clean enough that it's a new file, not a
    refactor.

### Update gate per platform (safety)

Keep a code constant `VERIFIED_UPDATE_PLATFORMS`, initially `['windows-chrome', 'windows-edge']`. On any other
platform/browser the update buttons are disabled with a clear reason. I add a platform only after it passes
`docs/HARDWARE_TEST.md` on the test bike. Reading, the report and log downloads are allowed anywhere the capability
check passes.

## Architecture

```
src/
  ble/transport.ts        GattTransport interface + capability report
  ble/webBluetooth.ts     WebBluetoothTransport (Windows/Linux/Android/macOS + Bluefy/WebBLE browsers)
  ble/iosExtension.ts     IosExtensionTransport (Safari + WebBLE extension polyfill)
  ble/mock.ts             MockTransport (replays raw.jsonl) + MockHmi (scriptable responses)
  ble/queue.ts            single serial queue for EVERY GATT op
  platform/detect.ts      OS/browser id, capability checks, VERIFIED_UPDATE_PLATFORMS
  protocol/frames.ts      frame builders, ONLY for the whitelisted opcodes
  protocol/pages.ts       port of decode_page + strip_na (units in field names)
  protocol/errors.ts      sbc table + decode_errors + raw-code sentinel rules
  protocol/logs.ts        0xBE…0xED framing; event (48 B), ride (32 B), period (64 B) parsers
  protocol/session.ts     the connect/read sequence as a state machine
  analysis/firmware.ts    LatestKnown table (ONE place) + verdicts + SHA-256 allowlist
  analysis/distance.ts    ride-log reset-aware Bike distance (PROTOCOL.md Type 2, incl. glitch rule)
  analysis/battery.ts     nibble-swap correction, SC/RC line
  update/controller.ts    0x46/0x47 block-stream state machine (pure, driven through GattTransport)
  update/hmiDfu.ts        Nordic Secure DFU behind an HmiDfu interface (web impl now, native later)
  ui/…                    Connect, Confirm bike, Firmware, Live, Report, Logs, Capabilities
  export/…                print view, JSON, CSV, .bin, raw.jsonl
```

Keep `protocol/`, `analysis/` and `update/` free of DOM and `navigator`, so they are fully unit-testable.

## Hard safety rules

The app may only ever send these frames. Page-request frames are built **exactly** like `page_req()` in the
Python script: 19 bytes, zero-padded.

| Opcode | Use |
|---|---|
| `3C 01` | MTU page mode |
| `3D …` | one-shot page requests: identity 11–28, 54, 55, 56 (and 1–28, 40, 51–56 for a read-only sweep) |
| `3E 28 07 08 09 0A` | the live loop (HMI 5.19 streams 40/7/8/9/10, not 51/52/53) |
| `29 <1\|2\|3> 00 00` | dump the event / ride / period log |
| `46 00 …` / `47 …` | controller update (type `0x00` only), only inside `update/controller.ts`, only with an allowlisted file |
| Nordic Secure DFU ops | only inside `update/hmiDfu.ts`, only with the allowlisted zip |

Put the whitelist in code. `frames.ts` must refuse to build anything else, including `46` with type ≠ 0, and a
unit test must assert it.

**Never send:** `2A` (log erase), `2B` (config bundle), `1E` / `20` (bypass / raw CAN), `0B`, `08`, `0C`, `01`,
`02`, `04` / `05` / `06` (PIN), `07`, `09`, `2C`, `52`, `50`, battery firmware, or anything undocumented. The
app never modifies firmware or touches assist curves, current/power limits or the speed cutoff.

## Web Bluetooth specifics

- **Picking a bike:** `requestDevice({ filters: [{ namePrefix: 'EH02_' }, { services: ['00005800-0000-1000-8000-41564f4c5058'] }], optionalServices: ['00010000-452d-4269-6b65-58706c6f7661', 'device_information', 'battery_service', 0xFE59] })`.
  Never use the 128-bit Globe service as a scan filter; it is GATT-only. The chooser lists every nearby
  `EH02_xxxxx`. A connected HMI stops advertising, so the UI says: "Bike missing? Close any other app, tab or
  phone connected to it."
- **Confirm-the-bike step** (mandatory): show the advertised name large, plus **battery % (page 10)** and the
  **controller odometer (page 7)**. Prompt: "Check the bike's screen shows the same." Buttons: Confirm / Wrong
  bike (disconnect). In recovery mode (controller not answering), the odometer may be missing. Confirm then
  uses the name and battery % only, and says so.
- **DIS Serial Number `0x2A25` is on Chrome's GATT blocklist.** Don't read it. Read the other DIS fields, each
  in try/catch.
- MTU can't be set from a browser. Accept notifications holding 1…n 20-byte pages, plus the short framed
  replies (0x3C, `0xBE` / `0xED`). Log the observed sizes.
- One serial queue for every GATT op: writes, reads, notification start/stop. "Cancel" means dropping writes
  that haven't been issued yet; an issued write can't be recalled.
- `…0010`: `writeValueWithResponse`, plus indications for acks `[0x10, op, status]`. `…0011`: read
  `properties` at runtime and use the matching write method (the Python script says write-without-response).
  Log which method was used.
- `…0004` repeats about 55 times a second. Act on changes only.
- Handle `gattserverdisconnected` everywhere. Reconnect with the same `BluetoothDevice` (no chooser).
- One bike per tab; multiple tabs are allowed.

## Connect / read sequence

Mirror `cmd_capture` in `globe_capture.py`:

1. Read DIS. Error table = `sbc`.
2. Enable indications on `…0010`, notifications on `…0004`, read `…0004` once.
3. `3C 01`, then enable notifications on `…0001`.
4. If locked (status byte 1 = 1): show "Bike is PIN-locked". There is no unlock in this app. **Updates are
   blocked while locked.** The documents don't say whether a locked HMI accepts `46`, so ask me before
   relaxing this.
5. `3D` identity pages 11–28, then 54, 55, 56, with the Python script's wait/timeout behaviour.
6. Start the live loop.

**Log dumps never run while the live loop streams**, because live pages would land in the dump buffer. Pause it
the way the Android app does (the stock update trace uses a one-shot `3D` page 55), dump, then restore the loop.
The event log and ride history are read after connect. The period log is a separate button, with a progress
bar and an idle timeout (no bytes for 15 s) rather than a total cap; read it to the `0xED`. Validate dump
lengths against the record size (the event log starts 2 bytes into record 0) and flag mismatches.

## 1. Controller firmware update (TOP PRIORITY — build and test this first)

`update/controller.ts`, per PROTOCOL.md "Controller / battery firmware update" and the Android implementation.

**Files and allowlist.** The bundled `M1B0306s0.bin` is pre-selected. "Load file from disk…" is
allowlist-only. Re-check the SHA-256 immediately before every flash (full lowercase hashes; never shorten them):

- Controller `M1B0306s0.bin`, 81,920 B, `e7e308034972da1604a72676acc05fdb45bbbdbb15947ef88d99052a71e9f6e4`
- HMI `EH02_Eagotech_5.19.zip`, 98,963 B, `1c8f1374bb929d8b8176fd19b8bf81726fe4bbf0b42939793dac8afd66d715d2`

**When it is offered** (the stock rule):

- ctype is `sbc`.
- The file's type suffix (`M1B0306s0` → `s0`) equals the 3rd field of the controller SW (`03.06.s0`).
- Either the file is newer, **or** `controller_e031` (sbc bit 21) is set in the **live** error bitmask. The
  Android app checks its stored error history; this app is stateless and the event-log flags are only 16 bits,
  so the live bitmask is the only e031 source here.
- Never gate on HW rev (AS.03 ST / AL.03 LT both qualify).
- **HMI must be 5.19.** The `46`/`47` relay was decoded and verified on HMI 5.19. If the HMI is older, the app
  says "update the HMI first" and only offers the HMI update.
- **Recovery mode:** the display is sbc, but the controller answered none of its identity pages. Assume `s0` and
  allow the bundled image, with a recovery banner.

**Pre-flight:** connected, bike confirmed, not locked, speed 0 from live pages, platform in
`VERIFIED_UPDATE_PLATFORMS`, plus every check the Android app applies (port them exactly; ask if any are
unclear). The mechanic types the bike's name to arm it. The point-of-no-return warning is always shown.

**Sequence (matches the stock trace):**

1. One-shot `3D` page 55 (pauses the live loop). Wait for its ack.
2. Start frame `46 00 <N u16 LE> <v0 v1 v2>`, where version bytes = filename chars at index 1, 2, 7. For
   `M1B0306s0.bin` this is exactly `46 00 00 28 31 42 73` (unit test). Write it to `…0010` and expect ack
   `10 46 01`.
3. **Point of no return:** the controller erases its application now. Wait for page 0x3C status 2 (about
   4.5 s; use a generous timeout). **Send no blocks until it arrives.** If it never arrives: "No answer from
   the controller bootloader. Power-cycle the bike and retry; it stays reflashable."
4. Stream `47 <seq u16 LE, 1-based> <len> <8 bytes, zero-padded>` to `…0011`, from that seq to the end,
   back-to-back through the queue. The file is split exactly as stored, with no byte swap.
5. A later status 2 = resend: drop unissued writes, wait 500 ms, resend from that seq. Status 1 = failed.
   Status 0 = success.
6. Restore the live loop, re-request page 19, and show the new controller SW.

**During the flash:** show a progress bar (seq / N), the measured ETA and the elapsed time. Keep the status
text plain and never hidden.

**Failures:**

- Link drop mid-stream: "Reconnect and flash again. The controller stays in its bootloader (e031) and is
  reflashable."
- HMI stuck showing bypass: "Power-cycle the bike, reconnect, recovery flash."

## 2. HMI firmware update (second priority)

`update/hmiDfu.ts`, Nordic Secure DFU of the signed zip.

- Parse `manifest.json` → `application.dat` + `application.bin`.
- **Entering the bootloader is not in PROTOCOL.md.** Port it from the Android DFU code (it uses
  `no.nordicsemi.android:dfu`). Also log the full GATT table on connect to a debug panel, to confirm whether
  the HMI exposes the buttonless service `0xFE59`. Do not guess.
- After the jump, the bootloader usually advertises under a **different address**, and possibly a different
  name. In a browser this needs a **second `requestDevice()` from a user click** (filter on service `0xFE59`).
  Build it as a guided two-step: "The display restarted into update mode — click to select it."
- The bootloader verifies the signature, and an interrupted DFU stays in bootloader mode and can be retried,
  so "Resume HMI update" must always be reachable.
- Afterwards, reconnect and confirm the DIS sw = 5.19.
- Same gates as the controller: verified platform, not locked, typed confirmation.

## 3. Report (on screen + Print to PDF + JSON)

One report per connection:

1. **Bike:** name, time, HMI DIS (model/hw/fw/sw), page 56 build date (ASCII YYYYMM) and unit id, status flags
   (locked / charging / units). The bike's unit setting is the default display unit, with a toggle that is not
   saved.
2. **Firmware status:** HMI vs 5.19; controller by SW suffix (`s0` → 03.06.s0); battery raw, corrected (reverse
   each 2-digit group) and SC/RC line vs latest (SC 01.00.08, RC 01.00.12). All verdicts come from one
   `LatestKnown` table. Battery is labelled "dealer update only".
3. **Controller:** serial (16/17), model, sw, hw, mfr. **Controller odometer** (page 7) labelled as such, plus
   trip and range (km, 1 km units).
4. **Battery:** serial (21/22), model, versions, live %, V, signed current, temperature. Page 54 health/cycles
   only if reported.
5. **Config as reported:** assist levels, wheel circumference, auto-off timer, headlight field. The speed-limit
   field is shown as "reported field — not the enforced cutoff".
6. **Active errors:** the 32-bit bitmask through sbc (code, description, bit), with the documented
   `controller_e010` hint. Page 55 raw codes only if nonzero and not a sentinel, labelled "raw, undecoded".
7. **Error history (event log):** decoded table, flags through sbc. Year < 2015 or an invalid date shows as
   "clock not set". Per-code counts with first/last seen, and the coverage check (seq starts at 0 and first
   odometer ≈ 0 → complete since new).
8. **Ride history:** placeholders hidden. **Bike distance** from the ride log using the exact PROTOCOL.md
   Type 2 rules, shown beside the controller odometer. Total ride time, average speed, and top speed with the
   plausibility filter.
9. **Period log** (if read): count, ≈ powered-on minutes, date span. Raw only.
10. **Not reported by this bike:** every null/sentinel field, listed once.

## Downloads

- Print-to-PDF report (print stylesheet) and `report.json`.
- Per log: the raw `.bin` exactly as received, plus a decoded `.csv`.
- `raw.jsonl` in **exactly** the Python format (`{"t","ch","hex"}`, with the `read` / `power` / `ack` / `tx`
  channels), so `python3 globe_capture.py replay raw.jsonl` works on it.
- **The update session log** (every frame, per-block timing, every page 0x3C) as `update_<name>_<time>.txt`.
  It is offered automatically after any update attempt, success or not.
- On iOS Web-BLE browsers, downloads may not behave like desktop. Test them, and fall back to "copy JSON" /
  share if needed.

## Testing

- **Controller update simulator first:** `MockHmi` answers `46` with ack, then `3C 02 01 00` after about 4.5 s,
  then `3C 00 00 00` after N blocks. Variants:
  - resend mid-stream (status 2 at seq k)
  - failure (status 1)
  - disconnect mid-stream
  - bootloader never answers
  - **slow host** (50 ms per write), to prove the ETA and resend logic
  - `…0011` reporting only write-with-response
- **Parity tests** against the Python script: `tools/make_fixtures.py` runs `globe_capture.py`'s functions on
  sample frames and captures and writes expected JSON; Vitest compares field by field. Ask me for real
  `raw.jsonl` and `spi_*.bin` captures. Until then, use the PROTOCOL.md byte examples (`3C 02 01 00`,
  `46 00 00 28 31 42 73`, the page 56 sample, etc.).
- **Distance tests:** the four validated bikes plus the glitch-case bike, once I provide logs.
- The whitelist test, and a `page_req` padding test (19 bytes).
- **`docs/HARDWARE_TEST.md`** (I run it), on the test bike only until it passes:
  1. Windows read-only connect.
  2. Controller flash on Windows Chrome, then Edge, recording block timing.
  3. HMI DFU on Windows.
  4. Two-bike chooser and confirm test.
  5. Logs and report.
  6. Linux Chrome: read-only, then a controller flash.
  7. iOS Safari + extension (then Bluefy on iPad): the capability panel, then read-only, then (only if I decide)
     a flash.

## Milestones (stop after each and show me)

1. Scaffold, reference files and hash check, `frames` / `pages` / `errors` with parity tests, whitelist test,
   `MockTransport` / `MockHmi`.
2. Connect, confirm bike and a minimal live/identity panel on **Windows Chrome** (whatever the controller-update
   gate needs: page 19, bitmask, HMI version, speed, lock state).
3. **Controller update**: simulator tests green, then hardware on the test bike (Windows), with the session-log
   download.
4. **HMI DFU** on Windows (after reading the Android DFU code).
5. Log reads, the full report and all downloads.
6. Linux flag-detection screen. iOS Route A1 (Safari extension, guided install card) and the A2 fallback note.
   Capability detection, an HTTPS deployment, and test notes per platform.
7. PWA offline, print stylesheet, unsupported-browser screen, docs.
8. (Only when I ask) iOS Route B: the Capacitor wrapper.

## Deployment

- **Windows shop laptop:** `npm run build` and serve `dist/` on `localhost` (a secure context), or install it
  as a PWA from there. This works offline.
- **iOS** needs HTTPS on a real hostname. Use a **private** host, such as Cloudflare Pages behind Cloudflare
  Access (email login), not a public URL. The firmware images are Specialized's files. Alternatively, build
  without bundled images and use "Load file from disk".
