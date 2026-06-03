/**
 * Startup environment-probe — the CLOSED declared check list + degradation
 * hint mapper (ADR-0466).
 *
 * Slice: @/runtime. Imports only this slice's `types` + `@/shared` for
 * `assertNever`. NO-THROW: pure data + a total mapper.
 *
 * NO HEURISTICS: the core check list is a hand-authored, documented constant.
 * Nothing is sniffed — each entry names a binary and the warning it produces
 * when absent. The test-runner checks are DERIVED from a declared manifest
 * (read elsewhere), not guessed from the filesystem.
 */

import { assertNever } from "@/shared"
import type { ProbeCheck, ProjectManifest, WarningKind } from "./types"

/**
 * Core toolchain checks. CLOSED list — every entry is a binary the agent may
 * try to invoke during a normal session, so its absence is worth surfacing.
 *
 * Rationale per entry:
 *   - node   : the agent's own JS test/build tools assume a node runtime.
 *   - bun    : this project's first-class runner (`bun test`, build).
 *   - python3: the agent runs python repair/eval flows; absence means skip.
 *   - git    : nearly every tool path (diff/commit/worktree) needs git.
 *
 * `--version` is the universal, side-effect-free probe argv every one of these
 * binaries supports. Ordering here is the canonical emission order (see
 * `CORE_CHECKS` consumption in `probe.ts`).
 */
export const CORE_CHECKS: readonly ProbeCheck[] = [
  {
    id: "toolchain:node",
    target: "node",
    probeArgv: ["node", "--version"],
    kind: "missing-toolchain",
    severity: "warn",
  },
  {
    id: "toolchain:bun",
    target: "bun",
    probeArgv: ["bun", "--version"],
    kind: "missing-toolchain",
    severity: "warn",
  },
  {
    id: "toolchain:python3",
    target: "python3",
    probeArgv: ["python3", "--version"],
    kind: "missing-toolchain",
    severity: "info",
  },
  {
    id: "toolchain:git",
    target: "git",
    probeArgv: ["git", "--version"],
    kind: "missing-toolchain",
    severity: "warn",
  },
] as const

/**
 * Build the test-runner checks DERIVED from the declared manifest. These are
 * conditional — only emitted when the manifest implies the runner is expected,
 * so a JS-only repo never gets a spurious "pytest missing" warning and vice
 * versa.
 *
 *   - package.json declares a `test` script ⇒ expect a JS test runner. We probe
 *     `bun` (the canonical runner here) because `bun test` / `bun run test` is
 *     how the script executes; absence ⇒ "missing-test-runner".
 *   - pyproject.toml present ⇒ expect pytest; probe `pytest --version`.
 *
 * Pure + total: same manifest ⇒ same checks, deterministic order (JS before
 * python, matching CORE order conventions).
 */
export const testRunnerChecks = (manifest: ProjectManifest): readonly ProbeCheck[] => {
  const checks: ProbeCheck[] = []
  if (manifest.packageJsonTestScript !== undefined) {
    checks.push({
      id: "test-runner:js",
      target: "bun",
      probeArgv: ["bun", "--version"],
      kind: "missing-test-runner",
      severity: "warn",
    })
  }
  if (manifest.hasPyproject) {
    checks.push({
      id: "test-runner:pytest",
      target: "pytest",
      probeArgv: ["pytest", "--version"],
      kind: "missing-test-runner",
      severity: "warn",
    })
  }
  return checks
}

/**
 * Raw, presence-only project signals the composition root gathers from disk.
 * Deliberately minimal — the ONLY impure step (the file read) lives at the
 * root; this kernel stays pure. `packageJson` is the PARSED object when a
 * `package.json` exists and parsed cleanly, or `undefined` when it is absent or
 * unparseable. No filesystem, no globbing, no sniffing.
 */
export interface RawProjectSignals {
  /** Parsed `package.json`, or `undefined` if absent/unparseable. `unknown`
   *  because the root must NOT pre-trust its shape — we READ `scripts.test`
   *  defensively below. */
  readonly packageJson?: unknown
  /** Whether a `pyproject.toml` file exists (presence READ from disk). */
  readonly hasPyproject: boolean
}

/**
 * Derive the {@link ProjectManifest} from raw, presence-only signals — pure and
 * total. The test-runner expectation is READ from `package.json.scripts.test`,
 * NEVER guessed: a `test` script must be PRESENT and a non-empty string for the
 * JS test runner to be considered expected. A missing/malformed package.json or
 * a non-string/empty `test` script yields no JS-runner expectation. `pyproject`
 * presence is taken verbatim. No-throw: malformed input degrades to "absent".
 */
export const deriveManifest = (signals: RawProjectSignals): ProjectManifest => {
  const testScript = readTestScript(signals.packageJson)
  return {
    ...(testScript !== undefined ? { packageJsonTestScript: testScript } : {}),
    hasPyproject: signals.hasPyproject,
  }
}

/** Defensively READ `scripts.test` from an untrusted parsed package.json.
 *  Returns the script string only when it is genuinely present as a non-empty
 *  string; anything else (absent, wrong type, empty) ⇒ `undefined`. Never
 *  throws. */
const readTestScript = (packageJson: unknown): string | undefined => {
  if (typeof packageJson !== "object" || packageJson === null) return undefined
  const scripts = (packageJson as { scripts?: unknown }).scripts
  if (typeof scripts !== "object" || scripts === null) return undefined
  const test = (scripts as { test?: unknown }).test
  if (typeof test !== "string" || test.length === 0) return undefined
  return test
}

/**
 * Map a (kind, target) to the human/agent-readable degradation hint. Total
 * over {@link WarningKind} — `assertNever` makes a new kind a compile error
 * until a hint is authored. No template magic beyond interpolating `target`.
 */
export const degradationHint = (kind: WarningKind, target: string): string => {
  switch (kind) {
    case "missing-toolchain":
      return `${target} is not on PATH — skip steps that invoke ${target}; prefer alternatives or ask the user to install it.`
    case "missing-test-runner":
      return `the project expects ${target} to run its tests, but ${target} is not resolvable — do not attempt to run the test suite; report the gap instead of failing mid-turn.`
    default:
      return assertNever(kind)
  }
}
