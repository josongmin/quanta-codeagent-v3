/**
 * Stale-read-guard — the CLOSED set of WRITE_COMMAND_MARKERS (ADR-0474).
 *
 * WHAT: a documented, fixed allow-list of leading shell-command tokens whose
 * execution is KNOWN to mutate files in the workspace (install/build/format/
 * codegen). After a bash command whose first token matches one of these, the
 * guard treats any read file whose mtime advanced as stale and surfaces a
 * reminder. The set is CLOSED and JUSTIFIED (not a guessed heuristic): each
 * entry is a tool that, by its documented contract, writes to the tree.
 *
 * ADR: ADR-0474.
 * Slices imported: NONE (pure data + one matcher).
 * NO-THROW: the matcher returns a boolean, never throws.
 *
 * Why a marker set at all (vs. trusting the post-bash mtime diff alone): the
 * host's diff already lists files whose mtime changed; the marker set is a
 * SECOND, cheaper gate so a bash that demonstrably could NOT have written (e.g.
 * `git status`, `ls`, `grep`) never triggers a stale hint even if an UNRELATED
 * concurrent process touched a file. Requiring BOTH (marker matched AND mtime
 * advanced) keeps the hint precise. This mirrors the conservative "only warn on
 * a known-mutating command" posture and avoids false stale-hints on read-only
 * inspection commands.
 */

/**
 * Leading-token markers for commands that, by documented contract, write files.
 * Grouped by family for auditability. ASCII-lowercased comparison; the matcher
 * normalizes. Closed set — additions require an ADR amendment.
 */
export const WRITE_COMMAND_MARKERS: ReadonlySet<string> = new Set<string>([
  // Package managers — install/add/remove rewrite lockfiles + node_modules.
  "npm",
  "yarn",
  "pnpm",
  "bun",
  "bunx",
  "npx",
  // Build / task systems — emit artifacts and can codegen into the tree.
  "make",
  "cargo",
  "go",
  "mvn",
  "gradle",
  "./gradlew",
  "gradlew",
  "dotnet",
  "tsc",
  "vite",
  "webpack",
  "rollup",
  "esbuild",
  // Formatters / linters with --write / --fix — rewrite source in place.
  "prettier",
  "eslint",
  "biome",
  "rustfmt",
  "gofmt",
  "goimports",
  "black",
  "isort",
  "ruff",
  "clang-format",
  // Codegen / scaffolding.
  "protoc",
  "openapi-generator",
  "codegen",
])

/**
 * Extract the leading command token from a raw bash command string and report
 * whether it is a known file-mutating marker.
 *
 * Normalization (documented, not magic):
 *   - trims surrounding whitespace,
 *   - takes the substring up to the first whitespace as the command token,
 *   - strips a leading `./` or `path/` prefix to its basename (so `./gradlew`
 *     and `tools/biome` both reduce to a comparable token), then ALSO keeps the
 *     literal `./gradlew` / `gradlew` forms which are explicit members,
 *   - ASCII-lowercases.
 *
 * Env-var prefixes (`FOO=bar npm ...`) and leading `sudo` are skipped so the
 * real command token is examined. Pipelines/`&&` chains: only the FIRST token is
 * inspected — the host re-invokes the guard per command if it splits chains; for
 * a raw chain we conservatively match the first segment (a build at the head of
 * a chain is the common case). NO-THROW.
 */
export const isWriteCommand = (rawCommand: string): boolean => {
  const tokens = tokenize(rawCommand)
  for (const tok of tokens) {
    // Skip leading env-assignments (`KEY=value`) and `sudo`.
    if (tok === "sudo") continue
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) continue
    const lowered = tok.toLowerCase()
    if (WRITE_COMMAND_MARKERS.has(lowered)) return true
    // Reduce `./gradlew` / `dir/biome` to basename for a second comparison.
    const slash = lowered.lastIndexOf("/")
    if (slash >= 0) {
      const base = lowered.slice(slash + 1)
      if (base.length > 0 && WRITE_COMMAND_MARKERS.has(base)) return true
    }
    // The first real (non-env, non-sudo) token decides — stop scanning.
    return false
  }
  return false
}

/** Split a command into whitespace-delimited tokens, dropping empties. */
const tokenize = (raw: string): readonly string[] =>
  raw.trim().length === 0 ? [] : raw.trim().split(/\s+/)
