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
import { readdirSync, readFileSync } from "node:fs"
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
    // ALBB-09 (jul-9) — the LOOP surface (shim + `src/agent/loop/` slice). The
    // `emitCompactionEvent` bare `} catch {}` in `compaction-wire.ts` was
    // migrated to a bound `} catch (e) { logger.warn(\`compaction-wire.
    // emitCompactionEvent: ...\`) }` (parity with `compaction.postCompactEmit`
    // and the install-side `codex-r2-wire.compactionEventEmit`). Pinned here so a
    // regression back to the silent swallow drops the label ⇒ RED.
    file: "src/agent/loop.ts",
    labels: ["loop.objectiveSetNextActions", "compaction-wire.emitCompactionEvent"],
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
  "src/agent/approval-state-machine/store.ts": 2,
  "src/agent/codex-r2-wire-install/install.ts": 4,
  "src/agent/compaction.ts": 0,
  // jul-2 (FIX 5): two silent `} catch {` in the loop slice
  // (compaction-wire `resolveContextEventsForTurn`, context-assembler
  // `resolveMentionInjectionMessages`) were migrated to bound
  // `} catch (e) { config.stream.emit({type:"error", ...}) }` so a throwing
  // context-events / @mention provider is observable instead of silently
  // indistinguishable from "nothing to inject". Ratchet tightened 6 → 4.
  //
  // jul-9 (ALBB-09): Wave A added ONE new loop-surface bare-catch
  // (`compaction-wire.defaultResetEffortClassifier`, advisory reset — its own
  // ticket's owned site) which transiently lifted the count to 5. THIS ticket
  // migrates the `emitCompactionEvent` bare `} catch {}` to a bound
  // `logger.warn(\`compaction-wire.emitCompactionEvent: ...\`)`, bringing the
  // count back DOWN to the pinned floor of 4. Net: the floor is unchanged (a
  // one-in / one-out swap) but the `emitCompactionEvent` swallow is removed —
  // reverting THIS fix re-lifts the count to 5 ⇒ ratchet RED, and drops the
  // pinned `compaction-wire.emitCompactionEvent` label ⇒ label test RED.
  "src/agent/loop.ts": 4,
  "src/agent/observability-wire/wire.ts": 1,
}

// Matches the canonical SILENT form `} catch {` (no binding, swallowed error);
// a bound `} catch (e) { ... }` deliberately does NOT match.
const BARE_CATCH_RE = /\}\s*catch\s*\{/g

// The 2026-06 loop decomposition split `src/agent/loop.ts` into a thin shim +
// the `src/agent/loop/` slice. The bare-catches + pinned labels relocated there,
// so for the loop entry the ratchet reads the WHOLE surface (shim + slice): the
// invariant is "the LOOP has ≤ baseline bare-catches / still emits the label,"
// independent of how the decomposition distributes them across files.
const loopSurfaceFiles = (): string[] => {
  const files = [resolve(REPO_ROOT, "src/agent/loop.ts")]
  const dir = resolve(REPO_ROOT, "src/agent/loop")
  try {
    for (const f of readdirSync(dir).sort()) {
      if (f.endsWith(".ts")) files.push(resolve(dir, f))
    }
  } catch {
    // pre-decomposition tree: the shim is the whole surface.
  }
  return files
}

const isLoop = (relPath: string): boolean => relPath === "src/agent/loop.ts"

const countBareCatches = (relPath: string): number => {
  const sources = isLoop(relPath)
    ? loopSurfaceFiles().map((p) => readFileSync(p, "utf8"))
    : [readFileSync(resolve(REPO_ROOT, relPath), "utf8")]
  return sources.reduce((n, src) => n + [...src.matchAll(BARE_CATCH_RE)].length, 0)
}

const fileContents = (relPath: string): string =>
  isLoop(relPath)
    ? loopSurfaceFiles()
        .map((p) => readFileSync(p, "utf8"))
        .join("\n")
    : readFileSync(resolve(REPO_ROOT, relPath), "utf8")

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

describe("R3 audit-H — bare-catch count must EQUAL baseline (R5 tightened)", () => {
  for (const [file, baseline] of Object.entries(BARE_CATCH_BASELINE)) {
    test(`${file} bare-catch count === ${baseline}`, () => {
      const observed = countBareCatches(file)
      if (observed > baseline) {
        throw new Error(
          `Silent-catch regression in ${file}: ${observed} bare-catches ` +
            `(baseline = ${baseline}). A new bare \`} catch {\` was added — ` +
            `swap to \`} catch (e) { logger.warn(\\\`<label>: ${"${"}errMessage(e)${"}"}\\\`) }\` ` +
            `with a stable label prefix.`,
        )
      }
      if (observed < baseline) {
        // R5: progress is GOOD but ratchet must move forward — the BASELINE
        // table is the source of truth and a decrement means a swallow was
        // successfully migrated. Edit the BASELINE constant to ${observed}
        // in the same change so the next regression hits the new floor.
        throw new Error(
          `Silent-catch IMPROVEMENT in ${file}: ${observed} bare-catches ` +
            `(baseline = ${baseline}). Progress is welcome but the ratchet ` +
            `must move forward — tighten BASELINE to ${observed} in the ` +
            `same change. (Drift in either direction breaks attribution.)`,
        )
      }
      // Strictly equal — the baseline is the floor AND the ceiling. Any drift
      // (up = regression, down = un-recorded migration) fails the ratchet.
      expect(observed).toBe(baseline)
    })
  }
})

// NOTE: the two regex self-check tests (canonical-form match / bound-catch
// non-match) were removed as tautological — they asserted hand-written string
// literals against the test's own BARE_CATCH_RE, exercising RegExp not src/.
// BARE_CATCH_RE intent is documented at its definition above.
