/**
 * ★ MR-02 — the REAL `ModelRoutingAuthority` against the shared conformance suite.
 *
 * The suite (`tests/_support/model-routing-conformance.ts`) is the acceptance gate
 * every root must pass; MR-00 proved it satisfiable and toothy against a reference.
 * This file runs it against the shipping implementation, over the REAL collaborators
 * it will have in production — the fs-backed store wrapped in the session-scoped
 * decorator, and the real `buildModelCatalogWire` — so "conforms" means the actual
 * store/catalog wiring conforms, not an in-memory sketch of it.
 *
 * Hermetic: every scenario gets its own `QUANTA_CONFIG_DIR`-shaped scratch path and
 * removes it afterwards. Nothing here reads the developer's `~/.quanta` (an empty
 * env bag would — `quantaHomeDirFrom({})` resolves to the real home).
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createModelRoutingSession } from "@/agent/model-routing"
import { createModelRoutingAuthority } from "@/agent/model-routing/authority"
import {
  fsBackedStickyModelStore,
  readStickyModelSnapshotSync,
  sessionScopedStickyModelStore,
} from "@/agent/sticky-model"
import type { LLMPort } from "@/llm"
import { buildModelCatalogWire } from "@/llm/model-catalog"
import {
  describeModelRoutingAuthorityContract,
  type ModelRoutingConformanceScenario,
} from "../../_support/model-routing-conformance"

const dirs: string[] = []
afterEach(() => {
  while (dirs.length > 0) {
    const d = dirs.pop()
    if (d !== undefined) rmSync(d, { recursive: true, force: true })
  }
})

const fakePort = (model: string): LLMPort =>
  ({ model, provider: "openai", stream: async function* () {} }) as unknown as LLMPort

/** Build the shipping authority over the REAL store + catalog for a scenario. */
const realAuthority = (scenario: ModelRoutingConformanceScenario) => {
  const dir = mkdtempSync(join(tmpdir(), "mr02-authority-"))
  dirs.push(dir)
  const path = join(dir, "sticky-model.json")
  writeFileSync(path, JSON.stringify(scenario.persisted), "utf8")

  const bootPort = fakePort(scenario.bootModelId)
  const persisted = readStickyModelSnapshotSync({ path })
  // A read-only home is the production shape of a failing durable write: the fs
  // store's `mkdir`/atomic-write fails and it returns a typed `{ok:false}`.
  const storePath = scenario.failWrites === true ? join(dir, "blocker", "sticky-model.json") : path
  if (scenario.failWrites === true) writeFileSync(join(dir, "blocker"), "not a dir", "utf8")
  const store = sessionScopedStickyModelStore({
    inner: fsBackedStickyModelStore({ path: storePath }),
    seed: persisted,
  })
  const catalog = buildModelCatalogWire({
    provider: scenario.provider,
    bootModel: scenario.bootModelId,
    llm: bootPort,
    seeded: [],
    // The eager seed a resumed session needs: every buildable id this scenario
    // declares. The catalog applies its OWN admission (`isPlausibleModelSlug`), so
    // a hostile id listed here must still not become a candidate.
    extraIds: scenario.buildable,
    buildPort: (id: string) => (scenario.buildable.includes(id) ? fakePort(id) : null),
    env: {} as NodeJS.ProcessEnv,
  })
  return {
    authority: createModelRoutingAuthority({
      store,
      catalog,
      provider: scenario.provider,
      bootModelId: scenario.bootModelId,
      bootPort,
      mode: () => scenario.mode,
      pinned: scenario.pinned,
      persisted,
    }),
    bootPort,
  }
}

describeModelRoutingAuthorityContract("authority", async (scenario) =>
  Promise.resolve(realAuthority(scenario)),
)

/** The ROOT-FACING factory, through the same gate. This is the one every
 *  composition root calls, so it — not just the authority underneath it — has to
 *  conform: the measured defects were assembly-order mistakes (seeding the cell
 *  from the RAW file, seeding candidate ports from the scoped key only), and only
 *  a factory-level run can catch those. */
describeModelRoutingAuthorityContract("session-factory", async (scenario) => {
  const dir = mkdtempSync(join(tmpdir(), "mr02-session-"))
  dirs.push(dir)
  const path =
    scenario.failWrites === true
      ? (writeFileSync(join(dir, "blocker"), "not a dir", "utf8"),
        join(dir, "blocker", "sticky-model.json"))
      : join(dir, "sticky-model.json")
  if (scenario.failWrites !== true) writeFileSync(path, JSON.stringify(scenario.persisted), "utf8")
  else writeFileSync(join(dir, "seed.json"), "{}", "utf8")

  const bootPort = fakePort(scenario.bootModelId)
  const session = createModelRoutingSession({
    env: {} as NodeJS.ProcessEnv,
    path,
    provider: scenario.provider,
    bootModelId: scenario.bootModelId,
    bootPort,
    mode: () => scenario.mode,
    pinned: scenario.pinned,
    buildPort: (id: string) => (scenario.buildable.includes(id) ? fakePort(id) : null),
  })
  return { authority: session.authority, bootPort }
})

describe("MR-02 · the authority's durable half", () => {
  test("a select() is on DISK under the provider-scoped key, for the next session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mr02-durable-"))
    dirs.push(dir)
    const path = join(dir, "sticky-model.json")
    writeFileSync(path, "{}", "utf8")
    const bootPort = fakePort("boot-model")
    const store = sessionScopedStickyModelStore({
      inner: fsBackedStickyModelStore({ path }),
      seed: {},
    })
    const catalog = buildModelCatalogWire({
      provider: "openai",
      bootModel: "boot-model",
      llm: bootPort,
      seeded: [],
      extraIds: ["gpt-4o"],
      buildPort: (id: string) => fakePort(id),
      env: {} as NodeJS.ProcessEnv,
    })
    const authority = createModelRoutingAuthority({
      store,
      catalog,
      provider: "openai",
      bootModelId: "boot-model",
      bootPort,
      mode: () => "default",
      pinned: false,
      persisted: {},
    })
    expect((await authority.select("gpt-4o")).ok).toBe(true)
    expect(readStickyModelSnapshotSync({ path })["openai:default"]).toBe("gpt-4o")

    // …and clear() removes that exact key rather than truncating the file.
    expect((await authority.clear()).ok).toBe(true)
    expect(readStickyModelSnapshotSync({ path })["openai:default"]).toBeUndefined()
  })

  test("per-MODE isolation: selecting under one mode leaves the other's pick alone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mr02-mode-"))
    dirs.push(dir)
    const path = join(dir, "sticky-model.json")
    writeFileSync(path, JSON.stringify({ "openai:plan": "gpt-4o-mini" }), "utf8")
    const bootPort = fakePort("boot-model")
    const persisted = readStickyModelSnapshotSync({ path })
    let mode: "default" | "plan" = "default"
    const catalog = buildModelCatalogWire({
      provider: "openai",
      bootModel: "boot-model",
      llm: bootPort,
      seeded: [],
      extraIds: ["gpt-4o", "gpt-4o-mini"],
      buildPort: (id: string) => fakePort(id),
      env: {} as NodeJS.ProcessEnv,
    })
    const authority = createModelRoutingAuthority({
      store: sessionScopedStickyModelStore({
        inner: fsBackedStickyModelStore({ path }),
        seed: persisted,
      }),
      catalog,
      provider: "openai",
      bootModelId: "boot-model",
      bootPort,
      mode: () => mode,
      pinned: false,
      persisted,
    })
    // In `default` nothing is picked; the plan pick must not leak across.
    expect(authority.view().modelId).toBe("boot-model")
    expect((await authority.select("gpt-4o")).ok).toBe(true)

    // shift+tab into plan: the OTHER mode's persisted pick is what applies.
    mode = "plan"
    expect(authority.view().modelId).toBe("gpt-4o-mini")
    expect(authority.view().mode).toBe("plan")
    // …and back again.
    mode = "default"
    expect(authority.view().modelId).toBe("gpt-4o")
    expect(readStickyModelSnapshotSync({ path })).toEqual({
      "openai:plan": "gpt-4o-mini",
      "openai:default": "gpt-4o",
    })
  })
})
