/**
 * The spawn-time environment allowlist and the scrubber that applies it.
 *
 * LIVES IN `@/shared` BECAUSE MORE THAN ONE SLICE MUST SPAWN SAFELY. It began
 * in `@/runtime/sandbox.ts`, which is unreachable from `@/subagent` — that
 * slice may only import `@/tool` and `@/shared`, deliberately, so a subagent
 * cannot reach for a runtime capability on its own. When `exec_command` was
 * fixed to stop handing a model-supplied shell line the parent's full
 * environment, the only scrubber available sat on the wrong side of that fence
 * and the arch guard went red.
 *
 * The fence's own documented answer for a runtime CAPABILITY is injection from
 * the composition root (that is how the kill escalation reaches this slice).
 * This is not a capability: it is a pure allowlist copy with no ports, no
 * lifetime and no policy — the same shape as `env-flag.ts` and `env-files.ts`
 * already in this directory. So it moves to the leaf layer both slices share,
 * and `@/runtime/sandbox` re-exports it, leaving its own consumers untouched.
 */

/** Minimal, non-sensitive variables a child generally needs to function.
 *  Deliberately excludes anything that could carry credentials. This is the
 *  SINGLE source of truth for the env allowlist — `runShell`'s scrubbed mode
 *  (src/runtime/shell.ts) imports {@link scrubEnv}, it does NOT keep its own
 *  copy of this list (ADR-0006: one Local-honored guarantee, one definition). */
// Locale/identity, plus the infra vars a real edit→build→test loop needs:
// corp proxy + custom-CA (npm/bun/git/pip fail behind a MITM proxy without
// them), TMPDIR (pytest/tsc/bun temp), and an active venv.
//
// S5 [HIGH] env-policy → `sandbox.v2`: `NODE_OPTIONS` and
// `NODE_EXTRA_CA_CERTS` were REMOVED. `NODE_OPTIONS=--require=/evil.js`
// (or `--import`) is arbitrary code-exec injected into EVERY scrubbed
// node/bun child, and `NODE_EXTRA_CA_CERTS` lets an attacker-controlled CA
// silently MITM https from those children — both defeat the scrub. So the
// allowlist no longer claims "NONE can carry code/credentials": it now
// carries ONLY non-credential, non-code-exec vars. `SSL_CERT_FILE`/
// `SSL_CERT_DIR` are RETAINED on purpose — they add CA trust via a file
// path (needed behind a corp MITM proxy) but, unlike `NODE_OPTIONS`, cannot
// inject code into the runtime. The default-deny posture (no
// `*_API_KEY`/`*_TOKEN`/`*_SECRET`) is unchanged. Case-sensitive: tools
// read both `HTTP_PROXY` and lowercase `http_proxy`, so both are listed.
// NOTE for the bench agent: the env-policy version literal lives in
// `src/apps/bench/runner.ts` (ENV_POLICY_VERSION) — bump it to `sandbox.v2`
// to record that this allowlist change governs the run.
export const DEFAULT_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TZ",
  "TERM",
  "TMPDIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "VIRTUAL_ENV",
  // Python-specific: PYTHONPATH is needed for SWE-bench repos where the package
  // is not installed but added to sys.path at runtime. Without it, pytest fails
  // with ModuleNotFoundError silently (the agent sees a test failure but not why).
  // PYTEST_ADDOPTS carries per-repo pytest flags (e.g. -p no:warnings) needed by
  // some repos' CI configs. Both are non-secret, non-code-exec env vars.
  "PYTHONPATH",
  "PYTEST_ADDOPTS",
]

/** Build the scrubbed environment: ONLY allowlisted names, copied from `env`
 *  if present. The source env's other entries (API keys, tokens, …) never
 *  leak — absent names are simply omitted.
 *
 *  TAKES THE BAG rather than reading `process.env`, because `@/shared` is the
 *  leaf layer and its own architecture guard forbids ambient process reads
 *  ("must take plain config"). The one-argument convenience that DOES read the
 *  process lives in `@/runtime/sandbox`, on the side of the fence allowed to
 *  have it; `@/subagent/exec-command.ts` passes `process.env` explicitly under
 *  that slice's documented spawner env carve-out. Pure ⇒ also directly
 *  testable without touching the real environment. */
export const scrubEnvFrom = (
  env: Readonly<Record<string, string | undefined>>,
  allowlist: readonly string[] = DEFAULT_ENV_ALLOWLIST,
): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const name of allowlist) {
    const value = env[name]
    if (value !== undefined) out[name] = value
  }
  return out
}
