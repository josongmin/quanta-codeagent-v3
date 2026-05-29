/**
 * R3 audit-H 24h-window — silent-catch ratchet.
 *
 * The 11 catch sites swapped in this audit (across 5 files) MUST stay bound
 * + telemetered. A regression back to bare `} catch {` at any of these
 * sites is a silent-attribution loss in production.
 *
 * The ratchet works against a CALLSITE allowlist: each entry pins (file,
 * label) where `label` is the stable prefix passed to `logger.warn`. The
 * test asserts (a) the file contains the label, (b) within the same file
 * every `} catch (X) {` body that calls `logger.warn` with the label
 * appears on a sibling line — i.e. the swap survives. The 5 files are
 * also scanned for any NEW bare `} catch {` introduced AFTER this audit;
 * pre-existing bare-catches OUTSIDE the swap targets are explicitly
 * allow-listed (the audit scoped to those 11 sites — other catches in
 * the same file are out of scope until a follow-up audit closes them).
 *
 * Design notes:
 *  - The "no NEW bare-catch in audited files" rule is enforced by counting
 *    bare-catches and comparing against the pre-existing baseline count
 *    captured at audit time. A diff that ADDS one new bare-catch lifts the
 *    count and FAILS the ratchet.
 *  - The "label survives" rule asserts each pinned label is still present
 *    in the source — a regression that removes the `logger.warn(...)` line
 *    (e.g. by re-introducing a bare-catch) drops the label and FAILS.
 *
 * Zero-grep + zero-AST: pure regex over the file contents, deterministic
 * across platforms. No hostile-input attack surface (read-only).
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const REPO_ROOT = resolve(import.meta.dir, "../..")

/** Pinned: (file, label) tuples for every catch swap in this audit. */
const PINNED_LABELS: ReadonlyArray<{ file: string; labels: readonly string[] }> = [
  {
    file: "src/agent/approval-state-machine/store.ts",
    labels: ["approval-state.attr.clearBlocker", "approval-state.attr.settleLedger"],
  },
  {
    file: "src/agent/codex-r2-wire-install/install.ts",
    labels: [
      "codex-r2-wire.appendAllSafe",
      "codex-r2-wire.contextEventsForTurn",
      "codex-r2-wire.mentionInjector",
      "codex-r2-wire.compactionEventEmit",
    ],
  },
  {
    file: "src/agent/compaction.ts",
    labels: ["compaction.postCompactEmit", "compaction.objectiveSetNextActions"],
  },
  {
    file: "src/agent/loop.ts",
    labels: ["loop.objectiveSetNextActions"],
  },
  {
    file: "src/agent/observability-wire/wire.ts",
    labels: ["observability-wire.subscribe", "observability-wire.unsubscribe"],
  },
]

/**
 * Pre-existing bare-catch baseline (captured at the time of this audit).
 * These bare-catches are OUTSIDE the 11 swap targets — they belong to other
 * code paths (e.g. `tryConstruct` helpers, deep loop-recovery paths) and
 * are explicitly out of scope for the audit-H closeout.
 *
 * A future audit may close these too; until then the ratchet enforces "no
 * NEW bare-catch beyond the baseline" — i.e. the count must NEVER grow.
 */
const BARE_CATCH_BASELINE: Readonly<Record<string, number>> = {
  "src/agent/approval-state-machine/store.ts": 12,
  "src/agent/codex-r2-wire-install/install.ts": 4,
  "src/agent/compaction.ts": 0,
  "src/agent/loop.ts": 6,
  "src/agent/observability-wire/wire.ts": 1,
}

const BARE_CATCH_RE = /\}\s*catch\s*\{/g

const countBareCatches = (relPath: string): number => {
  const abs = resolve(REPO_ROOT, relPath)
  const src = readFileSync(abs, "utf8")
  return [...src.matchAll(BARE_CATCH_RE)].length
}

const fileContents = (relPath: string): string => readFileSync(resolve(REPO_ROOT, relPath), "utf8")

describe("R3 audit-H — pinned labels survive on every audited catch site", () => {
  for (const { file, labels } of PINNED_LABELS) {
    for (const label of labels) {
      test(`${file} still emits logger.warn(\`${label}: ...\`)`, () => {
        const src = fileContents(file)
        // Require the label string to be present.
        expect(src).toContain(`${label}:`)
        // AND require that label to be inside a logger.warn call (so a
        // future commit can't "satisfy" the test by leaving the comment
        // but removing the logger call).
        const re = new RegExp(`logger\\.warn\\(\\s*\`${label.replace(/\./g, "\\.")}:`)
        expect(re.test(src)).toBe(true)
      })
    }
  }
})

describe("R3 audit-H — bare-catch count must NOT grow beyond baseline", () => {
  for (const [file, baseline] of Object.entries(BARE_CATCH_BASELINE)) {
    test(`${file} bare-catch count <= ${baseline}`, () => {
      const observed = countBareCatches(file)
      if (observed > baseline) {
        throw new Error(
          `Silent-catch regression in ${file}: ${observed} bare-catches ` +
            `(baseline = ${baseline}). A new bare \`} catch {\` was added — ` +
            `swap to \`} catch (e) { logger.warn(\\\`<label>: ${"${"}errMessage(e)${"}"}\\\`) }\` ` +
            `with a stable label prefix.`,
        )
      }
      expect(observed).toBeLessThanOrEqual(baseline)
    })
  }
})

describe("R3 audit-H — self-checks (proof the regex actually catches drift)", () => {
  test("bare-catch regex matches the canonical silent form", () => {
    expect("function f() { try {} catch { /* swallowed */ } }".match(BARE_CATCH_RE)?.length).toBe(1)
  })

  test("bound-catch with logger.warn does NOT match the bare-catch regex", () => {
    // Build the sample without a literal `${...}` so biome's
    // `noTemplateCurlyInString` doesn't flag the sample — we just need
    // the `} catch (e) { ... }` SHAPE to be present, not the exact
    // production logger.warn body.
    const seed = "function f() { try {} catch (e) { logSomething() } }"
    expect(seed.match(BARE_CATCH_RE)?.length ?? 0).toBe(0)
  })
})
