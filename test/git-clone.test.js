// "Add project from a Git URL" — issue #94.
//
// Two halves. git-clone.js is pure and is pinned directly: which URLs are accepted,
// what the argv looks like, and that nothing user-supplied can reach git as an
// option. Then POST /api/projects/clone is driven against a REAL server whose PATH
// holds a FAKE `git` — it records its argv and environment, creates the directory
// the way a clone would, and fails on demand — so the suite proves the endpoint's
// gates, the project registration and the failure cleanup without touching the
// network or a developer's real repositories.
//
// Run: node test/git-clone.test.js   (TEST_PORT=<n> to move off the default port)
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const G = require('../git-clone');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

console.log('\n— git-clone.js: which URLs are cloned from —');
check('https URL', G.parseCloneUrl('https://github.com/Lexus2016/claude-code-studio.git'), { url: 'https://github.com/Lexus2016/claude-code-studio.git', repoName: 'claude-code-studio' });
check('scp-like ssh', G.parseCloneUrl('git@github.com:Lexus2016/claude-code-studio'), { url: 'git@github.com:Lexus2016/claude-code-studio', repoName: 'claude-code-studio' });
check('ssh:// with a port', G.parseCloneUrl('ssh://git@host:2222/a/b.git').repoName, 'b');
check('git://', G.parseCloneUrl('git://host/x/y.git').repoName, 'y');
check('trailing slash is tolerated', G.parseCloneUrl('http://h/repo/').repoName, 'repo');
check('surrounding whitespace is trimmed', G.parseCloneUrl('  https://h/a/b  ').url, 'https://h/a/b');
check('ext:: transport is refused — it executes a command', G.parseCloneUrl('ext::sh -c id'), null);
check('file:// is refused', G.parseCloneUrl('file:///etc'), null);
check('a bare local path is refused', G.parseCloneUrl('/tmp/x'), null);
check('an option-shaped string is refused', G.parseCloneUrl('--upload-pack=id'), null);
check('embedded whitespace is refused', G.parseCloneUrl('git@h:a b'), null);
check('a repo name of `..` is refused', G.parseCloneUrl('https://h/x/..'), null);
check('a dot-leading repo name is refused', G.parseCloneUrl('https://h/x/.git'), null);
check('non-string input is refused', G.parseCloneUrl({ toString: () => 'https://h/a/b' }), null);
// CVE-2017-1000117: the host itself is an ssh option. The leading `-` check on the
// whole string does not see it — it sits behind the scheme or the `@`.
check('an option-shaped host behind the scheme is refused', G.parseCloneUrl('ssh://-oProxyCommand=id/x/y'), null);
check('an option-shaped host behind the @ is refused', G.parseCloneUrl('git@-oProxyCommand=id:a/b'), null);
check('an option-shaped user is refused', G.parseCloneUrl('ssh://-u@h/a/b'), null);
check('a port does not hide the host', G.parseCloneUrl('ssh://git@host:2222/a/b.git').repoName, 'b');
check('a password in the userinfo is still a URL', G.parseCloneUrl('https://user:pw@h/a/b').repoName, 'b');

console.log('\n— git-clone.js: argv and environment —');
check('argv puts -- before the URL and target', G.cloneArgs({ url: 'U', target: 'T' }), ['clone', '--', 'U', 'T']);
check('branch and depth precede --', G.cloneArgs({ url: 'U', target: 'T', branch: 'dev', shallow: true }), ['clone', '--branch', 'dev', '--depth', '1', '--', 'U', 'T']);
check('a branch starting with - is not a branch', G.isValidBranch('-x'), false);
check('a branch with .. is not a branch', G.isValidBranch('a..b'), false);
check('feat/x is a branch', G.isValidBranch('feat/x'), true);
check('a dir name with a separator is refused', G.isValidDirName('a/b'), false);
check('a dir name of .. is refused', G.isValidDirName('..'), false);
check('a plain dir name is accepted', G.isValidDirName('my-repo_1.0'), true);
const env = G.cloneEnv({ FOO: '1' });
check('env keeps the base', env.FOO, '1');
check('env never prompts', env.GIT_TERMINAL_PROMPT, '0');
check('env pins the transport allowlist', env.GIT_ALLOW_PROTOCOL, 'http:https:ssh:git');

// ── the endpoint against a real server with a fake git ──────────────────────
const PORT = Number(process.env.TEST_PORT || 4541);
const BASE = `http://127.0.0.1:${PORT}`;
const APP_DIR  = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-clone-app-'));
const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-clone-home-'));
const BIN_DIR  = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-clone-bin-'));
const OUTSIDE  = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-clone-outside-'));
process.on('exit', () => { for (const d of [APP_DIR, HOME_DIR, BIN_DIR, OUTSIDE]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
fs.mkdirSync(path.join(APP_DIR, 'data'), { recursive: true });
const WORKSPACE = path.join(APP_DIR, 'workspace');
fs.mkdirSync(WORKSPACE, { recursive: true });
// The endpoint answers with the PHYSICAL parent (realpath), so on macOS, where
// /var is a symlink to /private/var, the path it returns is not the one composed
// here. Requests still send the unresolved WORKSPACE — that is what exercises it.
const WS_REAL = fs.realpathSync(WORKSPACE);
const GIT_LOG = path.join(APP_DIR, 'git-calls.log');

// Fake git: one line of JSON per call — argv, cwd, the two env vars we care about.
// Creates the target like a clone would. A URL containing "boom" fails AFTER creating
// the directory, which is what a SIGKILLed real clone leaves behind.
fs.writeFileSync(path.join(BIN_DIR, 'git'), `#!/bin/sh
PATH=/usr/bin:/bin:$PATH
printf '%s\\n' "$(node -e 'console.log(JSON.stringify({argv:process.argv.slice(1),cwd:process.cwd(),prompt:process.env.GIT_TERMINAL_PROMPT,allow:process.env.GIT_ALLOW_PROTOCOL}))' -- "$@")" >> "${GIT_LOG}"
for last; do :; done
mkdir -p "$last/.git"
case "$*" in *slow*) sleep 3;; esac
case "$*" in *boom*) echo "fatal: repository 'boom' not found" >&2; exit 128;; esac
exit 0
`, { mode: 0o755 });
// `node` must resolve for the fake git, so PATH is the fake dir plus node's own dir.
const PATH_ENV = BIN_DIR + path.delimiter + path.dirname(process.execPath);

let srvLog = '';
const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), CCS_DESKTOP: '1', APP_DIR, WORKDIR: WORKSPACE, HOME: HOME_DIR, PATH: PATH_ENV },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let exited = false;
child.on('exit', () => { exited = true; });
child.stdout.on('data', d => { srvLog += d; });
child.stderr.on('data', d => { srvLog += d; });
let cleanedUp = false;
function cleanup() { if (cleanedUp) return; cleanedUp = true; if (!exited) { try { child.kill('SIGTERM'); } catch {} } }
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { cleanup(); process.exit(1); });
function die(msg) { console.error(msg); if (srvLog) console.error(srvLog.slice(-2000)); cleanup(); process.exit(1); }

async function api(method, url, body) {
  const res = await fetch(BASE + url, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}
const clone = body => api('POST', '/api/projects/clone', body);
const gitCalls = () => fs.existsSync(GIT_LOG) ? fs.readFileSync(GIT_LOG, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [];

(async () => {
  let up = false;
  for (let i = 0; i < 80 && !exited; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) { up = true; break; } } catch {}
    await sleep(250);
  }
  if (exited) die(`server exited before it became ready — port ${PORT} collision or startup crash`);
  if (!up) die(`server on port ${PORT} did not start`);

  console.log('\n— gates, in the order the endpoint applies them —');
  check('ext:: URL is 400 and git is never run', (await clone({ url: 'ext::sh -c id', parentDir: WORKSPACE })).status, 400);
  check('option-shaped branch is 400', (await clone({ url: 'https://h/a/b', parentDir: WORKSPACE, branch: '-x' })).status, 400);
  check('dirName with a separator is 400', (await clone({ url: 'https://h/a/b', parentDir: WORKSPACE, dirName: '../x' })).status, 400);
  check('a parent outside the allowed roots is 403', (await clone({ url: 'https://h/a/b', parentDir: OUTSIDE })).status, 403);
  check('a parent that does not exist is 400', (await clone({ url: 'https://h/a/b', parentDir: path.join(WORKSPACE, 'nope') })).status, 400);
  fs.mkdirSync(path.join(WORKSPACE, 'taken'));
  check('an existing target is 409', (await clone({ url: 'https://h/a/taken.git', parentDir: WORKSPACE })).status, 409);
  // A symlink inside an allowed root is a string that passes isPathAllowed() and a
  // directory that is somewhere else — so the parent is re-checked after realpath.
  fs.symlinkSync(OUTSIDE, path.join(WORKSPACE, 'linkout'));
  check('a parent that is a symlink out of the allowed roots is 403', (await clone({ url: 'https://h/a/b', parentDir: path.join(WORKSPACE, 'linkout') })).status, 403);
  // A DANGLING symlink does not "exist" — git would follow it and populate its target.
  fs.symlinkSync(path.join(OUTSIDE, 'nowhere'), path.join(WORKSPACE, 'ghost'));
  check('a target that is a dangling symlink is 409, not a clone', (await clone({ url: 'https://h/a/ghost.git', parentDir: WORKSPACE })).status, 409);
  check('none of the refusals reached git', gitCalls().length, 0);

  console.log('\n— a clone that succeeds —');
  const ok = await clone({ url: 'https://github.com/acme/widget.git', parentDir: WORKSPACE, branch: 'dev' });
  check('answers 200 ok', [ok.status, ok.json?.ok], [200, true]);
  const target = path.join(WS_REAL, 'widget');
  check('workdir is <parent>/<repo>', ok.json?.workdir, target);
  check('the directory exists', fs.existsSync(path.join(target, '.git')), true);
  const call = gitCalls()[0];
  check('git argv: clone --branch dev -- <url> <target>', call.argv, ['clone', '--branch', 'dev', '--', 'https://github.com/acme/widget.git', target]);
  check('git ran in the parent', fs.realpathSync(call.cwd), WS_REAL);
  check('git was told never to prompt', call.prompt, '0');
  check('git was pinned to the transport allowlist', call.allow, 'http:https:ssh:git');
  const projects = (await api('GET', '/api/projects')).json;
  const row = projects.find(p => p.id === ok.json.id);
  check('a project row was registered', !!row, true);
  check('named after the repository when no name was given', row?.name, 'widget');
  check('pointing at the clone', row?.workdir, target);
  check('and it is local', !!row?.isRemote, false);

  console.log('\n— a clone that fails —');
  const bad = await clone({ url: 'https://h/a/boom.git', parentDir: WORKSPACE, name: 'named' });
  check('answers 502', bad.status, 502);
  check('with git\'s own last stderr line', bad.json?.error, "fatal: repository 'boom' not found");
  check('the half-made directory is removed', fs.existsSync(path.join(WS_REAL, 'boom')), false);
  check('and no project was registered', (await api('GET', '/api/projects')).json.some(p => p.name === 'named'), false);

  console.log('\n— the concurrency cap —');
  const slowA = clone({ url: 'https://h/a/slow1.git', parentDir: WORKSPACE });
  const slowB = clone({ url: 'https://h/a/slow2.git', parentDir: WORKSPACE });
  await sleep(400);
  check('a third clone while two run is 429', (await clone({ url: 'https://h/a/slow3.git', parentDir: WORKSPACE })).status, 429);
  check('the two that were admitted still succeed', (await Promise.all([slowA, slowB])).map(r => r.status), [200, 200]);
  check('and the slot is given back', (await clone({ url: 'https://h/a/after.git', parentDir: WORKSPACE })).status, 200);

  console.log('\n— dirName and name overrides —');
  const named = await clone({ url: 'git@github.com:acme/widget.git', parentDir: WORKSPACE, dirName: 'widget2', name: 'Widget Two', shallow: true });
  check('dirName picks the folder', named.json?.workdir, path.join(WS_REAL, 'widget2'));
  check('shallow adds --depth 1', gitCalls().pop().argv.slice(0, 3), ['clone', '--depth', '1']);
  check('name is the project name', (await api('GET', '/api/projects')).json.find(p => p.id === named.json.id)?.name, 'Widget Two');

  cleanup();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => die(String(e && e.stack || e)));
