import { describe, expect, test } from "bun:test"
import { resolveActiveModelId } from "@/agent/loop/skill-gate"
import type { AgentConfig } from "@/agent/types"

/**
 * D4 (jun-7 naive-impl hardening) — the compaction window threshold MUST track
 * the model that will ACTUALLY process the turn, not the base `config.llm`.
 *
 * A session can swap model mid-stream via a per-mode STICKY model (`/sticky-model`)
 * or a SKILL `model:` override. `prepareTurnContext` (compaction) runs BEFORE
 * `streamConsume` resolves the swap, and `config.llm` still names the BASE model,
 * so deriving the threshold from `config.llm` re-introduces the model-blind bug
 * D4 fixed: base opus (200k) + sticky sonnet-1m would compact at ~155k instead of
 * ~923k (845k of window wasted); the inverse overflows. `resolveActiveModelId`
 * mirrors the stream-side model pick (`override.model ?? sticky ?? base`).
 *
 * Red-on-injection: revert `prepareTurnContext` to `configuredModel(config.llm)`
 * and the threshold reverts to the base model's window.
 */

const port = (model: string) => ({ model }) as unknown as AgentConfig["llm"]

const baseConfig = (opts: {
  baseModel: string
  sticky?: string
  candidates?: string[]
}): AgentConfig =>
  ({
    llm: port(opts.baseModel),
    modelCandidates: (opts.candidates ?? []).map((id) => ({ id, port: port(id) })),
    stickyModelStore:
      opts.sticky !== undefined
        ? {
            store: {
              get: () => opts.sticky,
              peek: () => opts.sticky,
              set: () => {},
              unset: () => {},
              clear: () => {},
            },
          }
        : undefined,
    mode: "default",
  }) as unknown as AgentConfig

describe("resolveActiveModelId — compaction tracks the per-turn swapped model (D4)", () => {
  test("sticky model wins over the base config.llm", async () => {
    const config = baseConfig({
      baseModel: "claude-opus-4-8",
      sticky: "claude-sonnet-4-6-1m",
      candidates: ["claude-sonnet-4-6-1m"],
    })
    expect(await resolveActiveModelId(config, undefined)).toBe("claude-sonnet-4-6-1m")
  })

  test("a skill `model:` override beats the sticky model", async () => {
    const config = baseConfig({
      baseModel: "claude-opus-4-8",
      sticky: "claude-sonnet-4-6-1m",
      candidates: ["claude-sonnet-4-6-1m", "gpt-5"],
    })
    expect(await resolveActiveModelId(config, { model: "gpt-5" })).toBe("gpt-5")
  })

  test("no sticky + no override ⇒ base model (byte-identical legacy)", async () => {
    const config = baseConfig({ baseModel: "claude-opus-4-8" })
    expect(await resolveActiveModelId(config, undefined)).toBe("claude-opus-4-8")
  })

  test("a sticky id with no matching candidate port falls back to the base model", async () => {
    const config = baseConfig({ baseModel: "claude-opus-4-8", sticky: "ghost-model" })
    expect(await resolveActiveModelId(config, undefined)).toBe("claude-opus-4-8")
  })

  test("INTEGRATION: the resolved active model drives a DIFFERENT threshold than base", async () => {
    const { resolveCompactionLimitTokens } = await import("@/agent/compaction")
    // base opus-200k threshold vs the sticky sonnet-1m threshold — they MUST differ
    // (this is the whole point: the active model, not the base, sets the ceiling).
    const opus = resolveCompactionLimitTokens(undefined, "claude-opus-4-8") // 200k window
    const oneM = resolveCompactionLimitTokens(undefined, "claude-sonnet-4-6-1m") // 1M window
    expect(oneM).toBeGreaterThan(opus)
    expect(oneM).toBeGreaterThan(900_000) // ~1M − 64k − 13k
    expect(opus).toBeLessThan(200_000)
  })
})
