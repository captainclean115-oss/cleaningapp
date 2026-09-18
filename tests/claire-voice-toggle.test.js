// Feature: Claire voice on/off toggle. Tom: "doesn't want to hear her speak
// most of the time -- reading her responses is faster." Requirements:
//   1. Toggle in Claire's own view (no existing settings screen to hook
//      into -- confirmed by full-file search before implementing).
//   2. Default ON (matches current behavior for anyone who never touches it).
//   3. OFF skips text-to-speech only -- the text bubble always still renders.
//   4. Persisted per-user in Supabase, not just localStorage.
//   5. Same setting works across devices via realtime sync.
//
// Implementation: reuses the EXISTING window.PentaSettings facade
// (public.users.settings jsonb, already used for claire_photo/rc_token/etc
// -- no new column) rather than a bespoke new column/table, and adds a
// postgres_changes subscription to PentaSettings itself (it previously only
// synced on load()/set(), never on a change from another device) so the
// toggle reaches an already-open tab on a different device live.
//
// This test extracts _claireVoiceEnabled/toggleClaireVoice/
// _claireUpdateVoiceToggleUI/claireSpeak and the full window.PentaSettings
// IIFE verbatim from index.html and exercises them against mocked
// localStorage/DOM/Supabase -- same technique as
// tests/emp-schedule-integration-melissa.test.js (real IIFE, mocked infra).
//
// Run with: node tests/claire-voice-toggle.test.js

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(INDEX_HTML, 'utf8');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

function extract(startMarker, endMarker, fromIdx) {
  const s = src.indexOf(startMarker, fromIdx || 0);
  if (s === -1) { console.error('FAIL: could not find start marker: ' + startMarker); process.exit(1); }
  const e = src.indexOf(endMarker, s);
  if (e === -1) { console.error('FAIL: could not find end marker: ' + endMarker); process.exit(1); }
  return src.slice(s, e + (endMarker.length || 0));
}

// ==== window.PentaSettings, verbatim IIFE ====
const pentaSettingsSrc = extract('window.PentaSettings = (function() {', '\n})();\n');
check('claire_voice_enabled was added to PentaSettings.SYNC_KEYS', pentaSettingsSrc.indexOf("'claire_voice_enabled'") !== -1, true);
check('PentaSettings now sets up a realtime subscription (cross-device sync requirement)', pentaSettingsSrc.indexOf('_setupRealtime') !== -1, true);
check('the realtime filter scopes to the signed-in user\'s OWN row only (never another user\'s)', pentaSettingsSrc.indexOf("filter: 'id=eq.' + uid") !== -1, true);

// ==== The voice-toggle helper functions, verbatim ====
const voiceEnabledSrc = extract('function _claireVoiceEnabled() {', '\n}\n');
const toggleSrc = extract('function toggleClaireVoice() {', '\n}\n');
const updateUiSrc = extract('function _claireUpdateVoiceToggleUI(enabled) {', '\n}\n');
const claireSpeakSrc = extract('function claireSpeak(text) {', '\n}\n');

function makeDom() {
  const els = {};
  function makeEl(id) {
    return els[id] || (els[id] = { id, textContent: '', _attrs: {}, setAttribute(k, v) { this._attrs[k] = v; }, getAttribute(k) { return this._attrs[k]; } });
  }
  return { getElementById: (id) => makeEl(id), _els: els };
}

// ---- _claireVoiceEnabled(): defaults ON, only 'false' turns it OFF ----
{
  function run(getReturn) {
    const sandbox = { window: { PentaSettings: { get: () => getReturn } } };
    vm.createContext(sandbox);
    vm.runInContext(voiceEnabledSrc + '\nvar __r = _claireVoiceEnabled();', sandbox);
    return sandbox.__r;
  }
  check('unset (null, brand new user) defaults to voice ON', run(null), true);
  check('unset (undefined) defaults to voice ON', run(undefined), true);
  check('explicit string "false" turns voice OFF', run('false'), false);
  check('explicit string "true" is voice ON', run('true'), true);
  check('no window.PentaSettings at all still defaults ON (never throws)', (() => {
    const sandbox = { window: {} };
    vm.createContext(sandbox);
    vm.runInContext(voiceEnabledSrc + '\nvar __r = _claireVoiceEnabled();', sandbox);
    return sandbox.__r;
  })(), true);
}

// ---- claireSpeak(): OFF skips speechSynthesis entirely; text rendering
// (claireReply's _claireRenderBubble call) is a SEPARATE, earlier step
// claireSpeak has no control over, so this only needs to prove speech
// itself is skipped. ----
{
  function run(voiceEnabled) {
    const spoken = [];
    const sandbox = {
      window: {
        PentaSettings: { get: () => (voiceEnabled ? 'true' : 'false') },
        speechSynthesis: {
          cancel: () => {},
          speak: (u) => spoken.push(u.text),
          getVoices: () => [],
        },
      },
      SpeechSynthesisUtterance: function (t) { this.text = t; },
      document: { getElementById: () => null },
      console,
      _claireVoice: null,
      _pickClaireVoice: () => null,
      _claireStripForSpeech: (t) => t,
      _claireSetSpeakingUI: () => {},
    };
    sandbox.window.speechSynthesis['speechSynthesis in window'] = true;
    vm.createContext(sandbox);
    // '('speechSynthesis' in window)' needs the property to literally exist on window.
    vm.runInContext(voiceEnabledSrc + '\n' + claireSpeakSrc + "\nclaireSpeak('Saved hours for Nadia. Done.');", sandbox);
    return spoken;
  }
  check('voice ON: claireSpeak actually calls speechSynthesis.speak', run(true).length, 1);
  check('voice OFF: claireSpeak skips speechSynthesis.speak entirely -- text-only', run(false).length, 0);
}

// ---- toggleClaireVoice(): flips state, persists via PentaSettings.set as
// the string 'true'/'false' (matching every other PentaSettings-backed
// flag's convention), updates the button immediately, and cuts off
// in-flight speech when turning OFF mid-sentence. ----
{
  function run(startEnabled) {
    const setCalls = [];
    const cancelCalls = [];
    const speakingUiCalls = [];
    const dom = makeDom();
    const sandbox = {
      window: {
        PentaSettings: { get: () => (startEnabled ? 'true' : 'false'), set: (k, v) => { setCalls.push([k, v]); return Promise.resolve(true); } },
        speechSynthesis: { cancel: () => cancelCalls.push(true) },
      },
      document: dom,
      console,
      _claireSetSpeakingUI: (on) => speakingUiCalls.push(on),
    };
    vm.createContext(sandbox);
    vm.runInContext(voiceEnabledSrc + '\n' + updateUiSrc + '\n' + toggleSrc + '\ntoggleClaireVoice();', sandbox);
    return { setCalls, cancelCalls, speakingUiCalls, dom };
  }

  const offResult = run(true); // was ON, toggling to OFF
  check('toggling ON->OFF persists claire_voice_enabled="false" (string, matching convention)', offResult.setCalls, [['claire_voice_enabled', 'false']]);
  check('toggling to OFF cuts off any in-flight speech (speechSynthesis.cancel called)', offResult.cancelCalls.length, 1);
  check('toggling to OFF resets the speaking UI state', offResult.speakingUiCalls, [false]);
  check('the button icon updates to muted immediately (no DB round-trip wait)', offResult.dom._els['claire-voice-toggle-icon'].textContent, '🔇');
  check('the button label updates to "Voice off"', offResult.dom._els['claire-voice-toggle-label'].textContent, 'Voice off');
  check('aria-pressed reflects the new OFF state', offResult.dom._els['claire-voice-toggle-btn'].getAttribute('aria-pressed'), 'false');

  const onResult = run(false); // was OFF, toggling to ON
  check('toggling OFF->ON persists claire_voice_enabled="true"', onResult.setCalls, [['claire_voice_enabled', 'true']]);
  check('toggling to ON does NOT call speechSynthesis.cancel (nothing was playing to interrupt turning voice back on)', onResult.cancelCalls.length, 0);
  check('the button icon updates to speaker-on immediately', onResult.dom._els['claire-voice-toggle-icon'].textContent, '🔊');
  check('the button label updates to "Voice on"', onResult.dom._els['claire-voice-toggle-label'].textContent, 'Voice on');
}

// ==== Toggle button markup exists in Claire's own view (no other settings
// screen exists to hook into -- confirmed by research before implementing) ====
check('a voice toggle button is present in #claire-view', src.indexOf('id="claire-voice-toggle-btn"') !== -1, true);
check('the toggle button is wired to toggleClaireVoice()', src.indexOf('onclick="toggleClaireVoice()"') !== -1, true);
{
  const viewStart = src.indexOf('<div id="claire-view">');
  const viewEnd = src.indexOf('<!-- GPS VIEW -->', viewStart);
  const viewSrc = src.slice(viewStart, viewEnd);
  check('the toggle button lives INSIDE #claire-view (not some unrelated screen)', viewSrc.indexOf('claire-voice-toggle-btn') !== -1, true);
  check('unlike #claire-stop-btn, the toggle has no display:none -- always visible, can be flipped mid-conversation', !/id="claire-voice-toggle-btn"[^>]*display:\s*none/.test(viewSrc), true);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
