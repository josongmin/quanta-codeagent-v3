import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import type { ContentBlock, ImageBlock, Message } from "@/llm"
import type { SessionDeps } from "@/runner/assemble/config"
import { normalizePromptPayload } from "@/runner/orchestrate/prompt-payload"
import { runOnce } from "@/runner/orchestrate/run-once"

const PNG: ImageBlock = { type: "image", data: "AAAA", mediaType: "image/png" }
const JPG: ImageBlock = { type: "image", data: "BBBB", mediaType: "image/jpeg" }

class ProbeDone extends Error {}

interface TurnProbe {
  readonly text: string
  readonly imageCount: number
  readonly images: readonly ImageBlock[]
}

const stubDeps = (signal: AbortSignal): SessionDeps =>
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
  }) satisfies SessionDeps

const probeAssembleConfig =
  (out: TurnProbe[]): ((m: Message[]) => AgentConfig) =>
  (messages) => {
    const last = messages.at(-1)
    const blocks = (last?.content as ContentBlock[] | undefined) ?? []
    const text = blocks.find((block) => block.type === "text")
    const images = blocks.filter((block): block is ImageBlock => block.type === "image")
    out.push({
      text: text?.type === "text" ? text.text : "",
      imageCount: images.length,
      images,
    })
    throw new ProbeDone()
  }

describe("@/runner/orchestrate runOnce multi-modal payload", () => {
  test("normalizePromptPayload is a pure widening", () => {
    expect(normalizePromptPayload("hi")).toEqual({ text: "hi", images: [] })
    expect(normalizePromptPayload({ text: "x" })).toEqual({ text: "x", images: [] })
    expect(normalizePromptPayload({ text: "y", images: [PNG] })).toEqual({
      text: "y",
      images: [PNG],
    })
  })

  test("runOnce accepts a PromptPayload directly", async () => {
    const abort = new AbortController()
    const probes: TurnProbe[] = []

    try {
      await runOnce({
        deps: stubDeps(abort.signal),
        assembleConfig: probeAssembleConfig(probes),
        history: [],
        prompt: { text: "one-shot", images: [PNG] },
        state: undefined,
        idMeta: undefined,
      })
    } catch (error) {
      if (!(error instanceof ProbeDone)) throw error
    }

    expect(probes).toHaveLength(1)
    expect(probes[0]?.text).toBe("one-shot")
    expect(probes[0]?.imageCount).toBe(1)
    expect(probes[0]?.images[0]?.mediaType).toBe("image/png")
  })

  test("runOnce concatenates pendingImages with payload images", async () => {
    const abort = new AbortController()
    const probes: TurnProbe[] = []

    try {
      await runOnce({
        deps: stubDeps(abort.signal),
        assembleConfig: probeAssembleConfig(probes),
        history: [],
        prompt: { text: "one-shot", images: [JPG] },
        pendingImages: [PNG],
        state: undefined,
        idMeta: undefined,
      })
    } catch (error) {
      if (!(error instanceof ProbeDone)) throw error
    }

    expect(probes).toHaveLength(1)
    expect(probes[0]?.imageCount).toBe(2)
    expect(probes[0]?.images[0]?.mediaType).toBe("image/png")
    expect(probes[0]?.images[1]?.mediaType).toBe("image/jpeg")
  })
})
