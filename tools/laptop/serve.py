#!/usr/bin/env python3
"""Serves the Globe Haul Shop Tool from the "app" folder next to this file on http://localhost:8173/
(localhost is a secure context, so Web Bluetooth works) and opens it in Chrome, Chromium, Edge or Brave.

The Linux launcher (start-shop-tool.sh runs it); Windows uses "Start Shop Tool.cmd". Python 3.7+
standard library only, nothing to install. Listens on 127.0.0.1 only: nothing is reachable from other
computers, and only requests addressed to localhost / 127.0.0.1 are answered (a web page can't reach the
app's files, the firmware included, by pointing its own name at this computer). Ctrl+C (or closing the
terminal) stops it.

Linux, fast Bluetooth: the battery update sends every block and waits for the battery's answer, so its
speed is the Bluetooth connection interval. BlueZ connects at about 60 ms by default (26 minutes for a
battery); the display accepts 7.5 ms. With your OK (sudo), this sets BlueZ's interval for new connections
to 7.5-15 ms (PROTOCOL.md "Speed": /sys/kernel/debug/bluetooth/hci0/conn_min_interval / conn_max_interval)
and puts the old values back when the tool stops, even if the terminal is closed.

    python3 serve.py [--port 8173] [--no-browser] [--fast-bluetooth ask|yes|no] [--hci hci0]
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

# BlueZ's LE connection interval for new connections, in units of 1.25 ms: 6 = 7.5 ms, 12 = 15 ms.
FAST_MIN, FAST_MAX = 6, 12

# Runs as root (sudo). Sets the interval, reports the old values, then waits until the shop tool exits
# (its stdin closes, also when the terminal is closed: HUP / INT are ignored here) and puts them back.
# The kernel refuses min > max, so: set min then max; restore max then min.
FAST_HELPER = r"""
trap '' HUP INT TERM
d="/sys/kernel/debug/bluetooth/$1"
if [ ! -e "$d/conn_min_interval" ] || [ ! -e "$d/conn_max_interval" ]; then echo "missing $d (is debugfs mounted?)"; exit 1; fi
old_min=$(cat "$d/conn_min_interval"); old_max=$(cat "$d/conn_max_interval")
if ! { echo "$2" > "$d/conn_min_interval" && echo "$3" > "$d/conn_max_interval"; }; then
  echo "$old_max" > "$d/conn_max_interval" 2>/dev/null; echo "$old_min" > "$d/conn_min_interval" 2>/dev/null
  echo "refused by the kernel"; exit 1
fi
echo "ok $old_min $old_max"
read _ || true
echo "$old_max" > "$d/conn_max_interval"
echo "$old_min" > "$d/conn_min_interval"
echo "restored"
"""


class FastBluetooth:
    """The fast connection interval while the tool runs (Linux, sudo), put back afterwards."""

    def __init__(self):
        self.proc = None

    @staticmethod
    def ms(units):
        try:
            return '%g' % (int(units) * 1.25)
        except ValueError:
            return units

    def start(self, hci):
        if shutil.which('sudo') is None:
            print('No sudo on this computer: fast Bluetooth not set (updates still work, just slower).')
            return
        print('Setting the fast Bluetooth connection: sudo asks for your password.')
        try:
            self.proc = subprocess.Popen(['sudo', 'sh', '-c', FAST_HELPER, 'fast-bluetooth', hci, str(FAST_MIN), str(FAST_MAX)],
                                         stdin=subprocess.PIPE, stdout=subprocess.PIPE, universal_newlines=True)
            line = (self.proc.stdout.readline() or '').strip()
        except (OSError, KeyboardInterrupt) as e:
            print("Couldn't set the fast Bluetooth connection (" + str(e) + '). Updates still work, just slower.')
            self.stop(quiet=True)
            return
        if line.startswith('ok '):
            _, old_min, old_max = line.split()
            print('Fast Bluetooth on: new connections use 7.5-15 ms (was %s-%s ms). Put back when the tool stops.'
                  % (self.ms(old_min), self.ms(old_max)))
            print('If a bike was already connected, click Reconnect in the app.')
        else:
            print("Couldn't set the fast Bluetooth connection (" + (line or 'no answer') + '). Updates still work, just slower.')
            self.stop(quiet=True)

    def stop(self, quiet=False):
        p, self.proc = self.proc, None
        if p is None:
            return
        try:
            if p.stdin:
                p.stdin.close()
            out = p.stdout.read() if p.stdout else ''
            p.wait(timeout=5)
            if not quiet and 'restored' in out:
                print('Bluetooth connection interval put back.')
        except (OSError, subprocess.SubprocessError, ValueError):
            pass


class Handler(http.server.SimpleHTTPRequestHandler):
    """Static files from app/ only: no directory listings, no caching, no MIME sniffing, localhost only."""

    # Set in main(): the Host headers this server answers ("localhost:8173", "127.0.0.1:8173").
    allowed_hosts = frozenset()

    def send_head(self):
        # DNS rebinding: a web page whose own name resolves to 127.0.0.1 would send its own Host header.
        host = (self.headers.get('Host') or '').strip().lower()
        if host not in self.allowed_hosts:
            self.send_error(403, 'Forbidden')
            return None
        return super().send_head()

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
    ap.add_argument('--fast-bluetooth', choices=['ask', 'yes', 'no'], default='ask',
                    help='Linux: fast Bluetooth connection interval while the tool runs (needs sudo)')
    ap.add_argument('--hci', default='hci0', help='Linux: the Bluetooth adapter for --fast-bluetooth (default hci0)')
    args = ap.parse_args()

    if not os.path.isfile(os.path.join(APP, 'index.html')):
        sys.exit('No app/index.html next to this script. Copy the whole laptop folder.')

    Handler.allowed_hosts = frozenset({'localhost:%d' % args.port, '127.0.0.1:%d' % args.port})
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
    fast = FastBluetooth()
    if sys.platform.startswith('linux') and args.fast_bluetooth != 'no' and args.hci.isalnum():
        want = args.fast_bluetooth == 'yes'
        if args.fast_bluetooth == 'ask' and sys.stdin.isatty():
            try:
                answer = input('Fast Bluetooth for firmware updates (a battery update about 4x faster)? '
                               'Needs your password; undone when the tool stops. [Y/n] ')
            except EOFError:
                answer = 'n'
            want = answer.strip().lower() in ('', 'y', 'yes')
        if want:
            fast.start(args.hci)
    print('')
    if not args.no_browser:
        open_browser(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nStopped.')
    finally:
        server.server_close()
        fast.stop()


if __name__ == '__main__':
    main()
