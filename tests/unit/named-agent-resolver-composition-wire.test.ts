/**
 * Named-agent registry composition wiring.
 *
 * `runMain` loads `loadNamedAgents(cwd)` ONCE per session and threads the
 * resolver onto `AssembleRequestPartial.namedAgentResolver`; `buildBaseFromArgs`
 * lifts it onto `AgentConfig.namedAgentResolver`, which the subagent runner
 * consults per spawn. This proves the three legs:
 *   1. present on the partial ⇒ lifted onto `base` (and onto the assembled cfg);
 *   2. absent ⇒ slot OMITTED (byte-identical default-OFF spawn path);
 *   3. `loadNamedAgents` on an ABSENT `.quanta/agents` dir ⇒ EMPTY registry
 *      (size 0) ⇒ `runMain` would NOT thread it (so the field stays absent).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadNamedAgents, type NamedAgentResolver } from "@/agent"
import { buildBaseFromArgs } from "@/host/runtime/agent-arg-builder"
import { __resetRuntimeConfig } from "@/shared/runtime-config"

const DRIVEN = ["QUANTA_PROVIDER", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"] as const
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of DRIVEN) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  // The builder REQUIRES a provider key or it throws ProviderKeyMissingError.
  process.env.QUANTA_PROVIDER = "openai"
  process.env.OPENAI_API_KEY = "sk-test-deterministic-key"
  __resetRuntimeConfig()
})
afterEach(() => {
  for (const k of DRIVEN) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  __resetRuntimeConfig()
})

// A trivial stand-in resolver (the runner only depends on the structural port).
const fakeResolver: NamedAgentResolver = { resolve: () => undefined }

describe("namedAgentResolver — buildBaseFromArgs lift", () => {
  test("present on the partial ⇒ lifted onto base.namedAgentResolver", () => {
    const base = buildBaseFromArgs({
      mode: "headless",
      dials: undefined,
      namedAgentResolver: fakeResolver,
    } as Parameters<typeof buildBaseFromArgs>[0])
    expect((base as { namedAgentResolver?: NamedAgentResolver }).namedAgentResolver).toBe(
      fakeResolver,
    )
  })

  test("absent ⇒ slot OMITTED (byte-identical default-OFF)", () => {
    const base = buildBaseFromArgs({ mode: "headless", dials: undefined })
    expect(Object.hasOwn(base, "namedAgentResolver")).toBe(false)
  })
})

describe("loadNamedAgents — absent dir is fail-open empty", () => {
  test("a cwd with no .quanta/agents dir ⇒ empty registry (size 0)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "named-agents-empty-"))
    try {
      const registry = await loadNamedAgents(dir)
      expect(registry.size).toBe(0)
      expect(registry.resolve("anything")).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
