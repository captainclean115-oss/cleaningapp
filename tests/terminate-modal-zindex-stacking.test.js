// Regression test: Terminate Employee modal rendered invisible behind the
// still-open Staff modal.
//
// Reported: "Terminate Employee button does nothing when tapped" -- visible,
// styled correctly, no error, no response. Static code reading (button
// wiring, openTerminateEmployeeModal, duplicate IDs) found nothing wrong,
// and an isolated repro (button + modal only, no surrounding staff-modal
// context) worked fine -- because the isolated repro didn't reproduce the
// real stacking context.
//
// Root cause: #terminate-employee-modal shipped with z-index:800.
// #staff-modal (the modal it's opened FROM via the "Staff > Employees >
// click employee" flow -- the canonical path) has z-index:9000 and stays
// open underneath it. Since 800 < 9000, openTerminateEmployeeModal('staff')
// correctly sets display:flex, but the confirmation dialog renders
// completely hidden behind the still-visible staff-modal: no JS error, no
// visible change -- exactly the reported symptom. Confirmed live with a
// real headless-Chrome hit-test: a tap at the Confirm button's exact
// screen coordinates landed on #staff-modal, not the button.
//
// The #main-emp-modal path (z-index:300) was unaffected (800 > 300),
// which is why testing that path alone didn't catch this.
//
// Other modals nested inside staff-modal that already work correctly
// (#balance-modal, #form-builder-modal) use z-index:9500 -- adopted here
// for consistency, comfortably above staff-modal's 9000.
//
// Run with: node tests/terminate-modal-zindex-stacking.test.js

const fs = require('fs');
const path = require('path');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(INDEX_HTML, 'utf8');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + expected + ', got ' + actual); }
}

function zIndexOf(id) {
  const re = new RegExp('id="' + id + '"[^>]*style="[^"]*z-index:\\s*(\\d+)');
  const m = src.match(re);
  return m ? parseInt(m[1], 10) : null;
}

const termZ = zIndexOf('terminate-employee-modal');
const staffZ = zIndexOf('staff-modal');
const mainEmpZ = zIndexOf('main-emp-modal');

check('terminate-employee-modal has a z-index defined', termZ !== null, true);
check('staff-modal has a z-index defined', staffZ !== null, true);
check('main-emp-modal has a z-index defined', mainEmpZ !== null, true);

if (termZ !== null && staffZ !== null) {
  check(
    'terminate-employee-modal z-index (' + termZ + ') is above staff-modal\'s (' + staffZ + ') -- otherwise the confirmation dialog opened via the "Staff > Employees" flow renders invisibly behind the still-open staff modal',
    termZ > staffZ,
    true
  );
}
if (termZ !== null && mainEmpZ !== null) {
  check(
    'terminate-employee-modal z-index (' + termZ + ') is above main-emp-modal\'s (' + mainEmpZ + ')',
    termZ > mainEmpZ,
    true
  );
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
