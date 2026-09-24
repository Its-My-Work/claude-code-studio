// A bridge "child" that can never start: used by test/llm-bridge-host.test.js to drive the
// host's restart backoff into its give-up rule.
'use strict';
process.stderr.write('[error] exit-child: refusing to start\n');
process.exit(7);
