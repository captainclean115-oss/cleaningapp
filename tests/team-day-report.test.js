// Team Day Report v2 (team-day-report-v2 branch, PR #211): redesigned
// from a row-per-employee table (PR #210) into one block per team per
// day that reads like the Team Hours modal's own GPS activity timeline
// -- same stop list, same labels (_renderGPSStopRow itself, called
// with readOnly:true so this report can never trigger its "Not lunch"/
// "Mark as lunch" write). Adds a downloadable PDF (jsPDF, text/vector
// drawing).
//
// team-day-report-files-entry branch: the second entry point moved
// from the manager Forms area to the manager Files screen
// (FILES_LIST/renderFilesGrid, "Reports & documents") -- the Forms
// entry no longer exists at all.
//
// This test extracts the real _teamHoursEligibility, dateKey,
// _hrCsvField, _renderGPSStopRow, FILES_LIST/renderFilesGrid, and the
// whole v2 Team Day Report module verbatim from index.html. A minimal
// FakeJsPDF stub stands in for the real jsPDF (loaded via CDN in the
// browser, not available in Node) so _tdrBuildPdf/_tdrBlockLines/
// _tdrMeasureLines/_tdrDrawLines -- the real functions -- can be
// exercised directly; only the rendering backend is faked, never the
// report logic itself.
//
// Run with: node tests/team-day-report.test.js

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(INDEX_HTML, 'utf8');

function extract(startMarker, endMarker, label) {
  const s = src.indexOf(startMarker);
  if (s === -1) { console.error('FAIL: could not find start "' + startMarker + '" (' + label + ')'); process.exit(1); }
  const e = src.indexOf(endMarker, s);
  if (e === -1) { console.error('FAIL: could not find end boundary for ' + label); process.exit(1); }
  return src.slice(s, e);
}

const eligSource = extract('function _teamHoursEligibility(team, dateStr) {', '\n\n// PR #118', 'Team Hours eligibility block');
const dateKeySource = extract('function dateKey(d) {', '\n\nfunction jobsForDate', 'dateKey');
const hrCsvFieldSource = extract('function _hrCsvField(s) {', '\n\n// Tom: Export Hours Report always used', '_hrCsvField');
const stopRowSource = extract('function _renderGPSStopRow(s, includeDriveInfo, ctx) {', '\n\nfunction renderGPS() {', '_renderGPSStopRow');
const filesSource = extract('var FILES_LIST = [', '\n\nfunction openFileDetail', 'FILES_LIST/renderFilesGrid');
const tdrSource = extract('var TDR_MAX_RANGE_DAYS = 31;', '\nfunction openTeamDayReport() {', 'Team Day Report v2 module');

const fnSource = eligSource + '\n' + dateKeySource + '\n' + hrCsvFieldSource + '\n' + stopRowSource + '\n' + filesSource + '\n' + tdrSource;

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}
function checkTrue(label, cond) { check(label, !!cond, true); }

// Minimal stand-in for jsPDF's instance API -- only the methods
// _tdrBuildPdf/_tdrBlockLines/_tdrDrawLines actually call. Records every
// doc.text() call per page so tests can assert on real PDF content
// without a real PDF renderer (not available in Node / not bundled).
function FakeJsPDF() {
  var self = this;
  this._pages = [[]];
  this._curPage = 0;
  this.internal = {
    pageSize: { getWidth: function () { return 612; }, getHeight: function () { return 792; } },
    getNumberOfPages: function () { return self._pages.length; }
  };
}
FakeJsPDF.prototype.setFont = function () {};
FakeJsPDF.prototype.setFontSize = function () {};
FakeJsPDF.prototype.setTextColor = function () {};
FakeJsPDF.prototype.setDrawColor = function () {};
FakeJsPDF.prototype.line = function () {};
FakeJsPDF.prototype.text = function (txt) { this._pages[this._curPage].push(txt); };
FakeJsPDF.prototype.addPage = function () { this._pages.push([]); this._curPage = this._pages.length - 1; };
FakeJsPDF.prototype.setPage = function (p) { this._curPage = p - 1; };
FakeJsPDF.prototype.splitTextToSize = function (text) {
  // Deterministic word-wrap at ~60 chars -- enough to exercise
  // multi-line wrapping without needing real font metrics.
  var words = String(text).split(' ');
  var lines = [], cur = '';
  words.forEach(function (w) {
    var next = cur ? cur + ' ' + w : w;
    if (next.length > 60) { lines.push(cur); cur = w; } else { cur = next; }
  });
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
};
FakeJsPDF.prototype.save = function (filename) { this._savedFilename = filename; };

// ── Fixtures ──
const ROSTER = [
  { id: 'e1', name: 'Alice', uuid: 'uuid-alice', defaultTeam: 'B1' },
  { id: 'e2', name: 'Bob', uuid: 'uuid-bob', defaultTeam: 'B1' },
  { id: 'e3', name: 'Cara', uuid: 'uuid-cara', defaultTeam: 'B1' }, // on vacation this date
  { id: 'e4', name: 'Dana', uuid: 'uuid-dana', defaultTeam: 'B1' }, // terminated as of this date
  { id: 'e5', name: 'Eve', uuid: 'uuid-eve', defaultTeam: 'S1' },
];

function buildSandbox(opts) {
  opts = opts || {};
  const overrides = opts.overrides || {}; // empId -> { start, end, lunch }
  const gpsResults = opts.gpsResults || {}; // 'team|date' -> detail object, or an Error to throw
  const lunchOverrides = opts.lunchOverrides || {}; // 'team|date|stopKey' -> { override_type }
  const elements = Object.assign({
    'team-day-report-btn': { style: {} },
    'files-grid': { innerHTML: '' },
  }, opts.elements || {});
  const calls = [];

  const sandbox = {
    console,
    document: { getElementById: function (id) { return Object.prototype.hasOwnProperty.call(elements, id) ? elements[id] : null; } },
    alert: function (msg) { calls.push(['alert', msg]); },
    window: {
      PentaEmployees: { getByLegacyRosterId: function () { return null; } },
      PentaLunchFlags: { getOverride: function (team, dateStr, stopKey) { return lunchOverrides[team + '|' + dateStr + '|' + stopKey] || null; } },
      jspdf: { jsPDF: FakeJsPDF },
      PentaTenant: { name: function () { return opts.bizName || 'Fixture Cleaning Co'; } },
    },

    getUnifiedRoster: function () { return ROSTER.slice(); },
    getEmployeeTeam: function (empId) {
      if (empId === 'e3' || empId === 'e4') return null; // off/terminated -> not on any team today
      var emp = ROSTER.find(function (e) { return e.id === empId; });
      return emp ? emp.defaultTeam : null;
    },
    getRosterTermData: function () { return { e4: { status: 'terminated' } }; },
    getEmployeeDayOffInfo: function (empId) { return empId === 'e3' ? { status_type: 'vacation' } : null; },
    DAY_OFF_CATEGORY_LABELS: { vacation: 'Vacation' },

    getEmpHours: function (empId) { return overrides[empId] || null; },
    _fetchTeamDayGpsDetail: function (team, dateStr) {
      calls.push(['_fetchTeamDayGpsDetail', team, dateStr]);
      var key = team + '|' + dateStr;
      var v = gpsResults[key];
      if (v instanceof Error) return Promise.reject(v);
      return Promise.resolve(v || { device: null, resolved: {}, trips: [], stopList: [], gps: { available: false, reason: 'No GPS device assigned' } });
    },
    matchStopToClientGeo: function (lat, lng, addr) {
      if (opts.clientMatchFor && opts.clientMatchFor[addr]) return opts.clientMatchFor[addr];
      return null;
    },
    jobs: opts.jobs || [],
    _pentaTeamNames: function () { return opts.teams || ['B1']; },
    _pentaBusinessTimezone: function () { return 'America/New_York'; },
    _bizHM: function (date) {
      var d = (date instanceof Date) ? date : new Date(date);
      return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
    },
    _adminEsc: function (s) { return String(s); },
    getCurrentAppRole: function () { return opts.role !== undefined ? opts.role : 'owner'; },
  };
  vm.createContext(sandbox);
  vm.runInContext(fnSource, sandbox);
  return { sandbox, calls, elements };
}

async function main() {
  // ── Timeline order/labels match the modal's own stop-row renderer ──
  {
    const { sandbox } = buildSandbox({
      clientMatchFor: { '123 Main St': { name: 'Jane Smith', id: 'c1', scheduled: true } },
    });
    const stops = [
      { addr: 'Depot', inTime: new Date('2026-09-10T12:00:00Z'), outTime: new Date('2026-09-10T12:10:00Z'), isDepot: true },
      { addr: '123 Main St', inTime: new Date('2026-09-10T14:00:00Z'), outTime: new Date('2026-09-10T14:30:00Z'), isDepot: false },
      { addr: '456 Oak Ave', inTime: new Date('2026-09-10T15:00:00Z'), outTime: new Date('2026-09-10T15:20:00Z'), isDepot: false }, // unrecognized, 20min -- "possible lunch" heuristic (<60min, no match)
      { addr: '789 Pine Rd', inTime: new Date('2026-09-10T16:00:00Z'), outTime: new Date('2026-09-10T17:30:00Z'), isDepot: false }, // unrecognized, 90min -- NOT possible lunch
    ];
    const ctx = { tz: 'America/New_York', team: 'B1', teamJobs: [] };
    const infos = stops.map(function (s) { return sandbox._tdrStopInfo(s, ctx); });
    check('depot stop labeled "Office" (data function)', infos[0].label, 'Office');
    check('matched client stop labeled with the client name (data function)', infos[1].label, 'Jane Smith');
    check('short unmatched stop flagged "Possible lunch / break" (data function)', infos[2].label, 'Possible lunch / break');
    check('long unmatched stop labeled "Unrecognized stop" (data function)', infos[3].label, 'Unrecognized stop');

    // Same stops through the REAL _renderGPSStopRow (readOnly) -- labels must agree.
    const html = stops.map(function (s, si) {
      return sandbox._renderGPSStopRow(s, si > 0, { tz: 'America/New_York', team: 'B1', teamJobs: [], readOnly: true, isLastOverall: s === stops[stops.length - 1] });
    }).join('');
    checkTrue('modal renderer HTML contains the matched client name', html.indexOf('Jane Smith') !== -1);
    checkTrue('modal renderer HTML contains "Possible lunch / break" for the same stop the data function flagged', html.indexOf('Possible lunch / break') !== -1);
    checkTrue('modal renderer HTML contains "Unrecognized stop" for the long unmatched stop', html.indexOf('Unrecognized stop') !== -1);
    checkTrue('modal renderer HTML labels the depot stop "Office"', /Office/.test(html));
    checkTrue('read-only mode never renders the write-capable "Not lunch" toggle', html.indexOf('Not lunch') === -1 && html.indexOf('Mark as lunch') === -1);
  }

  // ── _tdrExpandDateRange (range cap + basics) ──
  {
    const { sandbox } = buildSandbox({});
    const single = sandbox._tdrExpandDateRange('2026-09-10', '2026-09-10');
    check('single-day range expands to exactly one date', single, { ok: true, dates: ['2026-09-10'] });
    const tooLong = sandbox._tdrExpandDateRange('2026-01-01', '2026-03-01');
    check('a range over the 31-day cap is rejected', tooLong.ok, false);
    checkTrue('cap-rejection message names the 31-day limit', /31 days/.test(tooLong.error));
    const backwards = sandbox._tdrExpandDateRange('2026-09-16', '2026-09-10');
    check('To before From is rejected with a visible message', backwards.ok, false);
  }

  // ── Office/lunch resolution: override agreement -> Saved, else GPS, else No data ──
  {
    const { sandbox } = buildSandbox({});
    const gpsOutcome = { ok: true, detail: { gps: { available: true, start: new Date('2026-09-10T13:00:00Z'), end: new Date('2026-09-10T21:00:00Z'), lunchMin: 45 }, stopList: [] } };
    const agreeing = sandbox._tdrResolveOfficeAndLunch(
      [{ id: 'e1' }, { id: 'e2' }],
      '2026-09-10',
      gpsOutcome,
      'America/New_York'
    );
    // Need overrides configured for this sandbox instance specifically.
    const { sandbox: sb2 } = buildSandbox({ overrides: { e1: { start: '08:00', end: '16:00', lunch: 30 }, e2: { start: '08:00', end: '16:00', lunch: 30 } } });
    const saved = sb2._tdrResolveOfficeAndLunch([{ id: 'e1' }, { id: 'e2' }], '2026-09-10', gpsOutcome, 'America/New_York');
    check('every included employee agreeing on a saved override -> "Saved", using that value (GPS ignored)', [saved.left, saved.back, saved.lunchMinutes, saved.source], ['08:00', '16:00', 30, 'Saved']);

    const { sandbox: sb3 } = buildSandbox({ overrides: { e1: { start: '08:00', end: '16:00', lunch: 30 } } }); // only e1 has one -- not everyone
    const partial = sb3._tdrResolveOfficeAndLunch([{ id: 'e1' }, { id: 'e2' }], '2026-09-10', gpsOutcome, 'America/New_York');
    check('not everyone has a saved override -> falls back to GPS, labeled "GPS"', [partial.left, partial.back, partial.lunchMinutes, partial.source], ['13:00', '21:00', 45, 'GPS']);

    const { sandbox: sb4 } = buildSandbox({ overrides: { e1: { start: '08:00', end: '16:00', lunch: 30 }, e2: { start: '09:00', end: '17:00', lunch: 0 } } }); // disagree
    const mixed = sb4._tdrResolveOfficeAndLunch([{ id: 'e1' }, { id: 'e2' }], '2026-09-10', gpsOutcome, 'America/New_York');
    check('overrides exist but disagree -> no single "Saved" value, falls back to GPS', mixed.source, 'GPS');

    const noGpsOutcome = { ok: true, detail: { gps: { available: false }, stopList: [] } };
    const { sandbox: sb5 } = buildSandbox({});
    const none = sb5._tdrResolveOfficeAndLunch([{ id: 'e1' }], '2026-09-10', noGpsOutcome, 'America/New_York');
    check('neither override nor GPS -> "No data", never a guess', [none.left, none.back, none.lunchMinutes, none.source], [null, null, null, 'No data']);
  }

  // ── terminated-after-date appears, terminated-before does not (real _teamHoursEligibility) ──
  {
    const { sandbox } = buildSandbox({});
    const elig = sandbox._teamHoursEligibility('B1', '2026-09-10');
    check('Alice and Bob included', elig.included.map(function (e) { return e.name; }).sort(), ['Alice', 'Bob']);
    checkTrue('Dana (terminated as of this date) is skipped, not included', !elig.included.some(function (e) { return e.name === 'Dana'; }));
    checkTrue('Dana appears in skipped with reason Terminated', elig.skipped.some(function (s) { return s.emp.name === 'Dana' && s.reason === 'Terminated'; }));
  }

  // ── _tdrBuildDateBlocks: a day with real blocks, "off" roster surfaced, mixed sources across blocks ──
  {
    const { sandbox } = buildSandbox({
      teams: ['B1', 'S1'],
      overrides: { e1: { start: '08:00', end: '16:00', lunch: 30 }, e2: { start: '08:00', end: '16:00', lunch: 30 } }, // B1 agrees -> Saved
      gpsResults: { 'S1|2026-09-10': { device: {}, trips: [], stopList: [], gps: { available: true, start: new Date('2026-09-10T13:00:00Z'), end: new Date('2026-09-10T21:00:00Z'), lunchMin: 20 } } }, // S1 -> GPS
    });
    sandbox._tdrGeneration = 1;
    const blocks = await sandbox._tdrBuildDateBlocks('2026-09-10', 'America/New_York', 1, null);
    const b1 = blocks.find(function (b) { return b.team === 'B1'; });
    const s1 = blocks.find(function (b) { return b.team === 'S1'; });
    checkTrue('B1 block exists with Alice and Bob on the roster', b1 && b1.included.map(function (e) { return e.name; }).sort().join(',') === 'Alice,Bob');
    checkTrue('B1 block\'s "Off" list surfaces Cara (vacation) and Dana (terminated)', b1.skipped.some(function (s) { return s.name === 'Cara'; }) && b1.skipped.some(function (s) { return s.name === 'Dana'; }));
    check('B1 block source is "Saved" (mixed-across-blocks case: one block Saved)', b1.office.source, 'Saved');
    check('S1 block source is "GPS" (mixed-across-blocks case: the other block GPS)', s1.office.source, 'GPS');
  }

  // A date with nobody on any team at all -> a single "No assignment recorded" marker block.
  {
    const { sandbox } = buildSandbox({ teams: ['Z9'] });
    sandbox._tdrGeneration = 1;
    const blocks = await sandbox._tdrBuildDateBlocks('2026-09-10', 'America/New_York', 1, null);
    check('exactly one marker block for a day with no coverage at all', blocks.length, 1);
    checkTrue('marker block is noAssignment', blocks[0].noAssignment);
  }

  // ── One team's GPS fetch failing does not stop another team's block on the same date ──
  {
    const { sandbox } = buildSandbox({
      teams: ['B1', 'S1'],
      gpsResults: { 'S1|2026-09-10': new Error('Geotab rate limited') },
    });
    sandbox._tdrGeneration = 1;
    const blocks = await sandbox._tdrBuildDateBlocks('2026-09-10', 'America/New_York', 1, null);
    const b1 = blocks.find(function (b) { return b.team === 'B1'; });
    const s1 = blocks.find(function (b) { return b.team === 'S1'; });
    checkTrue('B1 (the team whose fetch succeeded) still produced a real block', !!b1 && !b1.loadFailed);
    checkTrue('S1 (the team whose fetch threw) still produced a real block, degraded to "No data" -- the fetch helper catches its own failure', !!s1 && !s1.loadFailed && s1.office.source === 'No data' && s1.loadError === 'Geotab rate limited');
    check('no blocks dropped for the date', blocks.length, 2);
  }

  // ── Totals: team-days only, marker blocks excluded ──
  {
    const { sandbox } = buildSandbox({});
    const blocks = [
      { date: '2026-09-10', team: 'B1' },
      { date: '2026-09-10', team: 'S1' },
      { date: '2026-09-11', team: 'B1' },
      { date: '2026-09-12', team: null, noAssignment: true },
      { date: '2026-09-13', team: 'B1', loadFailed: true },
    ];
    check('team-days counts only real blocks', sandbox._tdrComputeTotals(blocks), { teamDays: 3 });
  }

  // ── No money/pay fields anywhere in a block ──
  {
    const { sandbox } = buildSandbox({ overrides: { e1: { start: '08:00', end: '16:00', lunch: 30 } } });
    const elig = sandbox._teamHoursEligibility('B1', '2026-09-10');
    sandbox._tdrGeneration = 1;
    const block = await sandbox._tdrBuildTeamDayBlock(elig, 'B1', '2026-09-10', 'America/New_York');
    const flat = JSON.stringify(block).toLowerCase();
    checkTrue('no pay/rate/cost/money field anywhere on the block', !/pay|rate|cost|\$|money/.test(flat));
  }

  // ── CSV escaping ──
  {
    const { sandbox } = buildSandbox({});
    const blocks = [
      {
        date: '2026-09-10', team: 'B1', included: [{ id: 'e1', name: 'Alice, "Al"' }],
        office: { left: '08:00', back: '16:00', source: 'Saved' }, lunch: { minutes: 30, source: 'Saved' },
        tz: 'America/New_York', teamJobs: [], gpsAvailable: true,
        stops: [{ addr: '1 Main St, Apt "B"\nUnit 2', inTime: new Date('2026-09-10T13:00:00Z'), outTime: new Date('2026-09-10T13:20:00Z'), isDepot: false }],
      },
      { date: '2026-09-11', team: null, noAssignment: true },
      { date: '2026-09-12', team: 'B1', loadFailed: true, reason: 'Geotab timeout, retry failed' },
    ];
    const csv = sandbox._tdrBuildCsv(blocks);
    const lines = csv.split('\r\n');
    check('header row present', lines[0], 'Date,Team,Employee,Left office,Back at office,Lunch (min),Client homes visited,Source');
    checkTrue('a name with a comma and quotes is quoted/quote-doubled', lines[1].indexOf('"Alice, ""Al"""') !== -1);
    checkTrue('an address with a comma, quotes, and a newline is quoted/quote-doubled inside the combined visits field', lines[1].indexOf('Apt ""B""\nUnit 2') !== -1);
    checkTrue('the no-assignment marker renders as a real CSV line', lines[2].indexOf('No assignment recorded') !== -1);
    checkTrue('the load-failed marker carries its reason, its own comma quoted', lines[3].indexOf('"Could not load: Geotab timeout, retry failed"') !== -1);
    check('exactly 4 lines (header + 3 data rows)', lines.length, 4);
  }

  // ── PDF builder: every block included, no money fields, page breaks never split a block ──
  {
    const { sandbox } = buildSandbox({});
    const blocks = [
      {
        date: '2026-09-10', team: 'B1', included: [{ id: 'e1', name: 'Alice' }], skipped: [],
        office: { left: '08:00', back: '16:00', source: 'Saved' }, lunch: { minutes: 30, source: 'Saved' },
        tz: 'America/New_York', teamJobs: [], gpsAvailable: true, loadError: null,
        stops: [{ addr: '123 Main St', inTime: new Date('2026-09-10T14:00:00Z'), outTime: new Date('2026-09-10T14:30:00Z'), isDepot: false }],
      },
      { date: '2026-09-11', team: null, noAssignment: true },
      { date: '2026-09-12', team: 'S1', loadFailed: true, reason: 'Geotab timeout' },
    ];
    const doc = sandbox._tdrBuildPdf(blocks, '2026-09-10', '2026-09-12');
    const allText = doc._pages.map(function (p) { return p.join(' '); }).join(' ');
    checkTrue('PDF includes the real team-day block (date/team)', /B1/.test(allText));
    checkTrue('PDF includes the no-assignment marker block', /No assignment recorded/.test(allText));
    checkTrue('PDF includes the load-failed marker block with its reason', /Could not load/.test(allText) && /Geotab timeout/.test(allText));
    checkTrue('PDF header includes the date range', /2026-09-10 to 2026-09-12/.test(allText));
    checkTrue('no money/pay text anywhere in the PDF', !/\$|pay rate|payroll/i.test(allText));

    // Page-break-never-splits-a-block: every line of one block's content lands on the SAME page.
    const b = blocks[0];
    const lines = sandbox._tdrBlockLines(doc, b, 500);
    const linesText = lines.map(function (l) { return l.text; });
    var foundPage = -1, allSamePage = true;
    doc._pages.forEach(function (pageTexts, pIdx) {
      var hasAny = linesText.some(function (t) { return pageTexts.indexOf(t) !== -1; });
      if (hasAny) { if (foundPage === -1) foundPage = pIdx; else if (foundPage !== pIdx) allSamePage = false; }
    });
    checkTrue('a single team-day block\'s lines all land on the same PDF page', allSamePage);
  }

  // ── Hours-tab entry (_tdrSyncButtonVisibility) and Files-grid entry (renderFilesGrid) visibility ──
  // Forms no longer has any Team Day Report entry at all (moved to
  // Files in this branch) -- there is nothing left to test there.
  {
    const cases = [
      { role: 'owner', expectVisible: true },
      { role: 'admin', expectVisible: true },
      { role: 'manager', expectVisible: true },
      { role: 'dispatcher', expectVisible: false },
      { role: 'employee', expectVisible: false },
      { role: null, expectVisible: false }, // logged-out
    ];
    cases.forEach(function (c) {
      const { sandbox, elements } = buildSandbox({ role: c.role });
      sandbox._tdrSyncButtonVisibility('team-day-report-btn');
      sandbox.renderFilesGrid();
      const hoursVisible = elements['team-day-report-btn'].style.display !== 'none';
      const filesHtml = elements['files-grid'].innerHTML;
      const filesVisible = filesHtml.indexOf('openTeamDayReport()') !== -1;
      check('Hours-tab entry visibility for role=' + c.role, hoursVisible, c.expectVisible);
      check('Files-grid entry visibility for role=' + c.role, filesVisible, c.expectVisible);
      checkTrue('Files grid still renders every other (unrestricted) report item regardless of role=' + c.role,
        filesHtml.indexOf('Payroll') !== -1 && filesHtml.indexOf('Pricing Review') !== -1);
    });
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(function (e) {
  console.error('FAIL: test harness threw', e);
  process.exit(1);
});
