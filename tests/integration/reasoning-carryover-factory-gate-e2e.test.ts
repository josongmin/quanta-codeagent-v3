import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createLLM } from "@/llm"
import type { StreamEvent } from "@/llm"

/**
 * REAL FACTORY-GATE e2e for `reasoning-carryover` (QUANTA_REASONING_CARRYOVER,
 * H15 / OpenAI-Responses).
 *
 * Prior coverage (`tests/unit/reasoning-carryover-live-e2e-hellgate.test.ts`)
 * drives the real `OpenAIResponsesAdapter` but CONSTRUCTS it directly with
 * `reasoningCarryover: true` — it never proves the ENV gate
 * `QUANTA_REASONING_CARRYOVER` actually flows through the REAL factory
 * (`createLLM` → `resolveReasoningCarryover(env)` → adapter). This battery
 * closes that: the adapter is built by the REAL `createLLM` with ONLY the env
 * knob, then driven across two turns; the encrypted reasoning captured on turn-1
 * must re-appear on turn-2's OUTBOUND request body (observed off a monkeypatched
 * global fetch — the real bytes the SDK-less adapter POSTs).
 *
 *   ON  (env QUANTA_REASONING_CARRYOVER=1) ⇒ turn-2 body leads with turn-1's
 *        encrypted reasoning + include:["reasoning.encrypted_content"] + store:false
 *   OFF (env unset — paired control)        ⇒ turn-2 body carries NO reasoning
 *        item and NO include (dropped) — RED if the factory armed carry-over
 *        without the env gate.
 */

const CIPHER = "ENC_CARRY_T1"

const sseResponse = (chunks: readonly string[]): Response => {
  const enc = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c))
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })
}

const turn1Chunks = (cipher: string): readonly string[] => [
  'data: {"type":"response.output_text.delta","delta":"answer"}\n\n',
  `data: {"type":"response.output_item.done","item":{"type":"reasoning","id":"rs_t1","encrypted_content":"${cipher}"}}\n\n`,
  'data: {"type":"response.output_item.done","item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hello","annotations":[]}]}}\n\n',
  'data: {"type":"response.completed","response":{"id":"resp_t1","model":"gpt-5","usage":{"input_tokens":1,"output_tokens":5,"output_tokens_details":{"reasoning_tokens":3}}}}\n\n',
  "data: [DONE]\n\n",
]

const turn2Chunks = (): readonly string[] => [
  'data: {"type":"response.output_item.done","item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done","annotations":[]}]}}\n\n',
  'data: {"type":"response.completed","response":{"id":"resp_t2","model":"gpt-5","usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
  "data: [DONE]\n\n",
]

const turn1Input = () => ({
  messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "step 1" }] }],
  tools: [],
  promptCacheKey: "lane",
})
const turn2Input = () => ({
  messages: [
    { role: "user" as const, content: [{ type: "text" as const, text: "step 1" }] },
    { role: "assistant" as const, content: [{ type: "text" as const, text: "hello" }] },
    { role: "user" as const, content: [{ type: "text" as const, text: "step 2" }] },
  ],
  tools: [],
  promptCacheKey: "lane",
})

const collect = async (stream: AsyncIterable<StreamEvent>): Promise<void> => {
  for await (const _ of stream) {
    // drain
  }
}

/** Drive two turns of a factory-built adapter behind a recording global fetch;
 *  return the outbound request bodies. */
const driveTwoTurns = async (
  env: Record<string, string | undefined>,
): Promise<Record<string, unknown>[]> => {
  const bodies: Record<string, unknown>[] = []
  const orig = globalThis.fetch
  let call = 0
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>)
    call += 1
    return sseResponse(call === 1 ? turn1Chunks(CIPHER) : turn2Chunks())
  }) as unknown as typeof fetch
  try {
    const adapter = createLLM(
      "openai",
      { model: "gpt-5" },
      { OPENAI_API_KEY: "sk-test", QUANTA_OPENAI_SURFACE: "responses", ...env },
    )
    // Sanity: the factory really picked the Responses surface (the carry-over path).
    expect(adapter.constructor.name).toBe("OpenAIResponsesAdapter")
    await collect(adapter.stream(turn1Input()))
    await collect(adapter.stream(turn2Input()))
  } finally {
    globalThis.fetch = orig
  }
  return bodies
}

type Item = { type: string; encrypted_content?: string }

describe("reasoning-carryover — real factory ENV gate ⇒ carry-over on the wire", () => {
  const orig = process.env.QUANTA_REASONING_CARRYOVER
  beforeEach(() => {
    delete process.env.QUANTA_REASONING_CARRYOVER
  })
  afterEach(() => {
    if (orig === undefined) delete process.env.QUANTA_REASONING_CARRYOVER
    else process.env.QUANTA_REASONING_CARRYOVER = orig
  })

  test("ON: env gate ⇒ turn-2 outbound body re-emits turn-1 encrypted reasoning", async () => {
    // The gate is passed via the factory `env` arg (createLLM reads env, not
    // process.env) — the exact SSOT `resolveReasoningCarryover` consumes.
    const bodies = await driveTwoTurns({ QUANTA_REASONING_CARRYOVER: "1" })
    expect(bodies).toHaveLength(2)
    const t2 = bodies[1]
    const items = t2?.input as Item[]
    expect(items[0]).toEqual({ type: "reasoning", id: "rs_t1", encrypted_content: CIPHER } as never)
    expect(t2?.include).toEqual(["reasoning.encrypted_content"])
    expect(t2?.store).toBe(false)
    // turn-1 itself never re-emits prior reasoning (store started empty).
    expect(bodies[0]?.include).toBeUndefined()
  })

  // ── PAIRED CONTROL (env unset) ────────────────────────────────────────────
  // Factory built with NO carry-over env ⇒ turn-2 carries no reasoning item and
  // no include. RED if the factory armed carry-over unconditionally / read the
  // wrong env key.
  test("CONTROL: env unset ⇒ turn-2 body drops the reasoning (no carry-over)", async () => {
    const bodies = await driveTwoTurns({})
    expect(bodies).toHaveLength(2)
    const t2 = bodies[1]
    const items = t2?.input as Item[]
    expect(items.some((i) => i.type === "reasoning")).toBe(false)
    expect(t2?.include).toBeUndefined()
  })

  test("ON vs OFF turn-2 bodies DIFFER exactly by the carried reasoning + include", async () => {
    const on = await driveTwoTurns({ QUANTA_REASONING_CARRYOVER: "1" })
    const off = await driveTwoTurns({})
    expect(JSON.stringify(on[1])).not.toBe(JSON.stringify(off[1]))
    expect((on[1]?.input as Item[]).some((i) => i.type === "reasoning")).toBe(true)
    expect((off[1]?.input as Item[]).some((i) => i.type === "reasoning")).toBe(false)
  })
})
