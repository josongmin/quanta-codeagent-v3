/**
 * ★ HELLGATE (MR-09) — REAL host → REAL kernel → REAL readout, for the model echo.
 *
 * The audit's remaining wiring gap: every existing guard on this chain drove ONE
 * link with the others hand-built. `effective-model-projection-hellgate` builds a
 * base by hand and calls the real `describe()`; `session-model-echo-staleness`
 * drives the real kernel with a hand-written host. Nothing ran the composed host
 * INTO the kernel and out through the readout renderer — which is the path a user
 * actually sees (`/state`'s `model` row, and the same `SessionStateView` the attach
 * pill and the SDK's `session.model` read).
 *
 * A break anywhere in the middle — a slot dropped at the binding, a projection that
 * forgot the field, a renderer reading the wrong key — would leave both existing
 * guards green.
 *
 * RED-on-injection: revert `context-binding.ts` to `base.llm.model`, or drop
 * `modelSlug` from `toSessionStateView` ⇒ case 1 reds.
 */

import { describe, expect, test } from "bun:test"
import { inMemoryStickyModelStore, stickyModelKeyOf } from "@/agent/sticky-model"
import { renderReadout } from "@/apps/web-daemon/readout"
import { createRuntimeContextBindingFromAgentConfigBase } from "@/host/runtime/internal/context-binding"
import { createKernelSessionState, toSessionStateView } from "@/kernel/session"
import type { LLMPort } from "@/llm"
import type { RuntimeAgentConfigBase } from "@/sdk/runtime/base"
import { ToolRegistry } from "@/tool"

const port = (model: string): LLMPort => ({ model }) as unknown as LLMPort

/** A base whose SESSION has selected `gpt-4o` while its boot port is `boot-model`
 *  — the shape every root produces after a pick. */
const baseWithSelection = (selected?: string): RuntimeAgentConfigBase => {
  const store = inMemoryStickyModelStore(
    selected === undefined
      ? {}
      : { [stickyModelKeyOf({ mode: "default", provider: "openai" })]: selected },
  )
  return {
    llm: port("boot-model"),
    registry: new ToolRegistry([]),
    stream: { emit: () => undefined },
    permission: { mode: "default" },
    system: "system",
    cwd: "/tmp/model-echo-e2e",
    maxTurns: 5,
    signal: new AbortController().signal,
    ...(selected === undefined
      ? {}
      : {
          stickyModelStore: {
            store,
            provider: "openai",
            effectiveModel: () => store.peek({ mode: "default", provider: "openai" }),
          },
        }),
  } as unknown as RuntimeAgentConfigBase
}

/** Compose the REAL host, seed the REAL kernel state from its REAL `describe()`,
 *  project the REAL state view, and render the REAL `/state` readout body. */
const chain = async (base: RuntimeAgentConfigBase): Promise<string> => {
  const host = await createRuntimeContextBindingFromAgentConfigBase({ base })
    .createRuntimeHost({
      history: [],
      state: undefined,
      idMeta: undefined,
      shutdown: async () => undefined,
    })
    .createSessionHost({})
  const kernelState = createKernelSessionState(host.describe())
  const view = toSessionStateView(kernelState)
  const result = renderReadout("state", { state: view } as never)
  return result.output
}

describe("MR-09 · the model echo survives host → kernel → readout", () => {
  test("1. a SELECTED model reaches the rendered `/state` body", async () => {
    const body = await chain(baseWithSelection("gpt-4o"))
    expect(body).toContain("gpt-4o")
    // …and the boot model is NOT what the row names.
    expect(body).not.toMatch(/model\s+boot-model/)
  })

  test("2. paired control — NO selection ⇒ the boot model, unchanged", async () => {
    const body = await chain(baseWithSelection())
    expect(body).toMatch(/model\s+boot-model/)
  })
})
