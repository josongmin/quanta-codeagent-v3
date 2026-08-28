/**
 * ★ HELLGATE — every surface reports the model that will actually RUN (aug-28).
 *
 * `config.llm.model` is the BOOT model: the port the composition root minted at
 * session start. Once `/model` and the web `set_model` frame became real per-turn
 * swaps (aug-27), two producers kept publishing the boot model forever:
 *
 *   1. `SessionHost.describe().modelSlug` — and it is not a debug field. It is the
 *      value the attach pill renders (`[session · <model>]`), the SDK exposes as
 *      `session.model`, and the web `/state` + `/status` readouts print. So after a
 *      switch, FOUR user-facing surfaces named a model the loop was not running,
 *      while the CLI picker (reading the store) named the right one.
 *   2. `emitWorkMetrics` — the turn's token/cost rollup was tagged
 *      `cfg.llm.model`, and `cfg` there is the loop's BASE config (the swap lives
 *      on the per-turn `turnLlm`). A switched session's entire spend was therefore
 *      attributed to a model that never ran — the kind of wrong that is worse than
 *      missing, because it looks like data.
 *
 * The fix is ONE authority (`@/agent/effective-model#effectiveModelOf`) over a
 * value the SURFACE publishes on the store slot, read straight off the store with
 * the same key the pick was written under.
 *
 * RED-on-injection (each restored immediately):
 *   - `context-binding.ts` → `{ modelSlug: base.llm.model }` ⇒ §1/§2 RED.
 *   - `session-resources.ts` → `collector.finalize(cfg.llm.model)` ⇒ §4 RED.
 *   - `effectiveModelOf` → `cfg.llm.model` ⇒ every non-control case RED.
 */

import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { effectiveModelOf } from "@/agent/effective-model"
import { emitWorkMetrics } from "@/agent/session-resources"
import { inMemoryStickyModelStore, stickyModelKeyOf } from "@/agent/sticky-model"
import { renderAttachModelPill } from "@/apps/cli/attach/render"
import { createRuntimeContextBindingFromAgentConfigBase } from "@/host/runtime/internal/context-binding"
import type { RuntimeAgentConfigBase } from "@/sdk/runtime/base"
import { ToolRegistry } from "@/tool"

/** A store holding one pick, plus the sync cell the surface publishes — i.e. the
 *  exact pair the CLI's `runtime-compose` and the web's `agent-config-base` build. */
const switchedSlot = (pick: string) => {
  const store = inMemoryStickyModelStore({
    [stickyModelKeyOf({ mode: "default", provider: "openai" })]: pick,
  })
  return {
    store,
    provider: "openai",
    effectiveModel: (): string | undefined => store.peek({ mode: "default", provider: "openai" }),
  }
}

const baseWith = (slot?: ReturnType<typeof switchedSlot>): RuntimeAgentConfigBase =>
  ({
    llm: { model: "boot-model" } as never,
    registry: new ToolRegistry([]),
    stream: { emit: () => undefined },
    permission: { mode: "default" } as never,
    system: "system",
    cwd: "/tmp/test",
    maxTurns: 5,
    signal: new AbortController().signal,
    ...(slot !== undefined ? { stickyModelStore: slot } : {}),
  }) as unknown as RuntimeAgentConfigBase

const describeOf = async (base: RuntimeAgentConfigBase) =>
  (
    await createRuntimeContextBindingFromAgentConfigBase({ base })
      .createRuntimeHost({
        history: [],
        state: undefined,
        idMeta: undefined,
        shutdown: async () => undefined,
      })
      .createSessionHost({})
  ).describe()

describe("the effective model is what every surface reports", () => {
  test("1. the REAL host projection names the PICK, not the boot model", async () => {
    const d = await describeOf(baseWith(switchedSlot("gpt-4o")))
    expect(d.modelSlug).toBe("gpt-4o")
  })

  test("2. …and the attach pill (which renders that projection) shows it", async () => {
    const d = await describeOf(baseWith(switchedSlot("gpt-4o")))
    expect(renderAttachModelPill(d.modelSlug)).toBe("[session · gpt-4o]\n")
  })

  test("3. paired control — NO switch wired ⇒ the boot model, byte-identical to before", async () => {
    const d = await describeOf(baseWith())
    expect(d.modelSlug).toBe("boot-model")
    expect(renderAttachModelPill(d.modelSlug)).toBe("[session · boot-model]\n")
  })

  test("4. work metrics are tagged with the model that RAN (cost attribution)", () => {
    let seen: string | undefined = "unset"
    const cfg = {
      ...baseWith(switchedSlot("gpt-4o")),
      workMetricsSink: {
        emit: (m: { readonly model?: string }) => {
          seen = m.model
        },
      },
    } as unknown as AgentConfig
    emitWorkMetrics(
      cfg,
      { finalize: (model?: string) => ({ model }) } as never,
      "turn-1",
      "completed",
    )
    expect(seen).toBe("gpt-4o")
  })

  test("4b. paired control — no switch ⇒ tagged with the boot model", () => {
    let seen: string | undefined = "unset"
    const cfg = {
      ...baseWith(),
      workMetricsSink: {
        emit: (m: { readonly model?: string }) => {
          seen = m.model
        },
      },
    } as unknown as AgentConfig
    emitWorkMetrics(
      cfg,
      { finalize: (model?: string) => ({ model }) } as never,
      "turn-1",
      "completed",
    )
    expect(seen).toBe("boot-model")
  })

  test("5. the SSOT degrades honestly: absent getter, empty answer, and no slot", () => {
    expect(effectiveModelOf({ llm: { model: "boot" } })).toBe("boot")
    expect(effectiveModelOf({ llm: { model: "boot" }, stickyModelStore: {} })).toBe("boot")
    // An empty string is "no preference", not a model name — it must never win, or
    // the pill would render `[session · ]`.
    expect(
      effectiveModelOf({ llm: { model: "boot" }, stickyModelStore: { effectiveModel: () => "" } }),
    ).toBe("boot")
    expect(
      effectiveModelOf({ llm: { model: "boot" }, stickyModelStore: { effectiveModel: () => "x" } }),
    ).toBe("x")
  })

  test("6. the sync cell tracks a LATER pick (it is a store read, not a boot snapshot)", () => {
    const slot = switchedSlot("gpt-4o")
    expect(effectiveModelOf({ llm: { model: "boot-model" }, stickyModelStore: slot })).toBe(
      "gpt-4o",
    )
    // A pick written after the slot was published (what `set_model` / `/model` do).
    void slot.store.set({ mode: "default", provider: "openai", modelId: "gpt-5.6-terra" })
    expect(effectiveModelOf({ llm: { model: "boot-model" }, stickyModelStore: slot })).toBe(
      "gpt-5.6-terra",
    )
  })
})
