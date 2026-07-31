/**
 * R2-R5 audit-H ratchet — canonical errMessage invariant.
 *
 * Four adversarial invariants pinned here:
 *
 *  1. NO `(e as Error).message` (or `err`/`error` variants) under src/.
 *     The unsafe-cast pattern silently returns `undefined` when a non-Error
 *     is thrown (number, string, plain object, null) — same hole that
 *     spawned this audit round. Every site must route through the canonical
 *     `errMessage` helper from `@/shared`, which is well-defined for
 *     every throw shape.
 *
 *  2. NO file-local `const errMessage = …` declarations under src/.
 *     Five such shadows had drifted into 5 different policies (one returned
 *     the literal "unknown"; two `JSON.stringify`d non-Errors; two were
 *     byte-identical to canonical but still duplicated the contract). The
 *     project policy is the SINGLE `errMessage` exported from `@/shared`.
 *
 *  3. NO inline `X instanceof Error ? X.message : String(X)` TERNARY form
 *     (R5 expansion). Semantically byte-identical to `errMessage(X)` — but
 *     duplicating the body at every site means the next behaviour patch (e.g.
 *     R5's `String()` throwing-toString guard, `errors.ts:445-454`) doesn't
 *     reach the inline copies. ~175 sites were swapped to `errMessage(X)` in
 *     the R5 commit pair; the ratchet locks the migration. Variants where
 *     the fallback is NOT `String(X)` (e.g. `: "yaml parse failure"`,
 *     `: "unknown"`) carry intentionally different semantics and are kept
 *     intentionally — the regex matches the canonical form ONLY.
 *
 *  4. NO bare `String(e|err|cause|error)` standalone expression (R5
 *     expansion). When `e` is an `Error`, `String(e)` calls `e.toString()`
 *     which yields `"Error: <message>"` — leaking the class name into log
 *     records and growing per-line bytes for no signal. `errMessage(e)`
 *     extracts `e.message` directly. A small allowlist covers the canonical
 *     helper body in `shared/errors.ts`, the safe-wrapper in
 *     `apps/cli/repl-silent-catch.ts`, and three sites whose semantics
 *     differ from `errMessage` by design (`plan-exit-flow.ts` undefined→""
 *     ladder, `rewind-git.ts` deliberately uses `Error.toString()` format).
 *
 * A small in-flight allowlist accommodates files the user is actively
 * editing on a parallel branch — they migrate at their own pace. Every
 * other site MUST be canonical. New growth fails the ratchet.
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { extname, join, relative } from "node:path"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")
const SRC_DIR = join(REPO_ROOT, "src")

/**
 * User-in-flight files exempt from the canonical-errMessage policy for
 * this round (R2 audit-H). The user owns these on a parallel branch and
 * will migrate them when their slice lands. New files MUST NOT be added.
 */
const ALLOWED_UNSAFE_CAST_SITES = new Set<string>(["runner/assemble/search-index-backend.ts"])

/** No shadow `errMessage` definitions are permitted anywhere under src/. */
const ALLOWED_SHADOW_DEFINITION_SITES = new Set<string>()

/**
 * Files where the canonical-equivalent ternary
 * `X instanceof Error ? X.message : String(X)` MUST stay inline (plane-clean
 * contracts — these slices declare zero `@/shared` dependency, so importing
 * `errMessage` would violate the slice header).
 *
 * Migration policy: every entry MUST carry a `Plane-clean` / `Zero imports`
 * header comment justifying the inline. Adding a new entry without that
 * header marker is the migration test below catching the regression.
 */
const ALLOWED_TERNARY_INLINE_SITES = new Set<string>([
  // ADR-0133 — plane-clean parser, contract #4 "Zero imports".
  "tool/document/ndjson-parse.ts",
  // ADR-0177 — header: "Plane-clean: imports only ./types".
  "agent/streaming-cancellation/default.ts",
  // ADR-0311 R3 slice-fence — CLI lib is port-only (no `@/shared`); the
  // local `stringifyError` shadow is the slice's intentional escape hatch.
  // The slice-fence hellgate
  // (`tests/unit/integrations/github/slice-fence-static-hellgate-r3.test.ts`)
  // pins that no `@/shared` import survives.
  "apps/cli/from-pr-cmd.ts",
  // ADR-0311 / ADR-0313 — the `integrations/github` slice is plane-clean: the
  // slice-fence hellgate
  // (`tests/unit/integrations/github/slice-fence-static-hellgate-r3.test.ts`
  // "every slice file imports only from `@/reactor`, `node:crypto`, or `./*`")
  // FORBIDS any `@/shared` import, so `errMessage` cannot reach this file. The
  // inline ternary is the canonical-equivalent form kept by design.
  "integrations/github/idempotency.ts",
  // jun-6 CLUSTER D #5 — `permission_propose_pattern` LLM-callable surface.
  // The slice imports ONLY `zod` + its sibling `../types` port (no `@/shared`),
  // matching the port-only discipline of the other plane-clean entries above:
  // the file is the residual security-sensitive surface of ADR-0061's
  // remember-patterns seam and deliberately carries zero `@/shared` coupling so
  // the no-widen / no-self-grant audit stays self-contained. The inline ternary
  // is the canonical-equivalent form kept by design.
  "tool/permission-propose/index.ts",
  // R8 audit close-out (ADR-0165 §Plane discipline): the coverage adapter
  // quartet's plane-clean contract was tightened to admit ONE pure-helper
  // import (`errMessage` from `@/shared`, no I/O) so the canonical
  // policy reaches every site instead of drifting at inline ternaries.
  // The four files now call `errMessage(e)` directly — no inline ternary
  // survives — so the entries below were removed.
])

/**
 * Files where bare `String(e|err|cause|error)` is intentional and MUST NOT be
 * swapped to `errMessage(X)`. Every entry pins a CONCRETE per-file reason —
 * the next ratchet hit must justify the same way.
 */
const ALLOWED_RAW_STRING_SITES = new Set<string>([
  // Canonical `errMessage` helper body — the ONE site allowed to call
  // `String(e)`. Migrating this away breaks every consumer.
  "shared/errors.ts",
  // Safe wrapper. `safeErrMessage` re-implements the policy inside an extra
  // try/catch so a throwing `e.toString()` / `Symbol.toPrimitive` cannot
  // crash a swallowed-error log path (R5 audit-H closeout).
  "apps/cli/repl-silent-catch.ts",
  // Multi-tier ladder with an `undefined → ""` rung that `errMessage` does
  // NOT model (`errMessage(undefined)` returns `"undefined"`).
  "agent/plan-exit-flow.ts",
  // `child_process.error` emits a real `Error`; this site DELIBERATELY uses
  // `Error.toString()` ("Error: <msg>") format for shell-style stderr.
  "apps/cli/rewind-git.ts",
  // `new Error(String(X))` ERROR-CONSTRUCTION sites (NOT message extraction).
  // These wrap a non-Error throw into a proper Error so a downstream consumer
  // can `e.message` / `e.stack` it. Migrating to `errMessage(X)` would be a
  // type error (`new Error` requires a string, not the side-effect). The
  // canonical migration target is `toError(X)` from `@/shared` — those are
  // tracked separately under the local-`toError`-shadow burn-down.
  "agent/retry-pretry.ts",
  "llm/replay/recording-llm.ts",
])

// Expanded R3 audit: catches all `(IDENT as Error)?.message` (any var name,
// optional chaining). Prior `(?:e|err|error)` missed `parseErr`/`ioErr`/etc.
const UNSAFE_CAST_PATTERN = /\([a-zA-Z_$][\w$]* as Error\)\??\.message\b/
const SHADOW_DEF_PATTERN = /^\s*const errMessage = /
// R5 expansion: ternary form `X instanceof Error ? X.message : String(X)` —
// SAME identifier on both `X.message` and `String(X)`, so a non-canonical
// fallback (e.g. `: "yaml parse failure"`, `: "unknown"`) is intentionally NOT
// matched. Optional chaining `X?.message` is included for completeness.
const TERNARY_PATTERN =
  /\b([a-zA-Z_$][\w$]*)\s+instanceof\s+Error\s*\?\s*\1\??\.message\s*:\s*String\(\s*\1\s*\)/
// R5 expansion: bare `String(IDENT)` where IDENT ∈ {e, err, cause, error}.
// Matches the four canonical catch-variable names — does NOT scan arbitrary
// `String(...)` callsites (those are deliberate coercions of typed data).
const RAW_STRING_PATTERN = /\bString\(\s*(?:e|err|cause|error)\s*\)/

const walkTsFiles = (dir: string): readonly string[] => {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const stat = statSync(full)
    if (stat.isDirectory()) out.push(...walkTsFiles(full))
    else if (extname(name) === ".ts") out.push(full)
  }
  return out
}

const isCommentLine = (line: string): boolean => {
  const trimmed = line.trim()
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")
}

interface Match {
  readonly relPath: string
  readonly lineNo: number
  readonly line: string
}

const scanForUnsafeCasts = (): readonly Match[] => {
  const matches: Match[] = []
  for (const file of walkTsFiles(SRC_DIR)) {
    const relPath = relative(SRC_DIR, file).replaceAll("\\", "/")
    const text = readFileSync(file, "utf8")
    const lines = text.split("\n")
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? ""
      if (isCommentLine(line)) continue
      if (UNSAFE_CAST_PATTERN.test(line)) {
        matches.push({ relPath, lineNo: i + 1, line: line.trim() })
      }
    }
  }
  return matches
}

const scanForShadowDefinitions = (): readonly Match[] => {
  const matches: Match[] = []
  for (const file of walkTsFiles(SRC_DIR)) {
    const relPath = relative(SRC_DIR, file).replaceAll("\\", "/")
    const text = readFileSync(file, "utf8")
    const lines = text.split("\n")
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? ""
      if (isCommentLine(line)) continue
      if (SHADOW_DEF_PATTERN.test(line)) {
        matches.push({ relPath, lineNo: i + 1, line: line.trim() })
      }
    }
  }
  return matches
}

const scanForCanonicalTernary = (): readonly Match[] => {
  const matches: Match[] = []
  for (const file of walkTsFiles(SRC_DIR)) {
    const relPath = relative(SRC_DIR, file).replaceAll("\\", "/")
    const text = readFileSync(file, "utf8")
    const lines = text.split("\n")
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? ""
      if (isCommentLine(line)) continue
      if (TERNARY_PATTERN.test(line)) {
        matches.push({ relPath, lineNo: i + 1, line: line.trim() })
      }
    }
  }
  return matches
}

const scanForRawStringCall = (): readonly Match[] => {
  const matches: Match[] = []
  for (const file of walkTsFiles(SRC_DIR)) {
    const relPath = relative(SRC_DIR, file).replaceAll("\\", "/")
    const text = readFileSync(file, "utf8")
    const lines = text.split("\n")
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? ""
      if (isCommentLine(line)) continue
      // Skip lines that ALSO contain the ternary form — those are caught by
      // the canonical-ternary scanner (and the migration story is identical).
      // Without this skip, swap-ready ternary call sites would double-count.
      if (TERNARY_PATTERN.test(line)) continue
      if (RAW_STRING_PATTERN.test(line)) {
        matches.push({ relPath, lineNo: i + 1, line: line.trim() })
      }
    }
  }
  return matches
}

describe("error-message canonical ratchet (R2 audit-H)", () => {
  test(
    "no `(e as Error).message` outside the in-flight allowlist",
    () => {
      const all = scanForUnsafeCasts()
      const unexpected = all
        .filter((m) => !ALLOWED_UNSAFE_CAST_SITES.has(m.relPath))
        .sort((a, b) => a.relPath.localeCompare(b.relPath))

      if (unexpected.length > 0) {
        throw new Error(
          [
            "Unsafe `(e as Error).message` cast detected under src/.",
            "Use the canonical `errMessage` from `@/shared`:",
            '  import { errMessage } from "@/shared"',
            "  errMessage(e) // defined for every throw shape",
            "",
            "Unexpected hits:",
            ...unexpected.map((m) => `- ${m.relPath}:${m.lineNo}  ${m.line}`),
          ].join("\n"),
        )
      }

      expect(unexpected).toEqual([])
    },
    { timeout: 30_000 },
  )

  test(
    "in-flight allowlist sites still own their unsafe casts (no false-positive cleanup)",
    () => {
      // Every entry in the allowlist MUST still have at least one hit. If the
      // user has migrated a site already, the allowlist entry must be removed
      // in the same change to keep the ratchet honest.
      const byPath = new Map<string, number>()
      for (const m of scanForUnsafeCasts()) {
        byPath.set(m.relPath, (byPath.get(m.relPath) ?? 0) + 1)
      }
      const allowlistedButGone = [...ALLOWED_UNSAFE_CAST_SITES].filter((path) => !byPath.has(path))
      expect(allowlistedButGone).toEqual([])
    },
    { timeout: 30_000 },
  )

  test(
    "no file-local `const errMessage = …` shadow declarations",
    () => {
      const all = scanForShadowDefinitions()
      const unexpected = all
        .filter((m) => !ALLOWED_SHADOW_DEFINITION_SITES.has(m.relPath))
        .sort((a, b) => a.relPath.localeCompare(b.relPath))

      if (unexpected.length > 0) {
        throw new Error(
          [
            "File-local `const errMessage = …` shadow detected under src/.",
            "There is exactly ONE canonical `errMessage` — it lives in `@/shared`.",
            "Import it instead of re-defining a local copy with drifting policy.",
            "",
            "Unexpected shadows:",
            ...unexpected.map((m) => `- ${m.relPath}:${m.lineNo}  ${m.line}`),
          ].join("\n"),
        )
      }

      expect(unexpected).toEqual([])
    },
    { timeout: 30_000 },
  )

  test(
    "no inline `X instanceof Error ? X.message : String(X)` ternary outside plane-clean allowlist (R5)",
    () => {
      const all = scanForCanonicalTernary()
      const unexpected = all
        .filter((m) => !ALLOWED_TERNARY_INLINE_SITES.has(m.relPath))
        .sort((a, b) => a.relPath.localeCompare(b.relPath))

      if (unexpected.length > 0) {
        throw new Error(
          [
            "Inline canonical ternary `X instanceof Error ? X.message : String(X)` detected under src/.",
            "Use the canonical `errMessage` from `@/shared`:",
            '  import { errMessage } from "@/shared"',
            "  errMessage(e)",
            "",
            "The behaviour is byte-identical, and the helper centralises future",
            "fixes (e.g. throwing-toString guard) so they reach every callsite.",
            "",
            "Unexpected hits:",
            ...unexpected.map((m) => `- ${m.relPath}:${m.lineNo}  ${m.line}`),
          ].join("\n"),
        )
      }

      expect(unexpected).toEqual([])
    },
    { timeout: 30_000 },
  )

  test(
    "ternary allowlist sites still have at least one inline hit (no false-positive cleanup)",
    () => {
      const byPath = new Map<string, number>()
      for (const m of scanForCanonicalTernary()) {
        byPath.set(m.relPath, (byPath.get(m.relPath) ?? 0) + 1)
      }
      const allowlistedButGone = [...ALLOWED_TERNARY_INLINE_SITES].filter(
        (path) => !byPath.has(path),
      )
      expect(allowlistedButGone).toEqual([])
    },
    { timeout: 30_000 },
  )

  test(
    "no bare `String(e|err|cause|error)` outside the intentional allowlist (R5)",
    () => {
      const all = scanForRawStringCall()
      const unexpected = all
        .filter((m) => !ALLOWED_RAW_STRING_SITES.has(m.relPath))
        .sort((a, b) => a.relPath.localeCompare(b.relPath))

      if (unexpected.length > 0) {
        throw new Error(
          [
            "Bare `String(e|err|cause|error)` detected under src/.",
            "`String(e)` calls `e.toString()` when `e` is an Error — yielding",
            '`"Error: <message>"` and leaking the class name into log records.',
            "Use the canonical `errMessage` from `@/shared` so Error-thrown values",
            "extract `.message` directly:",
            '  import { errMessage } from "@/shared"',
            "  errMessage(e)",
            "",
            "Unexpected hits:",
            ...unexpected.map((m) => `- ${m.relPath}:${m.lineNo}  ${m.line}`),
          ].join("\n"),
        )
      }

      expect(unexpected).toEqual([])
    },
    { timeout: 30_000 },
  )

  test(
    "raw-String allowlist sites still have at least one hit",
    () => {
      const byPath = new Map<string, number>()
      for (const m of scanForRawStringCall()) {
        byPath.set(m.relPath, (byPath.get(m.relPath) ?? 0) + 1)
      }
      const allowlistedButGone = [...ALLOWED_RAW_STRING_SITES].filter((path) => !byPath.has(path))
      expect(allowlistedButGone).toEqual([])
    },
    { timeout: 30_000 },
  )

  test("self-check: ternary regex matches the canonical form on a synthetic sample", () => {
    const sample = "const m = e instanceof Error ? e.message : String(e)"
    expect(TERNARY_PATTERN.test(sample)).toBe(true)
  })

  test("self-check: ternary regex does NOT match non-canonical fallbacks", () => {
    expect(
      TERNARY_PATTERN.test('const m = e instanceof Error ? e.message : "yaml parse failure"'),
    ).toBe(false)
    expect(
      TERNARY_PATTERN.test(
        'const m = e instanceof Error ? e.message : typeof e === "string" ? e : "unknown"',
      ),
    ).toBe(false)
  })

  test("self-check: raw-String regex matches the four canonical catch names", () => {
    expect(RAW_STRING_PATTERN.test("log(String(e))")).toBe(true)
    expect(RAW_STRING_PATTERN.test("log(String(err))")).toBe(true)
    expect(RAW_STRING_PATTERN.test("log(String(cause))")).toBe(true)
    expect(RAW_STRING_PATTERN.test("log(String(error))")).toBe(true)
  })

  test("self-check: raw-String regex does NOT match other identifiers", () => {
    expect(RAW_STRING_PATTERN.test("const s = String(value)")).toBe(false)
    expect(RAW_STRING_PATTERN.test("const s = String(x)")).toBe(false)
    expect(RAW_STRING_PATTERN.test("const s = String(foo)")).toBe(false)
  })
})
