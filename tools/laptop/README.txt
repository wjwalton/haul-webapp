Globe Haul Shop Tool - laptop copy (Windows and Linux)
=====================================================

Copy this whole folder to the laptop (USB stick, network share, anything). No internet is needed.
Nothing is saved; data leaves only through the app's download buttons. If the firmware files were in
the build, they are inside the "app" folder: keep this folder private.


Windows
-------
1. Double-click "Start Shop Tool.cmd". A window opens, and the app opens in Chrome or Edge at
   http://localhost:8173/ . If it opens in another browser, paste that address into Chrome or Edge.
2. Keep the window open while you use the app. Close it to stop.

- Don't pair the bike in Windows Bluetooth settings. If it was paired, remove it there first.


Linux
-----
Needs Python 3 (installed on most desktops) and Chrome or Chromium. Firefox has no Web Bluetooth.

1. Open a terminal in this folder and run:   sh start-shop-tool.sh
   (or: python3 serve.py). The app opens in Chrome / Chromium at http://localhost:8173/ .
2. First time only: if the app says "Web Bluetooth is off by default on Linux", open
   chrome://flags/#enable-experimental-web-platform-features , set it to Enabled, and click Relaunch.
3. Keep the terminal open while you use the app. Ctrl+C stops it.
4. It asks "Fast Bluetooth for firmware updates?". Say yes (Enter) and type your password: new
   Bluetooth connections then use a 7.5-15 ms interval instead of BlueZ's ~60 ms, which makes a
   battery update about 4x faster (minutes instead of ~26). The old setting is put back when the tool
   stops. Skip the question with:  sh start-shop-tool.sh --fast-bluetooth no   (or yes)

- Bluetooth must be on (the BlueZ service running: systemctl status bluetooth).
- Chromium installed as a Snap also needs, once:   sudo snap connect chromium:bluez
- The header shows "updates: battery only on this browser" on Linux: reading and the battery update
  work; the controller update stays disabled until Linux passes the hardware test.


Before connecting (both)
------------------------
- Close any phone app connected to the bike: a connected display stops advertising.
- For a firmware update: keep the laptop plugged in and the lid open.
