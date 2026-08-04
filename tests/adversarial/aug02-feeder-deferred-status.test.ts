/**
 * ADVERSARIAL RE-AUDIT (Round 2B) — HONESTY + DEAD-SEAM re-sweep across aug-02.
 *
 * Round 1 found the RFC03 promote actuator dead seam (fixed). This suite PROVES
 * two OTHER dead-seams whose catalog `purpose` claims a working production effect
 * that never occurs in production:
 *
 *   (1) RFC06-4 hunk-mutation receipt / CAS undo journal — the catalog claims
 *       "each per-hunk apply persists an intent/effect/terminal receipt into a
 *       CAS undo journal so the apply is undoable via a content-VERIFIED revert".
 *       REALITY: no production composition root ever constructs a journal store
 *       (`makeDurableJournalStore` / `makeInMemoryJournalStore`) nor sets
 *       `deps.mutationJournal`, so the receipt-wrap gate
 *       `hunkMutationReceipt && deps.mutationJournal !== undefined` is ALWAYS
 *       false in production — even with QUANTA_HUNK_MUTATION_RECEIPT=1. And
 *       `undoHunkMutation` has NO production caller at all.
 *
 *   (2) RFC01 durable ThreadRollback saga — the catalog claims "the ThreadRollback
 *       effect saga replays the mapping to rewind the thread with a CLI `/rewind`
 *       wire ... consumed by the rewind saga". REALITY: `executeRollback` /
 *       `resumePendingRollback` have NO production caller, and `buildRollbackEffectPort`
 *       (the real ShadowOdb-backed effect adapter) is never invoked in production.
 *       The CLI `/rewind` path (`rewindSession`) still degrades file restore to
 *       "working tree unchanged (file restore not yet wired)".
 *
 * These are caller-grep proofs over the REAL src tree: a failing assertion means
 * a production caller was ADDED (the seam got wired — delete the corresponding
 * assertion) OR the grep is stale. A PASSING assertion is the finding (the effect
 * never occurs in production).
 */

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

const SRC = join(import.meta.dir, "..", "..", "src")

/** Recursively collect all .ts files under a dir (excluding *.test.ts). */
const collectTs = (dir: string): string[] => {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) out.push(...collectTs(p))
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(p)
  }
  return out
}

const ALL_SRC = collectTs(SRC)

/** Count production (non-test) src files that contain `needle`, optionally
 *  excluding the files where the symbol is DEFINED/DECLARED. */
const filesContaining = (needle: RegExp, excludeSubstr: string[] = []): string[] =>
  ALL_SRC.filter((f) => {
    if (excludeSubstr.some((ex) => f.includes(ex))) return false
    return needle.test(readFileSync(f, "utf8"))
  })

describe("R2B dead-seam sweep — RFC06-4 hunk-mutation CAS undo journal", () => {
  test("FINDING: no production code assigns `mutationJournal:` (the dep the receipt-wrap requires)", () => {
    // The receipt path only runs when `deps.mutationJournal !== undefined`.
    // Grep for an ASSIGNMENT `mutationJournal:` (object-literal / property set)
    // anywhere in production src. If this is empty, the wrap is unreachable in
    // production regardless of the QUANTA_HUNK_MUTATION_RECEIPT knob.
    const setters = filesContaining(/\bmutationJournal:\s/, [])
    // Consumers only DECLARE `mutationJournal?:` (type) and READ
    // `deps.mutationJournal` — none SET it. Assert zero production setters.
    expect(setters).toEqual([])
  })

  test("FINDING: journal store factories are never constructed in production", () => {
    const constructors = filesContaining(
      /\b(makeDurableJournalStore|makeInMemoryJournalStore)\s*\(/,
      ["hunk-mutation-journal.ts"], // exclude the definition file
    )
    expect(constructors).toEqual([])
  })

  test("FINDING: undoHunkMutation (the 'undoable via content-verified revert') has no production caller", () => {
    const callers = filesContaining(/\bundoHunkMutation\s*\(/, ["hunk-mutation-journal.ts"])
    expect(callers).toEqual([])
  })
})

describe("R2B dead-seam sweep — RFC01 durable ThreadRollback saga", () => {
  test("FINDING: executeRollback has no production caller (tests-only)", () => {
    const callers = filesContaining(/\bexecuteRollback\s*\(/, ["thread-rollback.ts"])
    expect(callers).toEqual([])
  })

  test("FINDING: resumePendingRollback has no production caller (tests-only)", () => {
    const callers = filesContaining(/\bresumePendingRollback\s*\(/, ["thread-rollback.ts"])
    expect(callers).toEqual([])
  })

  test("FINDING: buildRollbackEffectPort (real ShadowOdb effect adapter) is never invoked", () => {
    // It is DEFINED in per-tool-checkpoint-wire.ts; assert it is never CALLED
    // (an invocation would be `buildRollbackEffectPort(`).
    const callers = filesContaining(/\bbuildRollbackEffectPort\s*\(/, [
      "per-tool-checkpoint-wire.ts",
    ])
    expect(callers).toEqual([])
  })

  test("FINDING: the CLI `/rewind` path still degrades file restore (saga not wired in)", () => {
    // The transcript-owner rewind (the actual CLI `/rewind` effect) still prints
    // the "file restore not yet wired" degrade note — the saga did NOT replace it.
    const rewind = readFileSync(join(SRC, "session", "rewind.ts"), "utf8")
    expect(rewind).toContain("file restore not yet wired")
    // And it does NOT import/call the coordinator.
    expect(rewind).not.toMatch(/\bexecuteRollback\b/)
    expect(rewind).not.toMatch(/\bresumePendingRollback\b/)
  })
})

describe("R2B dead-seam sweep — RFC02-3 model-route transition witness", () => {
  // Catalog claim (aug02-rfc02-route-transition-witness.yaml): "whenever the
  // effective model route changes (fallback trip, scheduler model reroute,
  // /retry-with), the CALLER that owns the transition emits a typed witness
  // event." REALITY: all three `model_route_changed` producers are gated on an
  // `onTransition`/`onModelReroute` sink that NO production root ever supplies,
  // so the event is never emitted in production.

  test("FINDING: fallback producer `fallbackTransitionToRouteEvent` has no production caller", () => {
    // The pure mapper is DEFINED in runner/assemble/llm.ts but never CALLED —
    // because `new FallbackLLM({...})` (llm.ts) never passes `onTransition`.
    const callers = filesContaining(/\bfallbackTransitionToRouteEvent\s*\(/, ["assemble/llm.ts"])
    expect(callers).toEqual([])
  })

  test("FINDING: no production FallbackLLM construction wires `onTransition`", () => {
    // `onTransition:` (the sink that would make the fallback witness fire) is
    // never assigned anywhere in production — only declared as a private field.
    const setters = filesContaining(/\bonTransition:\s/, ["fallback.ts"])
    expect(setters).toEqual([])
  })

  test("FINDING: no production root supplies an `onModelReroute` sink (scheduler + /retry-with dead)", () => {
    // Every production `onModelReroute` is a type-decl, a conditional
    // passthrough (`deps.onModelReroute !== undefined ? {...}`), or a guarded
    // consumer (`if (state.onModelReroute === undefined) return`). NONE assign a
    // concrete function — so both the scheduler reroute emit (runtime-wire.ts)
    // and the /retry-with emit (retry-with.ts) are unreachable. Assert there is
    // no CONCRETE-FUNCTION assignment `onModelReroute: (` / `onModelReroute: fn`
    // (an arrow/named function value, not the passthrough spread).
    const concreteAssign = filesContaining(/\bonModelReroute:\s*(\(|async|function|[A-Za-z_$][\w$]*\s*,)/)
    // (The runtime-wire passthrough `onModelReroute: deps.onModelReroute` would
    // match the identifier arm, so exclude it explicitly by requiring the value
    // is NOT `deps.onModelReroute`.)
    const realSuppliers = concreteAssign.filter((f) => {
      const src = readFileSync(f, "utf8")
      // keep only files with an onModelReroute assignment whose value is not the
      // pure passthrough identifier.
      return /\bonModelReroute:\s*(?!deps\.onModelReroute\b)(\(|async|function|[A-Za-z_$])/.test(src)
        ? !/\bonModelReroute:\s*deps\.onModelReroute\b/.test(
            src.match(/\bonModelReroute:[^\n]*/)?.[0] ?? "",
          )
        : false
    })
    expect(realSuppliers).toEqual([])
  })

  test("FINDING: the only reachable-looking emit callsites are all sink-gated (no live sink upstream)", () => {
    // rerouteResultToRouteEvent IS called (runtime-wire.ts:283) but only inside
    // `if (route.onModelReroute !== undefined)`; emitOperatorRouteTransition is
    // guarded by `if (state.onModelReroute === undefined) return`. Prove both
    // guards exist (so absent-sink ⇒ no emit) AND that the sink is never seeded.
    const wire = readFileSync(join(SRC, "scheduler", "runtime-wire.ts"), "utf8")
    expect(wire).toMatch(/if\s*\(\s*route\.onModelReroute\s*!==\s*undefined\s*\)/)
    const retry = readFileSync(join(SRC, "apps", "cli", "retry-with.ts"), "utf8")
    expect(retry).toMatch(/if\s*\(\s*state\.onModelReroute\s*===\s*undefined\s*\)\s*return/)
  })
})
