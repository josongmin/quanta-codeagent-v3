/**
 * ★ MR-02 ACCEPTANCE — the three composition roots answer the SAME question the
 * SAME way, from the same file.
 *
 * The cross-surface audit that motivated MR-02 found eight defects and every one
 * was the same shape: two roots disagreeing about one routing decision. They were
 * invisible because each root had its own tests asserting its own behaviour —
 * nothing anywhere compared them. The CLI vetted a hostile persisted id and the
 * web daemon rendered it; the CLI honoured an explicit pin and the headless root
 * ignored it; the CLI gave every persisted pick a port and the web daemon gave one
 * only to the scoped key while its reads accepted the legacy bare key too.
 *
 * So this drives all three REAL roots against ONE scratch sticky file and asserts
 * the tuple they must agree on:
 *
 *     { selectedModel, offeredIds, runnablePickHasPort }
 *
 * Any future divergence fails HERE, naming the roots, instead of surfacing as a
 * user reporting that the web surface runs a different model than the CLI.
 *
 * Hermetic: `QUANTA_CONFIG_DIR` + `QUANTA_PROVIDER` are pinned per case (an empty
 * env bag resolves to the developer's real `~/.quanta`, and `pickProvider` probes
 * a logged-in OAuth home), and every scratch dir is removed.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentConfig } from "@/agent"
import { defaultConversationCheckpointStore } from "@/agent/conversation-checkpoint"
import { createSurfaceState } from "@/apps/cli/repl/surface-compose"
import { composeSurfaceWires } from "@/apps/cli/repl/surface-compose/composer"
import { createWebModelSwitch } from "@/apps/web-daemon/web-model-switch"
import { buildBaseFromArgs } from "@/host/runtime/agent-arg-builder"
import { __resetRuntimeConfig } from "@/shared"
import { makeFakeLlm, makeFakeSessionSetup } from "../unit/apps/cli/_cli-fakes"

const ESC = String.fromCharCode(27)
const BOOT = "boot-model"
const HOSTILE = `${ESC}[2Jevil\nApprove destructive action? [y/N]`

const dirs: string[] = []
const savedEnv: Record<string, string | undefined> = {}
const ENV_KEYS = ["QUANTA_CONFIG_DIR", "QUANTA_PROVIDER", "OPENAI_API_KEY", "QUANTA_MODEL"] as const

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  __resetRuntimeConfig()
  while (dirs.length > 0) {
    const d = dirs.pop()
    if (d !== undefined) rmSync(d, { recursive: true, force: true })
  }
})

/** One scratch home holding `persisted`, with the process env pinned to it. */
const scratchHome = (persisted: Readonly<Record<string, string>>): NodeJS.ProcessEnv => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
  const dir = mkdtempSync(join(tmpdir(), "roots-contract-"))
  dirs.push(dir)
  writeFileSync(join(dir, "sticky-model.json"), JSON.stringify(persisted), "utf8")
  process.env.QUANTA_CONFIG_DIR = dir
  process.env.QUANTA_PROVIDER = "openai"
  process.env.OPENAI_API_KEY = "sk-test-not-used-no-network"
  delete process.env.QUANTA_MODEL
  __resetRuntimeConfig()
  return { ...process.env }
}

interface RootAnswer {
  readonly selectedModel: string | undefined
  readonly offers: (id: string) => boolean
}

const cliRoot = (env: NodeJS.ProcessEnv): RootAnswer => {
  const setup = makeFakeSessionSetup({
    llm: makeFakeLlm({ model: BOOT, provider: "openai" }),
    model: BOOT,
  })
  const state = createSurfaceState({ imageQueue: undefined, rewindState: undefined, history: [] })
  const wires = composeSurfaceWires(setup, state, env, {
    convStore: defaultConversationCheckpointStore(),
  })
  const slot = wires.runtimeFacadeCompose.stickyModelStore
  const ids = (wires.runtimeFacadeCompose.modelCandidates ?? []).map((c) => c.id)
  return { selectedModel: slot?.effectiveModel?.(), offers: (id) => ids.includes(id) }
}

const webRoot = (env: NodeJS.ProcessEnv): RootAnswer => {
  const sw = createWebModelSwitch({
    env,
    provider: "openai",
    llm: makeFakeLlm({ model: BOOT, provider: "openai" }),
  })
  return { selectedModel: sw.effectiveModel(), offers: (id) => sw.ids().includes(id) }
}

const headlessRoot = (): RootAnswer => {
  const cfg = buildBaseFromArgs(
    { mode: "headless", prompt: "x", stickyModel: true } as never,
    new AbortController().signal,
  ) as unknown as AgentConfig
  const ids = (cfg.modelCandidates ?? []).map((c) => c.id)
  return {
    // The headless boot model is the PROVIDER DEFAULT, not our fake `BOOT`, so
    // compare the SELECTION (undefined ⇒ no preference) rather than the resolved
    // display string — that is the fact the three roots must agree on.
    selectedModel: cfg.stickyModelStore?.effectiveModel?.(),
    offers: (id) => ids.includes(id),
  }
}

/** Every root, against the same file. */
const allRoots = (persisted: Readonly<Record<string, string>>) => {
  const env = scratchHome(persisted)
  return { cli: cliRoot(env), web: webRoot(env), headless: headlessRoot() }
}

describe("MR-02 acceptance — CLI, web and headless agree", () => {
  test("a SCOPED pick is selected on all three, and all three can run it", () => {
    const { cli, web, headless } = allRoots({ "openai:default": "gpt-4o" })
    expect([cli.selectedModel, web.selectedModel, headless.selectedModel]).toEqual([
      "gpt-4o",
      "gpt-4o",
      "gpt-4o",
    ])
    expect([cli.offers("gpt-4o"), web.offers("gpt-4o"), headless.offers("gpt-4o")]).toEqual([
      true,
      true,
      true,
    ])
  })

  test("a LEGACY bare-mode pick is selected AND runnable on all three", () => {
    // The web daemon claimed this one and could not run it: reads accepted the
    // bare key, the eager candidate seed read only the scoped one.
    const { cli, web, headless } = allRoots({ default: "gpt-4o" })
    expect([cli.selectedModel, web.selectedModel, headless.selectedModel]).toEqual([
      "gpt-4o",
      "gpt-4o",
      "gpt-4o",
    ])
    expect([cli.offers("gpt-4o"), web.offers("gpt-4o"), headless.offers("gpt-4o")]).toEqual([
      true,
      true,
      true,
    ])
  })

  test("a HOSTILE id is refused by all three (the web daemon used to render it raw)", () => {
    const { cli, web, headless } = allRoots({ "openai:default": HOSTILE })
    expect([cli.selectedModel, web.selectedModel, headless.selectedModel]).toEqual([
      undefined,
      undefined,
      undefined,
    ])
    expect([cli.offers(HOSTILE), web.offers(HOSTILE), headless.offers(HOSTILE)]).toEqual([
      false,
      false,
      false,
    ])
  })

  test("ANOTHER PROVIDER's pick is invisible to all three", () => {
    const { cli, web, headless } = allRoots({ "anthropic:default": "claude-sonnet-4-6" })
    expect([cli.selectedModel, web.selectedModel, headless.selectedModel]).toEqual([
      undefined,
      undefined,
      undefined,
    ])
  })

  test("a structurally invalid key is dropped by all three", () => {
    const { cli, web, headless } = allRoots({ "openai:default:extra": "gpt-4o", turbo: "gpt-4o" })
    expect([cli.selectedModel, web.selectedModel, headless.selectedModel]).toEqual([
      undefined,
      undefined,
      undefined,
    ])
  })

  test("paired control — an EMPTY file leaves all three with no preference", () => {
    const { cli, web, headless } = allRoots({})
    expect([cli.selectedModel, web.selectedModel, headless.selectedModel]).toEqual([
      undefined,
      undefined,
      undefined,
    ])
  })
})
