import { describe, expect, test } from "bun:test"
import { NullEmbedder, runAgent } from "@/agent"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { InMemoryStore, type MemoryEntry } from "@/memory"
import { __resetRuntimeConfig } from "@/shared"
import { defaultTools, ToolRegistry } from "@/tool"
import { cfg, RecordingStream, withTimeout } from "./_harness"

/**
 * REAL-LOOP FAKE-LLM e2e for the pre-save dedup planner (feature
 * `memory-dedup-planner`, `src/memory/dedup.ts` → `findNearDuplicates`).
 *
 * The GAP this closes: `findNearDuplicates` is exercised ONLY as a pure unit
 * (`tests/unit/dedup.test.ts`). NOTHING drives it through a real session so
 * that a session that WRITES a near-duplicate actually merges/supersedes the
 * existing store row via the real persist path. "the planner returns the
 * right candidate ids" ≠ "the write session's dedup plan takes effect on the
 * durable store".
 *
 * The persist path through `runAgent` (agent/loop/session-lifecycle.ts →
 * `persistSession`, agent/memory.ts):
 *
 *   session ends `completed` with `cfg.store` wired
 *     → persistSession distills the transcript (scripted distill LLM)
 *       → for each distilled record: buildCandidate
 *         → findNearDuplicates(candidate, store.all() snapshot)  ← the planner
 *           → decideOp: arbitrateConsolidation (scripted arbitration LLM)
 *             → applyOp: merge/supersede/insert on the REAL store
 *               → fresh readback: the plan is REALIZED (no un-superseded dup)
 *
 * Non-vacuity: the CONTROL run distills a clearly-DISTINCT fact whose tokens
 * do not overlap the seeded row, so `findNearDuplicates` returns [] and the
 * arbitration LLM is NEVER called — the record is inserted as a NEW second row
 * (no merge/supersede). That discriminator proves the main assertions key on
 * the dedup plan actually firing, not merely on "a row exists after persist".
 *
 * Offline: a {@link NullEmbedder} (empty vectors, no network) ⇒ the planner
 * matches on the LEXICAL (token-Jaccard) channel alone — exactly the
 * embedding-less path the feature must still catch.
 */

const DISTILL_MARKER = "You distill durable long-term memory"
const ARBITRATE_MARKER = "You consolidate a new candidate memory"

/** Flatten every message's text + tool_result content into one string so we
 *  can branch the scripted LLM on which prompt it received. */
const convo = (i: StreamInput): string =>
  i.messages
    .flatMap((m) =>
      m.content.map((b) => (b.type === "text" ? b.text : b.type === "tool_result" ? b.content : "")),
    )
    .join(" ")

// The already-stored fact. The write session distills a NEAR-DUPLICATE of this
// (heavy token overlap ⇒ lexical Jaccard >= 0.6, the planner's lexical gate).
const EXISTING_TEXT = "the release build runs bun test then bun run typecheck before shipping"
const EXISTING_ID = "mem:seed:release-guard-DEDUP-77"

// A distinct-enough paraphrase: shares the load-bearing tokens with EXISTING_TEXT
// so it clears the 0.6 lexical Jaccard, but is not byte-identical (so the
// arbitration path — not the exact-match `skip` short-circuit — is taken).
const NEAR_DUP_TEXT = "the release build runs bun test then bun run typecheck and lint before shipping"

// A clearly-distinct fact (no meaningful token overlap with EXISTING_TEXT) for
// the control — findNearDuplicates returns [], so it inserts as a new row.
const DISTINCT_TEXT = "prometheus scrapes the sidecar metrics endpoint every fifteen seconds"

const distillJson = (text: string): string =>
  JSON.stringify([{ kind: "fact", tier: "semantic", text, tags: ["build"], importance: 0.8 }])

// A FRESH `createdAt` (within the hour) so the post-dedup eviction sweep in
// `persistSession` neither DELETES a just-superseded ancient row (`age >
// STALE_MAX_MS`) nor DECAYS an `archived`-bucket row's importance — both would
// otherwise post-process the dedup outcome we are asserting on. The candidate
// the loop inserts is stamped `Date.now()` (also fresh), so the whole store
// stays in the `fresh` bucket for the sweep. This isolates the assertion to the
// dedup PLAN itself, not eviction (a separate planner with its own unit suite).
const seedEntry = (): MemoryEntry => ({
  id: EXISTING_ID,
  kind: "fact",
  tier: "semantic",
  text: EXISTING_TEXT,
  tags: ["build"],
  importance: 0.7,
  createdAt: Date.now(),
})

/**
 * One scripted model serving THREE roles, branching on the prompt text:
 *   - session-end DISTILL (carries {@link DISTILL_MARKER}): returns the scripted
 *     near-duplicate / distinct record as a JSON array.
 *   - dedup ARBITRATION (carries {@link ARBITRATE_MARKER}): returns the scripted
 *     consolidation op (supersede/merge/insert) — only reached when the planner
 *     found ≥1 near-duplicate.
 *   - main agent loop (anything else): a single final answer, so the session
 *     completes in one turn (persist fires on a clean finish).
 */
class DedupSessionLLM implements LLMPort {
  readonly model = "dedup-planner-test-model"
  arbitrateCalls = 0
  distillCalls = 0
  constructor(
    private readonly distilledText: string,
    private readonly arbitrationJson: string,
  ) {}
  async *stream(i: StreamInput): AsyncIterable<StreamEvent> {
    const text = convo(i)
    if (text.includes(DISTILL_MARKER)) {
      this.distillCalls += 1
      yield { type: "text_delta", delta: distillJson(this.distilledText) }
      yield { type: "message_stop", stop_reason: "end_turn" }
      return
    }
    if (text.includes(ARBITRATE_MARKER)) {
      this.arbitrateCalls += 1
      yield { type: "text_delta", delta: this.arbitrationJson }
      yield { type: "message_stop", stop_reason: "end_turn" }
      return
    }
    yield { type: "text_delta", delta: "implemented the change" }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

/** Un-superseded (live) entries in the store. */
const liveEntries = (all: MemoryEntry[]): MemoryEntry[] => all.filter((e) => !e.supersededBy)

describe("memory dedup planner — a near-duplicate write supersedes the existing row through runAgent", () => {
  test("SUPERSEDE: near-dup write ⇒ planner + arbitration realize supersede on the durable store (fresh readback)", async () => {
    __resetRuntimeConfig()
    const store = new InMemoryStore([seedEntry()])
    const embedder = new NullEmbedder()
    // Pre-condition: exactly one live seeded row.
    expect((await store.all()).length).toBe(1)

    // The arbitration LLM elects to SUPERSEDE the existing row with the new one.
    const llm = new DedupSessionLLM(
      NEAR_DUP_TEXT,
      JSON.stringify({ action: "supersede", oldId: EXISTING_ID }),
    )

    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          store,
          embedder,
          stream: new RecordingStream(),
          registry: new ToolRegistry([...defaultTools]),
          sessionId: "dedup-write-1",
          messages: [
            { role: "user", content: [{ type: "text", text: "record the release guard rule" }] },
          ],
          maxTurns: 4,
        }),
      ),
      15_000,
      "memory-dedup-planner-e2e",
    )
    expect(out.reason).toBe("completed")

    // LOAD-BEARING: the planner FOUND the near-duplicate (arbitration was
    // reached) and the distill ran — the whole dedup pipeline fired, not a
    // no-dup short-circuit.
    expect(llm.distillCalls).toBe(1)
    expect(llm.arbitrateCalls).toBe(1)

    // LOAD-BEARING: the supersede plan was REALIZED on the durable store
    // (fresh readback). The old row is now marked supersededBy the new one,
    // and exactly ONE live (un-superseded) row remains — the near-dup did NOT
    // become a second parallel duplicate.
    const all = await store.all()
    const old = all.find((e) => e.id === EXISTING_ID)
    if (!old) throw new Error("expected the seeded row to still exist (marked superseded)")
    expect(old.supersededBy).toBeDefined()
    const live = liveEntries(all)
    expect(live).toHaveLength(1)
    const survivor = live[0]
    if (!survivor) throw new Error("expected one live row after supersede")
    expect(survivor.id).not.toBe(EXISTING_ID)
    expect(survivor.text).toBe(NEAR_DUP_TEXT)
    // The old row is the one the new entry points at.
    expect(old.supersededBy).toBe(survivor.id)
  })

  test("MERGE: near-dup write ⇒ arbitration merges into the existing row (no new row; merged text realized)", async () => {
    __resetRuntimeConfig()
    const store = new InMemoryStore([seedEntry()])
    const embedder = new NullEmbedder()
    expect((await store.all()).length).toBe(1)

    const MERGED_TEXT = `${EXISTING_TEXT}; also runs lint`
    // The arbitration LLM elects to MERGE the candidate into the existing row.
    const llm = new DedupSessionLLM(
      NEAR_DUP_TEXT,
      JSON.stringify({
        action: "merge",
        intoId: EXISTING_ID,
        text: MERGED_TEXT,
        tags: ["build"],
        importance: 0.85,
      }),
    )

    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          store,
          embedder,
          stream: new RecordingStream(),
          registry: new ToolRegistry([...defaultTools]),
          sessionId: "dedup-write-merge-1",
          messages: [
            { role: "user", content: [{ type: "text", text: "record the release guard rule" }] },
          ],
          maxTurns: 4,
        }),
      ),
      15_000,
      "memory-dedup-planner-merge-e2e",
    )
    expect(out.reason).toBe("completed")
    expect(llm.distillCalls).toBe(1)
    expect(llm.arbitrateCalls).toBe(1)

    // LOAD-BEARING: merge folded the candidate INTO the existing row — still
    // exactly ONE row, its id unchanged, but its text is the merged text and
    // its importance was bumped. No second (candidate) row was inserted.
    const all = await store.all()
    expect(all).toHaveLength(1)
    const merged = all[0]
    if (!merged) throw new Error("expected the single merged row")
    expect(merged.id).toBe(EXISTING_ID)
    expect(merged.text).toBe(MERGED_TEXT)
    expect(merged.importance).toBeCloseTo(0.85, 5)
    expect(merged.supersededBy).toBeUndefined()
  })

  test("CONTROL: a DISTINCT write ⇒ planner finds no dup, no arbitration ⇒ inserted as a NEW second row (non-vacuous)", async () => {
    __resetRuntimeConfig()
    const store = new InMemoryStore([seedEntry()])
    const embedder = new NullEmbedder()
    expect((await store.all()).length).toBe(1)

    // A distinct fact ⇒ findNearDuplicates returns [] ⇒ arbitration is never
    // called (decideOp short-circuits to insert). If the SUPERSEDE/MERGE tests
    // were vacuous (asserting on "a row exists"), this control would still show
    // one row — instead it must show TWO distinct live rows and ZERO arbitration.
    const llm = new DedupSessionLLM(
      DISTINCT_TEXT,
      JSON.stringify({ action: "supersede", oldId: EXISTING_ID }), // never reached
    )

    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          store,
          embedder,
          stream: new RecordingStream(),
          registry: new ToolRegistry([...defaultTools]),
          sessionId: "dedup-write-distinct-1",
          messages: [
            { role: "user", content: [{ type: "text", text: "record a monitoring fact" }] },
          ],
          maxTurns: 4,
        }),
      ),
      15_000,
      "memory-dedup-planner-control-e2e",
    )
    expect(out.reason).toBe("completed")

    // The DISCRIMINATOR: distill ran, but the planner found no near-dup, so
    // arbitration was NEVER invoked.
    expect(llm.distillCalls).toBe(1)
    expect(llm.arbitrateCalls).toBe(0)

    // TWO distinct live rows: the original seed is untouched (NOT superseded)
    // and the distinct fact was inserted alongside it.
    const all = await store.all()
    const live = liveEntries(all)
    expect(live).toHaveLength(2)
    const seed = all.find((e) => e.id === EXISTING_ID)
    if (!seed) throw new Error("expected the seeded row to survive untouched")
    expect(seed.supersededBy).toBeUndefined()
    expect(seed.text).toBe(EXISTING_TEXT)
    const inserted = all.find((e) => e.id !== EXISTING_ID)
    if (!inserted) throw new Error("expected the distinct fact inserted as a new row")
    expect(inserted.text).toBe(DISTINCT_TEXT)
  })
})
