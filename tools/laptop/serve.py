#!/usr/bin/env python3
"""Serves the Globe Haul Shop Tool from the "app" folder next to this file on http://localhost:8173/
(localhost is a secure context, so Web Bluetooth works) and opens it in Chrome, Chromium, Edge or Brave.

The Linux launcher (start-shop-tool.sh runs it); Windows uses "Start Shop Tool.cmd". Python 3.7+
standard library only, nothing to install. Listens on 127.0.0.1 only: nothing is reachable from other
computers. Ctrl+C (or closing the terminal) stops it.

    python3 serve.py [--port 8173] [--no-browser]
"""
import argparse
import errno
import functools
import http.server
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.join(HERE, 'app')

TYPES = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
    '.bin': 'application/octet-stream', '.zip': 'application/zip',
}

# Chromium-based browsers have Web Bluetooth. Firefox doesn't, so it's never opened.
BROWSERS = [
    'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser',
    'microsoft-edge', 'microsoft-edge-stable', 'brave-browser', 'brave',
]

LINUX_FLAG = 'chrome://flags/#enable-experimental-web-platform-features'


class Handler(http.server.SimpleHTTPRequestHandler):
    """Static files from app/ only: no directory listings, no caching, no MIME sniffing."""

    def guess_type(self, path):
        return TYPES.get(os.path.splitext(path)[1].lower(), 'application/octet-stream')

    def list_directory(self, path):
        self.send_error(404)
        return None

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        super().end_headers()

    def log_message(self, fmt, *args):
        pass


def find_browser():
    for name in BROWSERS:
        exe = shutil.which(name)
        if exe:
            return exe
    return None


def open_browser(url):
    exe = find_browser()
    if exe is None:
        print('No Chrome, Chromium, Edge or Brave found on this computer.')
        print('Install Chrome or Chromium (Firefox has no Web Bluetooth), then open ' + url)
        return
    extra = {'start_new_session': True} if os.name == 'posix' else {}
    try:
        subprocess.Popen([exe, url], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **extra)
        print('Opened in ' + os.path.basename(exe) + '.')
    except OSError as e:
        print("Couldn't start " + exe + ' (' + str(e) + '). Open ' + url + ' in Chrome or Chromium.')


def bluetooth_hint():
    """Linux: say so if the BlueZ service isn't running (the browser can't see any bike without it)."""
    if not sys.platform.startswith('linux') or shutil.which('systemctl') is None:
        return
    try:
        state = subprocess.run(['systemctl', 'is-active', 'bluetooth'], stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, universal_newlines=True, timeout=3).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return
    if state != 'active':
        print('Bluetooth service: ' + (state or 'unknown') + '. Start it with: sudo systemctl start bluetooth')


def main():
    if sys.version_info < (3, 7):
        sys.exit('Python 3.7 or newer is needed.')
    ap = argparse.ArgumentParser(description='Serve the Globe Haul Shop Tool on localhost.')
    ap.add_argument('--port', type=int, default=8173)
    ap.add_argument('--no-browser', action='store_true', help="don't open a browser")
    args = ap.parse_args()

    if not os.path.isfile(os.path.join(APP, 'index.html')):
        sys.exit('No app/index.html next to this script. Copy the whole laptop folder.')

    handler = functools.partial(Handler, directory=APP)
    try:
        server = http.server.ThreadingHTTPServer(('127.0.0.1', args.port), handler)
    except OSError as e:
        if e.errno == errno.EADDRINUSE:
            sys.exit('Port ' + str(args.port) + ' is in use. Is the tool already running in another window? '
                     'Otherwise try: python3 serve.py --port ' + str(args.port + 1))
        raise

    url = 'http://localhost:' + str(args.port) + '/'
    print('')
    print('Globe Haul Shop Tool: ' + url)
    print('Use it in Chrome or Chromium. Keep this window open while you use the app; Ctrl+C stops it.')
    if sys.platform.startswith('linux'):
        print('If the app says Web Bluetooth is off: open ' + LINUX_FLAG + ', set it to Enabled and relaunch the browser (once).')
    bluetooth_hint()
    print('')
    if not args.no_browser:
        open_browser(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nStopped.')
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
