import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runAgent } from "@/agent"
import type { LLMPort, StreamEvent, StreamInput, SystemBlock } from "@/llm"
import { resolveMemoryDirPaths } from "@/memory/consolidate/paths"
import { JsonlFileStage1Store, type Stage1Entry } from "@/memory/stage1-store"
import { buildSessionMemoryAutoWires } from "@/runner/session-memory-auto"
import { __resetRuntimeConfig } from "@/shared"
import { defaultTools, ToolRegistry } from "@/tool"
import { cfg, RecordingStream, withTimeout } from "./_harness"

/**
 * REAL-LOOP FAKE-LLM e2e for ADR-0282 cross-session memory inject (feature
 * `memory-cross-session-inject`).
 *
 * The GAP this closes: `selectForInject` ranking is exercised ONLY in the pure
 * unit suite (`tests/unit/memory/auto-trigger-hellgate.test.ts` and the
 * `default-injector`/`prompt-section` unit tests). NOTHING drives the full
 * READ path through a real NEW session so that a PRIOR-session fact actually
 * reaches THAT session's LLM prompt. "selectForInject ranks correctly" ≠ "the
 * ranked fact lands in the system prompt the model sees this session".
 *
 * This drives the WHOLE path through the REAL assembler + REAL loop:
 *
 *   a PRIOR session's distinctive fact is persisted to the on-disk stage1
 *   store (selectedForPhase2 + usageCount>=1 — the promotion gate)
 *     → buildSessionMemoryAutoWires (env:{} ⇒ ADR-0413 default-ON) opens the
 *       SAME on-disk store, hydrates it, and its DefaultCrossSessionInjector
 *       .selectForInject + renderMemorySection mint `sessionCtx`
 *         → runAgent threads `sessionCtx` into the cached `session_ctx` system
 *           block (context-assembler → buildSystemPrompt)
 *             → the scripted LLM captures `StreamInput.system` and the prior
 *               fact's text is PRESENT in it (fresh capture, not the config slot)
 *
 * Control: an EMPTY store ⇒ the injector selects nothing ⇒ `sessionCtx` is
 * absent ⇒ the section header + fact NEVER appear in the system prompt. That
 * discriminator proves the main assertion is non-vacuous (it keys on the fact
 * actually reaching the prompt, not merely on the store being wired).
 *
 * Offline: the scripted `LLMPort` never touches the network. `homeDir` is a
 * throwaway tmp dir so the on-disk stage1 store is isolated per test.
 */

// The distinctive prior-session fact. If the cross-session inject truly drives
// through runAgent, this exact string must appear in the NEW session's system
// prompt — nowhere else in the prompt could it originate.
const PRIOR_FACT = "the staging deploy key rotates every Tuesday via ops/rotate-XSESSION-77.sh"
const SECTION_HEADER = "## Cross-session memory (auto)"

/** Flatten `StreamInput.system` (string | SystemBlock[]) into one string so we
 *  can assert the injected fact reached the prompt regardless of block layout. */
const systemText = (s: StreamInput["system"]): string => {
  if (s === undefined) return ""
  if (typeof s === "string") return s
  return (s as SystemBlock[]).map((b) => b.text).join("\n")
}

/**
 * Scripted model that RECORDS the flattened `system` prompt it saw each turn,
 * then ends the turn immediately (one turn, no tools). We only care about what
 * the system prompt carried on the first LLM call of this new session.
 */
class SystemCapturingLLM implements LLMPort {
  readonly model = "cross-session-inject-test-model"
  readonly seenSystem: string[] = []
  async *stream(i: StreamInput): AsyncIterable<StreamEvent> {
    this.seenSystem.push(systemText(i.system))
    await Promise.resolve()
    yield { type: "text_delta", delta: "acknowledged" }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

/** A minimal always-answers LLM used for the CONTROL run (empty store) — never
 *  distills (no store on the loop) and never emits tool calls. */
const controlLlm = (): SystemCapturingLLM => new SystemCapturingLLM()

/** Build a promoted prior-session stage1 entry carrying `summary` as its
 *  `rolloutSummary` (the field the injector reads). `usageCount:1` +
 *  `selectedForPhase2:true` clears the injector's `list({selectedForPhase2,
 *  minUsage:1})` promotion gate. */
const priorEntry = (threadId: string, summary: string, generatedAt: number): Stage1Entry => ({
  threadId,
  sourceUpdatedAt: generatedAt,
  rawMemory: `- [fact] ${summary}`,
  rolloutSummary: summary,
  generatedAt,
  rolloutSlug: `${threadId}-prior-session`,
  usageCount: 1,
  lastUsage: generatedAt,
  selectedForPhase2: true,
  selectedForPhase2SourceUpdatedAt: generatedAt,
})

describe("cross-session memory inject — prior-session fact reaches a NEW session's prompt through runAgent", () => {
  let tempHome: string
  beforeEach(() => {
    __resetRuntimeConfig()
    tempHome = mkdtempSync(join(tmpdir(), "q-xsession-inject-e2e-"))
  })
  afterEach(async () => {
    __resetRuntimeConfig()
    await rm(tempHome, { recursive: true, force: true })
  })

  test("PRE-POPULATED store ⇒ the prior fact is injected into the new session's system prompt", async () => {
    // --- Prior session: persist a distinctive promoted fact to the on-disk
    //     stage1 store the assembler will later open (SAME path). ---
    const paths = resolveMemoryDirPaths(tempHome)
    const stage1Path = join(paths.root, "stage1.jsonl")
    const priorStore = new JsonlFileStage1Store({ filePath: stage1Path, now: () => 1_000 })
    priorStore.put(priorEntry("prior-session-1", PRIOR_FACT, 1_000))
    // Sanity: the prior fact really is promoted + on disk (the injector's gate).
    expect(priorStore.list({ selectedForPhase2: true, minUsage: 1 })).toHaveLength(1)

    // --- New session: the REAL assembler opens the SAME store, hydrates it,
    //     and mints `sessionCtx` via the cross-session injector. ---
    const llm = new SystemCapturingLLM()
    const wires = await buildSessionMemoryAutoWires({
      env: {}, // empty ⇒ ADR-0413 default-ON ⇒ the injector runs at session start
      llm,
      sessionId: "new-session-1",
      homeDir: tempHome,
    })
    if (wires === undefined) throw new Error("expected auto-trigger wires (default-ON)")
    // LOAD-BEARING pre-check: the assembler's injector actually selected the
    // prior fact and rendered it into `sessionCtx` (the read half fired).
    if (wires.sessionCtx === undefined) throw new Error("expected sessionCtx from injector")
    expect(wires.sessionCtx).toContain(SECTION_HEADER)
    expect(wires.sessionCtx).toContain(PRIOR_FACT)

    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream: new RecordingStream(),
          registry: new ToolRegistry([...defaultTools]),
          sessionId: "new-session-1",
          messages: [
            { role: "user", content: [{ type: "text", text: "what should I know from before?" }] },
          ],
          maxTurns: 4,
          // The block the ASSEMBLER produced — NOT a hand-built literal.
          sessionCtx: wires.sessionCtx,
        }),
      ),
      15_000,
      "memory-cross-session-inject-e2e",
    )
    wires.dispose()

    expect(out.reason).toBe("completed")
    expect(llm.seenSystem.length).toBeGreaterThanOrEqual(1)

    // LOAD-BEARING: the prior-session fact actually reached the LLM's SYSTEM
    // prompt this new session — a fresh capture of `StreamInput.system`, not
    // the config slot. This is the whole point: cross-session recall surfaced
    // to the model on turn 1 of a brand-new session.
    const firstSystem = llm.seenSystem[0] ?? ""
    expect(firstSystem).toContain(SECTION_HEADER)
    expect(firstSystem).toContain(PRIOR_FACT)
  })

  test("CONTROL: EMPTY store ⇒ NO injection ⇒ the section + fact never reach the prompt (non-vacuous)", async () => {
    // Same assembler + loop, but NOTHING was persisted to the on-disk store.
    const llm = controlLlm()
    const wires = await buildSessionMemoryAutoWires({
      env: {},
      llm,
      sessionId: "new-session-empty-1",
      homeDir: tempHome,
    })
    if (wires === undefined) throw new Error("expected auto-trigger wires (default-ON)")
    // DISCRIMINATOR: with an empty store the injector selects nothing, so the
    // assembler produces NO `sessionCtx`. If the main test's assertion were
    // vacuous (e.g. the header were somewhere else in the base prompt), this
    // control would still surface it — it must NOT.
    expect(wires.sessionCtx).toBeUndefined()

    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream: new RecordingStream(),
          registry: new ToolRegistry([...defaultTools]),
          sessionId: "new-session-empty-1",
          messages: [
            { role: "user", content: [{ type: "text", text: "what should I know from before?" }] },
          ],
          maxTurns: 4,
          // No sessionCtx — mirrors the production path when nothing was promoted.
        }),
      ),
      15_000,
      "memory-cross-session-inject-e2e-control",
    )
    wires.dispose()

    expect(out.reason).toBe("completed")
    expect(llm.seenSystem.length).toBeGreaterThanOrEqual(1)
    // The INVERSE of the main assertion: neither the section header nor the
    // fact appear in ANY turn's system prompt (nothing was injected).
    for (const sys of llm.seenSystem) {
      expect(sys).not.toContain(SECTION_HEADER)
      expect(sys).not.toContain(PRIOR_FACT)
    }
  })
})
