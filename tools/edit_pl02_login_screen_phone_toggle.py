#!/usr/bin/env python3
"""Phone + password login feature. Adds a phone-mode toggle to the SAME
login screen managers already use (#penta-login-screen) -- not a
separate screen. Email mode (managers, and any employee who prefers it)
is completely unchanged; phone mode is an additional, parallel path.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """    <form id="penta-login-form" autocomplete="on">
      <div style="margin-bottom:14px">
        <label for="penta-login-email" style="display:block;font-size:11px;font-weight:700;color:var(--muted);letter-spacing:.08em;text-transform:uppercase;margin-bottom:6px">Email</label>
        <input id="penta-login-email" type="email" name="email" autocomplete="email" required
          style="width:100%;padding:12px 14px;background:var(--surface2);border:1px solid var(--border);border-radius:10px;color:var(--text);font-size:15px;font-family:inherit;box-sizing:border-box">
      </div>

      <div style="margin-bottom:20px">
        <label for="penta-login-password" style="display:block;font-size:11px;font-weight:700;color:var(--muted);letter-spacing:.08em;text-transform:uppercase;margin-bottom:6px">Password</label>
        <input id="penta-login-password" type="password" name="password" autocomplete="current-password" required
          style="width:100%;padding:12px 14px;background:var(--surface2);border:1px solid var(--border);border-radius:10px;color:var(--text);font-size:15px;font-family:inherit;box-sizing:border-box">
      </div>

      <button type="submit" id="penta-login-submit"
        style="width:100%;padding:13px;background:#5E5CE6;border:none;border-radius:10px;color:#fff;font-size:15px;font-weight:600;cursor:pointer;font-family:inherit">
        Sign in
      </button>

      <div id="penta-login-error" style="display:none;margin-top:12px;padding:10px;background:rgba(220,38,38,0.12);border:1px solid rgba(220,38,38,0.35);border-radius:8px;color:#fca5a5;font-size:13px"></div>
    </form>

    <div style="margin-top:20px;text-align:center;display:flex;flex-direction:column;gap:10px">
      <a href="#" id="penta-login-forgot-link" style="color:var(--muted);font-size:13px;text-decoration:none">Forgot password?</a>
      <button onclick="appGoApply()" style="background:none;border:none;color:var(--muted);font-family:inherit;font-size:13px;cursor:pointer;text-decoration:underline">
        Interested in joining our team? Apply here
      </button>
    </div>"""

NEW = """    <form id="penta-login-form" autocomplete="on">
      <div style="margin-bottom:14px" id="penta-login-email-field">
        <label for="penta-login-email" style="display:block;font-size:11px;font-weight:700;color:var(--muted);letter-spacing:.08em;text-transform:uppercase;margin-bottom:6px">Email</label>
        <input id="penta-login-email" type="email" name="email" autocomplete="email" required
          style="width:100%;padding:12px 14px;background:var(--surface2);border:1px solid var(--border);border-radius:10px;color:var(--text);font-size:15px;font-family:inherit;box-sizing:border-box">
      </div>

      <div style="margin-bottom:14px;display:none" id="penta-login-phone-field">
        <label for="penta-login-phone" style="display:block;font-size:11px;font-weight:700;color:var(--muted);letter-spacing:.08em;text-transform:uppercase;margin-bottom:6px">Phone Number</label>
        <input id="penta-login-phone" type="tel" name="phone" autocomplete="tel" inputmode="numeric" placeholder="(555) 555-5555"
          style="width:100%;padding:12px 14px;background:var(--surface2);border:1px solid var(--border);border-radius:10px;color:var(--text);font-size:15px;font-family:inherit;box-sizing:border-box">
      </div>

      <div style="margin-bottom:20px">
        <label for="penta-login-password" style="display:block;font-size:11px;font-weight:700;color:var(--muted);letter-spacing:.08em;text-transform:uppercase;margin-bottom:6px">Password</label>
        <input id="penta-login-password" type="password" name="password" autocomplete="current-password" required
          style="width:100%;padding:12px 14px;background:var(--surface2);border:1px solid var(--border);border-radius:10px;color:var(--text);font-size:15px;font-family:inherit;box-sizing:border-box">
      </div>

      <button type="submit" id="penta-login-submit"
        style="width:100%;padding:13px;background:#5E5CE6;border:none;border-radius:10px;color:#fff;font-size:15px;font-weight:600;cursor:pointer;font-family:inherit">
        Sign in
      </button>

      <div id="penta-login-error" style="display:none;margin-top:12px;padding:10px;background:rgba(220,38,38,0.12);border:1px solid rgba(220,38,38,0.35);border-radius:8px;color:#fca5a5;font-size:13px"></div>
    </form>

    <div style="margin-top:20px;text-align:center;display:flex;flex-direction:column;gap:10px">
      <a href="#" id="penta-login-forgot-link" style="color:var(--muted);font-size:13px;text-decoration:none">Forgot password?</a>
      <a href="#" id="penta-login-mode-toggle" style="color:var(--muted);font-size:13px;text-decoration:none">Sign in with phone number instead</a>
      <button onclick="appGoApply()" style="background:none;border:none;color:var(--muted);font-family:inherit;font-size:13px;cursor:pointer;text-decoration:underline">
        Interested in joining our team? Apply here
      </button>
    </div>"""

EDITS = [("Login screen: phone-mode field + toggle link", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
