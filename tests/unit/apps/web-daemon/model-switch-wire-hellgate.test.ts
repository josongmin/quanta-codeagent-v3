/**
 * ★ HELLGATE — web-daemon `set_model` is a REAL effect (aug-27).
 *
 * The control-request channel shipped with `set_permission_mode` load-bearing and
 * `set_model` an explicit observability-only ECHO: the port's own doc said "no
 * live model-swap cell on the daemon today". So a browser/IDE client could send
 * the frame, watch it acknowledged, and keep talking to the old model — the
 * "promised but the runtime does not keep it" shape.
 *
 * This pins the closed loop with the REAL collaborators, end to end:
 *   frame string → `peekControlRequest` (connection decode) → `enqueue` on the
 *   REAL `createWebControlRequestPort` → `drainControlRequests` (REAL loop drain +
 *   REAL pure planner) → the applier PERSISTS through the sticky store → the
 *   LOOP's own `readStickyModelForMode` reads it back and
 *   `resolveSkillTurnOverride` resolves it to that model's PORT.
 *
 * Invariants (each red on injection):
 *   1. LANDS — the pick reaches the store AND resolves to a different port than
 *      the base one (drop `applyModel` ⇒ the store never sees it; drop the base
 *      `modelCandidates` ⇒ the swap silently falls back to the boot model).
 *   2. LIVE ALLOWLIST — an id discovered by the LAZY catalog probe is accepted
 *      after the probe (a mint-time array snapshot would reject it forever).
 *   3. FAIL-CLOSED — an off-catalog id is REJECTED and nothing is written.
 *   4. NO-THROW — a failing store write cannot derail the drain.
 *   5. READ HALF — the `/model` readout lists exactly what `set_model` accepts.
 *
 * Hermetic: `QUANTA_CONFIG_DIR` points the sticky store at a scratch dir, so no
 * case touches the developer's `~/.quanta/sticky-model.json`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentConfig } from "@/agent"
import { drainControlRequests } from "@/agent/control-request"
import { readStickyModelForMode, resolveSkillTurnOverride } from "@/agent/loop/skill-gate"
import { createCanvasUsageSource } from "@/apps/web-daemon/canvas-usage-source"
import { peekControlRequest } from "@/apps/web-daemon/control-request-frame"
import { resolveReadout } from "@/apps/web-daemon/readout"
import { buildInteractiveTurnAssembler } from "@/apps/web-daemon/runtime-factory"
import { buildAgentConfigBase } from "@/apps/web-daemon/runtime-factory/agent-config-base"
import { buildReadoutSources } from "@/apps/web-daemon/runtime-factory/readout-sources"
import {
  mintInboundPorts,
  resolveWebLivePosture,
} from "@/apps/web-daemon/runtime-factory/session-collaborators"
import { wireSessionObservability } from "@/apps/web-daemon/runtime-factory/session-observability"
import { createWebControlRequestPort } from "@/apps/web-daemon/web-control-request-port"
import { createWebModelSwitch, renderWebModelReadout } from "@/apps/web-daemon/web-model-switch"
import type { LLMPort } from "@/llm"
import type { PermissionContext } from "@/permission"

const frame = (request: unknown): string => JSON.stringify({ kind: "controlRequest", request })

const liveCell = (): PermissionContext => {
  let mode: PermissionContext["mode"] = "default"
  return {
    get mode() {
      return mode
    },
    set mode(next) {
      mode = next
    },
  } as unknown as PermissionContext
}

/** The daemon's boot port, optionally exposing a provider catalog. */
const bootPort = (listModels?: () => Promise<readonly string[]>): LLMPort => ({
  model: "boot-model",
  stream: async function* () {
    yield { type: "message_stop", stop_reason: "end_turn" } as never
  },
  ...(listModels !== undefined ? { listModels } : {}),
})

/** A per-case scratch Quanta home. The switch resolves its store path from the
 *  env bag it is HANDED (`stickyModelPathFrom`), so no case has to mutate
 *  `process.env` — which is what made this suite order-dependent while the path
 *  came from the frozen global runtime config. */
let home = ""
/** Every scratch dir this file made (including the paired-control ones), removed
 *  after each case — a leaked `mkdtempSync` per case is a measured hazard here. */
const scratchDirs: string[] = []
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "web-model-home-"))
  scratchDirs.push(home)
})
afterEach(() => {
  while (scratchDirs.length > 0) {
    const d = scratchDirs.pop()
    if (d !== undefined) rmSync(d, { recursive: true, force: true })
  }
})

const wire = (
  listModels?: () => Promise<readonly string[]>,
  opts?: { readonly configDir?: string },
) => {
  const env = {
    PATH: process.env.PATH,
    OPENAI_API_KEY: "sk-test-not-used",
    QUANTA_CONFIG_DIR: opts?.configDir ?? home,
  } as Record<string, string | undefined>
  const llm = bootPort(listModels)
  const modelSwitch = createWebModelSwitch({ env, provider: "openai", llm })
  const handle = createWebControlRequestPort({
    permission: liveCell(),
    applyModel: modelSwitch.applyModel,
    modelAllowlist: () => modelSwitch.ids(),
  })
  /** The per-turn `AgentConfig` slice the base carries for this surface. */
  const cfg = {
    llm,
    // Mirrors the daemon base: the slot carries the PROVIDER half of the key.
    stickyModelStore: { store: modelSwitch.store, provider: modelSwitch.provider },
    modelCandidates: modelSwitch.candidates,
  } as unknown as AgentConfig
  const send = async (request: unknown): ReturnType<typeof drainControlRequests> => {
    const decoded = peekControlRequest(frame(request))
    if (decoded === null) throw new Error("frame did not decode")
    handle.enqueue(decoded)
    return await drainControlRequests(handle.port, handle.context, handle.applier)
  }
  return { env, llm, modelSwitch, handle, cfg, send }
}

/** The store write is FIRE-AND-FORGET by contract (the control-effect applier is
 *  sync and must not throw), so the assertion polls for the observable effect
 *  instead of sleeping a guessed interval — `write-file-atomic` does mkdir + tmp
 *  write + rename, which under load blows past any fixed delay. */
const untilSticky = async (
  cfg: AgentConfig,
  expected: string,
  timeoutMs = 3000,
): Promise<string | undefined> => {
  const deadline = Date.now() + timeoutMs
  let seen = await readStickyModelForMode(cfg)
  while (seen !== expected && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10))
    seen = await readStickyModelForMode(cfg)
  }
  return seen
}

/** For the NEGATIVE claims (nothing was persisted): wait a bounded interval and
 *  assert the store is STILL empty, so a slow write cannot pass by arriving late. */
const settle = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 200))
}

/** The web base builder with only the slots this proof needs (mirrors
 *  `goal-attempt-slot-base.test.ts`'s harness). */
const buildWebBase = async (
  env: Record<string, string | undefined>,
  llm: LLMPort,
  modelSwitch?: ReturnType<typeof createWebModelSwitch>,
) =>
  await buildAgentConfigBase({
    env,
    llm,
    artifactRegistry: undefined,
    askUserTools: [],
    mcpTools: [],
    permission: (await resolveWebLivePosture(env)).permission,
    cwd: "/tmp/quanta-web-model-switch",
    abort: new AbortController(),
    subagent: undefined,
    skills: undefined,
    planStore: undefined,
    usageHolder: createCanvasUsageSource(),
    canvasToolDiff: undefined,
    agentState: undefined,
    subagentSource: undefined,
    userInput: undefined,
    controlRequest: undefined,
    follower: undefined,
    observability: wireSessionObservability(env, "/tmp/quanta-web-model-switch", undefined),
    ...(modelSwitch !== undefined ? { modelSwitch } : {}),
  })

describe("web-daemon set_model — the effect LANDS (aug-27)", () => {
  // The FACTORY leg. `modelSwitch` is an OPTIONAL builder arg, so forgetting to
  // pass it at the call site type-checks fine and silently leaves the loop with
  // no sticky store and no candidates — exactly the inert-wire shape this whole
  // campaign is about. This pins the slots ONTO the base, with the paired control.
  test("0: the per-turn base carries BOTH slots when the switch is composed", async () => {
    const w = wire(async () => ["boot-model", "gpt-4o"])
    const base = (await buildWebBase(w.env, w.llm, w.modelSwitch)) as {
      stickyModelStore?: { store: unknown }
      modelCandidates?: readonly { id: string }[]
    }
    expect(base.stickyModelStore?.store).toBe(w.modelSwitch.store)
    expect(base.modelCandidates).toBe(w.modelSwitch.candidates)

    const without = (await buildWebBase(w.env, w.llm)) as {
      stickyModelStore?: unknown
      modelCandidates?: unknown
    }
    expect(without.stickyModelStore).toBeUndefined() // paired control
    expect(without.modelCandidates).toBeUndefined()
  })

  test("1: frame → drain → sticky store → the LOOP resolves the picked model's PORT", async () => {
    const w = wire(async () => ["boot-model", "gpt-4o"])
    await w.modelSwitch.refresh() // the /model readout's probe (lazy in prod)

    const effects = await w.send({ kind: "set_model", model: "gpt-4o" })
    expect(effects).toEqual([{ kind: "model-set", model: "gpt-4o" }])
    // The store — the SAME file+instance the loop reads.
    expect(await untilSticky(w.cfg, "gpt-4o")).toBe("gpt-4o")
    // The on-disk key is PROVIDER-scoped (`<provider>:<mode>`): a model id only
    // means anything for its own provider, so an anthropic pick must not be read
    // back by an openai session. The bare `default` key is the legacy shape.
    expect(JSON.parse(readFileSync(join(home, "sticky-model.json"), "utf8"))).toEqual({
      "openai:default": "gpt-4o",
    })

    // …and the swap: a DIFFERENT port than the base one (the D3-class proof).
    const resolved = resolveSkillTurnOverride(w.cfg, undefined, "gpt-4o")
    expect(resolved.llm).not.toBe(w.llm)
    expect(resolved.llm.model).toBe("gpt-4o")
  })

  test("0b: the ASSEMBLED per-turn config carries them too (base → turnAssembler hop)", async () => {
    // The base is only half the story: the runtime hands it to the per-turn
    // assembler, and THAT output is what the loop reads. This is the one hop the
    // live measurement on the CLI covers and the web cannot (no LLM-driven web
    // loop here), so pin it with the daemon's OWN assembler export (the one that
    // supplies the env view — the shared `@/host/runtime` one takes it as an arg).
    const w = wire(async () => ["boot-model", "gpt-4o"])
    const base = await buildWebBase(w.env, w.llm, w.modelSwitch)
    const cfg = buildInteractiveTurnAssembler()([], base as never) as unknown as {
      stickyModelStore?: { store: unknown }
      modelCandidates?: readonly { id: string }[]
    }
    expect(cfg.stickyModelStore?.store).toBe(w.modelSwitch.store)
    expect(cfg.modelCandidates).toBe(w.modelSwitch.candidates)
  })

  test("0c: the PRODUCER wires it — `mintInboundPorts` hands the switch to the control port", async () => {
    // Every other case here builds `createWebControlRequestPort({applyModel, …})`
    // BY HAND, so dropping the third argument at the real producer
    // (`mintInboundPorts`, called from `runtime-factory.ts`) would revert
    // `set_model` to the echo-only no-op with every case still green. This drives
    // the producer.
    const w = wire(async () => ["boot-model", "gpt-4o"])
    await w.modelSwitch.refresh()
    const { controlRequest } = mintInboundPorts(
      { ...w.env, QUANTA_CONTROL_REQUEST: "1" },
      liveCell(),
      w.modelSwitch,
    )
    expect(controlRequest).toBeDefined()
    if (controlRequest === undefined) throw new Error("control port not minted")

    const decoded = peekControlRequest(frame({ kind: "set_model", model: "gpt-4o" }))
    if (decoded === null) throw new Error("decode")
    controlRequest.enqueue(decoded)
    const effects = await drainControlRequests(
      controlRequest.port,
      controlRequest.context,
      controlRequest.applier,
    )
    expect(effects).toEqual([{ kind: "model-set", model: "gpt-4o" }])
    expect(await untilSticky(w.cfg, "gpt-4o")).toBe("gpt-4o")

    // PAIRED CONTROL — no switch passed ⇒ the port is minted WITHOUT the apply leg,
    // so the same frame is an echo-only no-op (the pre-aug-27 behavior).
    // A FRESH config dir: the session-scoped store seeds from the boot snapshot, so
    // reusing this case's dir would show the pick the positive half just persisted.
    const w2 = wire(async () => ["boot-model", "gpt-4o"], {
      configDir: ((): string => {
        const d = mkdtempSync(join(tmpdir(), "web-model-control-"))
        scratchDirs.push(d)
        return d
      })(),
    })
    const bare = mintInboundPorts({ ...w2.env, QUANTA_CONTROL_REQUEST: "1" }, liveCell())
    await w2.modelSwitch.refresh()
    const d2 = peekControlRequest(frame({ kind: "set_model", model: "gpt-4o" }))
    if (d2 === null || bare.controlRequest === undefined) throw new Error("decode/mint")
    bare.controlRequest.enqueue(d2)
    await drainControlRequests(
      bare.controlRequest.port,
      bare.controlRequest.context,
      bare.controlRequest.applier,
    )
    await settle()
    expect(await readStickyModelForMode(w2.cfg)).toBeUndefined()
  })

  test("2: LIVE allowlist — a model discovered by the lazy probe is accepted (not frozen at mint)", async () => {
    const w = wire(async () => ["boot-model", "gpt-4o"])
    // BEFORE the probe the id is off-list: fail-closed, nothing written.
    expect((await w.send({ kind: "set_model", model: "gpt-4o" }))[0]?.kind).toBe("rejected")
    await settle()
    expect(await readStickyModelForMode(w.cfg)).toBeUndefined()

    // AFTER the probe the SAME port instance accepts it — the context reads the
    // candidate ids per drain instead of copying them at mint time.
    await w.modelSwitch.refresh()
    expect((await w.send({ kind: "set_model", model: "gpt-4o" }))[0]?.kind).toBe("model-set")
    expect(await untilSticky(w.cfg, "gpt-4o")).toBe("gpt-4o")
  })

  test("3: FAIL-CLOSED — an off-catalog id is rejected and NOTHING is persisted", async () => {
    const w = wire(async () => ["boot-model"])
    await w.modelSwitch.refresh()
    const effects = await w.send({ kind: "set_model", model: "some-unlisted-model" })
    expect(effects[0]?.kind).toBe("rejected")
    await settle()
    expect(await readStickyModelForMode(w.cfg)).toBeUndefined()
  })

  test("4a: NO-THROW — an UNWRITABLE sticky store degrades to 'not persisted', never a throw", async () => {
    // Make the store path un-creatable the portable way: point the config dir at
    // a path UNDER a regular file, so `mkdir` (and the atomic write) must fail.
    writeFileSync(join(home, "blocker"), "not a directory", "utf8")
    const w = wire(async () => ["boot-model", "gpt-4o"], {
      configDir: join(home, "blocker", "nested"),
    })
    await w.modelSwitch.refresh()
    // The ECHO is OPTIMISTIC and that is deliberate, not an oversight: the applier
    // is SYNC by contract (a throwing applier abandons the whole drain) while the
    // write is async. MR-03 CHANGED THIS: the applier is awaited and returns a
    // typed result, so a refused write is echoed as `rejected` instead of
    // `model-set`. The old comment here recorded the opposite as a deliberate
    // asymmetry — it was deliberate only because a sync applier could not express
    // "not yet", which is exactly what MR-03 removed.
    const effects = await w.send({ kind: "set_model", model: "gpt-4o" })
    expect(effects).toHaveLength(1)
    expect(effects[0]?.kind).toBe("rejected")
    await settle()
    // The pick did NOT persist (honest) — and the surface is still alive.
    expect(await readStickyModelForMode(w.cfg)).toBeUndefined()
    // …and the read half does NOT claim the failed pick.
    expect(
      renderWebModelReadout({ current: await w.modelSwitch.current(), ids: w.modelSwitch.ids() }),
    ).toContain("model  boot-model")
    // The sync cell every readout/`describe()` consumes agrees with the turn.
    expect(w.modelSwitch.effectiveModel()).toBeUndefined()
  })

  test("4c: SPLIT-BRAIN — another process's pick does NOT land mid-session, but DOES next boot", async () => {
    // The store is `sessionScopedStickyModelStore` over the shared file. That is a
    // deliberate trade with two halves, and only pinning BOTH keeps it a design:
    //   - mid-session, this session reads its OWN cell, so a CLI `/model` (or a
    //     second daemon) cannot silently switch the model out from under a running
    //     turn while every display here still names the old one;
    //   - at the NEXT boot the same file is the seed, which is the whole point of
    //     persisting ("one user, one preference" across sessions).
    const dir = mkdtempSync(join(tmpdir(), "web-model-splitbrain-"))
    scratchDirs.push(dir)
    const w = wire(async () => ["boot-model", "gpt-4o"], { configDir: dir })
    await w.modelSwitch.refresh()

    // A FOREIGN write straight to the file — exactly what another surface does.
    writeFileSync(
      join(dir, "sticky-model.json"),
      JSON.stringify({ "openai:default": "gpt-4o" }),
      "utf8",
    )
    await settle()
    // Mid-session: invisible. (A per-turn FILE read — the pre-aug-28 shape — would
    // return "gpt-4o" here and this case would red.)
    expect(await readStickyModelForMode(w.cfg)).toBeUndefined()
    expect(w.modelSwitch.effectiveModel()).toBeUndefined()

    // NEXT session over the SAME file: the pick is adopted at boot.
    const next = wire(async () => ["boot-model", "gpt-4o"], { configDir: dir })
    expect(await readStickyModelForMode(next.cfg)).toBe("gpt-4o")
    expect(next.modelSwitch.effectiveModel()).toBe("gpt-4o")
    // …and its PORT exists without any probe (the eager `extraIds` seed), so turn 1
    // actually runs it instead of falling back.
    const resolved = resolveSkillTurnOverride(next.cfg, undefined, "gpt-4o")
    expect(resolved.llm).not.toBe(next.llm)
    expect(resolved.llm.model).toBe("gpt-4o")
  })

  test("6a: A HOSTILE persisted id never reaches the readouts (MR-02, was raw)", () => {
    // Measured before MR-02: the daemon seeded its session cell from the RAW file,
    // so an ANSI/OSC-laden id came straight back out of `effectiveModel()` — and
    // that value is what `describe().modelSlug` publishes to the `/state` readout,
    // the SDK's `session.model` and the `quanta attach` pill, which renders it
    // UNESCAPED to a terminal.
    const ESC = String.fromCharCode(27)
    const dir = mkdtempSync(join(tmpdir(), "web-model-hostile-"))
    scratchDirs.push(dir)
    writeFileSync(
      join(dir, "sticky-model.json"),
      JSON.stringify({ "openai:default": `${ESC}[2Jevil\nApprove destructive action? [y/N]` }),
      "utf8",
    )
    const w = wire(undefined, { configDir: dir })
    expect(w.modelSwitch.effectiveModel()).toBeUndefined()
    const offered = w.modelSwitch.ids().join("|")
    expect(offered).not.toContain(ESC)
    expect(offered).not.toContain("Approve destructive")
  })

  test("6b: a LEGACY bare-mode pick is both claimed AND runnable (MR-02, was claimed-only)", async () => {
    // The other half of the same seeding bug: reads accepted the legacy bare key
    // but the eager candidate seed read only the SCOPED one, so every display
    // named the pick while the turn ran the boot model. Any user who ran `/model`
    // before the provider joined the key hit this on their first web session.
    const dir = mkdtempSync(join(tmpdir(), "web-model-legacy-"))
    scratchDirs.push(dir)
    writeFileSync(join(dir, "sticky-model.json"), JSON.stringify({ default: "gpt-4o" }), "utf8")
    const w = wire(undefined, { configDir: dir })
    expect(w.modelSwitch.effectiveModel()).toBe("gpt-4o")
    // …and a PORT exists for it, so the loop really runs it.
    expect(w.modelSwitch.ids()).toContain("gpt-4o")
    expect(await readStickyModelForMode(w.cfg)).toBe("gpt-4o")
    const resolved = resolveSkillTurnOverride(w.cfg, undefined, "gpt-4o")
    expect(resolved.llm).not.toBe(w.llm)
    expect(resolved.llm.model).toBe("gpt-4o")
  })

  test("5b: the READ half degrades honestly (no candidates / no effective model)", () => {
    // Both branches are reachable in production: a rejected probe on a provider
    // with no `listModels` leaves the ids empty, and a daemon whose boot port
    // carries no `model` has nothing to name. Neither may render a blank row that
    // reads as "the model is (empty)".
    expect(renderWebModelReadout({ current: "", ids: [] })).toContain("model  (none)")
    expect(renderWebModelReadout({ current: "", ids: [] })).toContain("no candidates")
    const listed = renderWebModelReadout({ current: "gpt-4o", ids: ["boot-model", "gpt-4o"] })
    expect(listed).toContain("* gpt-4o")
    expect(listed).not.toContain("* boot-model")
    expect(listed).toContain("set_model")
  })

  test("4b: NO-THROW — even a SYNCHRONOUSLY throwing applyModel only bails the drain", async () => {
    const handle = createWebControlRequestPort({
      permission: liveCell(),
      applyModel: () => {
        throw new Error("disk on fire")
      },
      modelAllowlist: () => ["gpt-4o"],
    })
    const decoded = peekControlRequest(frame({ kind: "set_model", model: "gpt-4o" }))
    if (decoded === null) throw new Error("decode")
    handle.enqueue(decoded)
    // `drainControlRequests` catches a thrown applier and returns cleanly (it
    // records nothing for that request) — the turn must not die on a control frame.
    // The drain is async now, so "does not throw" is a claim about the PROMISE:
    // a rejected drain would fail this await and the assertion below would not run.
    const applied = await drainControlRequests(handle.port, handle.context, handle.applier)
    expect(applied).toEqual([])
  })

  test("5: READ half — the readout lists exactly what set_model accepts, marking the current", async () => {
    const w = wire(async () => ["boot-model", "gpt-4o"])
    await w.modelSwitch.refresh()
    await w.send({ kind: "set_model", model: "gpt-4o" })
    expect(await untilSticky(w.cfg, "gpt-4o")).toBe("gpt-4o")

    const ids = w.modelSwitch.ids()
    const body = renderWebModelReadout({ current: await w.modelSwitch.current(), ids })
    expect(body).toContain("model  gpt-4o")
    expect(body).toContain("* gpt-4o")
    expect(body).toContain("boot-model")
    // No split-brain: every listed id is one the allowlist admits.
    for (const id of ids) {
      const fresh = wire(async () => ids)
      await fresh.modelSwitch.refresh()
      expect((await fresh.send({ kind: "set_model", model: id }))[0]?.kind).toBe("model-set")
    }
  })

  test("5b: the REAL readout route serves /model through the composed sources", async () => {
    const w = wire(async () => ["boot-model", "gpt-4o"])
    const sources = buildReadoutSources({
      taskRegistry: undefined,
      planStore: undefined,
      skillAuthority: undefined,
      memoryStore: undefined,
      usageHolder: createCanvasUsageSource(),
      modelSwitch: w.modelSwitch,
    })
    const served = await resolveReadout("model", {} as never, sources)
    expect(served.wired).toBe(true)
    expect(served.isError).toBe(false)
    // The route's own probe populated the list (it awaits `refresh()`).
    expect(served.output).toContain("gpt-4o")
    expect(served.output).toContain("* boot-model")

    // Paired control: no switch composed ⇒ honest missing-source copy, wired:false.
    const bare = await resolveReadout(
      "model",
      {} as never,
      buildReadoutSources({
        taskRegistry: undefined,
        planStore: undefined,
        skillAuthority: undefined,
        memoryStore: undefined,
        usageHolder: createCanvasUsageSource(),
      }),
    )
    expect(bare.wired).toBe(false)
    expect(bare.output).toContain("model switch was not composed")
  })
})
