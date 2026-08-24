/**
 * HELLGATE / RATCHET — every harness-authored `role:"user"` producer carries
 * provenance, and the closed `SyntheticUserMessageKind` set cannot drift.
 *
 * Context: `Message.origin?: "harness"` exists precisely so a harness utterance
 * can be marked WITHOUT being given an id — `isSyntheticUserMessage` reads
 * `origin` first and only falls back to the legacy
 * `quanta:synthetic-user:` id prefix. The turn-budget tail reminder is the one
 * injector that could not use the id-minting factory: it is appended on EVERY
 * bounded run, and `rewind-capture-turn-wire-hellgate` pins that a gate-OFF
 * saved transcript stays entirely id-less. `origin` is the marker that fits
 * through that hole.
 *
 * Invariants pinned here:
 *
 *  H1  THE REMINDER IS HARNESS SPEECH — the shipped `injectTurnBudgetReminder`
 *      appends a message that `isSyntheticUserMessage` accepts.
 *
 *  H2  AND IT IS STILL ID-LESS — the same message carries no `id`, so the
 *      byte-identical id-less transcript invariant survives the tagging. H1
 *      without H2 would be "fixed" by calling the factory, which is the exact
 *      regression this file exists to forbid.
 *
 *  H3  PAIRED CONTROL / FALSE POSITIVE — a genuine human turn (with or without
 *      an id) is NOT classified as harness speech, and the injector does not
 *      retroactively taint messages already in working memory. A guard that
 *      says "everything is harness" would pass H1 and be worse than nothing.
 *
 *  H4  DRIFT GUARD over the closed kind set — every `SyntheticUserMessageKind`
 *      member is classified exactly once as: produced through
 *      `makeSyntheticUserMessage` (verified by scanning the shipped `src/`
 *      tree, not by a hand-kept list), produced directly with an executable
 *      provenance proof in THIS file, or knowingly unproduced with a written
 *      justification. The classification table is `Record<Kind, …>` so a new
 *      union member fails COMPILATION, and the union is re-parsed from the
 *      shipped source at runtime so a stale/extra key fails at test time.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { injectTurnBudgetReminder } from "@/agent/loop/turn-iteration"
import {
  isSyntheticUserMessage,
  makeSyntheticUserMessage,
  type SyntheticUserMessageKind,
} from "@/agent/synthetic-user"
import type { AgentConfig } from "@/agent/types"
import type { Message } from "@/llm"
import { createWorkingMemory } from "@/memory"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")

/** Only `maxTurns` is read on this path; the rest of AgentConfig is inert here.
 *  Cast rather than a fake so the test drives the SHIPPED function, not a
 *  re-implementation of it. */
const cfgWith = (maxTurns: number): AgentConfig => ({ maxTurns }) as unknown as AgentConfig

/** A tail turn for `maxTurns = 20` (tail starts at `maxTurns - K`, K = 3). */
const TAIL_TURN = 18

const appendReminder = (seed: readonly Message[] = []): readonly Message[] => {
  const wm = createWorkingMemory<Message>([...seed])
  injectTurnBudgetReminder(cfgWith(20), wm, TAIL_TURN)
  return wm.snapshot()
}

// ─── H1/H2 — the turn-budget reminder is tagged harness AND id-less ────────

describe("H1/H2 — injectTurnBudgetReminder emits id-less harness speech", () => {
  const snap = appendReminder()
  const appended = snap[0]

  test("exactly one message is appended", () => {
    expect(snap.length).toBe(1)
    expect(appended?.role).toBe("user")
  })

  test("H1 — it is classified as harness speech", () => {
    expect(isSyntheticUserMessage(appended)).toBe(true)
  })

  test("H2 — it carries NO id (the id-less transcript invariant survives)", () => {
    expect(appended?.id).toBeUndefined()
  })

  test("H1+H2 together — provenance rides on `origin`, not on `id`", () => {
    expect(appended?.origin).toBe("harness")
    expect(appended?.id).toBeUndefined()
  })
})

// ─── H3 — paired control: human speech is not swept up ─────────────────────

describe("H3 — a genuine human user message is NOT harness speech", () => {
  const human: Message = { role: "user", content: [{ type: "text", text: "fix the parser" }] }
  const humanWithId: Message = { ...human, id: "m1" }

  test("an id-less human turn is not classified as harness", () => {
    expect(isSyntheticUserMessage(human)).toBe(false)
  })

  test("a plainly-id'd human turn is not classified as harness", () => {
    expect(isSyntheticUserMessage(humanWithId)).toBe(false)
  })

  test("injecting the reminder does not taint messages already in memory", () => {
    const snap = appendReminder([humanWithId])
    expect(snap.length).toBe(2)
    expect(isSyntheticUserMessage(snap[0])).toBe(false)
    expect(snap[0]?.origin).toBeUndefined()
    expect(isSyntheticUserMessage(snap[1])).toBe(true)
  })

  test("the classifier is not degenerate — it separates the two in one array", () => {
    const mixed = [humanWithId, ...appendReminder()]
    expect(mixed.map((m) => isSyntheticUserMessage(m))).toEqual([false, true])
  })
})

// ─── H4 — drift guard over the closed kind set ─────────────────────────────

type KindCoverage =
  /** Produced somewhere in `src/` via `makeSyntheticUserMessage("<kind>", …)`.
   *  Verified by scanning the shipped tree — the table only declares intent. */
  | { readonly via: "factory" }
  /** Produced by a direct `wm.append` (no id minted). Legal ONLY when this file
   *  executes the shipped producer and asserts its provenance. */
  | { readonly via: "direct"; readonly provenBy: string }
  /** No producer exists today. Requires a one-line justification. */
  | { readonly via: "unused"; readonly why: string }

/** Compile-time exhaustive: adding a `SyntheticUserMessageKind` member without
 *  classifying it here fails `typecheck:tests`. */
const KIND_COVERAGE: Record<SyntheticUserMessageKind, KindCoverage> = {
  "same-turn-recovery": { via: "factory" },
  "hook-context": { via: "factory" },
  "context-change": { via: "factory" },
  "mention-injection": { via: "factory" },
  "focus-chain": { via: "factory" },
  "turn-budget": { via: "direct", provenBy: "H1/H2 above" },
  "tool-nudge": { via: "factory" },
  resume: { via: "factory" },
  "peer-mail": { via: "factory" },
  "conversation-summary": {
    via: "unused",
    why: "compaction summaries re-enter the transcript id-less and are marked with `origin` directly (see Message.origin docs); no factory call site exists.",
  },
  "identity-reminder": {
    via: "unused",
    why: "`injectIdentityReminder` ships but tags its message `focus-chain` (src/agent/loop/turn-iteration.ts); retagging is a separate change, so this kind is reserved and unproduced.",
  },
}

/** The kinds that are allowed to have zero producers. Derived from the table so
 *  the two cannot disagree. */
const KNOWN_UNUSED: readonly SyntheticUserMessageKind[] = (
  Object.entries(KIND_COVERAGE) as ReadonlyArray<[SyntheticUserMessageKind, KindCoverage]>
)
  .filter(([, c]) => c.via === "unused")
  .map(([k]) => k)

/** Re-parse the union from the SHIPPED source. A hand-copied literal array
 *  would go stale silently; this cannot. */
const parseKindUnionFromSource = (): readonly string[] => {
  const src = readFileSync(join(REPO_ROOT, "src", "agent", "synthetic-user.ts"), "utf8")
  const start = src.indexOf("export type SyntheticUserMessageKind =")
  expect(start, "SyntheticUserMessageKind declaration not found").toBeGreaterThanOrEqual(0)
  const body = src.slice(start, src.indexOf("\n\n", start))
  return [...body.matchAll(/\|\s*"([a-z-]+)"/g)].map((m) => m[1] as string)
}

/** Kinds that actually reach `makeSyntheticUserMessage` in shipped source.
 *  `src/**\/__tests__` is excluded: a test call site is not a producer. */
const scanFactoryProducerKinds = (): ReadonlySet<string> => {
  const proc = Bun.spawnSync({
    cmd: ["grep", "-rn", "--include=*.ts", 'makeSyntheticUserMessage("', "src"],
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  })
  // grep exits 1 on "no matches" — that is a real drift signal, not a crash.
  expect([0, 1]).toContain(proc.exitCode)
  const kinds = new Set<string>()
  for (const line of new TextDecoder().decode(proc.stdout).split("\n")) {
    if (line.includes("/__tests__/")) continue
    const m = /makeSyntheticUserMessage\("([a-z-]+)"/.exec(line)
    if (m?.[1] !== undefined) kinds.add(m[1])
  }
  return kinds
}

describe("H4 — SyntheticUserMessageKind coverage cannot drift", () => {
  const unionFromSource = parseKindUnionFromSource()

  test("the coverage table matches the shipped union exactly", () => {
    expect([...unionFromSource].sort()).toEqual(Object.keys(KIND_COVERAGE).sort())
  })

  test("every kind is either produced or explicitly justified as unused", () => {
    const produced = scanFactoryProducerKinds()
    for (const kind of unionFromSource) {
      const coverage = KIND_COVERAGE[kind as SyntheticUserMessageKind]
      expect(coverage, `kind "${kind}" is unclassified`).toBeDefined()
      if (coverage.via === "factory") {
        expect(produced.has(kind), `kind "${kind}" claims a factory producer but none exists`).toBe(
          true,
        )
      } else if (coverage.via === "direct") {
        expect(coverage.provenBy.length, `kind "${kind}" needs a named proof`).toBeGreaterThan(0)
      } else {
        expect(coverage.why.length, `kind "${kind}" needs a justification`).toBeGreaterThan(0)
        expect(produced.has(kind), `kind "${kind}" is listed unused but HAS a producer`).toBe(false)
      }
    }
  })

  test("turn-budget is NOT in KNOWN_UNUSED — it has a live, proven producer", () => {
    expect(KNOWN_UNUSED).not.toContain("turn-budget")
    expect(KIND_COVERAGE["turn-budget"].via).toBe("direct")
  })

  test("KNOWN_UNUSED is exactly the kinds with no producer today", () => {
    expect([...KNOWN_UNUSED].sort()).toEqual(["conversation-summary", "identity-reminder"])
  })

  test("the source scanner is not vacuous — it finds the known factory kinds", () => {
    const produced = scanFactoryProducerKinds()
    expect(produced.has("focus-chain")).toBe(true)
    expect(produced.has("tool-nudge")).toBe(true)
    expect(produced.size).toBeGreaterThanOrEqual(7)
  })

  test("the union parser is not vacuous — it finds a nontrivial closed set", () => {
    expect(unionFromSource.length).toBeGreaterThanOrEqual(11)
    expect(unionFromSource).toContain("turn-budget")
  })

  test("the factory itself still mints BOTH marks (direct producers may not)", () => {
    const m = makeSyntheticUserMessage("tool-nudge", [{ type: "text", text: "x" }])
    expect(isSyntheticUserMessage(m)).toBe(true)
    expect(typeof m.id).toBe("string")
  })
})
