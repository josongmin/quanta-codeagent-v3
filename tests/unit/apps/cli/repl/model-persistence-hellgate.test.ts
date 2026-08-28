/**
 * Hellgate — a `/model` pick SURVIVES the session, coherently (aug-27).
 *
 * Persisting the pick is the easy half. The hard half is that a FRESH session
 * must agree with the file in three places that all run BEFORE the first turn,
 * or the feature becomes a split-brain (which is exactly why this surface used a
 * session-only store before):
 *
 *   A. the loop must be able to RUN the persisted model on turn 1 — it resolves
 *      an id to a PORT out of `AgentConfig.modelCandidates`, and the catalog
 *      probe is LAZY (only `/model` triggers it), so the persisted id needs an
 *      eagerly-built port or the turn silently falls back to the boot model;
 *   B. the `/model` picker + status-line source (`current()`, SYNC) must report
 *      it — they cannot await the async store, hence the boot snapshot seed;
 *   C. the welcome banner must announce it — it renders before the surface
 *      exists, so it goes through the same one resolver.
 *
 * Plus the mode axis: the read must use the SAME derivation as the loop's
 * consume side (`resolveAgentMode(undefined, planMode)`), or a `--plan` session
 * reads the `'default'` key and the pick vanishes.
 *
 * Every case drives the REAL composition root against a HERMETIC
 * `QUANTA_CONFIG_DIR`, so nothing here reads or writes the developer's
 * `~/.quanta/sticky-model.json`.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentConfig } from "@/agent"
import { defaultConversationCheckpointStore } from "@/agent/conversation-checkpoint"
import { readStickyModelForMode, resolveSkillTurnOverride } from "@/agent/loop/skill-gate"
import { readStickyModelSnapshotSync } from "@/agent/sticky-model"
import { paintWelcomeBanner } from "@/apps/cli/repl"
import {
  resolveStickyModelBoot,
  stickyModelFilePath,
  vetPersistedPicks,
  vetRunnablePicks,
} from "@/apps/cli/repl/sticky-model-boot"
import { createSurfaceState } from "@/apps/cli/repl/surface-compose"
import { composeSurfaceWires } from "@/apps/cli/repl/surface-compose/composer"
import { buildWelcomeInfo } from "@/apps/cli/welcome-banner"
import type { LLMPort } from "@/llm"
import { makeFakeLlm, makeFakeSessionSetup } from "../_cli-fakes"

/** A hermetic Quanta home + the env bag every composition here is given. */
/** Scratch homes this file created, removed in `afterEach` (a leaked dir per case
 *  is what pushed `/private/tmp` past 36k entries and made `ls /tmp` time out). */
const scratchDirs: string[] = []
afterEach(() => {
  while (scratchDirs.length > 0) {
    const d = scratchDirs.pop()
    if (d !== undefined) rmSync(d, { recursive: true, force: true })
  }
})

const hermeticHome = (): { readonly dir: string; readonly env: NodeJS.ProcessEnv } => {
  const dir = mkdtempSync(join(tmpdir(), "sticky-persist-"))
  scratchDirs.push(dir)
  return {
    dir,
    // The provider key lets `tryCreateLLM("openai", …)` build a port for the
    // persisted id — case A is about that port existing.
    env: { QUANTA_CONFIG_DIR: dir, OPENAI_API_KEY: "sk-test-not-used" },
  }
}

/** Write a `{ "<provider>:<mode>" → modelId }` file exactly as the store would.
 *  aug-28: the key carries the PROVIDER, because a model id is only meaningful for
 *  its own provider and `tryCreateLLM` validates the credential, not the slug. */
const writePicks = (env: NodeJS.ProcessEnv, picks: Record<string, string>): string => {
  const path = stickyModelFilePath(env)
  writeFileSync(path, JSON.stringify(picks), "utf8")
  return path
}

const compose = (
  env: NodeJS.ProcessEnv,
  opts?: { readonly planMode?: boolean; readonly modelPinnedExplicitly?: boolean },
) => {
  const llm: LLMPort = makeFakeLlm({ model: "boot-model", provider: "openai" })
  const setup = makeFakeSessionSetup({
    llm,
    model: "boot-model",
    ...(opts?.planMode === true ? { planMode: true } : {}),
    ...(opts?.modelPinnedExplicitly === true ? { modelPinnedExplicitly: true } : {}),
  })
  const state = createSurfaceState({ imageQueue: undefined, rewindState: undefined, history: [] })
  const wires = composeSurfaceWires(setup, state, env, {
    convStore: defaultConversationCheckpointStore(),
  })
  const dispatch = async (line: string): Promise<string> => {
    let out = ""
    const real = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((s: string) => {
      out += String(s)
      return true
    }) as typeof process.stdout.write
    try {
      await wires.dispatchSlash(line)
    } finally {
      process.stdout.write = real
    }
    return out
  }
  return { setup, wires, dispatch }
}

/** The loop reads the sticky key as `<provider>:<mode>`, and a real `config.llm`
 *  always carries its provider (every adapter sets it, and `forwardPortIdentity`
 *  preserves it through the decorator chain). The fake must too, or the read key
 *  and the surface's write key diverge — which is the very drift being pinned. */
const loopConfig = (wires: ReturnType<typeof compose>["wires"], baseLlm: LLMPort): AgentConfig =>
  ({
    llm: baseLlm,
    stickyModelStore: wires.runtimeFacadeCompose.stickyModelStore,
    modelCandidates: wires.runtimeFacadeCompose.modelCandidates,
  }) as unknown as AgentConfig

describe("`/model` persistence across sessions (aug-27)", () => {
  test("a `/model` pick is WRITTEN to disk (session 1) — the file the next session reads", async () => {
    const { env } = hermeticHome()
    const s1 = compose(env)
    // `gpt-4o` is reachable because the fake port exposes no catalog: it comes
    // from nowhere, so first prove the write path with the boot model itself.
    await s1.dispatch("/model boot-model")
    const onDisk = JSON.parse(readFileSync(stickyModelFilePath(env), "utf8")) as Record<
      string,
      string
    >
    // PROVIDER-KEYED (aug-28): the same slug under a different provider is a
    // different preference, and must not be read back in the wrong session.
    expect(onDisk).toEqual({ "openai:default": "boot-model" })
  })

  test("A: session 2 can RUN the persisted model on turn 1 — a PORT exists without any /model call", async () => {
    const { env } = hermeticHome()
    writePicks(env, { "openai:default": "gpt-4o" })
    const s2 = compose(env)

    // No `/model` invocation ⇒ no catalog probe. The eager `extraIds` seed is
    // the only reason a port for the persisted id can exist here.
    const ids = (s2.wires.runtimeFacadeCompose.modelCandidates ?? []).map((c) => c.id)
    expect(ids).toContain("gpt-4o")

    const base = makeFakeLlm({ model: "boot-model", provider: "openai" })
    const cfg = loopConfig(s2.wires, base)
    expect(await readStickyModelForMode(cfg)).toBe("gpt-4o")
    const resolved = resolveSkillTurnOverride(cfg, undefined, "gpt-4o")
    expect(resolved.llm).not.toBe(base) // ← the swap, not a silent fallback
    expect(resolved.llm.model).toBe("gpt-4o")
  })

  test("B: session 2's picker marks the persisted model as current (sync `current()` seed)", async () => {
    const { env } = hermeticHome()
    writePicks(env, { "openai:default": "gpt-4o" })
    const out = await compose(env).dispatch("/model")
    expect(out).toContain("🎛️  model: gpt-4o")
    expect(out).toContain(" * gpt-4o")
    expect(out).not.toContain(" * boot-model")
  })

  test("C: the welcome banner announces the persisted model, not the boot model", () => {
    const { env } = hermeticHome()
    writePicks(env, { "openai:default": "gpt-4o" })
    const setup = makeFakeSessionSetup({ model: "boot-model" })
    const effective = resolveStickyModelBoot({
      planMode: false,
      env,
      provider: "openai",
    }).effectiveModel(setup.model)
    expect(effective).toBe("gpt-4o")
    expect(buildWelcomeInfo(setup, undefined, undefined, effective).model).toBe("gpt-4o")
    // Paired control: no override ⇒ the banner is byte-identical to before.
    expect(buildWelcomeInfo(setup, undefined).model).toBe("boot-model")
  })

  test("C2: the BANNER PAINTER paints the resolved effective model (not the boot model)", () => {
    // Case C above calls `buildWelcomeInfo` with an argument the test itself
    // resolved — it cannot catch the painter forgetting to pass it on. This drives
    // `paintWelcomeBanner`, the module the REPL actually calls, and reads the bytes
    // it writes to stderr.
    //
    // aug-28: the RESOLUTION moved up to `setupSession` (`effectiveBootModel`), so
    // three first-paint surfaces share one authority instead of one resolving it and
    // two naming the boot model — measured over a real pty, see
    // `tests/e2e-pty/cli-model-persistence-e2e.test.ts`, which is now the producer
    // leg (a real boot reading a real file). What THIS case owns is the painter's
    // half: it must render the resolved value it was handed.
    const { env } = hermeticHome()
    writePicks(env, { "openai:default": "gpt-4o" })
    const setup = makeFakeSessionSetup({ model: "boot-model", effectiveBootModel: "gpt-4o" })
    // The painter needs a TTY stderr and no one-shot prompt; and it resolves the
    // sticky file through `process.env`, so point that at the scratch home.
    const priorTty = process.stderr.isTTY
    const priorCfg = process.env.QUANTA_CONFIG_DIR
    const priorWrite = process.stderr.write
    let painted = ""
    try {
      Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true })
      process.env.QUANTA_CONFIG_DIR = env.QUANTA_CONFIG_DIR
      process.stderr.write = ((s: string) => {
        painted += String(s)
        return true
      }) as typeof process.stderr.write
      paintWelcomeBanner({ ...setup, stderrIsTTY: true, homeDir: "" } as never)
    } finally {
      process.stderr.write = priorWrite
      Object.defineProperty(process.stderr, "isTTY", { value: priorTty, configurable: true })
      if (priorCfg === undefined) delete process.env.QUANTA_CONFIG_DIR
      else process.env.QUANTA_CONFIG_DIR = priorCfg
    }
    expect(painted).toContain("gpt-4o")
    expect(painted).not.toMatch(/model\s+boot-model/)
  })

  test("the mode axis matches the loop: under --plan the 'plan' key is read, not 'default'", () => {
    const { env } = hermeticHome()
    writePicks(env, { "openai:default": "default-pick", "openai:plan": "plan-pick" })
    expect(resolveStickyModelBoot({ planMode: true, env, provider: "openai" }).modelId).toBe(
      "plan-pick",
    )
    expect(resolveStickyModelBoot({ planMode: false, env, provider: "openai" }).modelId).toBe(
      "default-pick",
    )
  })

  test("PRECEDENCE: an explicit `--model`/QUANTA_MODEL pin beats the persisted pick", async () => {
    // A CI/cron invocation pins the model. The stored preference must NOT win —
    // and the one-shot path paints no banner, so a silent override would be
    // invisible until the bill arrived.
    const { env } = hermeticHome()
    writePicks(env, { "openai:default": "gpt-4o" })

    const pinned = compose(env, { modelPinnedExplicitly: true })
    // Nothing seeds from the file: no candidate port, no sticky read, and the
    // picker/banner report the pinned boot model.
    expect((pinned.wires.runtimeFacadeCompose.modelCandidates ?? []).map((c) => c.id)).toEqual([])
    expect(
      await readStickyModelForMode(loopConfig(pinned.wires, makeFakeLlm({ provider: "openai" }))),
    ).toBeUndefined()
    expect(await pinned.dispatch("/model")).toContain(" * boot-model")

    // PAIRED CONTROL — same file, no pin ⇒ the pick applies (the feature still works).
    const unpinned = compose(env)
    expect(
      await readStickyModelForMode(loopConfig(unpinned.wires, makeFakeLlm({ provider: "openai" }))),
    ).toBe("gpt-4o")

    // …and the resolver itself states the rule once, for both consumers.
    expect(
      resolveStickyModelBoot({ planMode: false, env, provider: "openai", explicitPin: true })
        .modelId,
    ).toBeUndefined()
    expect(resolveStickyModelBoot({ planMode: false, env, provider: "openai" }).modelId).toBe(
      "gpt-4o",
    )
  })

  test("paired control — NO file ⇒ boot model everywhere (byte-identical to a first run)", async () => {
    const { env } = hermeticHome()
    expect(
      resolveStickyModelBoot({ planMode: false, env, provider: "openai" }).modelId,
    ).toBeUndefined()
    const s = compose(env)
    const out = await s.dispatch("/model")
    expect(out).toContain(" * boot-model")
    const cfg = loopConfig(s.wires, makeFakeLlm({ model: "boot-model", provider: "openai" }))
    expect(await readStickyModelForMode(cfg)).toBeUndefined()
  })

  test("a pick made under ANOTHER provider is invisible here (the provider is part of the key)", async () => {
    // A model id is only meaningful for its own provider, and `tryCreateLLM`
    // validates the CREDENTIAL, never the slug — so an anthropic slug read back in
    // an openai session used to build a real-looking port that failed at the wire
    // on EVERY turn, while four displays announced it.
    const { env } = hermeticHome()
    writePicks(env, { "anthropic:default": "claude-sonnet-4-6" })
    const s = compose(env) // the fake surface's provider is `openai`

    // The pick EXISTS on disk (keyed anthropic) …
    expect(resolveStickyModelBoot({ planMode: false, env, provider: "anthropic" }).modelId).toBe(
      "claude-sonnet-4-6",
    )
    // … and is invisible to this openai session, in every consumer:
    expect(
      resolveStickyModelBoot({ planMode: false, env, provider: "openai" }).modelId,
    ).toBeUndefined()
    expect(await s.dispatch("/model")).not.toContain("claude-sonnet-4-6")
    expect(await s.dispatch("/model")).toContain(" * boot-model")
    expect(
      await readStickyModelForMode(loopConfig(s.wires, makeFakeLlm({ provider: "openai" }))),
    ).toBeUndefined()
    expect(s.wires.modelAdapter?.current()).toBe("boot-model")
  })

  test("KEY AUTHORITY: the loop keys off the STORE SLOT's provider, not `config.llm.provider`", async () => {
    // The write key and the read key must have ONE authority. The surface owns
    // both halves (it built the store AND knows the provider), so it publishes the
    // provider ON the slot. Deriving the read key from `config.llm.provider`
    // instead makes the two halves independently reachable: any wrapper that drops
    // the field — the exact defect `forwardPortIdentity` exists to fix, found twice
    // in this campaign for `listModels`/`contextWindowKey` — silently reverts the
    // read to the bare key, and the pick stops applying with no error anywhere.
    //
    // RED-on-injection: drop `config.stickyModelStore?.provider ??` in skill-gate
    // ⇒ this reds (undefined provider ⇒ bare `default` key ⇒ pick invisible).
    const { env } = hermeticHome()
    writePicks(env, { "openai:default": "gpt-4o" })
    const s = compose(env)

    // A base port whose `provider` was eaten by a decorator (the measured defect).
    const stripped = makeFakeLlm({ model: "boot-model" }) as LLMPort
    expect(stripped.provider).toBeUndefined()

    const cfg = loopConfig(s.wires, stripped)
    expect(cfg.stickyModelStore?.provider).toBe("openai") // the surface published it
    expect(await readStickyModelForMode(cfg)).toBe("gpt-4o")
  })

  test("MODE SWITCH: a pick stored for ANOTHER mode is runnable after shift+tab", async () => {
    // The mode cycle is default-ON, so shift+tab between turns is ordinary use —
    // and the sticky key contains the mode. The boot seed used to feed the catalog
    // ONLY the CURRENT mode's pick (`extraIds: [stickyBoot.modelId]`), so after
    // switching posture the loop read the OTHER mode's pick from the store, found
    // no PORT for it, and silently ran the boot model while the picker, status line
    // and `/why` all named the pick. Same silent-swap-failure shape as the defect
    // this whole campaign closes, one axis over.
    const { env } = hermeticHome()
    writePicks(env, { "openai:default": "gpt-4o", "openai:plan": "gpt-5.6-terra" })
    const s = compose(env)

    const ids = (s.wires.runtimeFacadeCompose.modelCandidates ?? []).map((c) => c.id)
    // BOTH picks need a port, not just the booted mode's.
    expect(ids).toContain("gpt-4o")
    expect(ids).toContain("gpt-5.6-terra")

    const base = makeFakeLlm({ model: "boot-model", provider: "openai" })
    const cfg = loopConfig(s.wires, base)
    const resolved = resolveSkillTurnOverride(cfg, undefined, "gpt-5.6-terra")
    expect(resolved.llm).not.toBe(base)
    expect(resolved.llm.model).toBe("gpt-5.6-terra")
  })

  test("PER-KEY VETTING: a hostile id under ANOTHER mode is dropped, the good pick survives", async () => {
    // The admission check (`isPlausibleModelSlug` — the ANSI/OSC injection defense)
    // ran ONLY on the CURRENT mode's key, while the whole raw snapshot was handed to
    // the store as its seed. So a hostile id stored under `plan` sailed straight in
    // and became this session's pick the moment the operator pressed shift+tab —
    // reaching the loop and every display, with only the render seam left standing.
    // Vetting is per KEY now: the bad entry is dropped, the good one is not.
    const { env } = hermeticHome()
    const hostile = `\u001b[2Jclaude-evil\nApprove destructive action? [y/N]`
    writePicks(env, { "openai:default": "gpt-4o", "openai:plan": hostile })
    const s = compose(env)
    const loaded = await s.wires.runtimeFacadeCompose.stickyModelStore?.store.load()
    expect(loaded?.snapshot["openai:default"]).toBe("gpt-4o")
    expect(loaded?.snapshot["openai:plan"]).toBeUndefined()
    // …and it never became a candidate PORT either.
    const ids = (s.wires.runtimeFacadeCompose.modelCandidates ?? []).map((c) => c.id)
    expect(ids.some((id) => id.includes("Approve destructive"))).toBe(false)
  })

  test("the two boot filters are PER KEY (direct — the composition root cannot reach these cases)", () => {
    const hostile = `\u001b[2Jevil\nApprove destructive action? [y/N]`
    // 1. PLAUSIBILITY + provider scope. A hostile id under ANY key is dropped, and
    //    another provider's entries never seed this session. The bare-mode key is
    //    the legacy shape and applies to whoever reads it.
    expect(
      vetPersistedPicks(
        {
          "openai:default": "gpt-4o",
          "openai:plan": hostile,
          "anthropic:default": "claude-sonnet-4-6",
          review: "legacy-model",
        },
        "openai",
      ),
    ).toEqual({ "openai:default": "gpt-4o", review: "legacy-model" })
    // Paired control: no provider ⇒ only legacy bare-mode keys are in scope.
    expect(vetPersistedPicks({ "openai:default": "gpt-4o", review: "legacy-model" })).toEqual({
      review: "legacy-model",
    })

    // 2. RUNNABILITY. One unbuildable pick drops ITSELF, not the whole snapshot —
    //    the all-or-nothing version erased a good `plan` pick because `default`
    //    failed. Unreachable from a surface test (the root holds credentials for
    //    its own provider, so every plausible slug builds a port), which is exactly
    //    why the filter is a function.
    const dropped: string[] = []
    expect(
      vetRunnablePicks(
        { "openai:default": "no-port-for-this", "openai:plan": "gpt-4o" },
        ["boot-model", "gpt-4o"],
        (key) => dropped.push(key),
      ),
    ).toEqual({ "openai:plan": "gpt-4o" })
    // …and the drop is REPORTED, not silent (the operator gets a warn naming it).
    expect(dropped).toEqual(["openai:default"])
  })

  test("the surface publishes ONE effective-model getter, and it reports the pick", () => {
    // Every first-paint/report surface reads THIS getter now (the status-bar
    // preamble and the status-line seed through `setup.effectiveBootModel`, the
    // `stickyModelStore.effectiveModel` slot that `describe().modelSlug` publishes,
    // and `/retry-with`'s `currentModelId`). They each used to name `setup.model`
    // — the BOOT model — which is how the banner and the status bar ended up
    // disagreeing in the same frame (measured over a real pty).
    //
    // HONEST LIMIT: the `/retry-with` call site is reachable only after a turn has
    // streamed (`buildRetryState` returns undefined without a `streamInput`), so
    // that ONE consumer is guarded by the compiler and by this shared getter, not
    // by a front-door case. A dispatch-based test would print "no model candidates
    // configured" and pass vacuously — measured, so it is not written.
    const { env } = hermeticHome()
    writePicks(env, { "openai:default": "gpt-4o" })
    const live = compose(env).wires.runtimeFacadeCompose.stickyModelStore?.effectiveModel
    expect(live?.()).toBe("gpt-4o")

    // Paired control: no pick ⇒ the getter is silent and every consumer falls back
    // to the boot model (`effectiveModelOf` treats undefined/"" as no preference).
    const { env: bare } = hermeticHome()
    expect(
      compose(bare).wires.runtimeFacadeCompose.stickyModelStore?.effectiveModel?.(),
    ).toBeUndefined()
  })

  test("`/sticky-model <mode> <id>` writes the key the LOOP reads (not a bare mode)", async () => {
    // The provider joined the sticky key for `/model`'s wire, and `/sticky-model`
    // — the OTHER front door onto the same store — was left writing the bare mode.
    // Measured end to end before the fix: the command printed
    // `/sticky-model: default → boot-model`, the file held `{"default":"boot-model"}`,
    // and `readStickyModelForMode` returned `undefined`. A success line over an
    // inert write, which is the exact failure this campaign exists to remove.
    const { env } = hermeticHome()
    const s = compose(env)
    await s.dispatch("/sticky-model default boot-model")
    expect(JSON.parse(readFileSync(stickyModelFilePath(env), "utf8"))).toEqual({
      "openai:default": "boot-model",
    })
    const cfg = loopConfig(s.wires, makeFakeLlm({ model: "boot-model", provider: "openai" }))
    expect(await readStickyModelForMode(cfg)).toBe("boot-model")
  })

  test("MIGRATION: a LEGACY bare-mode pick (written before the provider key) is still honored", async () => {
    // Every `~/.quanta/sticky-model.json` that existed before the provider joined
    // the key holds bare-mode entries. Reading only the scoped key orphaned all of
    // them: the file still held the user's preference, the loop composed a key that
    // was not in it, and nothing said the preference had been dropped — the same
    // silent no-preference the provider key was added to prevent, aimed at existing
    // users instead of cross-provider ones.
    const { env } = hermeticHome()
    writePicks(env, { default: "gpt-4o" })
    const s = compose(env)
    const cfg = loopConfig(s.wires, makeFakeLlm({ model: "boot-model", provider: "openai" }))
    expect(await readStickyModelForMode(cfg)).toBe("gpt-4o")
    // …and it is a real switch, not just a string: the PORT exists.
    const resolved = resolveSkillTurnOverride(cfg, undefined, "gpt-4o")
    expect(resolved.llm.model).toBe("gpt-4o")
  })

  test("MIGRATION precedence: a SCOPED entry wins over a bare one for the same mode", async () => {
    // The scoped key is the more specific statement, so it must not be shadowed by
    // a legacy entry the user has since superseded.
    const { env } = hermeticHome()
    writePicks(env, { default: "gpt-4o", "openai:default": "gpt-4o-mini" })
    const s = compose(env)
    const cfg = loopConfig(s.wires, makeFakeLlm({ model: "boot-model", provider: "openai" }))
    expect(await readStickyModelForMode(cfg)).toBe("gpt-4o-mini")
  })

  test("no-throw: a CORRUPT file boots as 'no preference' rather than failing the surface", async () => {
    const { env } = hermeticHome()
    writeFileSync(stickyModelFilePath(env), "{not json at all", "utf8")
    expect(readStickyModelSnapshotSync({ path: stickyModelFilePath(env) })).toEqual({})
    expect(
      resolveStickyModelBoot({ planMode: false, env, provider: "openai" }).modelId,
    ).toBeUndefined()
    expect(await compose(env).dispatch("/model")).toContain(" * boot-model")
  })

  test("hermeticity guard: the store path follows the INJECTED env, so no suite touches the real home", () => {
    const { dir, env } = hermeticHome()
    expect(stickyModelFilePath(env)).toBe(join(dir, "sticky-model.json"))
    // …and a compose+set writes THERE (not under the developer's ~/.quanta).
    expect(stickyModelFilePath(env)).not.toBe(stickyModelFilePath())
  })
})
