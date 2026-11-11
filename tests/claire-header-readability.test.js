// Claire header redesign (PART B) + build-stamp visibility fix.
//
// Bug: the build stamp (and, it turned out, several neighboring
// elements -- the voice-toggle button, the voice-name debug line, the
// voice hint, and the New chat/Clear history buttons) were styled with
// white text/fills (color:#fff, rgba(255,255,255,0.08-0.5)) -- a color
// scheme that only makes sense on a dark background. This app's actual
// page background is solid white (--bg-gradient: #FFFFFF), so all of
// it rendered as a near-invisible white-on-white ghost. Confirmed via
// a live headless screenshot before the fix.
//
// This test reads the real index.html text directly (not a DOM/vm
// extraction -- the fix is almost entirely presentational CSS/HTML,
// so the most direct, reliable check is the markup itself) and asserts:
//   1. No white/near-white text color remains anywhere in Claire's
//      header block (build stamp, voice-name debug line, voice hint,
//      New chat / Clear history buttons).
//   2. The build stamp is at least 12px and uses a real text token.
//   3. The PART B slim header exists: a ~56px flex bar, a 40px avatar
//      override (not the old 140px big-avatar size), and the voice
//      toggle collapsed to an icon-only button (no separate "Voice on"/
//      "Voice off" text label row).
//   4. _claireUpdateVoiceToggleUI (still real, unmodified) gracefully
//      handles the now-removed label span via its existing null guard.
//
// Run with: node tests/claire-header-readability.test.js

const fs = require('fs');
const path = require('path');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(INDEX_HTML, 'utf8');

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label); }
}

function sliceBetween(startMarker, endMarker) {
  const s = src.indexOf(startMarker);
  if (s === -1) { console.error('FAIL: could not find start marker: ' + startMarker); process.exit(1); }
  const e = src.indexOf(endMarker, s);
  if (e === -1) { console.error('FAIL: could not find end marker: ' + endMarker); process.exit(1); }
  return src.slice(s, e);
}

const headerBlock = sliceBetween('<div id="claire-view">', '<div id="claire-messages"');
// The menu sheet (New chat / Clear history / Voice tips) lives AFTER
// #claire-messages / the input row, as the last child of #claire-view --
// headerBlock above deliberately stops before it (it's the always-
// visible portion); this wider slice covers the whole view, menu
// included, for checks that need to see both.
const fullClaireViewBlock = sliceBetween('<div id="claire-view">', '\n<!-- GPS VIEW -->');

// ======================================================================
// 1. No white/near-white text color anywhere in Claire's header block.
// ======================================================================
{
  const whiteTextPatterns = [/color:\s*#fff\b/i, /color:\s*rgba\(255,\s*255,\s*255,\s*0?\.\d+\)/i];
  const offenders = [];
  whiteTextPatterns.forEach((re) => {
    const m = headerBlock.match(new RegExp(re.source, re.flags + 'g'));
    if (m) offenders.push(...m);
  });
  check('no white or near-white text color remains anywhere in Claire\'s header block', offenders.length === 0);
  if (offenders.length) console.log('    found:', offenders);
}

// ======================================================================
// 2. The build stamp is readable: real color token, >= 12px.
// ======================================================================
{
  const stampLine = headerBlock.match(/<div id="claire-build-stamp"[^>]*>/);
  check('the build stamp element exists', !!stampLine);
  const stampCssBlock = sliceBetween('.claire-build-stamp-line {', '}');
  const fontSizeMatch = stampCssBlock.match(/font-size:\s*(\d+)px/);
  check('the build stamp font-size is at least 12px', !!fontSizeMatch && parseInt(fontSizeMatch[1], 10) >= 12);
  check('the build stamp uses a real text color token (var(--muted) or var(--text)), not a literal white', /color:\s*var\(--(muted|text)\)/.test(stampCssBlock));
}

// ======================================================================
// 3. The build stamp renders unconditionally at script-load (from the
//    prior PR), not only inside showTab -- still true, unmodified here.
// ======================================================================
{
  const unconditionalCallIdx = src.indexOf('_claireRenderBuildStamp();\n\n// -----------------------------------------------------------------------\n// CLAIRE SAFETY FOUNDATION');
  check('the build stamp still renders unconditionally at script-load (not gated on the view opening)', unconditionalCallIdx !== -1);
}

// ======================================================================
// 4. PART B: slim ~56px header bar exists with a 40px avatar override.
// ======================================================================
{
  const barCssBlock = sliceBetween('.claire-header-bar {', '}');
  check('the header bar is a flex row with centered cross-axis alignment', /display:\s*flex/.test(barCssBlock) && /align-items:\s*center/.test(barCssBlock));
  check('the header bar is about 56px tall', /min-height:\s*56px/.test(barCssBlock));

  const avatarOverrideBlock = sliceBetween('.claire-header-bar .claire-big-avatar {', '}');
  check('the avatar is shrunk to a small size inside the header bar (not the old 140px big-avatar size)', /width:\s*40px/.test(avatarOverrideBlock) && /height:\s*40px/.test(avatarOverrideBlock));

  const headerBarMarkup = headerBlock.match(/<div class="claire-header-bar">[\s\S]*?<\/button>\s*<\/div>/);
  check('the avatar, identity, and voice button all live inside the SAME header bar markup', !!headerBarMarkup);
}

// ======================================================================
// 5. Voice toggle is now icon-only -- no separate "Voice on"/"Voice off"
//    text row (the label span is gone from markup).
// ======================================================================
{
  check('the separate "Voice on"/"Voice off" text label span no longer exists in markup', headerBlock.indexOf('id="claire-voice-toggle-label"') === -1);
  check('the voice toggle icon span still exists (icon-only button)', headerBlock.indexOf('id="claire-voice-toggle-icon"') !== -1);
  check('the voice toggle button is accessible via aria-label now that there is no visible text label', /id="claire-voice-toggle-btn"[^>]*aria-label=/.test(headerBlock));

  const voiceBtnCssBlock = sliceBetween('.claire-header-voice-btn {', '}');
  check('the voice toggle button is compact (a small icon-sized circle, not a wide pill)', /width:\s*36px/.test(voiceBtnCssBlock) && /border-radius:\s*50%/.test(voiceBtnCssBlock));
}

// ======================================================================
// 6. _claireUpdateVoiceToggleUI (real, unmodified) still works correctly
//    with the label span gone -- its existing null guard handles it.
// ======================================================================
{
  const fnBlock = sliceBetween('function _claireUpdateVoiceToggleUI(enabled) {', '\n}');
  check('_claireUpdateVoiceToggleUI null-guards its label lookup (so removing the span from markup is safe)', /if\s*\(label\)\s*label\.textContent/.test(fnBlock));
  check('_claireUpdateVoiceToggleUI still updates the icon and aria-pressed regardless of the label', /if\s*\(icon\)\s*icon\.textContent/.test(fnBlock) && /btn\.setAttribute\('aria-pressed'/.test(fnBlock));
}

// ======================================================================
// 7. New chat / Clear history buttons and the voice-name debug line are
//    also fixed (found during the same investigation, same root cause).
// ======================================================================
{
  check('"New chat" / "Clear history" buttons use readable text (not white-on-white)', !/New chat<\/button>/.test(fullClaireViewBlock) || fullClaireViewBlock.indexOf('color:var(--text)') !== -1);
  check('the voice-name debug line uses a readable color token', /id="claire-voice-name" style="font-size:\d+px;color:var\(--muted\)/.test(fullClaireViewBlock));
  const voiceHintCssBlock = sliceBetween('.claire-voice-hint {', '}');
  check('the voice-hint base CSS class uses a readable color token', /color:\s*var\(--muted\)/.test(voiceHintCssBlock));
}

// ======================================================================
// 8. Claire cleanup PART 1: header must be a slim bar ONLY. The voice-
//    quality paragraph, the voice-name debug line, and the New chat /
//    Clear history buttons are NOT in the always-visible flow anymore --
//    they live in a closed-by-default "..." menu sheet instead. This is
//    what actually fixes "header still takes 1/3 of the screen": those
//    elements used to always be in the layout (just invisible before the
//    color fix, still taking up vertical space once visible).
// ======================================================================
{
  // The ALWAYS-VISIBLE portion is specifically the header bar + build
  // stamp + waveform/stop-button (mid-speech only) -- everything up to
  // where the menu sheet begins.
  const alwaysVisibleBlock = sliceBetween('<div class="claire-view-stage">', '<div id="claire-menu-overlay"');

  check('the voice-quality paragraph is NOT in the always-visible header', alwaysVisibleBlock.indexOf('id="claire-voice-hint"') === -1);
  check('the voice-name debug line is NOT in the always-visible header', alwaysVisibleBlock.indexOf('id="claire-voice-name"') === -1);
  check('"New chat" is NOT in the always-visible header', alwaysVisibleBlock.indexOf('_claireStartNewChat()') === -1);
  check('"Clear history" is NOT in the always-visible header', alwaysVisibleBlock.indexOf('_claireClearHistory()') === -1);

  check('a "..." menu button exists in the header bar', /id="claire-menu-btn"[^>]*onclick="openClaireMenu\(\)"/.test(headerBlock));

  const menuBlock = sliceBetween('<div id="claire-menu-overlay"', '\n</div>\n\n<!-- GPS VIEW -->');
  check('the menu sheet is closed (display:none) by default', /id="claire-menu-overlay" style="display:none/.test(fullClaireViewBlock));
  check('the menu sheet contains New chat', menuBlock.indexOf('_claireStartNewChat()') !== -1);
  check('the menu sheet contains Clear history', menuBlock.indexOf('_claireClearHistory()') !== -1);
  check('the menu sheet contains a Voice tips item', menuBlock.indexOf('_claireToggleVoiceTips()') !== -1);
  check('the voice-hint paragraph now lives inside the menu sheet', menuBlock.indexOf('id="claire-voice-hint"') !== -1);
  check('the voice-name debug line now lives inside the menu sheet', menuBlock.indexOf('id="claire-voice-name"') !== -1);

  // The voice tip must NOT show unless the user opens that menu item --
  // its own detail container is closed by default, independent of the
  // sheet's own open/closed state.
  check('the voice-tips detail block is closed (display:none) by default -- independent of the sheet itself', /id="claire-voice-tips-detail" style="display:none/.test(fullClaireViewBlock));

  check('openClaireMenu() / closeClaireMenu() / _claireToggleVoiceTips() are all defined', src.indexOf('function openClaireMenu()') !== -1 && src.indexOf('function closeClaireMenu()') !== -1 && src.indexOf('function _claireToggleVoiceTips()') !== -1);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
