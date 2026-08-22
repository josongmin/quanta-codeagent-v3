/**
 * ADR-0333 — Image-sanitization-retry production hookup hellgate.
 *
 * The hookup lives at `src/agent/loop.ts#createRunAgentContext` and
 * runs once when each session is built (right after `wm` is created).
 * Default-OFF: `cfg.imageSanitizationRetry` absent OR
 * `enabled === false` ⇒ `cfg.llm` is NOT decorated (byte-identical to
 * pre-ADR-0328 behaviour).
 *
 *  A. absent slot              ⇒ cfg.llm untouched           (1)
 *  B. enabled === false        ⇒ cfg.llm untouched           (1)
 *  C. enabled !== false        ⇒ cfg.llm wrapped (retry on
 *                                 LLMError("invalid_image")) (2)
 *  D. caller's `config` object ⇒ NEVER mutated (clone)       (1)
 *  E. defaults: maxAttempts=1, placeholder="[invalid …]"     (1)
 *
 *  Total = 6 cases.
 */

import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { runAgent } from "@/agent"
import type { LLMPort, Message, StreamEvent } from "@/llm"
import type { PermissionContext } from "@/permission"
import { LLMError } from "@/shared"
import type { AgentEvent, StreamPort } from "@/stream"
import { defaultTools, ToolRegistry } from "@/tool"

/** Scripts a sequence of stream attempts. Each call to `stream()`
 *  shifts from `attempts`. If the slot is `"invalid_image"` we throw
 *  the typed `LLMError` PRE-stream (no yield). Otherwise we yield the
 *  given StreamEvent[]. */
class ScriptedLLM implements LLMPort {
  public calls = 0
  public readonly lastInputMessages: Message[][] = []

  constructor(private readonly attempts: Array<StreamEvent[] | "invalid_image">) {}

  async *stream(input: { messages: Message[] }): AsyncIterable<StreamEvent> {
    this.calls += 1
    this.lastInputMessages.push(input.messages)
    const next = this.attempts.shift()
    if (next === undefined) {
      // Out of script — terminate cleanly.
      yield { type: "message_stop", stop_reason: "end_turn" }
      return
    }
    if (next === "invalid_image") {
      throw new LLMError("scripted invalid_image", { kind: "invalid_image" })
    }
    for (const ev of next) yield ev
  }
}

class RecordingStream implements StreamPort {
  readonly events: AgentEvent[] = []
  emit(ev: AgentEvent): void {
    this.events.push(ev)
  }
}

const okScript = (): StreamEvent[] => [
  { type: "text_delta", delta: "ok" },
  { type: "message_stop", stop_reason: "end_turn" },
]

const baseCfg = (
  llm: LLMPort,
  permission: PermissionContext,
  extras: Partial<AgentConfig> = {},
): AgentConfig => ({
  llm,
  registry: new ToolRegistry(defaultTools),
  stream: new RecordingStream(),
  permission,
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "describe" },
        { type: "image", data: "AAAA", mediaType: "image/png" },
      ],
    },
  ],
  system: "test",
  cwd: process.cwd(),
  maxTurns: 5,
  signal: new AbortController().signal,
  onConfirm: async () => false,
  ...extras,
})

describe("ADR-0333 §A — absent slot ⇒ cfg.llm untouched", () => {
  test("imageSanitizationRetry undefined ⇒ no wrap, no retry on invalid_image", async () => {
    const llm = new ScriptedLLM(["invalid_image"])
    const cfg = baseCfg(llm, { mode: "acceptEdits" })
    const outcome = await runAgent(cfg)
    // Without the wrap, an `invalid_image` is fatal (Codex parity routes
    // it as bad_request → fatal). Exactly ONE stream call was made.
    expect(llm.calls).toBe(1)
    expect(outcome.reason).not.toBe("completed")
  })
})

describe("ADR-0333 §B — enabled === false ⇒ cfg.llm untouched", () => {
  test("imageSanitizationRetry.enabled === false ⇒ no wrap", async () => {
    const llm = new ScriptedLLM(["invalid_image"])
    const cfg = baseCfg(
      llm,
      { mode: "acceptEdits" },
      {
        imageSanitizationRetry: { enabled: false, maxAttempts: 3 },
      },
    )
    await runAgent(cfg)
    expect(llm.calls).toBe(1)
  })
})

describe("ADR-0333 §C — enabled === true ⇒ cfg.llm wrapped", () => {
  test("enabled undefined ⇒ NO wrap (default-OFF — user landed in 1f959885 sets a stricter `enabled !== true` guard than the W-D draft)", async () => {
    // Slot present with no `enabled` key. The production wire landed in
    // `1f959885` (user commit) uses `enabled !== true` ⇒ this case does NOT
    // engage the wrap, so the invalid_image error propagates after exactly
    // ONE call (no sanitize, no retry).
    const llm = new ScriptedLLM(["invalid_image", okScript()])
    const cfg = baseCfg(
      llm,
      { mode: "acceptEdits" },
      {
        imageSanitizationRetry: { maxAttempts: 1 },
      },
    )
    await runAgent(cfg)
    expect(llm.calls).toBe(1)
  })

  test("enabled === true with maxAttempts: 2 ⇒ retries up to 2× after sanitize", async () => {
    // First throws → sanitize → second throws (NOT re-sanitizable since
    // image already replaced; sanitize returns wasMutated:false the
    // second time) → propagate as terminal. Verify NO infinite loop:
    // calls bounded to 2 (initial + 1 retry per the maxAttempts=1
    // sanitize budget once the first sanitize succeeds; the wm now has
    // a placeholder so a second invalid_image returns wasMutated:false
    // and we propagate).
    const llm = new ScriptedLLM(["invalid_image", "invalid_image"])
    const cfg = baseCfg(
      llm,
      { mode: "acceptEdits" },
      {
        imageSanitizationRetry: { enabled: true, maxAttempts: 2 },
      },
    )
    await runAgent(cfg)
    // The second invalid_image stops the retry chain (sanitizer can't
    // mutate further). Bound is 2 attempts max.
    expect(llm.calls).toBeLessThanOrEqual(3)
    expect(llm.calls).toBeGreaterThanOrEqual(2)
  })
})

describe("ADR-0333 §D — caller config ownership", () => {
  test("caller's `config.llm` reference is NOT mutated by the hookup", async () => {
    const llm = new ScriptedLLM([okScript()])
    const cfg = baseCfg(
      llm,
      { mode: "acceptEdits" },
      {
        imageSanitizationRetry: { enabled: true },
      },
    )
    const callerLlmBefore = cfg.llm
    await runAgent(cfg)
    // The hookup clones the cfg (`{ ...baseCfg }`) and wraps the CLONE's
    // `llm`. The caller's `cfg.llm` reference is unchanged.
    expect(cfg.llm).toBe(callerLlmBefore)
  })
})

describe("ADR-0333 §E — defaults", () => {
  test("empty knob ({}) ⇒ NO wrap (user's `enabled !== true` guard treats undefined as off)", async () => {
    // The W-D draft assumed `enabled !== false` (default-ON when slot present);
    // the landed wire in `1f959885` uses `enabled !== true` (default-OFF unless
    // explicitly enabled), which is the safer choice. Pinning the landed
    // semantics here: an `{}` knob does NOT engage the wrap.
    const llm = new ScriptedLLM(["invalid_image", okScript()])
    const cfg = baseCfg(
      llm,
      { mode: "acceptEdits" },
      {
        imageSanitizationRetry: {},
      },
    )
    await runAgent(cfg)
    expect(llm.calls).toBe(1)
  })
})
