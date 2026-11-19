#!/usr/bin/env python3
"""
Regenerate the parity fixtures by running reference/globe_capture.py's OWN functions: decode_page,
strip_na, decode_errors, page_req, Session (on_read / on_power replay) and json.dumps for raw.jsonl
lines. The Vitest parity tests compare the TypeScript port with these, field by field. Never hand-edit
the outputs; rerun this instead:

    python tools/make_fixtures.py

Two kinds of output:
- tests/fixtures/py_*.json: from synthetic inputs only (PROTOCOL.md byte examples, the Android tests'
  examples, edge cases, seeded random pages). Committed.
- tests/fixtures/captures/py_capture_*.json: from the real captures in tests/fixtures/captures/
  (the owner's bike). That folder is personal data and git-ignored; without it these are skipped and
  so are the tests that need them.
Nothing in reference/ is modified (no __pycache__ is written there).
"""
import glob
import json
import os
import random
import sys
import tempfile

sys.dont_write_bytecode = True
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REF = os.path.join(ROOT, "reference")
FIX = os.path.join(ROOT, "tests", "fixtures")
CAPTURE_DIR = os.path.join(FIX, "captures")
CAPTURES = sorted(glob.glob(os.path.join(CAPTURE_DIR, "*_raw.jsonl")))
sys.path.insert(0, REF)

import globe_capture as gc  # noqa: E402  (reference client, read-only)

KNOWN_PIDS = list(range(11, 29)) + [5, 6, 7, 8, 9, 10, 40, 51, 52, 53, 54, 55, 56]
ODD_PIDS = [0, 1, 2, 3, 4, 29, 39, 41, 50, 57, 60, 81, 90, 0xBE, 0xED, 255]


def dump(name, obj, folder=FIX):
    path = os.path.join(folder, name)
    with open(path, "w", newline="\n") as fh:
        json.dump(obj, fh, indent=1, sort_keys=True)
        fh.write("\n")
    print("wrote %s" % os.path.relpath(path, ROOT))


def page_case(name, b, with_raw=True):
    raw = gc.decode_page(b)
    out = {"name": name, "hex": bytes(b).hex(), "stripped": gc.strip_na(raw)}
    if with_raw:
        out["raw"] = raw
    return out


def synthetic_pages():
    rng = random.Random(20261118)
    cases = []
    # PROTOCOL.md "Page 56": 38 0001 "202209" ae01 de6a4700 0000 03 ffff (bytes as captured: 38 00 01 ...)
    cases.append(page_case("protocol.md page 56", bytes.fromhex("38000132303232303938c5de6a4700000003ffff")))
    cases.append(page_case("protocol.md page 56 (doc bytes)", bytes.fromhex("38" "0001" "323032323039" "ae01" "de6a4700" "0000" "03" "ffff")))
    # Android GlobeProtocolTest examples
    cases.append(page_case("android page 9", bytes.fromhex("09" "02" "9900" "0000" "14" "92ff" "37ca" "ff" "0000" "7c01" "0000" "0000")))
    cases.append(page_case("android page 7 assist 255", bytes.fromhex("07" "ff" "0000" "0000" "8b010000" "b80b0000" "30330b00" "4d00")))
    cases.append(page_case("android page 10", bytes.fromhex("0a" "01" "0000" "05" "50" "1027" "010000000001" "ff" "00000000" "00")))
    cases.append(page_case("android page 40 sentinels", bytes.fromhex("28" "03" "ffff" "05000000" + "ff" * 12)))
    cases.append(page_case("android page 8 cadence 62", bytes.fromhex("08" "02" "0000" "0000" "00000000" "00000000" "00000000" "3e00")))
    # throttle fault seen live: bit 16 on page 40 and page 55
    cases.append(page_case("page 40 C101 throttle under", bytes.fromhex("2801000000000100ffffffffffffff00ffffffff")))
    cases.append(page_case("page 55 C101 throttle under", bytes.fromhex("3701ff010000000000000100000000000000ffff")))
    for pid in KNOWN_PIDS + ODD_PIDS:
        cases.append(page_case("pid %d zeros" % pid, bytes([pid]) + bytes(19)))
        cases.append(page_case("pid %d ff" % pid, bytes([pid]) + b"\xff" * 19))
        for i in range(4):
            cases.append(page_case("pid %d random %d" % (pid, i), bytes([pid]) + bytes(rng.randrange(256) for _ in range(19))))
        for n in (1, 2, 5, 9, 15, 19):
            cases.append(page_case("pid %d short %d" % (pid, n), (bytes([pid]) + bytes(rng.randrange(256) for _ in range(19)))[:n]))
    # text16 edge cases: Python strip() whitespace incl. \x1c-\x1f, NULs, non-ASCII, text past byte 16
    texts = [
        b" 123456789 ", b"03.06.s0", b"", b"\x1c\x1dAB\x1e\x1f", b"\t\nAB\x0b\x0c\r", b"A\x00B", b"1B\xc3",
        b"ABCDEFGHIJKLMNOPQRS", b"\xff" * 16, b"  \xa0x\xa0  ", b"\x00abc", b"x\x7f",
    ]
    for pid in (16, 19, 24, 28):
        for t in texts:
            p = bytearray(20)
            p[0] = pid
            p[1:1 + min(len(t), 19)] = t[:19]
            cases.append(page_case("text pid %d %r" % (pid, t), bytes(p)))
    # strip_na corner cases: 0xFF on keys outside the NA8 list, 6553.5 on tenth fields
    cases.append(page_case("page 54 all ff but levels", bytes.fromhex("36ff" + "ff" * 18)))
    cases.append(page_case("page 10 ff headlight + batt ff", bytes.fromhex("0aff" "ffff" "ff" "ff" "ffff" "ffffffffffff" "ff" "ffffffff" "ff")))
    return cases


def capture_pages():
    """Every distinct page Session._record_page sees while replaying the captures (cap 150 per pid)."""
    seen = {}
    per_pid = {}

    class Capturing(gc.Session):
        def _record_page(self, p, t=None):
            h = bytes(p).hex()
            if h not in seen and per_pid.get(p[0], 0) < 150:
                seen[h] = bytes(p)
                per_pid[p[0]] = per_pid.get(p[0], 0) + 1
            super()._record_page(p, t)

    for path in CAPTURES:
        replay(path, Capturing)
    return [page_case("capture page %s" % h[:2], b, with_raw=False) for h, b in seen.items()]


def replay(path, cls=gc.Session):
    """cmd_replay, into a throwaway output folder. Returns the closed session."""
    with tempfile.TemporaryDirectory() as tmp:
        sess = cls(os.path.join(tmp, "replay"), "sbc", quiet=True)
        sess.acks = None
        with open(path) as fh:
            for line in fh:
                r = json.loads(line)
                data = bytes.fromhex(r["hex"])
                if r["ch"] == "read":
                    sess.on_read(data, r["t"])
                elif r["ch"] == "power":
                    sess.on_power(data, r["t"])
        sess.close()
        return sess


def replays():
    out = {}
    for path in CAPTURES:
        s = replay(path)
        out[os.path.basename(path)] = {
            "page_counts": {str(k): v for k, v in sorted(s.page_counts.items())},
            "state": s.state,
            "last_error_bits": s.last_error_bits,
        }
    return out


def tx_frames():
    """Every frame the Python client wrote in the captures (for the whitelist test)."""
    out = []
    for path in CAPTURES:
        for line in open(path):
            r = json.loads(line)
            if r["ch"] == "tx":
                out.append({"capture": os.path.basename(path), "hex": r["hex"]})
    return out


def errors():
    rng = random.Random(7)
    masks = [0, 0x00010000, 0x00200000, 0x00000003, 0xFFFFFFFF, 0x00FFFFFF, 0xFF000000, 0x80000001]
    masks += [1 << i for i in range(32)] + [rng.getrandbits(32) for _ in range(20)]
    return [{"bits": m, "decoded": [list(x) for x in gc.decode_errors(m, "sbc")]} for m in masks]


def frames():
    lists = [
        ("identity", gc.OP_ONCE_PAGE, gc.PAGES_IDENTITY),
        ("config", gc.OP_ONCE_PAGE, gc.PAGES_CONFIG),
        ("config+56", gc.OP_ONCE_PAGE, gc.PAGES_CONFIG + [56]),
        ("error page", gc.OP_ONCE_PAGE, [gc.ERROR_PAGE]),
        ("ctrl sw", gc.OP_ONCE_PAGE, [19]),
        ("production", gc.OP_ONCE_PAGE, [56]),
        ("sweep 1-18", gc.OP_ONCE_PAGE, list(range(1, 19))),
        ("sweep 19-28,40,51-56", gc.OP_ONCE_PAGE, list(range(19, 29)) + [40] + list(range(51, 57))),
        ("loop", gc.OP_LOOP_PAGE, gc.PAGES_LOOP),
    ]
    out = [{"name": n, "op": op, "pages": pages, "hex": gc.page_req(op, pages).hex()} for n, op, pages in lists]
    out.append({"name": "mtu page mode", "op": gc.OP_MTU_PAGE_MODE, "pages": [], "hex": bytes([gc.OP_MTU_PAGE_MODE, 1]).hex()})
    for name, t in sorted(gc.SPI_TYPES.items(), key=lambda kv: kv[1]):
        out.append({"name": "dump " + name, "op": gc.OP_DUMP_SPI, "pages": [t], "hex": bytes([gc.OP_DUMP_SPI, t, 0, 0]).hex()})
    return out


def raw_lines():
    # Session.t() is always a float (time.time() - t0), so every t is a float, 0.0 included.
    ts = [0.0, 0.001, 0.5, 1.0, 2.0, 12.345, 100.0, 1234.5, 0.1 + 0.2, 59.999, 3600.0, 7.25, 1e-4, 123456.789]
    out = []
    for i, t in enumerate(ts):
        rec = {"t": round(t, 3), "ch": ["read", "power", "ack", "tx"][i % 4], "hex": "3c020100"}
        out.append({"t": rec["t"], "ch": rec["ch"], "hex": rec["hex"], "line": json.dumps(rec)})
    return out


def main():
    gen = "tools/make_fixtures.py"
    pages = synthetic_pages()
    dump("py_pages.json", {"generator": gen, "cases": pages})
    dump("py_errors.json", {"generator": gen, "cases": errors()})
    dump("py_frames.json", {"generator": gen, "cases": frames()})
    dump("py_rawjsonl.json", {"generator": gen, "cases": raw_lines()})
    print("%d synthetic page cases" % len(pages))
    if not CAPTURES:
        print("No captures in tests/fixtures/captures/: capture fixtures skipped (and so are their tests).")
        return
    cap = capture_pages()
    dump("py_capture_pages.json", {"generator": gen, "cases": cap}, CAPTURE_DIR)
    dump("py_capture_tx.json", {"generator": gen, "capture_tx": tx_frames()}, CAPTURE_DIR)
    dump("py_capture_replay.json", {"generator": gen, "captures": replays()}, CAPTURE_DIR)
    print("%d capture page cases from %d captures" % (len(cap), len(CAPTURES)))


if __name__ == "__main__":
    main()
