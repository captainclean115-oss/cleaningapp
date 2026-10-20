// Phone + password login feature -- extracts and runs the ACTUAL
// _normPhoneForStaffCard() + duplicate-detection logic from
// renderStaffList() in index.html, against the real patterns found in
// Manna's live data (read-only audit, 2026-10-20): Blanca Payan and
// Viviana share a phone (one has a leading "1", the other doesn't);
// Tomas Manna's phone is the placeholder "555" (too short to normalize);
// 8 active employees have no phone at all.
//
// Run with: node tests/phone-normalization-duplicates.test.js

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(INDEX_HTML, 'utf8');

function extract(startMarker, endMarker, label) {
  const s = src.indexOf(startMarker);
  if (s === -1) throw new Error('extraction failed: could not find start marker (' + label + '): ' + startMarker);
  const e = src.indexOf(endMarker, s);
  if (e === -1) throw new Error('extraction failed: could not find end marker after start (' + label + '): ' + endMarker);
  return src.slice(s, e);
}

// Just the normalize function + the per-active-list duplicate-counting
// block, lifted verbatim out of renderStaffList's own source.
const normSrc = extract(
  '  function _normPhoneForStaffCard(raw) {',
  '\n  const card = (emp, i) => {',
  '_normPhoneForStaffCard + duplicate counting'
);

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

function run(activeList) {
  const sandbox = { console: console, active: activeList };
  vm.createContext(sandbox);
  vm.runInContext(normSrc, sandbox);
  return { normalize: sandbox._normPhoneForStaffCard, counts: sandbox._phoneCounts };
}

(function () {
  console.log('Testing extracted phone normalization + duplicate detection from index.html\n');

  // Real data shape (names changed to protect nothing -- these are the
  // actual normalization edge cases found live).
  const active = [
    { name: 'Blanca Payan', phone: '7816263485' },
    { name: 'Viviana', phone: '17816263485' }, // same number, leading country code
    { name: 'Melissa Manna', phone: '7813125552' },
    { name: 'Nadia Barros', phone: '7742251270' },
    { name: 'Tomas Manna', phone: '555' }, // too short -- not a real number
    { name: 'Ana A', phone: null },         // no phone at all
    { name: 'Katy A', phone: '' },
  ];
  const { normalize, counts } = run(active);

  check('Blanca and Viviana normalize to the SAME 10-digit number', normalize('7816263485'), normalize('17816263485'));
  check('that shared number is counted twice', counts[normalize('7816263485')], 2);
  check('a distinct number (Melissa) is counted once', counts[normalize('7813125552')], 1);
  check('Tomas\'s "555" does not normalize to a real 10-digit number', normalize('555'), null);
  check('a null phone does not normalize', normalize(null), null);
  check('an empty-string phone does not normalize', normalize(''), null);
  check('a malformed short number is never silently counted as a duplicate of anything', counts[normalize('555')], undefined);

  // A clean set with zero duplicates should report nothing above 1.
  {
    const cleanActive = [
      { name: 'A', phone: '1111111111' },
      { name: 'B', phone: '2222222222' },
    ];
    const { counts: cleanCounts } = run(cleanActive);
    check('no false-positive duplicates among genuinely distinct numbers', Object.values(cleanCounts).every(function (c) { return c === 1; }), true);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
})();
