// PR #144 — regression test for job duration = clients.estimated_minutes
// (total labor-minutes for a full clean) ÷ live team headcount for that
// specific date.
//
// Covers the acceptance criteria from the feature spec:
//   1. Client with estimated_minutes=300, team of 3 -> 100 min duration
//   2. Same client, team grows to 4 -> 75 min
//   3. Same client, team shrinks to 2 -> 150 min
//   4. Client with no estimated_minutes set -> falls back through
//      getClientQuotedMinutes' existing chain (legacy clientExtras.quotedMin,
//      then the 120min default), still divided by team size
//   5. An explicit job-level time range (job.time + job.endTime) still wins
//      over the minutes/headcount math -- pre-existing behavior, must not
//      regress
//
// Extracted and run from the ACTUAL getClientQuotedMinutes/getJobDurationMins
// source in index.html (not a reimplementation). getTeamEmployees and
// PentaClients/getClientExtras are stubbed, matching the existing test
// convention of stubbing a function's direct collaborators rather than
// pulling in their entire transitive dependency graph (getUnifiedRoster,
// dailyAssignments, EMPLOYEE_ROSTER, etc.).
//
// Run with: node tests/in-home-minutes-duration-calc.test.js

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(INDEX_HTML, 'utf8');

const startMarker = 'function getClientQuotedMinutes(clientId) {';
const startIdx = src.indexOf(startMarker);
if (startIdx === -1) {
  console.error('FAIL: could not find getClientQuotedMinutes in index.html — did the duration calc get refactored?');
  process.exit(1);
}
const endMarker = '\nfunction jobStartMins(job) {';
const endIdx = src.indexOf(endMarker, startIdx);
if (endIdx === -1) {
  console.error('FAIL: could not find the end boundary after getJobDurationMins — extraction range may need updating.');
  process.exit(1);
}
const fnSource = src.slice(startIdx, endIdx);

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

function buildSandbox(opts) {
  opts = opts || {};
  const clients = opts.clients || {};
  const extras = opts.extras || {};
  const teamHeadcount = opts.teamHeadcount || {};
  const sandbox = {
    console: console,
    PentaClients: {
      getClient: function (id) { return clients[id] || null; },
    },
    getClientExtras: function (id) { return extras[id] || {}; },
    getTeamEmployees: function (team, dateStr) {
      const n = (teamHeadcount[team] && teamHeadcount[team][dateStr] != null) ? teamHeadcount[team][dateStr] : 0;
      return new Array(n).fill(0).map(function (_, i) { return { id: 'emp' + i }; });
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(fnSource, sandbox);
  return sandbox;
}

// --- Acceptance criteria: 300 total minutes, team size 3/4/2 ---
{
  const sandbox = buildSandbox({
    clients: { c1: { estimated_minutes: 300 } },
    teamHeadcount: { M1: { '2026-08-25': 3 } },
  });
  const job = { clientId: 'c1', team: 'M1', date: '2026-08-25' };
  check('300 total minutes / 3-person team = 100 min duration', sandbox.getJobDurationMins(job), 100);
}
{
  const sandbox = buildSandbox({
    clients: { c1: { estimated_minutes: 300 } },
    teamHeadcount: { M1: { '2026-08-25': 4 } },
  });
  const job = { clientId: 'c1', team: 'M1', date: '2026-08-25' };
  check('team grows to 4 -> 300 / 4 = 75 min duration', sandbox.getJobDurationMins(job), 75);
}
{
  const sandbox = buildSandbox({
    clients: { c1: { estimated_minutes: 300 } },
    teamHeadcount: { M1: { '2026-08-25': 2 } },
  });
  const job = { clientId: 'c1', team: 'M1', date: '2026-08-25' };
  check('team shrinks to 2 -> 300 / 2 = 150 min duration', sandbox.getJobDurationMins(job), 150);
}

// --- Fallback chain when estimated_minutes is unset ---
{
  const sandbox = buildSandbox({
    clients: { c2: { estimated_minutes: null } },
    extras: {},
    teamHeadcount: { M1: { '2026-08-25': 2 } },
  });
  const job = { clientId: 'c2', team: 'M1', date: '2026-08-25' };
  check(
    'no estimated_minutes and no legacy clientExtras override -> 120min default / 2-person team = 60',
    sandbox.getJobDurationMins(job),
    60
  );
}
{
  const sandbox = buildSandbox({
    clients: { c3: { estimated_minutes: null } },
    extras: { c3: { quotedMin: '240' } },
    teamHeadcount: { M1: { '2026-08-25': 2 } },
  });
  const job = { clientId: 'c3', team: 'M1', date: '2026-08-25' };
  check(
    'no estimated_minutes but legacy clientExtras.quotedMin set -> 240 / 2 = 120',
    sandbox.getJobDurationMins(job),
    120
  );
}

// --- Zero-headcount guard (team fully unstaffed for the date) ---
{
  const sandbox = buildSandbox({
    clients: { c1: { estimated_minutes: 300 } },
    teamHeadcount: { M1: { '2026-08-25': 0 } },
  });
  const job = { clientId: 'c1', team: 'M1', date: '2026-08-25' };
  check(
    'zero headcount for the team/date falls back to the 2-person divisor guard, not divide-by-zero/Infinity',
    sandbox.getJobDurationMins(job),
    150
  );
}

// --- Pre-existing behavior must not regress: explicit time range wins ---
{
  const sandbox = buildSandbox({
    clients: { c1: { estimated_minutes: 300 } },
    teamHeadcount: { M1: { '2026-08-25': 3 } },
  });
  const job = { clientId: 'c1', team: 'M1', date: '2026-08-25', time: '9:00', endTime: '11:30' };
  check(
    'an explicit job-level time range still overrides the minutes/headcount math',
    sandbox.getJobDurationMins(job),
    150
  );
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
