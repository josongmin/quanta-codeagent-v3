/**
 * ADR-0083 multi-modal extension — `PromptSource.next()` widening from
 * `string` → `PromptPayload`. Validates that:
 *   1. A pre-multi-modal `PromptSource` returning a plain `string` keeps
 *      working byte-identically (backward-compat type widening).
 *   2. A multi-modal `PromptSource` returning `{ text, images }` attaches
 *      the images to THAT turn's user message.
 *   3. Mixed: argv-seed `seedImages` PLUS a per-turn payload images list
 *      both attach to the first turn (concat semantics).
 *   4. Single-shot drain: a per-turn payload's images do NOT carry over to
 *      the next turn (the surface owns the queue; the driver does NOT
 *      re-attach the previous turn's payload images).
 *   5. `runOnce` accepts the `PromptPayload` form directly (one-shot
 *      surfaces — Web/Tauri — bypass the loop driver).
 *   6. `normalizePromptPayload` is a pure widening from `string` → object.
 */
import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import type { ContentBlock, ImageBlock, Message } from "@/llm"
import {
  normalizePromptPayload,
  type OrchestrateDeps,
  type PromptSource,
  runInteractive,
} from "@/runner"

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

const PNG: ImageBlock = { type: "image", data: "AAAA", mediaType: "image/png" }
const JPG: ImageBlock = { type: "image", data: "BBBB", mediaType: "image/jpeg" }

/** Probe sentinel: thrown by `assembleConfig` after recording the per-turn
 *  user message; `wrapTurn` swallows it so `runAgent` never runs (we don't
 *  have a wired LLM in the stub). */
class ProbeDone extends Error {}

interface TurnProbe {
  readonly text: string
  readonly imageCount: number
  readonly images: readonly ImageBlock[]
}

/** Build a probe `assembleConfig` that records the last user message in `out`
 *  and throws to short-circuit before runAgent. */
const probeAssembleConfig =
  (out: TurnProbe[]): ((m: Message[]) => AgentConfig) =>
  (m) => {
    const last = m.at(-1)
    const blocks = (last?.content as ContentBlock[] | undefined) ?? []
    const text = blocks.find((b) => b.type === "text")
    const images = blocks.filter((b): b is ImageBlock => b.type === "image")
    out.push({
      text: text && text.type === "text" ? text.text : "",
      imageCount: images.length,
      images,
    })
    throw new ProbeDone()
  }

describe("@/runner — PromptSource multi-modal (ADR-0083 extension)", () => {
  test("string payload (backward-compat) — byte-identical to today", async () => {
    const prompts = ["hello", "world"]
    let i = 0
    const ps: PromptSource = {
      next: async () => (i < prompts.length ? (prompts[i++] ?? null) : null),
    }
    const abort = new AbortController()
    const probes: TurnProbe[] = []
    await runInteractive({
      deps: stubDeps(abort.signal),
      assembleConfig: probeAssembleConfig(probes),
      promptSource: ps,
      history: [],
      state: undefined,
      idMeta: undefined,
      signal: abort.signal,
      wrapTurn: async (run) => {
        try {
          return await run(stubDeps(abort.signal))
        } catch (e) {
          if (e instanceof ProbeDone) return undefined
          throw e
        }
      },
    })
    expect(probes.map((p) => p.text)).toEqual(["hello", "world"])
    expect(probes.map((p) => p.imageCount)).toEqual([0, 0])
  })

  test("PromptPayload { text, images } attaches images to that turn only", async () => {
    let n = 0
    const ps: PromptSource = {
      next: async () => {
        n += 1
        if (n === 1) return { text: "with-image", images: [PNG] }
        if (n === 2) return { text: "text-only", images: [] }
        return null
      },
    }
    const abort = new AbortController()
    const probes: TurnProbe[] = []
    await runInteractive({
      deps: stubDeps(abort.signal),
      assembleConfig: probeAssembleConfig(probes),
      promptSource: ps,
      history: [],
      state: undefined,
      idMeta: undefined,
      signal: abort.signal,
      wrapTurn: async (run) => {
        try {
          return await run(stubDeps(abort.signal))
        } catch (e) {
          if (e instanceof ProbeDone) return undefined
          throw e
        }
      },
    })
    expect(probes).toHaveLength(2)
    expect(probes[0]?.text).toBe("with-image")
    expect(probes[0]?.imageCount).toBe(1)
    expect(probes[0]?.images[0]?.data).toBe("AAAA")
    // Second turn — single-shot semantics, the surface chose not to attach.
    expect(probes[1]?.text).toBe("text-only")
    expect(probes[1]?.imageCount).toBe(0)
  })

  test("mixed seedImages + per-turn payload images concat on the first turn", async () => {
    let n = 0
    const ps: PromptSource = {
      next: async () => {
        n += 1
        if (n === 1) return { text: "first", images: [JPG] }
        if (n === 2) return { text: "second", images: [] }
        return null
      },
    }
    const abort = new AbortController()
    const probes: TurnProbe[] = []
    await runInteractive({
      deps: stubDeps(abort.signal),
      assembleConfig: probeAssembleConfig(probes),
      promptSource: ps,
      history: [],
      state: undefined,
      idMeta: undefined,
      signal: abort.signal,
      seedImages: [PNG],
      wrapTurn: async (run) => {
        try {
          return await run(stubDeps(abort.signal))
        } catch (e) {
          if (e instanceof ProbeDone) return undefined
          throw e
        }
      },
    })
    expect(probes).toHaveLength(2)
    // First turn: seed (PNG) + payload (JPG) concatenated, order preserved.
    expect(probes[0]?.imageCount).toBe(2)
    expect(probes[0]?.images[0]?.mediaType).toBe("image/png")
    expect(probes[0]?.images[1]?.mediaType).toBe("image/jpeg")
    // Second turn: seed already drained AND payload had no images.
    expect(probes[1]?.imageCount).toBe(0)
  })

  test("payload images do NOT carry across turns (single-shot)", async () => {
    let n = 0
    const ps: PromptSource = {
      next: async () => {
        n += 1
        if (n === 1) return { text: "t1", images: [PNG, JPG] }
        if (n === 2) return "t2"
        return null
      },
    }
    const abort = new AbortController()
    const probes: TurnProbe[] = []
    await runInteractive({
      deps: stubDeps(abort.signal),
      assembleConfig: probeAssembleConfig(probes),
      promptSource: ps,
      history: [],
      state: undefined,
      idMeta: undefined,
      signal: abort.signal,
      wrapTurn: async (run) => {
        try {
          return await run(stubDeps(abort.signal))
        } catch (e) {
          if (e instanceof ProbeDone) return undefined
          throw e
        }
      },
    })
    expect(probes[0]?.imageCount).toBe(2)
    expect(probes[1]?.imageCount).toBe(0)
  })

  test("cancelled turn replays seed + payload images on the retry turn", async () => {
    let n = 0
    const ps: PromptSource = {
      next: async () => {
        n += 1
        if (n === 1) return { text: "cancelled", images: [JPG] }
        if (n === 2) return "retry"
        return null
      },
    }
    const abort = new AbortController()
    const probes: TurnProbe[] = []
    let wraps = 0
    await runInteractive({
      deps: stubDeps(abort.signal),
      assembleConfig: probeAssembleConfig(probes),
      promptSource: ps,
      history: [],
      state: undefined,
      idMeta: undefined,
      signal: abort.signal,
      seedImages: [PNG],
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
    expect(probes).toHaveLength(1)
    expect(probes[0]?.text).toBe("retry")
    expect(probes[0]?.imageCount).toBe(2)
    expect(probes[0]?.images[0]?.mediaType).toBe("image/png")
    expect(probes[0]?.images[1]?.mediaType).toBe("image/jpeg")
  })

  test("normalizePromptPayload is a pure widening", () => {
    expect(normalizePromptPayload("hi")).toEqual({ text: "hi", images: [] })
    expect(normalizePromptPayload({ text: "x" })).toEqual({ text: "x", images: [] })
    expect(normalizePromptPayload({ text: "y", images: [PNG] })).toEqual({
      text: "y",
      images: [PNG],
    })
  })

  test("runOnce accepts a PromptPayload directly (one-shot path)", async () => {
    // Import inside to keep the top-level imports tidy.
    const { runOnce } = await import("@/runner")
    const probes: TurnProbe[] = []
    const abort = new AbortController()
    try {
      await runOnce({
        deps: stubDeps(abort.signal),
        assembleConfig: probeAssembleConfig(probes),
        history: [],
        prompt: { text: "one-shot", images: [PNG] },
        state: undefined,
        idMeta: undefined,
      })
    } catch (e) {
      if (!(e instanceof ProbeDone)) throw e
    }
    expect(probes).toHaveLength(1)
    expect(probes[0]?.text).toBe("one-shot")
    expect(probes[0]?.imageCount).toBe(1)
  })
})
