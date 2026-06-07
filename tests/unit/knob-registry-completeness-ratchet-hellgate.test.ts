/**
 * KNOB-REGISTRY COMPLETENESS RATCHET (ADR-0503, P0).
 *
 * GOVERNANCE INVARIANT: every `QUANTA_*` env var that is READ in `src/` to
 * gate/configure behavior MUST be declared in a known registry — so a feature
 * added later can never silently bypass discoverability + default-OFF proof
 * (the failure mode that left ~77 orphan reads this session).
 *
 * The knob systems are 3 (hexagonal-layer-forced, ADR-0503 — NOT mergeable):
 *   - `src/shared/runtime-config.ts`  (value knobs)
 *   - `src/runner/knobs/**`           (AgentConfig-mutating knobs)
 *   - [future] apps/cli-local         (CLI-render knobs)
 * This ratchet is the SINGLE governance point that spans all of them: it does
 * NOT care WHICH registry a knob lives in, only that EVERY read is in ONE.
 *
 * DECREASING-CEILING BURN-DOWN (same pattern as gate-vocabulary / no-raw-nul):
 * the count of orphan reads (read somewhere, declared nowhere) may only ever
 * DECREASE. A NEW orphan trips the ceiling → register it (or, if genuinely not
 * a knob, add to EXCEPTIONS with a reason). NON-BLOCKING: the ceiling is the
 * current high-water mark, not 0 — touching an existing orphan does not fail CI.
 *
 * Method: PURE STATIC source-scan (deterministic, no runtime registration
 * side-effects). The "declared" set = every QUANTA_* token in the declaration
 * files; "reads" = QUANTA_* tokens in env-access lines of every OTHER src file.
 */

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

/** A QUANTA_* env-var read is ALWAYS either quoted (`"QUANTA_X"` — bracket
 *  access / gate-helper arg / `envKey:` decl) or a dot-access (`env.QUANTA_X`,
 *  `process.env.QUANTA_X`). A BARE identifier (`gateOn(env, QUANTA_X_ENV)`) is a
 *  CONST reference whose VALUE is the real var (declared at the const site) — NOT
 *  a distinct knob, so we must NOT count the const name. These two precise
 *  extractors skip const-name false-positives (the `*_ENV` noise). */
const QUOTED = /["'](QUANTA_[A-Z0-9_]+)["']/g
const ENV_DOT = /\benv\.(QUANTA_[A-Z0-9_]+)\b/g

/** Every real-read QUANTA_* token on a line (quoted ∪ env-dot). */
const knobsOnLine = (line: string): string[] => {
  const out: string[] = []
  for (const m of line.matchAll(QUOTED)) out.push(m[1] as string)
  for (const m of line.matchAll(ENV_DOT)) out.push(m[1] as string)
  return out
}

/** Files that DECLARE knobs (their QUANTA_* tokens are the registry, not orphan
 *  reads). The canonical reads live here by design. */
const isDeclarationFile = (path: string): boolean =>
  path.endsWith("src/shared/runtime-config.ts") ||
  path.includes("src/runner/knobs/") ||
  // the future apps/cli-local registry (declared, not orphan) — pre-registered
  path.endsWith("src/apps/cli/cli-knobs.ts")

/** Files excluded from the orphan scan entirely: tests, type decls, and the
 *  `--help` doc renderer (it NAMES knobs as documentation, not reads). */
const isExcludedFromScan = (path: string): boolean =>
  path.endsWith(".d.ts") ||
  path.endsWith(".test.ts") ||
  path.includes("/__tests__/") ||
  path.endsWith("src/apps/cli/help-render.ts")

/** A line that READS an env var (vs merely mentioning the token in prose / an
 *  error string). Requires an env-access or gate-helper on the line. */
const isReadLine = (line: string): boolean => {
  const t = line.trimStart()
  if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return false
  return (
    /\bprocess\.env\b/.test(line) ||
    /\benv\s*[.[]/.test(line) ||
    /\bgate(?:On|Disabled)(?:Strict)?\s*\(/.test(line) ||
    /\bparseEnvFlag\s*\(/.test(line)
  )
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    const s = statSync(p)
    if (s.isDirectory()) yield* walk(p)
    else if (entry.endsWith(".ts")) yield p
  }
}

/** Declared tokens in a declaration file = every quoted/env-dot QUANTA_* on any
 *  non-comment line (declarations use `env["X"]` / `envKey: "X"` — both quoted). */
const declaredTokensIn = (text: string): Set<string> => {
  const out = new Set<string>()
  for (const line of text.split("\n")) {
    const t = line.trimStart()
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue
    for (const tok of knobsOnLine(line)) out.add(tok)
  }
  return out
}

/** EXCEPTIONS — tokens that look like knob reads but are NOT a registrable knob
 *  (e.g. a doc/error-string literal, a const NAME echoed in a read line). Each
 *  MUST carry a reason. Keep this SMALL; prefer registering a real knob. */
const EXCEPTIONS: ReadonlyMap<string, string> = new Map([
  // (populate during P1 burn-down triage; empty = every read must be declared)
])

const scan = (): { declared: Set<string>; orphans: Map<string, string> } => {
  const declared = new Set<string>()
  const reads = new Map<string, string>() // token -> first file:line
  for (const file of walk("src")) {
    const rel = file.replace(/^.*\/quanta-codeagent-v3\//, "")
    const text = readFileSync(file, "utf8")
    if (isDeclarationFile(file)) {
      for (const tok of declaredTokensIn(text)) declared.add(tok)
      continue
    }
    if (isExcludedFromScan(file)) continue
    const lines = text.split("\n")
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string
      if (!isReadLine(line)) continue
      for (const tok of knobsOnLine(line)) {
        if (!reads.has(tok)) reads.set(tok, `${rel}:${i + 1}`)
      }
    }
  }
  const orphans = new Map<string, string>()
  for (const [tok, loc] of reads) {
    if (!declared.has(tok) && !EXCEPTIONS.has(tok)) orphans.set(tok, loc)
  }
  return { declared, orphans }
}

/** Frozen ceiling = current orphan high-water mark (ADR-0503 P0 baseline).
 *  May ONLY decrease as orphans are burned down (P1). A new orphan above this
 *  is a governance regression — declare the knob in one of the 3 registries.
 *
 *  Baseline 196 (jun-07, TDD red-first: ceiling 0 → RED surfaced 196 → recorded).
 *  This is the FULL surface of `QUANTA_*` DIRECT-env reads (`process.env.X` /
 *  `gateOn(env,"X")` / `env["X"]`) in non-declaration files that are NOT in the
 *  typed registries (runtime-config / @/runner/knobs). NOTE: a knob properly
 *  registered in runtime-config is consumed as `runtimeConfig().field` and so
 *  never appears here — these 196 genuinely bypass the central typed registry
 *  (many are legit `gateOn` reads but undiscoverable: not in --help/catalog).
 *  P1 burn-down: register each (or route through runtimeConfig) → ceiling ↓ 0.
 *  Priority subset = the 50 needing a NEW home (ADR-0503 §census: 16 AgentConfig
 *  → @/runner/knobs, 8 daemon → runtime-config, 26 CLI-render → apps/cli-local).
 *
 *  Burn-down log (decreasing-only):
 *    196 → 181  (P1-C cluster 1: 15 CLI-render knobs → apps/cli/cli-knobs.ts —
 *                flash timings + status/lifecycle pills)
 *    181 → 171  (P1-C cluster 2: 10 REPL render/input/history knobs → cli-knobs.ts)
 *    171 → 139  (P1-C cluster 3: 32 CLI render/input/status/session/voice → cli-knobs.ts)
 *  Remaining 139 = ~31 apps/cli AGENT-GATE (→ runtime-config, P1-B) + ~108
 *  host/runner/daemon (A→@/runner/knobs · B→runtime-config · BENCH · SECRET-excl). */
const ORPHAN_CEILING = 139

describe("knob-registry completeness ratchet (ADR-0503 P0)", () => {
  test(`orphan QUANTA_* reads (declared nowhere) stay <= ${ORPHAN_CEILING}`, () => {
    const { declared, orphans } = scan()
    // biome-ignore lint/suspicious/noConsole: ratchet visibility for reviewers
    console.log(
      `[knob-completeness] declared=${declared.size} orphans=${orphans.size}/${ORPHAN_CEILING}`,
    )
    if (orphans.size > ORPHAN_CEILING) {
      const list = [...orphans.entries()]
        .sort()
        .map(([t, loc]) => `  ${t}  (${loc})`)
        .join("\n")
      throw new Error(
        `${orphans.size} orphan QUANTA_* reads (ceiling ${ORPHAN_CEILING}) — each is read in src ` +
          `but declared in NO registry (runtime-config / @/runner/knobs / apps/cli-local). ` +
          `Declare it, or add to EXCEPTIONS with a reason:\n${list}`,
      )
    }
    expect(orphans.size).toBeLessThanOrEqual(ORPHAN_CEILING)
  })

  // RED-ON-INJECTION: prove the scanner actually CATCHES an orphan read and does
  // NOT false-positive on a declared one — else the ceiling is a vacuous 0.
  test("scanner catches an undeclared read but not a declared one", () => {
    expect(isReadLine(`  const x = gateOn(env, "QUANTA_FAKE_ORPHAN")`)).toBe(true)
    expect(isReadLine(`  // QUANTA_FAKE_ORPHAN is just a comment`)).toBe(false)
    expect(isReadLine(`  throw new Error("QUANTA_FAKE_ORPHAN failed")`)).toBe(false)
    // quoted + env-dot are caught; bare const-name (the `*_ENV` indirection) is NOT
    expect(knobsOnLine(`gateOn(env, "QUANTA_FAKE_ORPHAN")`)).toEqual(["QUANTA_FAKE_ORPHAN"])
    expect(knobsOnLine(`const x = process.env.QUANTA_DOT_READ`)).toEqual(["QUANTA_DOT_READ"])
    expect(knobsOnLine(`gateOnStrict(env, QUANTA_CODE_MODE_ENV)`)).toEqual([]) // bare const ref skipped
  })
})
