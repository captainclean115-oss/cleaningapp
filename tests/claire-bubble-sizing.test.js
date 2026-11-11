// Claire cleanup PART 3: bubble sizing.
//
// User bubbles size to their content with a sensible min width (a
// 2-word message must not wrap), max width about 85%, timestamp on its
// own line BELOW the bubble, never overlapping. Proposal cards follow
// the same width rules (they're rendered as the inner content of a
// .claire-bubble-claire div via _claireRenderBubble, so they inherit
// these rules automatically -- confirmed below, not assumed).
//
// This extracts the REAL _claireRenderBubble markup-building function
// plus the real CSS rules it depends on, and checks both the DOM
// structure (timestamp is a sibling div below the bubble, no absolute
// positioning / negative margins that could cause overlap) and the CSS
// (width: fit-content + min-width + max-width: 85%).
//
// Run with: node tests/claire-bubble-sizing.test.js

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(INDEX_HTML, 'utf8');

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label); }
}

function extract(startMarker, endMarker) {
  const s = src.indexOf(startMarker);
  if (s === -1) { console.error('FAIL: could not find start marker: ' + startMarker); process.exit(1); }
  const e = src.indexOf(endMarker, s);
  if (e === -1) { console.error('FAIL: could not find end marker: ' + endMarker); process.exit(1); }
  return src.slice(s, e);
}

function sliceBetween(startMarker, endMarker) { return extract(startMarker, endMarker); }

// ---- 1. DOM structure: the REAL _claireRenderBubble, run against a
// fake document, to confirm the timestamp is a sibling div BELOW the
// bubble (never inside it, never absolutely positioned over it). ----
{
  const fnSrc = extract('function _claireRenderBubble(who, html) {', '\n\n// When _claireSilent is true');
  const appended = [];
  const sandbox = {
    console,
    _claireMsgsEl: function () { return { appendChild: function (el) { appended.push(el); }, scrollTop: 0, scrollHeight: 0 }; },
    _claireTimeNow: function () { return '3:45 PM'; },
    document: {
      createElement: function () { return { className: '', innerHTML: '' }; },
    },
    requestAnimationFrame: function (fn) { fn(); },
  };
  vm.createContext(sandbox);
  vm.runInContext(fnSrc, sandbox);
  sandbox._claireRenderBubble('user', 'Hi there');

  check('_claireRenderBubble appended exactly one row', appended.length === 1);
  const rowHtml = appended[0] ? appended[0].innerHTML : '';
  const bubbleIdx = rowHtml.indexOf('claire-bubble-user');
  const timeIdx = rowHtml.indexOf('claire-bubble-time');
  check('the row contains both a bubble and a timestamp element', bubbleIdx !== -1 && timeIdx !== -1);
  check('the timestamp markup comes AFTER the bubble markup in source order (below it, not overlapping)', timeIdx > bubbleIdx);
  check('the timestamp is a sibling div, not nested inside the bubble div (no absolute overlay)', !/claire-bubble-user">[^<]*<div class="claire-bubble-time"/.test(rowHtml));
  check('the actual message text is inside the bubble', rowHtml.indexOf('Hi there') > bubbleIdx && rowHtml.indexOf('Hi there') < timeIdx);
}

// ---- 2. CSS: bubbles size to content (fit-content) with a min-width
// floor and max-width ~85%, never fixed/stretched to the full row. ----
{
  const userCss = sliceBetween('.claire-bubble-user {', '}');
  const claireCss = sliceBetween('.claire-bubble-claire {', '}');

  [['user', userCss], ['claire', claireCss]].forEach(([who, css]) => {
    check(`.claire-bubble-${who} sizes to its content (width: fit-content) -- not stretched full-width, so a short message can't be forced to wrap`, /width:\s*(-webkit-)?fit-content/.test(css));
    check(`.claire-bubble-${who} has a sensible min-width floor (very short content never looks like a sliver)`, /min-width:\s*\d+px/.test(css));
    const maxWidthMatch = css.match(/max-width:\s*(\d+)%/);
    check(`.claire-bubble-${who} max-width is about 85%`, !!maxWidthMatch && parseInt(maxWidthMatch[1], 10) >= 83 && parseInt(maxWidthMatch[1], 10) <= 87);
  });
}

// ---- 3. Timestamp CSS has no absolute positioning / negative margins
// that could pull it back up over the bubble. ----
{
  const timeCss = sliceBetween('.claire-bubble-time {', '}');
  check('.claire-bubble-time is not absolutely positioned (so it can never overlap the bubble above it)', !/position:\s*absolute/.test(timeCss));
  check('.claire-bubble-time has no negative margin pulling it back up over the bubble', !/margin[^:]*:\s*-/.test(timeCss));
}

// ---- 4. Proposal cards follow the SAME width rules -- confirmed by
// checking they are rendered as the inner content of a
// .claire-bubble-claire div via _claireRenderBubble, not a separately
// (and potentially unboundedly) sized element. ----
{
  const flushFnSrc = extract('function _claireFlushProposalCards() {', '\n}');
  check('proposal cards are rendered via the same _claireRenderBubble(\'claire\', ...) call as any other Claire message -- so they inherit .claire-bubble-claire\'s width rules automatically', /_claireRenderBubble\('claire',\s*_clairePendingProposals\[i\]\.html\)/.test(flushFnSrc));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
