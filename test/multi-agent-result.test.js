// One-off verification for multi-agent-result (no test framework wired in this project).
// Run: node test/multi-agent-result.test.js
const assert = require('assert');
const { isAgentSuccess, shouldAutoContinue, agentStopReason, roomStopReason } = require('../multi-agent-result');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try {
    assert.strictEqual(actual, expected);
    pass++; console.log(`  ok   ${label}`);
  } catch {
    fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const OK = { subtype: 'success' };
const MAXT = { subtype: 'error_max_turns', num_turns: 50 };
const CRASH = { subtype: 'error_during_execution' };

console.log('isAgentSuccess — only an explicit success counts:');
check('success subtype', isAgentSuccess(OK, false), true);
check('max_turns is NOT success', isAgentSuccess(MAXT, false), false);
check('crash subtype is NOT success', isAgentSuccess(CRASH, false), false);
// A killed subprocess emits no result frame — the bug this whole branch exists to fix.
check('missing result frame is NOT success', isAgentSuccess(null, false), false);
check('undefined result is NOT success', isAgentSuccess(undefined, false), false);
// onError already reported the failure; never overrule it with a success.
check('errored wins over success frame', isAgentSuccess(OK, true), false);

console.log('\nshouldAutoContinue — only turn exhaustion, only within budget:');
check('max_turns, 0 of 3 used', shouldAutoContinue(MAXT, false, 0, 3), true);
check('max_turns, 2 of 3 used', shouldAutoContinue(MAXT, false, 2, 3), true);
check('max_turns, budget exhausted', shouldAutoContinue(MAXT, false, 3, 3), false);
check('max_turns, over budget', shouldAutoContinue(MAXT, false, 4, 3), false);
check('success -> no continue', shouldAutoContinue(OK, false, 0, 3), false);
check('crash -> no continue', shouldAutoContinue(CRASH, false, 0, 3), false);
check('missing frame -> no continue', shouldAutoContinue(null, false, 0, 3), false);
check('errored -> no continue', shouldAutoContinue(MAXT, true, 0, 3), false);
check('zero budget -> no continue', shouldAutoContinue(MAXT, false, 0, 0), false);

console.log('\nagentStopReason — says which of the four ways it stopped:');
check('errored', agentStopReason(CRASH, true, 50), 'failed — see the error above');
check('max_turns, no continues', agentStopReason(MAXT, false, 50), 'hit the 50-turn limit');
check('max_turns after continues', agentStopReason(MAXT, false, 50, 3),
  'still hit the 50-turn limit after 3 auto-continues');
check('other subtype', agentStopReason(CRASH, false, 50), 'stopped early (error_during_execution)');
check('missing frame', agentStopReason(null, false, 50), 'was stopped before it reported completion');

// A room bot that ran out of turns exits non-zero, which the CLI wrapper also reports as an error. The
// note then said "failed — see the error above" with nothing above it; the result frame has the reason.
console.log('roomStopReason — the result frame wins over the generic error:');
check('turn limit + an error flag -> the turn limit', roomStopReason(MAXT, true, 20), 'hit the 20-turn limit');
check('turn limit alone', roomStopReason(MAXT, false, 20), 'hit the 20-turn limit');
check('another subtype + error flag -> that subtype', roomStopReason(CRASH, true, 20), 'stopped early (error_during_execution)');
check('no frame + error -> the error', roomStopReason(null, true, 20), 'failed — see the error above');
check('no frame, no error -> stopped before completion', roomStopReason(null, false, 20), 'was stopped before it reported completion');
check('a success frame with an error flag is still the error', roomStopReason(OK, true, 20), 'failed — see the error above');
check('undefined result', roomStopReason(undefined, true, 20), 'failed — see the error above');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
