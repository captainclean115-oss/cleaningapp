#!/usr/bin/env python3
"""Phone + password login feature. Adds a show/hide toggle to
accept-invite.html's two password fields (password rules -- 8+
characters, confirm match -- already existed and are untouched).
"""
PATH = "accept-invite.html"

with open(PATH, "r", encoding="utf-8") as f:
    content = f.read()

OLD_HTML = """    <label for="pw">Create a password (8+ characters)</label>
    <input type="password" id="pw" autocomplete="new-password" autofocus>
    <label for="pw2">Confirm password</label>
    <input type="password" id="pw2" autocomplete="new-password">"""

NEW_HTML = """    <label for="pw">Create a password (8+ characters)</label>
    <div style="position:relative">
      <input type="password" id="pw" autocomplete="new-password" autofocus style="padding-right:56px">
      <button type="button" id="pw-toggle" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:none;color:#6b7280;font-size:12px;font-weight:600;cursor:pointer;padding:4px 6px">Show</button>
    </div>
    <label for="pw2">Confirm password</label>
    <div style="position:relative">
      <input type="password" id="pw2" autocomplete="new-password" style="padding-right:56px">
      <button type="button" id="pw2-toggle" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:none;color:#6b7280;font-size:12px;font-weight:600;cursor:pointer;padding:4px 6px">Show</button>
    </div>"""

if content.count(OLD_HTML) != 1:
    raise SystemExit(f"FAIL: HTML block found {content.count(OLD_HTML)} times, expected 1")
content = content.replace(OLD_HTML, NEW_HTML, 1)

OLD_JS = """  pwEl.addEventListener('input', hideErr);
  pw2El.addEventListener('input', hideErr);"""

NEW_JS = """  pwEl.addEventListener('input', hideErr);
  pw2El.addEventListener('input', hideErr);

  function wireToggle(inputEl, btnEl) {
    btnEl.addEventListener('click', function () {
      var showing = inputEl.type === 'text';
      inputEl.type = showing ? 'password' : 'text';
      btnEl.textContent = showing ? 'Show' : 'Hide';
    });
  }
  var pwToggleBtn = document.getElementById('pw-toggle');
  var pw2ToggleBtn = document.getElementById('pw2-toggle');
  if (pwToggleBtn) wireToggle(pwEl, pwToggleBtn);
  if (pw2ToggleBtn) wireToggle(pw2El, pw2ToggleBtn);"""

if content.count(OLD_JS) != 1:
    raise SystemExit(f"FAIL: JS block found {content.count(OLD_JS)} times, expected 1")
content = content.replace(OLD_JS, NEW_JS, 1)

with open(PATH, "w", encoding="utf-8") as f:
    f.write(content)
print("Applied 2 edit(s) to", PATH)
