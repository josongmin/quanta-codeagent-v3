/**
 * Hellgate — `emitPromptAssembled` reports a WINDOW-RELATIVE `max` (jun-7 D4).
 *
 * The `onPromptAssembled` snapshot's `max` changed from a hardcoded `0` to
 * `resolveModelWindow(activeModel)?.contextWindow ?? 0`, so the usage gauge is
 * relative to the model that will ACTUALLY process the turn (sticky/skill swap),
 * not a constant 0. This pins:
 *   - a known model id ⇒ `max === its contextWindow` AND `model === activeModel`;
 *   - the swapped `activeModel` (not the base `config.llm`) drives BOTH fields;
 *   - an un-tabled model ⇒ `max === 0` (the "unknown window" sentinel);
 *   - the default `activeModel` falls back to `config.llm`'s model.
 *
 * Red-on-injection: revert `max` to a literal `0` and the known-model + base
 * cases go red; revert `activeModel` to `config.llm` and the swap case goes red.
 *
 * Hermetic: a minimal hand-built `config` + `ctx`; no env, no real loop.
 */

import { describe, expect, test } from "bun:test"
import type { PromptAssembledSnapshot } from "@/agent/context/usage-breakdown"
import { emitPromptAssembled } from "@/agent/loop/context-assembler"
import type { AgentConfig } from "@/agent/types"

// Minimal turn-context stub — `emitPromptAssembled` reads only `ctx.system` and
// `ctx.promptPolicy.{systemLayout,repoRulesPresent,sessionCtxPresent,userAppendPresent}`.
const fakeCtx = () =>
  ({
    system: [{ type: "text", text: "sys" }],
    promptPolicy: {
      systemLayout: "single_block",
      repoRulesPresent: false,
      sessionCtxPresent: false,
      userAppendPresent: false,
    },
  }) as unknown as Parameters<typeof emitPromptAssembled>[1]

const port = (model: string) => ({ model }) as unknown as AgentConfig["llm"]

const capturingConfig = (
  baseModel: string,
  sink: (s: PromptAssembledSnapshot) => void,
): AgentConfig =>
  ({
    llm: port(baseModel),
    onPromptAssembled: sink,
    stream: { emit: () => {} },
  }) as unknown as AgentConfig

describe("emitPromptAssembled — window-relative max", () => {
  test("known model id ⇒ max === its contextWindow AND model === activeModel", () => {
    let snap: PromptAssembledSnapshot | undefined
    const config = capturingConfig("claude-opus-4-8", (s) => {
      snap = s
    })
    emitPromptAssembled(config, fakeCtx(), "claude-opus-4-8")
    expect(snap?.max).toBe(200_000) // claude-opus-4-8 contextWindow
    expect(snap?.model).toBe("claude-opus-4-8")
  })

  test("the SWAPPED activeModel (1M sonnet) drives max + model, not the base config.llm", () => {
    let snap: PromptAssembledSnapshot | undefined
    // Base is opus-200k, but the active turn model is the 1M sticky/skill swap.
    const config = capturingConfig("claude-opus-4-8", (s) => {
      snap = s
    })
    emitPromptAssembled(config, fakeCtx(), "claude-sonnet-4-6-1m")
    expect(snap?.max).toBe(1_000_000) // the ACTIVE model's window, not 200k
    expect(snap?.model).toBe("claude-sonnet-4-6-1m")
    expect(snap?.max).not.toBe(200_000) // would equal base if it read config.llm
  })

  test("un-tabled / unknown model ⇒ max === 0 (the 'unknown window' sentinel)", () => {
    let snap: PromptAssembledSnapshot | undefined
    const config = capturingConfig("claude-opus-4-8", (s) => {
      snap = s
    })
    emitPromptAssembled(config, fakeCtx(), "totally-made-up-model-xyz")
    expect(snap?.max).toBe(0)
    expect(snap?.model).toBe("totally-made-up-model-xyz")
  })

  test("default activeModel falls back to config.llm's model", () => {
    let snap: PromptAssembledSnapshot | undefined
    const config = capturingConfig("claude-sonnet-4-6-1m", (s) => {
      snap = s
    })
    emitPromptAssembled(config, fakeCtx()) // no explicit activeModel
    expect(snap?.model).toBe("claude-sonnet-4-6-1m")
    expect(snap?.max).toBe(1_000_000)
  })

  test("no onPromptAssembled hook ⇒ no-op (does not throw)", () => {
    const config = { llm: port("claude-opus-4-8") } as unknown as AgentConfig
    expect(() => emitPromptAssembled(config, fakeCtx(), "claude-opus-4-8")).not.toThrow()
  })
})
