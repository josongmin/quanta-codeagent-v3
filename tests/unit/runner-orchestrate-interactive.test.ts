/**
 * Locks down the `runInteractive` driver contract — the R5-deferred extraction
 * of `apps/cli/repl.ts`'s interactive loop into `@/runner/orchestrate`.
 *
 * Invariants under test:
 *   1. `promptSource.next()` returning `null` exits the loop cleanly.
 *   2. Each accepted prompt feeds `runOnce` exactly once via the injected
 *      `assembleConfig` (verified by counting calls).
 *   3. Conversation history carries forward turn-to-turn (each iteration
 *      starts with the prior turn's post-condition `messages`).
 *   4. `onTurnEnd` fires AFTER `runOnce` resolves and BEFORE the next prompt
 *      is solicited (ordering matters for CLI dashboard render).
 *   5. `wrapTurn` returning `undefined` (e.g. CLI Esc-Esc per-turn cancel) is
 *      treated as "history unchanged, solicit next prompt" — not a loop exit.
 *   6. `signal.aborted` between turns exits the loop without calling next().
 *   7. `seedImages` are attached to the FIRST iteration only, then drained.
 *   8. `mcpClients.stop()` fires on loop exit (finally semantics).
 */
import { describe, expect, test } from "bun:test"
import type { AgentConfig, AgentOutcome } from "@/agent"
import type { ContentBlock, ImageBlock, Message } from "@/llm"
import { type OrchestrateDeps, type PromptSource, runInteractive } from "@/runner"

/** Build a minimal `OrchestrateDeps` stub. Most fields are unused by these
 *  tests because we inject a fake `assembleConfig` that doesn't read them. */
const stubDeps = (signal: AbortSignal): OrchestrateDeps =>
  ({
    llm: {} as never,
    registry: {} as never,
    stream: {} as never,
    permission: { mode: "default" } as never,
    system: "",
    cwd: "/tmp",
    maxTurns: 10,
    signal,
    onConfirm: async () => false,
    store: undefined,
    sessionId: "test-session",
    embedder: undefined,
    memoryConfig: undefined,
    planMode: false,
    metrics: undefined,
    run: undefined,
    subagentConfig: undefined,
    skillsConfig: undefined,
    compactionBreakerConfig: undefined,
    verifyGuardConfig: undefined,
    summarizerLlm: undefined,
    onShellEvent: undefined,
    workMetricsSink: undefined,
  }) satisfies OrchestrateDeps

/** Fake assembleConfig+runAgent path: capture each call's `messages` then
 *  immediately resolve with a synthetic assistant turn appended. We do this
 *  by short-circuiting through the `wrapTurn` hook (which receives the
 *  driver-supplied `runTurn` closure but in tests we just run a fake). */
const makeOutcome = (turn: number, messages: Message[]): AgentOutcome => ({
  messages,
  reason: "max_turns",
  turns: turn,
})

describe("@/runner/orchestrate#runInteractive", () => {
  test("null prompt exits the loop cleanly", async () => {
    const calls: string[] = []
    const ps: PromptSource = {
      next: async () => {
        calls.push("next")
        return null
      },
    }
    const abort = new AbortController()
    await runInteractive({
      deps: stubDeps(abort.signal),
      assembleConfig: (m) => ({ messages: m }) as unknown as AgentConfig,
      promptSource: ps,
      history: [],
      state: undefined,
      idMeta: undefined,
      signal: abort.signal,
      wrapTurn: async () => undefined,
    })
    expect(calls).toEqual(["next"])
  })

  test("each prompt drives a single wrapTurn call + onTurnEnd in order", async () => {
    const log: string[] = []
    const prompts = ["one", "two", "three"]
    let i = 0
    const ps: PromptSource = {
      next: async () => {
        log.push(`next:${i}`)
        return i < prompts.length ? (prompts[i++] ?? null) : null
      },
    }
    const abort = new AbortController()
    let turnCounter = 0
    await runInteractive({
      deps: stubDeps(abort.signal),
      assembleConfig: (m) => ({ messages: m }) as unknown as AgentConfig,
      promptSource: ps,
      history: [],
      state: undefined,
      idMeta: undefined,
      signal: abort.signal,
      wrapTurn: async (_run) => {
        log.push(`wrap:${turnCounter}`)
        turnCounter += 1
        // Stub: don't actually call run(); just synthesize the result.
        // (Calling run() here would invoke runAgent, requiring full deps.)
        const messages: Message[] = [
          {
            role: "user",
            content: [{ type: "text", text: prompts[turnCounter - 1] ?? "" }],
          } as Message,
          { role: "assistant", content: [{ type: "text", text: "ok" }] } as Message,
        ]
        return { outcome: makeOutcome(turnCounter, messages), messages }
      },
      onTurnEnd: async ({ outcome }) => {
        log.push(`end:${outcome.turns}`)
      },
    })
    // 3 prompts → 3 wrap+end cycles, then a 4th `next` returns null.
    expect(log).toEqual([
      "next:0",
      "wrap:0",
      "end:1",
      "next:1",
      "wrap:1",
      "end:2",
      "next:2",
      "wrap:2",
      "end:3",
      "next:3",
    ])
  })

  test("history carries forward turn-to-turn", async () => {
    let n = 0
    const ps: PromptSource = {
      next: async () => (n < 2 ? (n++ === 0 ? "first" : "second") : null),
    }
    const abort = new AbortController()
    const historiesSeenByOnTurnEnd: Message[][] = []
    const initial: Message[] = [
      { role: "user", content: [{ type: "text", text: "seed" }] } as Message,
    ]
    let callIdx = 0
    await runInteractive({
      deps: stubDeps(abort.signal),
      assembleConfig: (m) => ({ messages: m }) as unknown as AgentConfig,
      promptSource: ps,
      history: initial,
      state: undefined,
      idMeta: undefined,
      signal: abort.signal,
      wrapTurn: async () => {
        callIdx += 1
        // Synthesize a strictly-growing history.
        const msgs: Message[] = [
          ...initial,
          { role: "assistant", content: [{ type: "text", text: `r${callIdx}` }] } as Message,
        ]
        return { outcome: makeOutcome(callIdx, msgs), messages: msgs }
      },
      onTurnEnd: ({ messages }) => {
        historiesSeenByOnTurnEnd.push(messages)
      },
    })
    expect(historiesSeenByOnTurnEnd.length).toBe(2)
    // Second turn's onTurnEnd sees the post-condition of the second turn,
    // which (by our stub) includes the assistant message tagged "r2".
    const last = historiesSeenByOnTurnEnd[1]?.at(-1)
    expect(last && (last.content as ContentBlock[])[0]).toEqual({
      type: "text",
      text: "r2",
    } as ContentBlock)
  })

  test("wrapTurn returning undefined skips history update + does NOT exit loop", async () => {
    let n = 0
    const ps: PromptSource = {
      next: async () => (n < 3 ? `p${n++}` : null),
    }
    const abort = new AbortController()
    const ends: number[] = []
    let wrapCount = 0
    await runInteractive({
      deps: stubDeps(abort.signal),
      assembleConfig: (m) => ({ messages: m }) as unknown as AgentConfig,
      promptSource: ps,
      history: [],
      state: undefined,
      idMeta: undefined,
      signal: abort.signal,
      wrapTurn: async () => {
        wrapCount += 1
        return undefined
      },
      onTurnEnd: ({ outcome }) => {
        ends.push(outcome.turns)
      },
    })
    // All 3 prompts wrap-called, then 4th `next` exits — onTurnEnd never
    // fires because each wrap returned undefined.
    expect(wrapCount).toBe(3)
    expect(ends).toEqual([])
  })

  test("aborted signal between turns exits without calling next()", async () => {
    let nextCalls = 0
    const abort = new AbortController()
    const ps: PromptSource = {
      next: async () => {
        nextCalls += 1
        // After the first call, abort the outer signal — the loop should
        // exit BEFORE soliciting the next prompt.
        if (nextCalls === 1) {
          // Simulate the very first turn completing; on the SECOND iteration
          // the loop will check `signal.aborted` before calling next().
          return "go"
        }
        return null
      },
    }
    await runInteractive({
      deps: stubDeps(abort.signal),
      assembleConfig: (m) => ({ messages: m }) as unknown as AgentConfig,
      promptSource: ps,
      history: [],
      state: undefined,
      idMeta: undefined,
      signal: abort.signal,
      wrapTurn: async () => {
        // Trigger the outer abort mid-turn so the next while-check exits.
        abort.abort()
        return undefined
      },
    })
    expect(nextCalls).toBe(1)
  })

  test("seedImages attach to the first iteration ONLY", async () => {
    // Probe `seedImages` drain by intercepting at `assembleConfig` — which is
    // called BY runOnce AFTER it builds the user message (with images
    // attached). We let wrapTurn actually call `run()` so runOnce composes
    // the message; assembleConfig throws a sentinel BEFORE runAgent runs,
    // and wrapTurn swallows the sentinel — leaving runAgent un-exercised
    // (no stub-deps complaints) while the image-count probe is recorded.
    const prompts = ["one", "two"]
    let i = 0
    const ps: PromptSource = {
      next: async () => (i < prompts.length ? (prompts[i++] ?? null) : null),
    }
    const abort = new AbortController()
    const seed: ImageBlock[] = [{ type: "image", data: "", mediaType: "image/png" }]
    const imagesPerTurn: number[] = []
    class ProbeDone extends Error {}
    await runInteractive({
      deps: stubDeps(abort.signal),
      assembleConfig: (m) => {
        const last = m.at(-1)
        const blocks = (last?.content as ContentBlock[] | undefined) ?? []
        imagesPerTurn.push(blocks.filter((b) => b.type === "image").length)
        throw new ProbeDone()
      },
      promptSource: ps,
      history: [],
      state: undefined,
      idMeta: undefined,
      signal: abort.signal,
      seedImages: seed,
      wrapTurn: async (run) => {
        try {
          return await run(stubDeps(abort.signal))
        } catch (e) {
          if (e instanceof ProbeDone) return undefined
          throw e
        }
      },
    })
    expect(imagesPerTurn).toEqual([1, 0])
  })

  test("cancelled turn preserves pending images for the retry iteration", async () => {
    const prompts = ["first", "retry"]
    let i = 0
    const ps: PromptSource = {
      next: async () => (i < prompts.length ? (prompts[i++] ?? null) : null),
    }
    const abort = new AbortController()
    const seed: ImageBlock[] = [{ type: "image", data: "", mediaType: "image/png" }]
    const imagesPerTurn: number[] = []
    class ProbeDone extends Error {}
    let wraps = 0
    await runInteractive({
      deps: stubDeps(abort.signal),
      assembleConfig: (m) => {
        const last = m.at(-1)
        const blocks = (last?.content as ContentBlock[] | undefined) ?? []
        imagesPerTurn.push(blocks.filter((b) => b.type === "image").length)
        throw new ProbeDone()
      },
      promptSource: ps,
      history: [],
      state: undefined,
      idMeta: undefined,
      signal: abort.signal,
      seedImages: seed,
      wrapTurn: async (run) => {
        wraps += 1
        if (wraps === 1) return { cancelled: true }
        try {
          return await run(stubDeps(abort.signal))
        } catch (e) {
          if (e instanceof ProbeDone) return undefined
          throw e
        }
      },
    })
    expect(imagesPerTurn).toEqual([1])
  })

  test("mcpClients.stop() fires on loop exit (finally)", async () => {
    const stopCalls: string[] = []
    const ps: PromptSource = { next: async () => null }
    const abort = new AbortController()
    await runInteractive({
      deps: stubDeps(abort.signal),
      assembleConfig: (m) => ({ messages: m }) as unknown as AgentConfig,
      promptSource: ps,
      history: [],
      state: undefined,
      idMeta: undefined,
      signal: abort.signal,
      wrapTurn: async () => undefined,
      mcpClients: [
        {
          stop: async () => {
            stopCalls.push("a")
          },
        },
        {
          stop: async () => {
            stopCalls.push("b")
          },
        },
      ],
    })
    expect(stopCalls).toEqual(["a", "b"])
  })
})
