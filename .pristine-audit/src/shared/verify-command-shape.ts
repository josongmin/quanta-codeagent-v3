/**
 * Shared verify-command recognizer.
 *
 * This is the command-side half of the verification signal. It is intentionally
 * pure and leaf-level so both `@/agent` guard logic and `@/tool/bash` mode
 * validation can share one registry instead of drifting.
 */

/** One ecosystem's recognizer. `id` is stable for telemetry / debugging. */
export interface VerifyMatcher {
  /** Stable identifier, e.g. `"python-pytest"`, `"js-runner"`, `"go"`. */
  readonly id: string
  /** Ecosystem bucket, e.g. `"python"`, `"js"`, `"rust"`, `"generic"`. */
  readonly ecosystem: string
  /** Recognizes a test/reproduction invocation for this ecosystem. */
  readonly pattern: RegExp
}

const normalizeVerifyCommand = (cmd: string): string => cmd.trim().replace(/\s+/g, " ")

/**
 * Leading command-position boundary: start-of-string, whitespace, or a shell
 * separator (`;`, `&`, `|`). Prevents a runner *name* from matching as a
 * substring inside another word (e.g. `digest`, `ingest` must not match
 * `jest`). Used only for bare-name runners; subcommand forms (`go test`) carry
 * their own `\b` anchors.
 */
const CMD = "(?:^|\\s|[;&|])"

/**
 * The recognition registry — the single source of truth. Ordered by ecosystem;
 * order is irrelevant to correctness (matching is a logical OR) but
 * {@link matchVerifyCommand} returns the FIRST match, so the most specific
 * python forms precede the generic `reproduce`/`repro` token.
 */
export const VERIFY_MATCHERS: readonly VerifyMatcher[] = [
  {
    id: "python-pytest",
    ecosystem: "python",
    pattern: new RegExp(`${CMD}pytest\\b|\\bpython3?\\s+-m\\s+(?:pytest|unittest)\\b`, "i"),
  },
  {
    id: "python-toolrunner",
    ecosystem: "python",
    pattern: new RegExp(`${CMD}(?:tox|nox)\\b`, "i"),
  },
  {
    id: "python-testfile",
    ecosystem: "python",
    pattern: /\bpython3?\s+\S*(?:test|conftest)\S*\.py\b/i,
  },
  { id: "python-django", ecosystem: "python", pattern: /\bmanage\.py\s+test\b/i },
  {
    id: "js-runner",
    ecosystem: "js",
    pattern: new RegExp(`${CMD}(?:jest|vitest|mocha|jasmine|cypress|playwright)\\b`, "i"),
  },
  {
    id: "js-pm",
    ecosystem: "js",
    pattern:
      /\b(?:npm|pnpm|yarn)\s+(?:test|run\s+\S*test\S*)\b|\bbun\s+test\b|\bnode\b[^|]*--test\b|\bdeno\s+test\b/i,
  },
  { id: "go", ecosystem: "go", pattern: /\bgo\s+test\b/i },
  { id: "rust", ecosystem: "rust", pattern: /\bcargo\s+(?:test|nextest)\b/i },
  {
    id: "ruby",
    ecosystem: "ruby",
    pattern: new RegExp(`${CMD}rspec\\b|\\brake\\s+test\\b`, "i"),
  },
  { id: "php", ecosystem: "php", pattern: new RegExp(`${CMD}phpunit\\b`, "i") },
  { id: "dotnet", ecosystem: "dotnet", pattern: /\bdotnet\s+test\b/i },
  { id: "jvm", ecosystem: "jvm", pattern: /\bmvn\s+(?:test|verify)\b|\bgradlew?\s+\S*test\b/i },
  { id: "cpp", ecosystem: "cpp", pattern: new RegExp(`${CMD}ctest\\b`, "i") },
  { id: "elixir", ecosystem: "elixir", pattern: /\bmix\s+test\b/i },
  { id: "swift", ecosystem: "swift", pattern: /\bswift\s+test\b/i },
  { id: "make", ecosystem: "generic", pattern: /\bmake\s+(?:test|check)\b/i },
  { id: "reproduction", ecosystem: "generic", pattern: /reproduce|\brepro\b/i },
]

/**
 * The first matcher that recognizes `cmd` as a test/reproduction run, or `null`
 * when none does. Returning the matcher (not a bool) lets callers record which
 * ecosystem's verification ran.
 */
export const matchVerifyCommand = (cmd: string): VerifyMatcher | null => {
  for (const m of VERIFY_MATCHERS) {
    if (m.pattern.test(cmd)) return m
  }
  return null
}

/** True iff `cmd` looks like a real test or reproduction invocation. */
export const isTestLikeCommand = (cmd: string): boolean => matchVerifyCommand(cmd) !== null

/** Bench/host-wired exact verifier authority. Unlike the ecosystem registry,
 *  this is NOT heuristic recognition: the caller already knows the command is
 *  authoritative (e.g. bench `instance.testCmd`) and wants an exact-string
 *  allowance without widening generic shell noise into a verify signal. */
export const matchesExactVerifyCommand = (
  cmd: string,
  exactCommands: readonly string[] | undefined,
): boolean => {
  if (exactCommands === undefined || exactCommands.length === 0) return false
  const normalized = normalizeVerifyCommand(cmd)
  if (normalized === "") return false
  for (const candidate of exactCommands) {
    if (normalizeVerifyCommand(candidate) === normalized) return true
  }
  return false
}

/** True iff `cmd` is either a recognized test/repro command OR an exact
 *  caller-declared verifier authority command. */
export const isVerifySignalCommand = (
  cmd: string,
  exactCommands: readonly string[] | undefined,
): boolean => isTestLikeCommand(cmd) || matchesExactVerifyCommand(cmd, exactCommands)

/**
 * Back-compat composed regex, DERIVED from {@link VERIFY_MATCHERS} (so the
 * registry stays the single source of truth). `TEST_LIKE_RE.test(cmd)` is
 * equivalent to {@link isTestLikeCommand}; prefer the function (it also tells
 * you the ecosystem via {@link matchVerifyCommand}).
 */
export const TEST_LIKE_RE = new RegExp(VERIFY_MATCHERS.map((m) => m.pattern.source).join("|"), "i")
