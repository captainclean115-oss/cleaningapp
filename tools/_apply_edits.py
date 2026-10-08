#!/usr/bin/env python3
"""Shared helper for precise, verified string-replacement edits to
index.html. Used by the one-off edit scripts in this sprint (salaried
Admin/Office feature) instead of sed, per explicit instruction: sed's
regex matching has already silently hit the wrong occurrence in this
file this session (duplicate function names at different indent
levels), where a plain exact-substring count check catches the mistake
immediately instead of corrupting a 1M+ character file quietly.
"""
import sys

INDEX_HTML = "index.html"


def load():
    with open(INDEX_HTML, "r", encoding="utf-8") as f:
        return f.read()


def save(content):
    with open(INDEX_HTML, "w", encoding="utf-8") as f:
        f.write(content)


def replace_once(content, old, new, label):
    """Replace `old` with `new`, requiring EXACTLY one occurrence of
    `old` in `content`. Raises with a clear message otherwise -- never
    silently matches the wrong (or an extra) occurrence."""
    count = content.count(old)
    if count == 0:
        raise SystemExit(f"FAIL [{label}]: old string not found at all")
    if count > 1:
        raise SystemExit(f"FAIL [{label}]: old string found {count} times (expected exactly 1) -- ambiguous, refusing to guess")
    return content.replace(old, new, 1)


def apply_edits(edits):
    """edits: list of (label, old, new). Applies all sequentially to
    the same in-memory content, verifying each is uniquely present
    BEFORE applying any later edit changes the text further, then
    writes the file once at the end."""
    content = load()
    for label, old, new in edits:
        content = replace_once(content, old, new, label)
        print(f"  ok   {label}")
    save(content)
    print(f"Applied {len(edits)} edit(s) to {INDEX_HTML}")
