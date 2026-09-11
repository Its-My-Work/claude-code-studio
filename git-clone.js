// git-clone.js — "Add project from a Git URL" (issue #94): the pure half.
//
// POST /api/projects/clone in server.js takes a URL and a parent directory the
// user has already browsed to, runs `git clone` into <parent>/<repo>, and registers
// the result as a local project. Everything that can be decided without touching
// the filesystem or spawning git lives here so it is testable in isolation.
//
// Three rules, each of which exists because the URL and the names are user input
// that end up in a process argv and in a path we create:
//
// - TRANSPORTS ARE AN ALLOWLIST. `ext::` runs an arbitrary command, `file://` and a
//   bare local path clone any repository this process can read — neither is a URL a
//   project should be created from. The same list is exported as GIT_ALLOW_PROTOCOL
//   so a redirect or a submodule cannot widen it after the check.
// - NOTHING WE PASS MAY LOOK LIKE AN OPTION. The URL and the target follow `--`, but
//   `--branch <b>` cannot, so a branch starting with `-` is refused outright rather
//   than reaching git as a second flag.
// - THE DIRECTORY NAME IS A SINGLE PATH SEGMENT. Derived from the URL or given by
//   the user, it is joined onto a parent that passed isPathAllowed(); `..`, `/` or a
//   leading `.` would let the clone land somewhere else.
// - AND THE AUTHORITY IS PART OF THE ARGV. `ssh://-oProxyCommand=id/x` and
//   `git@-oProxyCommand=id:x/y` are URLs whose HOST is an ssh option — CVE-2017-1000117.
//   The leading `-` check on the whole string does not see them, because the option is
//   behind the scheme or the `@`. Current git passes `--` to ssh itself, so this is a
//   belt on top of a brace; the rule above says nothing we hand git may look like an
//   option, and a rule that holds only on a patched binary is not that rule.

const ALLOWED_PROTOCOLS = ['http', 'https', 'ssh', 'git'];

// A directory we will create — one segment, no leading dot, no separators.
const DIR_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// git's own rules are looser (check-ref-format), but a branch outside this set is
// far more likely a typo or an injection attempt than a real ref name.
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

const URL_RE = /^(?:https?|ssh|git):\/\/[^\s/@]+(?:@[^\s/@]+)?(?::\d+)?\/[^\s]+$/;
// scp-like: git@github.com:user/repo.git — no scheme, exactly one ':' after the host.
const SCP_RE = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[^\s:]+$/;

// Every `@`-separated part of an authority reaches ssh/git as argv; none may open
// with `-`. The trailing `:<port>` is dropped first so a port cannot hide the host.
function authorityIsSafe(authority) {
  return authority.replace(/:\d+$/, '').split('@').every(part => part && !part.startsWith('-'));
}

/**
 * @param {unknown} raw
 * @returns {{ url: string, repoName: string } | null} null when the URL is not one
 *   we clone from; repoName is the last path segment minus `.git`.
 */
function parseCloneUrl(raw) {
  if (typeof raw !== 'string') return null;
  const url = raw.trim();
  if (!url || url.startsWith('-') || /[\s\0]/.test(url)) return null;
  if (!URL_RE.test(url) && !SCP_RE.test(url)) return null;
  // `<user>@<host>[:port]` — the part before the path in a URL, before the `:` in
  // an scp-like address.
  const authority = URL_RE.test(url)
    ? url.slice(url.indexOf('://') + 3).split('/')[0]
    : url.split(':')[0];
  if (!authorityIsSafe(authority)) return null;
  const tail = url.replace(/\/+$/, '').split(/[/:]/).pop().replace(/\.git$/i, '');
  if (!DIR_NAME_RE.test(tail)) return null;
  return { url, repoName: tail };
}

function isValidDirName(s) {
  return typeof s === 'string' && DIR_NAME_RE.test(s);
}

function isValidBranch(s) {
  return typeof s === 'string' && BRANCH_RE.test(s) && !s.includes('..') && !s.endsWith('/');
}

/** argv for `git`, after the binary. */
function cloneArgs({ url, target, branch = '', shallow = false }) {
  const a = ['clone'];
  if (branch) a.push('--branch', branch);
  if (shallow) a.push('--depth', '1');
  a.push('--', url, target);
  return a;
}

/** Environment for the clone: never prompt, never widen the transport list. */
function cloneEnv(base = process.env) {
  return { ...base, GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: ALLOWED_PROTOCOLS.join(':') };
}

module.exports = { ALLOWED_PROTOCOLS, parseCloneUrl, authorityIsSafe, isValidDirName, isValidBranch, cloneArgs, cloneEnv };
