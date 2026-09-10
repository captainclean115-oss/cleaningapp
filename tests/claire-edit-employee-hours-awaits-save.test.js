// saveEmpHours became a Supabase write (migration 110 / PentaHourOverrides,
// see manual-hour-overrides-supabase.test.js) -- Claire's edit_employee_hours
// tool call site must await it and report a real failure back to the user
// instead of claiming "Done." while the correction never actually saved.
//
// _executeClaireToolCallInner is a multi-thousand-line dispatcher (many
// `else if (name === ...)` tool branches) -- not practical to extract
// wholesale into a vm sandbox the way smaller single-purpose functions
// are elsewhere in this test suite. This asserts the fix's exact shape
// in source instead: the edit_employee_hours branch awaits saveEmpHours
// inside a try/catch that reports failure, before it does anything else.
//
// Run with: node tests/claire-edit-employee-hours-awaits-save.test.js

const fs = require('fs');
const path = require('path');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(INDEX_HTML, 'utf8');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

const branchStart = src.indexOf("} else if (name === 'edit_employee_hours') {");
check('the edit_employee_hours branch was found', branchStart !== -1, true);
const branchEnd = src.indexOf("} else if (name === 'locate_team') {", branchStart);
check('the branch end boundary (next tool branch) was found', branchEnd !== -1, true);
const branch = src.slice(branchStart, branchEnd);

check(
  'saveEmpHours is awaited (not fire-and-forget)',
  /await\s+saveEmpHours\(/.test(branch),
  true
);
check(
  'the await is wrapped in try/catch',
  /try\s*\{\s*await\s+saveEmpHours\(/.test(branch),
  true
);
check(
  'the catch reports a failure via claireReply instead of silently continuing',
  /catch\s*\([^)]*\)\s*\{[^}]*claireReply/.test(branch),
  true
);
check(
  'the catch happens BEFORE the "Done"/success claireReply, not after',
  branch.indexOf('catch') < branch.lastIndexOf('claireReply('),
  true
);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
