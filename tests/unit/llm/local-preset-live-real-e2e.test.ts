/**
 * REAL local-OSS LLM e2e (opt-in) — RFC05-3 D2 LIVE streaming tool-call smoke.
 *
 * Drives the REAL `OpenAIAdapter` against a locally-running Ollama
 * `/v1/chat/completions` and asserts streaming text OR a structured tool-call
 * plus a finish reason flow through the SAME Chat adapter with NO new grammar
 * (RFC05-3 DoD: "config sugar, no runtime branch").
 *
 * OPT-IN (`bun run test:real-toolchain`), the same lane as the other
 * `*-real-e2e.test.ts` files, because its cost is a REAL LLM INFERENCE and is
 * therefore unbounded relative to machine load. Measured on one machine, same
 * test, same model (`llama3.1:8b`), across a single afternoon:
 *
 *     7.4s   alone, idle
 *    11.1s   inside `bun test tests/unit`
 *    33.4s   inside `bun test tests/unit`, busier
 *    59.3s   alone, busy
 *   151.4s   inside `bun test tests/integration`, busy  ⇒ RED (its own 160s cap)
 *
 * No suite-level timeout can be both honest and stable against that spread, and
 * the per-test unit speed budget (`tools/dev/unit-speed-budget.json`, 8,529ms)
 * cannot be met by any of those numbers. Relocating it between the blocking
 * suites only moves which gate flakes — the repo's existing answer for
 * "real-toolchain e2e too environment-dependent to block" is this lane, so that
 * is where it goes.
 *
 * Still HONEST, not disabled: without the env it is a VISIBLE bun skip (never a
 * faked pass), and inside the lane a missing server is reported with the reason.
 * The DETERMINISTIC preset-sugar half stays in the always-on suite at
 * `tests/unit/llm/local-preset-smoke-hellgate.test.ts`.
 */

import { beforeAll, expect, test } from "bun:test"
import { OpenAIAdapter } from "@/llm/adapters/openai"
import type { StreamEvent } from "@/llm/types"
import {
  assertCapabilityNotBlocked,
  capabilityGate,
  hasBinary,
  laneDescribe,
  reportCapability,
} from "../../_helpers/capability-lane"

const GROUP = "local-model"
const FILE = "tests/unit/llm/local-preset-live-real-e2e.test.ts"

const OLLAMA_BASE = "http://127.0.0.1:11434/v1"
const OLLAMA_TAGS = "http://127.0.0.1:11434/api/tags"

/**
 * TYPED CAPABILITY RESULT, replacing a literal `expect(true).toBe(true)`.
 *
 * The previous body printed "documented no-server outcome, not a pass" and then
 * asserted `true`, so bun reported `1 pass`, the junit carried a passing case,
 * and `test:real-toolchain` printed the same green a host that really ran a
 * 150s inference prints. The prose was the only place the truth lived.
 *
 * Now: no server ⇒ `blocked-missing` (RED when this group is REQUIRED, a
 * VISIBLE bun skip otherwise); lane not selected ⇒ `skipped-unsupported`.
 * Neither is ever a passing assertion.
 */
const GATE = capabilityGate({
  group: GROUP,
  file: FILE,
  // `ollama` on PATH is the cheapest bounded evidence the daemon could be up;
  // whether it ANSWERS is settled by the bounded HTTP probe in beforeAll,
  // because a CLI's inode is not a running server.
  needs: { ollama: hasBinary("ollama") },
})

/** Probe the local Ollama server. Returns a model name that exists, or null. */
const probeOllama = async (): Promise<string | null> => {
  try {
    const res = await fetch(OLLAMA_TAGS, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return null
    const body = (await res.json()) as { models?: { name?: string }[] }
    const names = (body.models ?? []).map((m) => m.name).filter((n): n is string => !!n)
    // Prefer a model with reliable native tool-call streaming (llama3.1 family).
    return names.find((n) => n.startsWith("llama3.1")) ?? names[0] ?? null
  } catch {
    return null
  }
}

const collect = async (it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> => {
  const out: StreamEvent[] = []
  for await (const ev of it) out.push(ev)
  return out
}

/** Resolved once, in a bounded setup step — never at module load. */
let liveModel: string | null = null

laneDescribe(GATE)("RFC05-3 LIVE Ollama streaming tool-call smoke (honest reachability)", () => {
  beforeAll(async () => {
    liveModel = await probeOllama()
    if (liveModel !== null) return
    // The lane WAS selected and the binary IS present, but the daemon does
    // not answer. That is `blocked-missing`, and in a REQUIRED job it is the
    // finding — not a reason to assert `true`.
    const blocked = {
      ...GATE,
      available: false,
      outcome: "blocked-missing",
      detail: `no local Ollama server answered ${OLLAMA_TAGS} within 3s`,
    } as const
    reportCapability({ group: GROUP, file: FILE, outcome: blocked.outcome, detail: blocked.detail })
    assertCapabilityNotBlocked({ group: GROUP, file: FILE }, blocked)
  })

  test("real Ollama /v1/chat/completions streams text or a structured tool-call through the Chat adapter", async () => {
    const model = liveModel
    if (model === null) {
      // Reached only when this group is NOT required: beforeAll already
      // reported `blocked-missing`. Fail the case rather than pass it — a
      // capability lane that was SELECTED and could not run has not proven
      // anything, and `test:real-toolchain` must not print green over it.
      throw new Error(
        `[capability] ${GROUP} blocked-missing in ${FILE}: no local Ollama server reachable at ` +
          `${OLLAMA_BASE}. Start \`ollama serve\` or deselect this group; an unreachable live ` +
          "model is not a pass.",
      )
    }
    reportCapability({
      group: GROUP,
      file: FILE,
      outcome: "executed",
      detail: "live Ollama reachable",
      receipt: { ollamaBaseUrl: OLLAMA_BASE, ollamaModel: model },
    })
    // The REAL Chat adapter — no fake client. Ollama ignores the placeholder key.
    const adapter = new OpenAIAdapter({
      apiKey: "ollama-local-no-auth",
      model,
      baseURL: OLLAMA_BASE,
      streamFirstChunkMs: 120_000,
      streamIdleMs: 120_000,
    })
    const events = await collect(
      adapter.stream({
        system: "You are a helpful assistant. When asked the time, call get_time.",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "What time is it in Tokyo? Use the get_time tool." }],
          },
        ],
        tools: [
          {
            name: "get_time",
            description: "Return the current time for a city",
            input_schema: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
        ],
        signal: AbortSignal.timeout(150_000),
      }),
    )
    const kinds = new Set(events.map((e) => e.type))
    // The stream MUST terminate with a message_stop (finish reason mapped).
    expect(kinds.has("message_stop")).toBe(true)
    // And it MUST carry model output — either streamed text OR a structured
    // tool-call round-trip (tool_use_end). A local model may choose either; both
    // prove the Chat adapter decoded the real Ollama SSE grammar with NO new
    // adapter (RFC05-3 DoD: "config sugar, no runtime branch").
    const hadText = events.some((e) => e.type === "text_delta")
    const hadToolCall = events.some((e) => e.type === "tool_use_end")
    expect(hadText || hadToolCall).toBe(true)
    reportCapability({
      group: GROUP,
      file: FILE,
      outcome: "executed",
      detail: `live smoke completed — events=${events.length} kinds=${[...kinds].join(",")}`,
      receipt: {
        ollamaBaseUrl: OLLAMA_BASE,
        ollamaModel: model,
        streamedText: String(hadText),
        streamedToolCall: String(hadToolCall),
      },
    })
  }, 160_000)
})
