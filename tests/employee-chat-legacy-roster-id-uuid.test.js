// Bug: "message from employee to in message tab is failing" for any
// employee onboarded via the job-application -> hire flow. Root cause:
// _bootResolveEmployeeFromAuth() set currentEmployee.id to
// `legacy_roster_id || id` (the same "unified roster id" convention
// getUnifiedRoster() uses so team/schedule lookups work across both id
// spaces -- see legacy-roster-id-vs-uuid memory). For an app-hired
// employee, legacy_roster_id is a non-UUID string like 'app_796a8946',
// not the real employees.id UUID. PentaChatMessages.send/listThread/
// markThreadRead/countUnreadForEmployee all validate their employeeId
// argument as a real UUID (chat_messages.thread_employee_id is a uuid
// column) and reject/no-op anything else -- so a message from such an
// employee threw 'threadEmployeeId must be a uuid', caught and shown as
// a generic "Message failed" toast, and even their own thread would have
// rendered empty (listThread) with a stuck unread badge (countUnread).
//
// Fix, matching the existing getUnifiedRoster() convention (id: legacy-
// preferred, uuid: always the real employees.id): _bootResolveEmployeeFromAuth
// now also returns `uuid: m.id`, and every chat_messages-facing call site
// (send, listThread, markThreadRead, countUnreadForEmployee, and the
// tenant-wide realtime INSERT matcher) now uses `currentEmployee.uuid ||
// currentEmployee.id` instead of the bare (legacy-preferred) `.id`.
//
// Run with: node tests/employee-chat-legacy-roster-id-uuid.test.js

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(INDEX_HTML, 'utf8');

function extract(startMarker, endMarker, label) {
  const s = src.indexOf(startMarker);
  if (s === -1) { console.error('FAIL: could not find "' + startMarker + '" (' + label + ')'); process.exit(1); }
  const e = src.indexOf(endMarker, s);
  if (e === -1) { console.error('FAIL: could not find end boundary for ' + label); process.exit(1); }
  return src.slice(s, e);
}

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

// --- _bootResolveEmployeeFromAuth returns BOTH the legacy-preferred id
//     (for schedule/team lookups) AND a real uuid (for uuid-strict DB work
//     like chat_messages), matching getUnifiedRoster()'s established shape.
{
  const bootFnSource = extract(
    'function _bootResolveEmployeeFromAuth(parsed) {',
    "\n  function _bootShowForcedPasswordChange",
    '_bootResolveEmployeeFromAuth'
  );
  const rows = {
    'app-hired-employee': {
      id: '7a8465c8-8ae1-48f8-8657-bfe407f21091',
      legacy_roster_id: 'app_796a8946',
      first_name: 'Melissa', last_name: 'Manna',
      team_text: 'B1', team_id: null, culture_tag: 'us', position: 'team_member',
      photo_url: '', status: 'active', auth_user_id: 'auth-uuid-1',
    },
    'roster-import-employee': {
      id: '11111111-1111-1111-1111-111111111111',
      legacy_roster_id: 'e_42',
      first_name: 'Old', last_name: 'Timer',
      team_text: 'B2', team_id: null, culture_tag: 'us', position: 'team_member',
      photo_url: '', status: 'active', auth_user_id: 'auth-uuid-2',
    },
  };
  function buildSandbox(authId) {
    const sandbox = {
      console,
      window: { supabaseClient: null, PentaTeams: null },
      supabaseClient: {
        from: () => ({
          select: () => ({
            eq: (col, val) => ({
              is: () => ({
                maybeSingle: () => Promise.resolve(
                  rows[val] ? { data: rows[val], error: null } : { data: null, error: null }
                ),
              }),
            }),
          }),
        }),
      },
    };
    sandbox.window.supabaseClient = sandbox.supabaseClient;
    vm.createContext(sandbox);
    vm.runInContext(bootFnSource, sandbox);
    return sandbox;
  }

  (async () => {
    // App-hired employee: legacy_roster_id is a non-UUID 'app_...' string.
    // .id stays legacy-preferred (unchanged, other code relies on this);
    // .uuid must be the real employees.id.
    {
      const sandbox = buildSandbox('app-hired-employee');
      const emp = await sandbox._bootResolveEmployeeFromAuth({ user: { id: 'app-hired-employee' } });
      check('app-hired employee: .id stays legacy_roster_id (unchanged convention)', emp.id, 'app_796a8946');
      check('app-hired employee: .uuid is the real employees.id', emp.uuid, '7a8465c8-8ae1-48f8-8657-bfe407f21091');
    }
    // Roster-import employee: legacy_roster_id already looks nothing like a
    // uuid either (e_42) -- same fix applies uniformly, not app_-specific.
    {
      const sandbox = buildSandbox('roster-import-employee');
      const emp = await sandbox._bootResolveEmployeeFromAuth({ user: { id: 'roster-import-employee' } });
      check('roster-import employee: .id stays legacy_roster_id', emp.id, 'e_42');
      check('roster-import employee: .uuid is the real employees.id', emp.uuid, '11111111-1111-1111-1111-111111111111');
    }

    // --- sendStaffReplyEmp passes the real uuid as threadEmployeeId, not
    //     whatever .id happens to be.
    {
      const sendFnSource = extract('async function sendStaffReplyEmp() {', '\n\n// Lightweight helper: translate to English', 'sendStaffReplyEmp');
      let sendArgs = null;
      const sandbox = {
        console,
        currentEmployee: { id: 'app_796a8946', uuid: '7a8465c8-8ae1-48f8-8657-bfe407f21091', lang: 'en' },
        currentLang: 'en',
        document: { getElementById: () => ({ value: 'hello manager' }) },
        window: { PentaChatMessages: { send: (input) => { sendArgs = input; return Promise.resolve(); } } },
        renderEmpChat: () => {},
        _toastSimple: () => {},
      };
      vm.createContext(sandbox);
      vm.runInContext(sendFnSource, sandbox);
      await sandbox.sendStaffReplyEmp();
      check('sendStaffReplyEmp sends the real uuid, not the legacy_roster_id', sendArgs && sendArgs.threadEmployeeId, '7a8465c8-8ae1-48f8-8657-bfe407f21091');
    }
    {
      // Fallback: an employee record with no .uuid (shouldn't happen post-fix,
      // but confirms the || fallback doesn't itself throw/crash).
      const sendFnSource = extract('async function sendStaffReplyEmp() {', '\n\n// Lightweight helper: translate to English', 'sendStaffReplyEmp');
      let sendArgs = null;
      const sandbox = {
        console,
        currentEmployee: { id: '22222222-2222-2222-2222-222222222222', lang: 'en' },
        currentLang: 'en',
        document: { getElementById: () => ({ value: 'hi' }) },
        window: { PentaChatMessages: { send: (input) => { sendArgs = input; return Promise.resolve(); } } },
        renderEmpChat: () => {},
        _toastSimple: () => {},
      };
      vm.createContext(sandbox);
      vm.runInContext(sendFnSource, sandbox);
      await sandbox.sendStaffReplyEmp();
      check('sendStaffReplyEmp falls back to .id when .uuid is absent', sendArgs && sendArgs.threadEmployeeId, '22222222-2222-2222-2222-222222222222');
    }

    // --- updateEmpChatBadge counts unread against the real uuid.
    {
      const badgeFnSource = extract('async function updateEmpChatBadge() {', '\n\nasync function sendStaffReplyEmp', 'updateEmpChatBadge');
      let calledWith = null;
      const badgeEl = { textContent: '', style: {} };
      const sandbox = {
        console,
        currentEmployee: { id: 'app_796a8946', uuid: '7a8465c8-8ae1-48f8-8657-bfe407f21091' },
        document: { getElementById: () => badgeEl },
        window: { PentaChatMessages: { countUnreadForEmployee: (id) => { calledWith = id; return Promise.resolve(2); } } },
      };
      vm.createContext(sandbox);
      vm.runInContext(badgeFnSource, sandbox);
      await sandbox.updateEmpChatBadge();
      check('updateEmpChatBadge queries unread count by the real uuid', calledWith, '7a8465c8-8ae1-48f8-8657-bfe407f21091');
    }

    console.log('\n' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail > 0 ? 1 : 0);
  })();
}
