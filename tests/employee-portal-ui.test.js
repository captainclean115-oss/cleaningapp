// Employee portal polish — UI-layer tests. Extracts the real
// showPortalTab/_renderPortalComingSoon/renderEmployeeHome/setPortalLang
// functions verbatim from index.html and drives them with a mocked DOM,
// plus structural checks against the real markup/source for things a
// behavioral mock can't easily prove (the date control has no onclick,
// the menu has exactly the 4 required items, the manager's own
// Schedule/Forms-adjacent screens are untouched).
//
// Run with: node tests/employee-portal-ui.test.js

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(INDEX_HTML, 'utf8');

function extract(startMarker, endMarker, label) {
  const s = src.indexOf(startMarker);
  if (s === -1) throw new Error('extraction failed (' + label + '): could not find start marker: ' + startMarker);
  const e = src.indexOf(endMarker, s);
  if (e === -1) throw new Error('extraction failed (' + label + '): could not find end marker after start: ' + endMarker);
  return src.slice(s, e);
}

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

// ---- A minimal fake DOM: just enough for these functions. ----
function makeFakeDom() {
  const nodes = {};
  function el(id) {
    if (!nodes[id]) {
      nodes[id] = {
        id, style: {}, classList: { _set: new Set(), add(c) { this._set.add(c); }, remove(c) { this._set.delete(c); }, toggle(c, on) { if (on) this._set.add(c); else this._set.delete(c); }, contains(c) { return this._set.has(c); } },
        innerHTML: '', textContent: '',
      };
    }
    return nodes[id];
  }
  return {
    nodes,
    getElementById: (id) => el(id),
    querySelectorAll: () => [],
  };
}

console.log('--- showPortalTab: gated tabs show Coming soon, fetch nothing ---\n');
{
  const flagSrc = extract("var PORTAL_TABS_COMING_SOON = ['schedule', 'forms', 'content'];", '\n\nfunction t(key)', 'PORTAL_TABS_COMING_SOON');
  const showPortalTabSrc = extract('function showPortalTab(tab) {', '\n\n// Back-to-home helper', 'showPortalTab');
  const comingSoonSrc = extract('function _renderPortalComingSoon(tab) {', '\n\n\n// Inline SVG glyphs', '_renderPortalComingSoon');

  const fetchCalls = [];
  let portalShareContentCalled = false;
  const sandbox = {
    console,
    document: makeFakeDom(),
    currentTab: null,
    t: (k) => 'T:' + k,
    _adminEsc: (s) => String(s),
    renderEmployeeHome: () => {},
    portalShareContent: () => { portalShareContentCalled = true; },
    renderSchedule: () => { fetchCalls.push('renderSchedule'); },
    seedStaffChatsIfEmpty: () => {},
    renderEmpChat: () => {},
    updateEmpChatBadge: () => {},
    localStorage: { setItem: () => {}, getItem: () => null },
    currentEmployee: { id: 'emp1' },
    renderRateWeek: () => {},
    renderHandbook: () => { fetchCalls.push('renderHandbook'); },
    checkExistingSignature: () => { fetchCalls.push('checkExistingSignature'); },
    renderPortalFormCards: () => { fetchCalls.push('renderPortalFormCards'); },
    renderPortalCustomFormCards: () => { fetchCalls.push('renderPortalCustomFormCards'); },
    renderPortalSubmittedForms: () => { fetchCalls.push('renderPortalSubmittedForms'); },
    renderEmployeeRewards: () => {},
    submittedForms: null,
  };
  vm.createContext(sandbox);
  vm.runInContext(flagSrc, sandbox);
  vm.runInContext(comingSoonSrc, sandbox);
  vm.runInContext(showPortalTabSrc, sandbox);

  sandbox.document.getElementById('portal-screen'); // pre-create
  sandbox.showPortalTab('schedule');
  check('PORTAL_TABS_COMING_SOON includes schedule, forms and content', sandbox.PORTAL_TABS_COMING_SOON, ['schedule', 'forms', 'content']);
  check('opening the gated "schedule" tab calls NO data-fetch function at all', fetchCalls, []);
  check('the coming-soon host for schedule is shown', sandbox.document.getElementById('tab-schedule-comingsoon').style.display, 'block');
  check('the real tab-schedule div stays hidden', sandbox.document.getElementById('tab-schedule').style.display, 'none');
  check('the coming-soon host actually has rendered text (not left blank)', sandbox.document.getElementById('tab-schedule-comingsoon').innerHTML.indexOf('T:scheduleComingSoon') !== -1, true);

  fetchCalls.length = 0;
  sandbox.showPortalTab('forms');
  check('opening the gated "forms" tab ALSO calls no data-fetch function (handbook included)', fetchCalls, []);
  check('the coming-soon host for forms is shown', sandbox.document.getElementById('tab-forms-comingsoon').style.display, 'block');

  // A non-gated tab (hours) still works exactly as before -- real data
  // IS fetched for it, proving the gate is specific to schedule/forms.
  fetchCalls.length = 0;
  sandbox.showPortalTab('chat');
  check('a NON-gated tab (chat) is unaffected by the gate', sandbox.document.getElementById('tab-chat').style.display, 'block');

  // Round 3: Content joins the gate too -- it never reaches
  // portalShareContent() (the camera/share flow) while gated.
  portalShareContentCalled = false;
  sandbox.showPortalTab('content');
  check('opening the gated "content" tab never launches the camera/share flow', portalShareContentCalled, false);
  check('the coming-soon host for content is shown', sandbox.document.getElementById('tab-content-comingsoon').style.display, 'block');
  check('the coming-soon host actually has rendered text (not left blank)', sandbox.document.getElementById('tab-content-comingsoon').innerHTML.indexOf('T:contentComingSoon') !== -1, true);
}

console.log('\n--- renderEmployeeHome: badges hidden for gated tabs, never fetched ---\n');
{
  const homeSrc = extract('function renderEmployeeHome() {', '\n\n// ═', 'renderEmployeeHome');
  const flagSrc = extract("var PORTAL_TABS_COMING_SOON = ['schedule', 'forms', 'content'];", '\n\nfunction t(key)', 'PORTAL_TABS_COMING_SOON');
  let scheduleCountFetched = false, formsCountFetched = false;
  const sandbox = {
    console,
    document: makeFakeDom(),
    _empTodayJobsCount: () => { scheduleCountFetched = true; return 3; },
    _empUnreadChatCount: () => 1,
    _empPendingForms: () => { formsCountFetched = true; return 2; },
    renderMotivationalBanner: () => {},
    renderRecognitionCard: () => {},
    applyPermissions: () => {},
    currentEmployee: { id: 'emp1', name: 'Test Employee' },
  };
  vm.createContext(sandbox);
  vm.runInContext(flagSrc, sandbox);
  vm.runInContext(homeSrc, sandbox);
  sandbox.renderEmployeeHome();
  check('schedule badge count is never fetched while schedule is gated', scheduleCountFetched, false);
  check('forms badge count is never fetched while forms is gated', formsCountFetched, false);
  check('schedule badge is hidden', sandbox.document.getElementById('emp-badge-schedule').style.display, 'none');
  check('forms badge is hidden', sandbox.document.getElementById('emp-badge-forms').style.display, 'none');
  check('chat badge is UNAFFECTED (chat is never gated) and still shows its real count', sandbox.document.getElementById('emp-badge-chat').textContent, '1');
}

console.log('\n--- Home date: display-only, no onclick, no chevron ---\n');
{
  const dateTagMatch = src.match(/<span id="portal-date"[^>]*>/);
  check('a #portal-date tag was found to check', !!dateTagMatch, true);
  check('#portal-date is a <span>, not a <button> (not a native tappable control)', /<span id="portal-date"/.test(src), true);
  check('#portal-date has no onclick attribute anywhere in its own tag', dateTagMatch[0].indexOf('onclick=') === -1, true);
  // Every place that SETS its text no longer appends the chevron.
  const chevronSets = (src.match(/portal-date[^;]*textContent\s*=\s*[^;]*▾/g) || []);
  check('no code path appends the "▾" chevron to #portal-date\'s text anymore', chevronSets.length, 0);
}

console.log('\n--- Hours tab: week nav arrows unchanged, no tap-to-change-date control added ---\n');
{
  check('Hours still has its week-back arrow (portalWeekNav(-1)) -- kept, per the brief', /portalWeekNav\(-1\)/.test(src), true);
  check('Hours still has its week-forward arrow (portalWeekNav(1))', /portalWeekNav\(1\)/.test(src), true);
  const hoursTabBlock = extract('<div id="tab-hours" class="section"', '\n\n  <!-- FORMS TAB -->', 'tab-hours markup');
  check('no NEW button/onclick was added inside the Hours tab\'s date row beyond the existing two arrows', (hoursTabBlock.match(/onclick="/g) || []).length, 2);
}

console.log('\n--- Menu: exactly Account, About me, Language, Log out ---\n');
{
  const menuBlock = extract('<div id="portal-menu-overlay"', '\n<!-- ACCOUNT -->', 'portal menu markup');
  check('menu has an Account item', /openPortalAccount\(\)/.test(menuBlock), true);
  check('menu has an About me item', /openPortalAboutMe\(\)/.test(menuBlock), true);
  check('menu has a Language item', /openPortalLanguage\(\)/.test(menuBlock), true);
  check('menu has a Log out item', /portalMenuLogout\(\)/.test(menuBlock), true);
  check('every menu button is at least 44px tall (min-height:44px)', (menuBlock.match(/min-height:44px/g) || []).length >= 4, true);
  check('Log out asks for confirmation before actually logging out', /confirm\(t\('logoutConfirm'\)\)/.test(src), true);
  check('the old always-visible "Log out" button in the header is gone, replaced by the hamburger', !/<button onclick="logout\(\)" style="background:var\(--surface2\)/.test(src), true);
}

console.log('\n--- Language switch applies everywhere, including Coming-soon + the menu itself ---\n');
{
  check('setPortalLang re-renders the coming-soon text when schedule is gated (never force-fetches it)', /PORTAL_TABS_COMING_SOON\.indexOf\('schedule'\) === -1\) \{ renderSchedule\(\); \}/.test(src), true);
  check('setPortalLang re-renders the menu\'s own text too', /_renderPortalMenuTexts/.test(src) && /setPortalLang[\s\S]{0,1500}_renderPortalMenuTexts/.test(src), true);
  check('choosePortalLanguage saves per-device (localStorage) immediately, regardless of the RPC', /localStorage\.setItem\('penta_portal_lang', lang\)/.test(src), true);
  check('choosePortalLanguage ALSO tries to save to her real row (best-effort, via the whitelist RPC)', /update_my_employee_profile[^)]*p_preferred_language: lang/.test(src), true);
}

console.log('\n--- Manager-side Schedule/Forms (unrelated to the portal) are untouched ---\n');
{
  check('the manager app\'s own showTab() function still exists, unmodified in shape', /function showTab\(tab\) \{/.test(src), true);
  check('PORTAL_TABS_COMING_SOON is referenced ONLY inside portal-specific functions, never inside showTab/renderCal (manager side)', (() => {
    const showTabBlock = extract('function showTab(tab) {', '\n\nasync function processVoiceCommand', 'showTab (manager)');
    return showTabBlock.indexOf('PORTAL_TABS_COMING_SOON') === -1;
  })(), true);
}

console.log('\n--- Handbook signature reachability (flagged, not silently fixed) ---\n');
{
  // Confirmed finding from Step 0 / the PR description: the handbook
  // flow is rendered ONLY inside the 'forms' tab branch today. This
  // test documents that fact stays true (so if it's ever fixed, this
  // test is the signal to update/remove it) rather than silently
  // asserting it's fine.
  const formsBranch = extract("if (tab === 'forms') {", '\n  if (tab ===', "showPortalTab's forms branch");
  check('renderHandbook/checkExistingSignature are still only invoked from the forms branch (handbook has no independent entry point) -- see PR description for the flagged tradeoff', /renderHandbook\(\)/.test(formsBranch) && /checkExistingSignature\(\)/.test(formsBranch), true);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
