// Team Day Report corrections (team-day-report-corrections branch):
// morning-office dedup, "Not lunch" exclusion, single-lunch merging,
// terminated-employee list cleanup, and app-wide-ready 12-hour time
// formatting (_hrsFmt12, the existing Hours tab/Export Hours Report
// helper -- reused here, not reinvented).
//
// Extracts the real _teamHoursEligibility, dateKey, _hrCsvField,
// _hrsFmt12, and the whole corrected Team Day Report module verbatim
// from index.html. A minimal FakeJsPDF stub stands in for the real
// jsPDF (loaded via CDN in the browser, not available in Node).
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
const hrsFmt12Source = extract('function _hrsFmt12(date) {', '\n\n// Portal-hours-match-manager fix.', '_hrsFmt12');
const tdrSource = extract('var TDR_MAX_RANGE_DAYS = 31;', '\nfunction openTeamDayReport() {', 'Team Day Report module (corrected)');

const fnSource = [eligSource, dateKeySource, hrCsvFieldSource, hrsFmt12Source, tdrSource].join('\n');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}
function checkTrue(label, cond) { check(label, !!cond, true); }

// Minimal stand-in for jsPDF's instance API.
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
  var words = String(text).split(' ');
  var lines = [], cur = '';
  words.forEach(function (w) {
    var next = cur ? cur + ' ' + w : w;
    if (next.length > 70) { lines.push(cur); cur = w; } else { cur = next; }
  });
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
};

const TZ = 'America/New_York';
// 2026-09-10 is EDT (UTC-4): "HH:MM" local -> "HH+4:MM" UTC.
function t(hhmm) {
  var p = hhmm.split(':');
  var hh = parseInt(p[0], 10) + 4;
  return new Date('2026-09-10T' + String(hh).padStart(2, '0') + ':' + p[1] + ':00.000Z');
}

const ROSTER = [
  { id: 'e1', name: 'Alice', uuid: 'uuid-alice', defaultTeam: 'B1' },
  { id: 'e2', name: 'Bob', uuid: 'uuid-bob', defaultTeam: 'B1' },
  { id: 'e3', name: 'Cara', uuid: 'uuid-cara', defaultTeam: 'B1' }, // on vacation this date
  { id: 'e4', name: 'Dana', uuid: 'uuid-dana', defaultTeam: 'B1' }, // terminated as of 2026-09-10
];

function buildSandbox(opts) {
  opts = opts || {};
  const overrides = opts.overrides || {};
  const lunchOverrides = opts.lunchOverrides || {}; // 'team|dateStr|stopKeyISO' -> { override_type }
  const clientMatchFor = opts.clientMatchFor || {}; // addr -> {name,id,scheduled}

  const sandbox = {
    console,
    window: {
      PentaEmployees: { getByLegacyRosterId: function () { return null; } },
      PentaLunchFlags: { getOverride: function (team, dateStr, stopKey) { return lunchOverrides[team + '|' + dateStr + '|' + stopKey] || null; } },
    },
    getUnifiedRoster: function () { return ROSTER.slice(); },
    getEmployeeTeam: function (empId) {
      if (empId === 'e3' || empId === 'e4') return null;
      var emp = ROSTER.find(function (e) { return e.id === empId; });
      return emp ? emp.defaultTeam : null;
    },
    getRosterTermData: function () { return { e4: { status: 'terminated' } }; },
    getEmployeeDayOffInfo: function (empId) { return empId === 'e3' ? { status_type: 'vacation' } : null; },
    DAY_OFF_CATEGORY_LABELS: { vacation: 'Vacation' },

    getEmpHours: function (empId) { return overrides[empId] || null; },
    _fetchTeamDayGpsDetail: function (team, dateStr) {
      var v = (opts.gpsResults || {})[team + '|' + dateStr];
      return Promise.resolve(v || { device: null, resolved: {}, trips: [], stopList: [], gps: { available: false, reason: 'No GPS device assigned' } });
    },
    matchStopToClientGeo: function (lat, lng, addr) { return clientMatchFor[addr] || null; },
    jobs: opts.jobs || [],
    _pentaTeamNames: function () { return opts.teams || ['B1']; },
    _pentaBusinessTimezone: function () { return TZ; },
    _adminEsc: function (s) { return String(s); },
    getCurrentAppRole: function () { return opts.role !== undefined ? opts.role : 'owner'; },
    jspdf: undefined,
    PentaTenant: { name: function () { return 'Fixture Cleaning Co'; } },
  };
  sandbox.window.jspdf = { jsPDF: FakeJsPDF };
  sandbox.window.PentaTenant = sandbox.PentaTenant;
  vm.createContext(sandbox);
  vm.runInContext(fnSource, sandbox);
  return { sandbox };
}

function classify(sandbox, stops, ctx) {
  return stops.map(function (s) { return sandbox._tdrClassifyStop(s, ctx); });
}

async function main() {
  // ── (a) Two morning office stops -> one office entry, start 9:01 AM ──
  {
    const { sandbox } = buildSandbox({});
    const stops = [
      { addr: 'DEPOT', inTime: null, outTime: t('08:47'), isDepot: true },
      { addr: 'DEPOT', inTime: t('08:48'), outTime: t('09:01'), isDepot: true },
      { addr: '123 Main St', inTime: t('09:30'), outTime: t('09:50'), isDepot: false, lat: 1, lng: 1 },
    ];
    const ctx = { team: 'B1', teamJobs: [], trueStart: t('09:01'), trueEnd: t('17:00') };
    const classified = classify(sandbox, stops, ctx);
    const trimmed = sandbox._tdrTrimMorningStops(classified, ctx.trueStart);
    check('the early 8:47 morning blip is dropped', trimmed.length, 2);
    checkTrue('exactly one Office entry remains, ending at the real start', trimmed[0].isDepot && trimmed[0].outTime.getTime() === t('09:01').getTime());
    check('"Left office" (via _hrsFmt12) reads 9:01 AM', sandbox._hrsFmt12(trimmed[0].outTime), '9:01 AM');
  }

  // ── (b) A non-office stop before the start is also dropped (generic rule) ──
  {
    const { sandbox } = buildSandbox({});
    const stops = [
      { addr: 'Personal Errand St', inTime: null, outTime: t('08:30'), isDepot: false },
      { addr: 'DEPOT', inTime: t('08:35'), outTime: t('09:00'), isDepot: true },
    ];
    const ctx = { team: 'B1', teamJobs: [], trueStart: t('09:00'), trueEnd: t('17:00') };
    const classified = classify(sandbox, stops, ctx);
    const trimmed = sandbox._tdrTrimMorningStops(classified, ctx.trueStart);
    check('the pre-start stop (not an office stop) is dropped too', trimmed.length, 1);
    checkTrue('only the real-departure entry remains', trimmed[0].outTime.getTime() === t('09:00').getTime());
  }

  // ── (c) Three lunch candidates, one marked "Not lunch" -> excluded entirely ──
  {
    const { sandbox } = buildSandbox({
      lunchOverrides: { ['B1|2026-09-10|' + t('12:00').toISOString()]: { override_type: 'exclude' } },
    });
    const stops = [
      { addr: '1 A St', inTime: t('12:00'), outTime: t('12:15'), isDepot: false }, // marked Not lunch
      { addr: '2 B St', inTime: t('12:20'), outTime: t('12:30'), isDepot: false },
      { addr: '3 C St', inTime: t('12:35'), outTime: t('12:50'), isDepot: false },
    ];
    const ctx = { team: 'B1', teamJobs: [], trueStart: t('09:00'), trueEnd: t('17:00') };
    const classified = classify(sandbox, stops, ctx);
    check('the "Not lunch" stop is never a candidate', classified[0].isPossibleLunch, false);
    checkTrue('the other two are candidates', classified[1].isPossibleLunch && classified[2].isPossibleLunch);
    const merge = sandbox._tdrMergeLunchCandidates(classified);
    check('only 2 of the 3 stops are merged (the excluded one is never included)', merge.mergedIndexes.sort(), [1, 2]);
    check('total minutes = sum of only the 2 real candidates (10 + 15 = 25)', merge.minutes + merge.droppedMin, 25);
    const label = sandbox._tdrStopDisplayLabel(classified[0], false);
    check('the "Not lunch" stop displays as a plain "Stop", not "Marked not-lunch"', label, 'Stop');
  }

  // ── (d) 40 min + 10 min candidates, a client arriving clips the end to 1 min before it; full backward recovery ──
  {
    const { sandbox } = buildSandbox({ clientMatchFor: { '456 Client Rd': { name: 'Jane Smith', id: 'c1', scheduled: true } } });
    const stops = [
      { addr: '1 Coffee St', inTime: t('11:55'), outTime: t('12:35'), isDepot: false }, // 40 min, the anchor (longest)
      { addr: '2 Snack St', inTime: t('12:36'), outTime: t('12:46'), isDepot: false },  // 10 min
      { addr: '456 Client Rd', inTime: t('12:40'), outTime: t('13:10'), isDepot: false, lat: 1, lng: 1 }, // real client at 12:40
    ];
    const ctx = { team: 'B1', teamJobs: [], trueStart: t('09:00'), trueEnd: t('17:00') };
    const classified = classify(sandbox, stops, ctx);
    const merge = sandbox._tdrMergeLunchCandidates(classified);
    check('end is clipped to exactly one minute before the client (12:40 -> 12:39)', sandbox._hrsFmt12(merge.end), '12:39 PM');
    check('no previous-client constraint -> the full 50 minutes is recovered by extending the start backward, nothing dropped', [merge.minutes, merge.droppedMin], [50, 0]);
    check('start moved backward from the anchor\'s own 11:55 to fit the full total', sandbox._hrsFmt12(merge.start), '11:49 AM');
  }

  // ── (f) A previous client ALSO constrains the backward extension -> some minutes genuinely dropped ──
  {
    const { sandbox } = buildSandbox({
      clientMatchFor: {
        '456 Client Rd': { name: 'Jane Smith', id: 'c1', scheduled: true },
        '789 Prior Client Rd': { name: 'Prior Client', id: 'c0', scheduled: true },
      },
    });
    const stops = [
      { addr: '789 Prior Client Rd', inTime: t('11:00'), outTime: t('11:52'), isDepot: false, lat: 2, lng: 2 }, // previous client, ends 11:52
      { addr: '1 Coffee St', inTime: t('11:55'), outTime: t('12:35'), isDepot: false }, // 40 min anchor
      { addr: '2 Snack St', inTime: t('12:36'), outTime: t('12:46'), isDepot: false },  // 10 min
      { addr: '456 Client Rd', inTime: t('12:40'), outTime: t('13:10'), isDepot: false, lat: 1, lng: 1 }, // next client at 12:40
    ];
    const ctx = { team: 'B1', teamJobs: [], trueStart: t('09:00'), trueEnd: t('17:00') };
    const classified = classify(sandbox, stops, ctx);
    const merge = sandbox._tdrMergeLunchCandidates(classified);
    check('end still clips to 12:39', sandbox._hrsFmt12(merge.end), '12:39 PM');
    check('start can only move back to 11:53 (one minute after the PRIOR client\'s 11:52 out-time), not the full 11:49 needed', sandbox._hrsFmt12(merge.start), '11:53 AM');
    check('46 of the 50 total minutes shown, 4 minutes genuinely dropped (never forced)', [merge.minutes, merge.droppedMin], [46, 4]);
  }

  // ── (e) Candidates on BOTH sides of the same limiting client ──
  {
    const { sandbox } = buildSandbox({ clientMatchFor: { '456 Client Rd': { name: 'Jane Smith', id: 'c1', scheduled: true } } });
    const stops = [
      { addr: '1 Before St', inTime: t('11:00'), outTime: t('11:20'), isDepot: false }, // 20 min, before the client -- the anchor (longest)
      { addr: '456 Client Rd', inTime: t('11:25'), outTime: t('11:40'), isDepot: false, lat: 1, lng: 1 },
      { addr: '2 After St', inTime: t('11:45'), outTime: t('11:50'), isDepot: false },  // 5 min, after the SAME client
    ];
    const ctx = { team: 'B1', teamJobs: [], trueStart: t('09:00'), trueEnd: t('17:00') };
    const classified = classify(sandbox, stops, ctx);
    const merge = sandbox._tdrMergeLunchCandidates(classified);
    checkTrue('the anchor is the "before" candidate (it\'s the longest)', merge.mergedIndexes.indexOf(0) !== -1);
    checkTrue('the "after" candidate\'s minutes still contribute to the total, even across the client', merge.mergedIndexes.indexOf(2) !== -1);
    check('end never overlaps the client (clipped to 11:24, one minute before 11:25)', sandbox._hrsFmt12(merge.end), '11:24 AM');
    // No previous-client constraint here, so the 1-minute shortfall (20+5=25
    // total vs. the 24-minute window from the anchor's own 11:00 start)
    // recovers in full by nudging the start back to 10:59 -- nothing is
    // dropped. The "after" candidate's own 5 minutes still land inside the
    // single merged window even though its ORIGINAL 11:45-11:50 slot is
    // chronologically outside it -- its own timeline row is still labeled
    // "Merged into lunch" at its real time, which can look visually
    // disjoint from the Lunch summary line; called out in this PR's body.
    check('nothing dropped -- the 1-minute shortfall recovers in full backward', merge.droppedMin, 0);
    check('start nudges back just 1 minute, from the anchor\'s own 11:00 to 10:59', sandbox._hrsFmt12(merge.start), '10:59 AM');
  }

  // ── (g) Saved override wins -- shown as-is, not recomputed from GPS; timeline still reflects GPS independently ──
  {
    const { sandbox } = buildSandbox({
      overrides: { e1: { start: '08:00', end: '16:00', lunch: 30 }, e2: { start: '08:00', end: '16:00', lunch: 30 } },
      gpsResults: { 'B1|2026-09-10': { device: {}, trips: [], stopList: [
        { addr: 'DEPOT', inTime: null, outTime: t('09:00'), isDepot: true },
      ], gps: { available: true, start: t('09:00'), end: t('17:00'), lunchMin: 45, hours: 7.25 } } },
    });
    const elig = sandbox._teamHoursEligibility('B1', '2026-09-10');
    const block = await sandbox._tdrBuildTeamDayBlock(elig, 'B1', '2026-09-10', TZ);
    check('office/lunch summary shows the SAVED values, labeled Saved', [block.office.left, block.office.back, block.lunch.minutes, block.office.source], ['08:00', '16:00', 30, 'Saved']);
    checkTrue('the timeline is still built from GPS data independently of the Saved summary', block.timeline.length === 1 && block.timeline[0].isDepot);
  }

  // ── (h) Terminated employees: absent from BOTH lists before exclusion date, present normally on/after their last real day ──
  {
    const { sandbox } = buildSandbox({});
    const elig = sandbox._teamHoursEligibility('B1', '2026-09-10');
    const block = await sandbox._tdrBuildTeamDayBlock(elig, 'B1', '2026-09-10', TZ);
    checkTrue('Alice and Bob are on the team', block.included.map(function (e) { return e.name; }).sort().join(',') === 'Alice,Bob');
    check('Dana (terminated as of this date) does not appear in "On team"', block.included.some(function (e) { return e.name === 'Dana'; }), false);
    check('Dana (terminated) does NOT appear in "Off" either -- removed entirely, not just unlabeled', block.skipped.some(function (sk) { return sk.name === 'Dana'; }), false);
    checkTrue('Cara (vacation, not terminated) still appears under "Off" normally', block.skipped.some(function (sk) { return sk.name === 'Cara' && sk.reason === 'Vacation'; }));
  }

  // ── (i) No 24-hour time strings anywhere in the screen HTML, PDF text, or CSV ──
  {
    const { sandbox } = buildSandbox({});
    const block = {
      date: '2026-09-10', team: 'B1',
      included: [{ id: 'e1', name: 'Alice' }], skipped: [],
      office: { left: '8:47 AM', back: '4:00 PM', source: 'GPS' },
      lunch: { minutes: 39, source: 'GPS' },
      lunchMerge: { start: t('12:00'), end: t('12:39'), minutes: 39, droppedMin: 0 },
      timeline: [
        { addr: 'DEPOT', inTime: null, outTime: t('08:47'), durationMin: null, isDepot: true, label: 'Office', isUnscheduled: false },
        { addr: '123 Main St', inTime: t('09:00'), outTime: t('09:30'), durationMin: 30, isDepot: false, label: 'Jane Smith', isUnscheduled: false },
      ],
      teamJobs: [], tz: TZ, gpsAvailable: true, loadError: null,
    };
    const html = sandbox._tdrRenderBlock(block);
    const notTimeRegex = /\b\d{1,2}:\d{2}\b(?!\s*[AaPp]\.?[Mm]\.?)/; // an HH:MM NOT immediately followed by AM/PM
    checkTrue('rendered HTML has no bare 24-hour-looking time', !notTimeRegex.test(html));
    checkTrue('rendered HTML DOES show the real 12-hour times', /8:47 AM/.test(html) && /9:00 AM/.test(html));

    const doc = new FakeJsPDF();
    const lines = sandbox._tdrBlockLines(doc, block, 500);
    const pdfText = lines.map(function (l) { return l.text; }).join(' ');
    checkTrue('PDF text has no bare 24-hour-looking time', !notTimeRegex.test(pdfText));

    const csv = sandbox._tdrBuildCsv([block]);
    checkTrue('CSV has no bare 24-hour-looking time', !notTimeRegex.test(csv));
    checkTrue('CSV DOES show real 12-hour times', /8:47 AM/.test(csv) && /4:00 PM/.test(csv));
  }

  // ── Hours-tab entry visibility matrix (unchanged from v2; the Files-grid
  // entry point itself is untouched by this branch and already covered by
  // PR #212's own test) ──
  {
    const cases = [
      { role: 'owner', expectVisible: true }, { role: 'admin', expectVisible: true }, { role: 'manager', expectVisible: true },
      { role: 'dispatcher', expectVisible: false }, { role: 'employee', expectVisible: false }, { role: null, expectVisible: false },
    ];
    cases.forEach(function (c) {
      const { sandbox } = buildSandbox({ role: c.role });
      const el = { style: {} };
      sandbox.document = { getElementById: function (id) { return id === 'team-day-report-btn' ? el : null; } };
      sandbox._tdrSyncButtonVisibility('team-day-report-btn');
      check('Hours-tab entry visibility for role=' + c.role, el.style.display !== 'none', c.expectVisible);
    });
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(function (e) {
  console.error('FAIL: test harness threw', e);
  process.exit(1);
});
