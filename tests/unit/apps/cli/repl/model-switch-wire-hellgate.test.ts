/**
 * Hellgate — `/model` end-to-end wiring on the INTERACTIVE CLI surface (aug-27).
 *
 * The defect this pins was three stacked half-wires, each invisible to the
 * existing per-unit tests (they all hand-built the very slot under test):
 *
 *   D1 the CLI's runtime overlay never carried `stickyModelStore`, so
 *      `mutable-wires` read `runtimeContext.stickyModelStore()` → `undefined` →
 *      `buildModelAdapterWire` returned `{}` → the `model` slot was omitted from
 *      the live slash context → `/model` printed "not wired in this surface".
 *      (`resolveStickyModelStore`'s in-memory default lives on the HEADLESS
 *      composition root, which the interactive REPL does not run through.)
 *   D2 the candidate set came from `QUANTA_RETRY_MODELS` alone (unset by
 *      default), so the picker offered only the boot model and `pickModel`
 *      rejected every other id — it could list, never pick.
 *   D3 the interactive CLI never set `AgentConfig.modelCandidates`, which is
 *      where `skill-gate#resolveSkillTurnOverride` resolves a picked id to a
 *      PORT. So even a stored pick was a SILENT no-op on this surface.
 *
 * Each case drives the REAL composition root (`composeSurfaceWires`) through its
 * REAL dispatcher (`wires.dispatchSlash`, the same closure the REPL calls, which
 * is where the `model` slot is installed) and reads the CONSUME side through the
 * real loop helpers. So a revert of any one wire goes red here:
 *   - surface-owned store dropped ⇒ case D1 sees "not wired in this surface";
 *   - catalog probe dropped       ⇒ case D2 cannot pick the probed model;
 *   - `modelCandidates` dropped   ⇒ case D3's port swap falls back to base.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentConfig } from "@/agent"
import { defaultConversationCheckpointStore } from "@/agent/conversation-checkpoint"
import { readStickyModelForMode, resolveSkillTurnOverride } from "@/agent/loop/skill-gate"
import { createSurfaceState } from "@/apps/cli/repl/surface-compose"
import { composeSurfaceWires } from "@/apps/cli/repl/surface-compose/composer"
import { buildLiveSlashContext, restampWhyModel } from "@/apps/cli/repl/surface-compose/dispatch"
import type { LLMPort } from "@/llm"
import { makeFakeLlm, makeFakeSessionSetup } from "../_cli-fakes"

/** Env the cases compose with:
 *  - a provider key so `tryCreateLLM("openai", …)` can actually BUILD a port for
 *    a probed slug (a slug with no buildable port is dropped by contract — the
 *    last case is that paired control);
 *  - `QUANTA_CONFIG_DIR` pointing at a scratch home, because the surface's
 *    sticky-model store is now PERSISTENT: without this the `/model` sets below
 *    would write into the DEVELOPER's real `~/.quanta/sticky-model.json` and
 *    later runs would read their pick back (a self-inflicted flake).
 */
/** Scratch homes this file created, removed in `afterEach`. A leaked `mkdtempSync`
 *  dir per case is not free: measured ~150 dirs per full run of these suites, and
 *  `/private/tmp` at 36k entries is what makes `ls /tmp` time out (a documented
 *  hazard in this repo). */
const scratchDirs: string[] = []
const scratchHome = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratchDirs.push(dir)
  return dir
}
afterEach(() => {
  while (scratchDirs.length > 0) {
    const d = scratchDirs.pop()
    if (d !== undefined) rmSync(d, { recursive: true, force: true })
  }
})

const ENV_WITH_KEY = (): NodeJS.ProcessEnv => ({
  OPENAI_API_KEY: "sk-test-not-used",
  QUANTA_CONFIG_DIR: scratchHome("model-switch-home-"),
})

const compose = (opts?: {
  readonly env?: NodeJS.ProcessEnv
  readonly listModels?: () => Promise<readonly string[]>
}) => {
  const llm: LLMPort = makeFakeLlm({
    model: "test-model",
    ...(opts?.listModels !== undefined ? { listModels: opts.listModels } : {}),
  })
  const setup = makeFakeSessionSetup({ llm })
  const state = createSurfaceState({ imageQueue: undefined, rewindState: undefined, history: [] })
  const wires = composeSurfaceWires(setup, state, opts?.env ?? ENV_WITH_KEY(), {
    convStore: defaultConversationCheckpointStore(),
  })
  // The live dispatcher hardcodes `out`/`err` to the process streams (that IS
  // the production wiring), so capture them around the call rather than
  // substituting a hand-made context — which is how D1 hid for so long.
  const dispatch = async (line: string): Promise<{ out: string; err: string }> => {
    let out = ""
    let err = ""
    const realOut = process.stdout.write.bind(process.stdout)
    const realErr = process.stderr.write.bind(process.stderr)
    process.stdout.write = ((s: string) => {
      out += String(s)
      return true
    }) as typeof process.stdout.write
    process.stderr.write = ((s: string) => {
      err += String(s)
      return true
    }) as typeof process.stderr.write
    try {
      expect(await wires.dispatchSlash(line)).toBe(true)
    } finally {
      process.stdout.write = realOut
      process.stderr.write = realErr
    }
    return { out, err }
  }
  return {
    setup,
    wires,
    dispatch,
    /** The ids the PICKER offers, read off the live slash context the real
     *  dispatcher builds (not off a hand-made slot). */
    ctxModelIds: (): readonly string[] => (wires.modelAdapter?.candidates() ?? []).map((m) => m.id),
  }
}

/** The per-turn `AgentConfig` fields the loop's model-swap helpers read, taken
 *  from the SAME compose output the runtime threads onto the per-turn base.
 *  Nothing is re-minted here — that is the point: a hand-built config would pass
 *  while the real surface stayed unwired. */
const loopConfig = (wires: ReturnType<typeof compose>["wires"], baseLlm: LLMPort): AgentConfig =>
  ({
    llm: baseLlm,
    stickyModelStore: wires.runtimeFacadeCompose.stickyModelStore,
    modelCandidates: wires.runtimeFacadeCompose.modelCandidates,
  }) as unknown as AgentConfig

describe("`/model` on the interactive CLI surface — full wire (aug-27)", () => {
  test("D1: the composed surface wires the slot — `/model` LISTS instead of printing not-wired", async () => {
    const h = compose()
    const { out, err } = await h.dispatch("/model")
    expect(out).not.toContain("not wired in this surface")
    expect(err).toBe("")
    // The boot model is listed and MARKED as current.
    expect(out).toContain("🎛️  model: test-model")
    expect(out).toContain(" * test-model")
  })

  test("D2: candidates come from the provider's LIVE catalog, so a probed model is pickable", async () => {
    const h = compose({ listModels: async () => ["test-model", "gpt-4o"] })

    // `gpt-4o` is in NO env knob — the only way it can be picked is the probe
    // the command awaits before resolving the id.
    const set = await h.dispatch("/model gpt-4o")
    expect(set.err).toBe("")
    expect(set.out).toContain("🎛️  model: gpt-4o")

    // …and the listing now offers both, with the pick marked current.
    const list = await h.dispatch("/model")
    expect(list.out).toContain(" * gpt-4o")
    expect(list.out).toContain("test-model")
  })

  test("D3: the pick reaches the LOOP — sticky read returns it AND it resolves to that model's PORT", async () => {
    const h = compose({ listModels: async () => ["test-model", "gpt-4o"] })
    await h.dispatch("/model gpt-4o")

    const base = makeFakeLlm({ model: "test-model" })
    const cfg = loopConfig(h.wires, base)

    // Leg 1 — the per-turn sticky read (`stream-consume` runs this every turn).
    expect(await readStickyModelForMode(cfg)).toBe("gpt-4o")

    // Leg 2 — the id resolves to a DIFFERENT port than the base. Without
    // `modelCandidates` this silently falls back to `cfg.llm` (the D3 no-op).
    const resolved = resolveSkillTurnOverride(cfg, undefined, "gpt-4o")
    expect(resolved.llm).not.toBe(base)
    expect(resolved.llm.model).toBe("gpt-4o")
  })

  test("no split-brain: every id the picker offers is RUNNABLE — a candidate port, or the boot model", async () => {
    const h = compose({ listModels: async () => ["test-model", "gpt-4o"] })
    const { out } = await h.dispatch("/model")
    const offered = h.ctxModelIds()
    const loopSide = (h.wires.runtimeFacadeCompose.modelCandidates ?? []).map((c) => c.id)

    // INVARIANT A (aug-28): the BOOT model deliberately has NO candidate port — it
    // resolves by falling through to `config.llm`, the real fully-decorated session
    // port. Minting a second port for it would swap a no-op pick onto a
    // differently-wrapped object. So the loop-side list is the offered list MINUS
    // the boot model, and every offered id is still runnable.
    expect(offered).toEqual(["test-model", "gpt-4o"])
    expect(loopSide).toEqual(["gpt-4o"])
    for (const id of offered) {
      expect(out).toContain(id)
      const runnable = id === "test-model" || loopSide.includes(id)
      expect(runnable, `${id} is offered but nothing can run it`).toBe(true)
    }
  })

  test("the `/why` header follows the pick (no stale model claim in the panel)", async () => {
    const h = compose({ listModels: async () => ["test-model", "gpt-4o"] })
    await h.dispatch("/model gpt-4o")
    // `/why`'s header model is a STRING captured at compose time (the boot
    // model). The live context re-stamps it per dispatch via `restampWhyModel`,
    // which is asserted at the seam: the rendered panel only appears for a
    // session that recorded tool calls, and this harness records none (`/why
    // last` exits with "no tool calls found").
    // The COMPOSED context still carries the boot model (a compose-time string)…
    expect(h.wires.slashCtx.why?.model).toBe("test-model")
    // …and the context the DISPATCHER builds — the one every command actually gets
    // — carries the pick, because `buildLiveSlashContext` re-stamps it per
    // dispatch. Asserting through the real builder is what makes deleting the
    // `restampWhyModel(...)` call site RED (a local re-implementation would not).
    const live = buildLiveSlashContext({
      sessionCwd: h.setup.cwd,
      slashCtx: h.wires.slashCtx,
      sessionIo: h.wires.sessionIo,
      inboundMode: h.wires.inboundMode,
      ...(h.wires.modelAdapter !== undefined ? { modelAdapter: h.wires.modelAdapter } : {}),
    } as never)
    expect(live.why?.model).toBe("gpt-4o")
    expect(live.model).toBeDefined() // the `/model` slot is installed by the same builder

    // Paired controls on the pure fragment: either half absent ⇒ untouched.
    expect(restampWhyModel(h.wires.slashCtx.why, undefined)).toEqual({})
    expect(restampWhyModel(undefined, { current: () => "gpt-4o" })).toEqual({})
    // …and the rendered panel is still reachable (no tool calls in this harness).
    expect((await h.dispatch("/why last")).out).toContain("no tool calls found")
  })

  test("a REJECTED catalog probe degrades: the seeded candidate still lists, and the degrade is SAID", async () => {
    const h = compose({
      listModels: async () => {
        throw new Error("401 unauthorized")
      },
    })
    const { out, err } = await h.dispatch("/model")
    // The listing still works…
    expect(out).toContain(" * test-model")
    expect(out).not.toContain("gpt-4o")
    // …and the operator is TOLD the list may be short, rather than being handed a
    // silently truncated menu (the probe warns once — the wire memoizes it).
    expect(err).toContain("candidate list may be incomplete")
    expect(err).not.toContain("/model:") // not a command error
  })

  test("paired control — a probed slug with NO buildable port is never offered", async () => {
    // No provider key ⇒ `tryCreateLLM("openai", …)` returns null ⇒ the slug is
    // DROPPED rather than listed-then-silently-ignored on the consume side,
    // which is the exact silent-failure shape this wire exists to remove.
    const h = compose({
      env: { QUANTA_CONFIG_DIR: scratchHome("model-switch-home-") },
      listModels: async () => ["test-model", "gpt-4o"],
    })
    const list = await h.dispatch("/model")
    expect(list.out).not.toContain("gpt-4o")
    const set = await h.dispatch("/model gpt-4o")
    expect(set.err).toContain("unknown model 'gpt-4o'")
  })

  // MEMBERSHIP GUARD — the compose slots are only READ by
  // `applyRuntimeFacadeComposeOptions`, which iterates the module-private
  // `PASS_THROUGH_COMPOSE_KEYS`. Drop either key from that list and the chain
  // goes INERT (the surface hands the slots down, the per-turn config never
  // receives them) while every case above stays green — the exact
  // "wired-looking feature that reaches nothing" shape. Same pattern as
  // `goal-compose-wiring-hellgate.test.ts`.
  test("drift-guard: PASS_THROUGH_COMPOSE_KEYS still routes both model slots (else inert)", async () => {
    const { PASS_THROUGH_COMPOSE_KEYS } = await import("@/sdk/runtime/context")
    expect([...PASS_THROUGH_COMPOSE_KEYS]).toContain("stickyModelStore")
    expect([...PASS_THROUGH_COMPOSE_KEYS]).toContain("modelCandidates")
  })

  // …and the per-key op that membership triggers must SURVIVE the immutable
  // patch → snapshot rebuild, which needs the key in `RuntimeContextPatch`'s
  // Pick (+ `buildOptionalSnapshotFields` for the read-back).
  test("drift-guard: a modelCandidates patch survives the snapshot rebuild (same instance)", async () => {
    const { createRuntimeContextBindingFromAgentConfigBase } = await import(
      "@/host/runtime/internal/context-binding"
    )
    const candidates = [{ id: "gpt-4o", port: makeFakeLlm({ model: "gpt-4o" }) }]
    const base = {
      llm: makeFakeLlm(),
      permission: { mode: "default" },
      registry: { all: () => [], has: () => false },
      messages: [],
    } as unknown as Parameters<typeof createRuntimeContextBindingFromAgentConfigBase>[0]["base"]
    const binding = createRuntimeContextBindingFromAgentConfigBase({ base })
    expect(binding.snapshot.modelCandidates).toBeUndefined() // paired control
    expect(binding.patch({ modelCandidates: candidates }).snapshot.modelCandidates).toBe(candidates)
  })

  // aug-28 — the sticky slot grew two fields the SURFACE publishes (`provider`,
  // `effectiveModel`). Every hop between the surface and the loop/`describe()`
  // passes the slot as a WHOLE OBJECT today, but a hop that re-built it as
  // `{ store }` — which `resolveStickyModelStore` on the headless path literally
  // does — would type-check and silently drop both: the read key would fall back
  // to `config.llm.provider` and every display would revert to the boot model.
  // Pin object IDENTITY through the patch→snapshot rebuild, which is where such a
  // re-build would have to happen.
  test("drift-guard: the sticky slot's provider + effectiveModel survive the rebuild", async () => {
    const { createRuntimeContextBindingFromAgentConfigBase } = await import(
      "@/host/runtime/internal/context-binding"
    )
    const { inMemoryStickyModelStore, stickyModelKeyOf } = await import("@/agent/sticky-model")
    const { effectiveModelOf } = await import("@/agent/effective-model")
    const store = inMemoryStickyModelStore({
      [stickyModelKeyOf({ mode: "default", provider: "openai" })]: "gpt-4o",
    })
    const slot = {
      store,
      provider: "openai",
      effectiveModel: (): string | undefined => store.peek({ mode: "default", provider: "openai" }),
    }
    const base = {
      llm: makeFakeLlm({ model: "boot-model" }),
      permission: { mode: "default" },
      registry: { all: () => [], has: () => false },
      messages: [],
    } as unknown as Parameters<typeof createRuntimeContextBindingFromAgentConfigBase>[0]["base"]
    const binding = createRuntimeContextBindingFromAgentConfigBase({ base })
    expect(binding.snapshot.stickyModelStore).toBeUndefined() // paired control
    const next = binding.patch({ stickyModelStore: slot }).snapshot
    expect(next.stickyModelStore).toBe(slot) // same object ⇒ no field can be lost
    // …and the value the projection would publish is the PICK, not the boot model.
    expect(effectiveModelOf({ llm: { model: "boot-model" }, ...next })).toBe("gpt-4o")
  })
})
