#!/usr/bin/env python3
"""Extract every inline <script>...</script> block from index.html (skips
any with a src= attribute or a non-JS type=) and run `node --check` on
each one, using a tempfile per block. Per the hard rule "node --check
every JS block before commit" -- this file has no bundler/build step,
so this is the closest equivalent to a syntax-check CI gate.

Usage: python3 tools/check_js_blocks.py
Exit code 0 if every block parses; non-zero (with details) otherwise.
"""
import re
import subprocess
import sys
import tempfile
import os

INDEX_HTML = os.path.join(os.path.dirname(__file__), "..", "index.html")

SCRIPT_RE = re.compile(r'<script\b([^>]*)>(.*?)</script>', re.DOTALL | re.IGNORECASE)


def main():
    with open(INDEX_HTML, "r", encoding="utf-8") as f:
        html = f.read()

    blocks = []
    for m in SCRIPT_RE.finditer(html):
        attrs = m.group(1)
        body = m.group(2)
        if re.search(r'\bsrc\s*=', attrs, re.IGNORECASE):
            continue
        if re.search(r'type\s*=\s*["\'](?!$|text/javascript|application/javascript)', attrs, re.IGNORECASE):
            continue
        if not body.strip():
            continue
        line_no = html[:m.start()].count("\n") + 1
        blocks.append((line_no, body))

    fail = 0
    for line_no, body in blocks:
        with tempfile.NamedTemporaryFile(suffix=".js", mode="w", delete=False, encoding="utf-8") as tf:
            tf.write(body)
            path = tf.name
        try:
            r = subprocess.run(["node", "--check", path], capture_output=True, text=True)
            if r.returncode != 0:
                fail += 1
                print(f"FAIL  <script> starting at index.html line {line_no}:")
                print("  " + r.stderr.strip().replace("\n", "\n  "))
            else:
                print(f"ok    <script> starting at index.html line {line_no} ({len(body)} chars)")
        finally:
            os.unlink(path)

    print(f"\n{len(blocks) - fail}/{len(blocks)} script blocks OK")
    sys.exit(1 if fail else 0)


if __name__ == "__main__":
    main()
