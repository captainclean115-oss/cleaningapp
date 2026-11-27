// Fix: the job-edit screen's Price box never actually saved. saveJob()
// read the field into `jobPrice` but never included it in either the
// update patch or the new-job object -- a bug present since this app's
// very first commit. Confirmed as the real cause of the 2026-11-15
// incident: 4 jobs added by hand that Sunday night (Lubrano, Rotker,
// Kim, Sullivan) still have price IS NULL in the database today,
// auto_generated=false, created_at ~9pm ET that night -- exactly the
// manual add-a-job path this function serves.
//
// Fix: resolve the price to the typed value, or -- if left blank --
// the client's own current_price (same fallback _pentaResolveJobPrice
// already uses for display, now actually stored too), and include it
// in both the insert and the update write.
//
// This file drives the REAL saveJob() (extracted from index.html, run
// in a vm sandbox against a fake DOM + fake PentaClients/_pentaJobWrite)
// with FAKE data only.
//
// Run with: node tests/job-price-save-fix.test.js

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

function extract(startMarker, endMarker) {
  const s = src.indexOf(startMarker);
  if (s === -1) { console.error('FAIL: could not find start marker: ' + startMarker); process.exit(1); }
  const e = src.indexOf(endMarker, s);
  if (e === -1) { console.error('FAIL: could not find end marker after ' + startMarker); process.exit(1); }
  return src.slice(s, e);
}

const saveJobSrc = extract('async function saveJob() {', '\nasync function deleteJob(');

function makeEl(overrides) {
  return Object.assign({ value: '', classList: { contains: function () { return false; } } }, overrides || {});
}

function buildSandbox(opts) {
  opts = opts || {};
  const els = {
    'job-client-input': makeEl({ value: opts.clientName || 'Testy McTestface' }),
    'job-team': makeEl({ value: opts.team || 'B3' }),
    'change-all-team': null,
    'job-client-id': makeEl({ value: opts.clientId || 'client-fake-1' }),
    'job-client-addr': makeEl({ value: '1 Fake St' }),
    'job-date': makeEl({ value: opts.date || '2026-12-01' }),
    'btn-flex-time': makeEl({ classList: { contains: function () { return !!opts.flex; } } }),
    'job-time': makeEl({ value: opts.time || '09:00' }),
    'job-end-time': makeEl({ value: '' }),
    'job-notes': makeEl({ value: '' }),
    'job-price': ('priceFieldValue' in opts) ? makeEl({ value: opts.priceFieldValue }) : makeEl({ value: '' })
  };
  const state = { writes: [], jobsPushed: [], alerts: [], renderCalled: false };
  const sandbox = {
    console,
    document: { getElementById: function (id) { return Object.prototype.hasOwnProperty.call(els, id) ? els[id] : null; } },
    editingJob: opts.editingJob || null,
    jobs: opts.jobs || [],
    calDate: new Date('2026-12-01T00:00:00'),
    alert: function (msg) { state.alerts.push(msg); },
    _pentaTeamColor: function () { return '#6b7280'; },
    _generateUuidV4: function () { return 'new-job-uuid-1'; },
    getClientQuotedMinutes: function () { return 120; },
    logPendingUpdate: function () {},
    saveJobs: function () {},
    closeJobModal: function () {},
    renderCal: function () { state.renderCalled = true; },
    PentaClients: {
      getClient: function (id) {
        if (id === 'client-with-price') return { ln: 'withprice', current_price: 249 };
        if (id === 'client-fake-1') return { ln: 'testface', current_price: 180 };
        return null;
      }
    },
    _pentaJobWrite: function (op, args) {
      state.writes.push({ op: op, args: args });
      return Promise.resolve({ ok: true, data: {} });
    }
  };
  sandbox.jobs.push = function (item) { state.jobsPushed.push(item); return Array.prototype.push.call(this, item); };
  vm.createContext(sandbox);
  vm.runInContext(saveJobSrc, sandbox);
  return { sandbox: sandbox, state: state };
}

async function main() {
  // ---- Adding a new job with a typed price actually saves that price. ----
  {
    const { sandbox, state } = buildSandbox({ priceFieldValue: '275' });
    await sandbox.saveJob();
    check('a new job insert happened', state.writes.length, 1);
    check('the insert is an insert op', state.writes[0].op, 'insert');
    check('the typed price is included in the new job object', state.writes[0].args.job.price, '275');
  }

  // ---- Adding a new job with the Price box left blank falls back to
  // the client's current price, instead of saving nothing (the exact
  // 2026-11-15 bug). ----
  {
    const { sandbox, state } = buildSandbox({ priceFieldValue: '', clientId: 'client-with-price' });
    await sandbox.saveJob();
    check('a new job insert happened even with a blank price box', state.writes.length, 1);
    check('the blank price falls back to the client\'s current_price', state.writes[0].args.job.price, '249');
  }

  // ---- A client with no price on file at all: still saves cleanly,
  // price stays null (never a crash, never a fabricated number). ----
  {
    const { sandbox, state } = buildSandbox({ priceFieldValue: '', clientId: 'client-with-no-price-on-file' });
    await sandbox.saveJob();
    check('no price anywhere resolves to null, not a crash or a made-up number', state.writes[0].args.job.price, null);
  }

  // ---- Editing an existing job: the typed price is included in the
  // update patch (previously silently dropped). ----
  {
    const existingJob = { id: 'job-fake-1', clientName: 'Testy McTestface', clientId: 'client-fake-1', date: '2026-12-01', time: '09:00', price: '180' };
    const { sandbox, state } = buildSandbox({ editingJob: existingJob, priceFieldValue: '300', jobs: [existingJob] });
    await sandbox.saveJob();
    check('an update write happened', state.writes[0].op, 'update');
    check('the new typed price reaches the update patch', state.writes[0].args.patch.price, '300');
    check('the in-memory job object is updated too (same pattern as every other field here)', existingJob.price, '300');
  }

  // ---- Editing an existing job and blanking the price falls back to
  // the client's current price rather than silently keeping (or
  // losing) the old value. ----
  {
    const existingJob = { id: 'job-fake-2', clientName: 'Has Price', clientId: 'client-with-price', date: '2026-12-01', time: '09:00', price: '500' };
    const { sandbox, state } = buildSandbox({ editingJob: existingJob, priceFieldValue: '', clientId: 'client-with-price', jobs: [existingJob] });
    await sandbox.saveJob();
    check('blanking the price on an edit falls back to the client\'s current price', state.writes[0].args.patch.price, '249');
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(function (e) {
  console.error('FAIL: test harness threw', e);
  process.exit(1);
});
