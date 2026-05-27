/**
 * ADR-0372 — `assembleAgentConfig` caller-owned session-registry wire
 * hellgate.
 *
 * Pins (4 cases):
 *   M. cfg.metrics absent           ⇒ legacy global-singleton path
 *   N. cfg.metrics MetricsRegistry  ⇒ caller-owned registry minted
 *   O. cfg.metrics + no sessionId   ⇒ caller-owned skipped (sessionResources = null)
 *   P. end-to-end emit through flock telemetry on disk env
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  getGlobalSessionResourceRegistry,
  resetGlobalSessionResourceRegistry,
} from "@/agent/session-resource-registry/global"
import type { AgentConfig } from "@/agent/types"
import { type AssembleRequest, assembleAgentConfig } from "@/apps/agent/assemble"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import type { MetricsRegistry } from "@/observability/metrics/port"

const inertLLM: LLMPort & { readonly model: string } = {
  model: "gpt-5",
  // biome-ignore lint/correctness/useYield: never invoked
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    throw new Error("unexpected stream()")
  },
}

const baseFor = (over: Partial<AgentConfig> = {}): AssembleRequest["base"] => ({
  llm: inertLLM,
  registry: {
    register: () => undefined,
    get: () => undefined,
    list: () => [],
  } as unknown as AgentConfig["registry"],
  stream: { emit: () => undefined },
  permission: { mode: "default" },
  messages: [],
  system: "test",
  cwd: "/repo",
  maxTurns: 1,
  signal: new AbortController().signal,
  sessionId: "sess-assemble-wire",
  ...over,
})

interface CapturedEmit {
  kind: "increment" | "gauge" | "observe"
  name: string
  value: number
}

const mkRegistry = (): { reg: MetricsRegistry; log: CapturedEmit[] } => {
  const log: CapturedEmit[] = []
  const reg: MetricsRegistry = {
    increment(name, delta = 1) {
      log.push({ kind: "increment", name, value: delta })
    },
    observe(name, value) {
      log.push({ kind: "observe", name, value })
    },
    gauge(name, value) {
      log.push({ kind: "gauge", name, value })
    },
    snapshot: () => [],
    reset: () => undefined,
    flush: () => Promise.resolve(),
  }
  return { reg, log }
}

let SAVED_DISK: string | undefined
let SAVED_SQLITE: string | undefined

beforeEach(() => {
  SAVED_DISK = process.env.QUANTA_SESSION_REGISTRY_DISK_DIR
  SAVED_SQLITE = process.env.QUANTA_SESSION_REGISTRY_SQLITE_PATH
  delete process.env.QUANTA_SESSION_REGISTRY_DISK_DIR
  delete process.env.QUANTA_SESSION_REGISTRY_SQLITE_PATH
  resetGlobalSessionResourceRegistry()
})

afterEach(() => {
  if (SAVED_DISK !== undefined) {
    process.env.QUANTA_SESSION_REGISTRY_DISK_DIR = SAVED_DISK
  } else {
    delete process.env.QUANTA_SESSION_REGISTRY_DISK_DIR
  }
  if (SAVED_SQLITE !== undefined) {
    process.env.QUANTA_SESSION_REGISTRY_SQLITE_PATH = SAVED_SQLITE
  } else {
    delete process.env.QUANTA_SESSION_REGISTRY_SQLITE_PATH
  }
  resetGlobalSessionResourceRegistry()
})

describe("ADR-0372 §M — cfg.metrics absent ⇒ legacy singleton path", () => {
  test("global singleton getOrCreate is invoked (no caller-owned mint)", () => {
    const req: AssembleRequest = { mode: "interactive", base: baseFor() }
    const cfg = assembleAgentConfig(req)
    // Sanity — assembled cfg has the session id baked in by the wire.
    expect(cfg.sessionId).toBe("sess-assemble-wire")
    // The global singleton must show the session id (proves legacy path
    // was used). If a caller-owned path had been used, the global
    // singleton's getOrCreate would NOT have been invoked.
    const singleton = getGlobalSessionResourceRegistry()
    const peek = singleton.peek("sess-assemble-wire")
    expect(peek).not.toBeNull()
  })
})

describe("ADR-0372 §N — cfg.metrics MetricsRegistry ⇒ caller-owned path", () => {
  test("global singleton does NOT contain the session id", () => {
    const { reg: metrics } = mkRegistry()
    const req: AssembleRequest = {
      mode: "interactive",
      base: baseFor({ metrics: metrics as unknown as NonNullable<AgentConfig["metrics"]> }),
    }
    assembleAgentConfig(req)
    // Caller-owned was used ⇒ the global singleton never saw the id.
    const singleton = getGlobalSessionResourceRegistry()
    expect(singleton.peek("sess-assemble-wire")).toBeNull()
  })
})

describe("ADR-0372 §O — cfg.metrics + no sessionId ⇒ caller-owned skipped", () => {
  test("sessionResources null when sessionId absent (no mint)", () => {
    const { reg: metrics } = mkRegistry()
    // Use a fresh base, no sessionId — strip the default-provided id.
    const baseWithId = baseFor({
      metrics: metrics as unknown as NonNullable<AgentConfig["metrics"]>,
    })
    const { sessionId: _strip, ...baseNoId } = baseWithId
    void _strip
    const req: AssembleRequest = {
      mode: "interactive",
      base: baseNoId as AssembleRequest["base"],
    }
    expect(() => assembleAgentConfig(req)).not.toThrow()
    // No session id ⇒ nothing in the global singleton either.
    const singleton = getGlobalSessionResourceRegistry()
    // Nothing to peek under — and size stays 0.
    expect(singleton.size()).toBe(0)
  })
})

describe("ADR-0372 §P — end-to-end flock telemetry through caller-owned wire", () => {
  test("disk env + cfg.metrics ⇒ codex_r2.lock.* lands on registry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "adr0372-assemble-"))
    process.env.QUANTA_SESSION_REGISTRY_DISK_DIR = dir
    const { reg: metrics, log } = mkRegistry()
    const req: AssembleRequest = {
      mode: "interactive",
      base: baseFor({ metrics: metrics as unknown as NonNullable<AgentConfig["metrics"]> }),
    }
    const cfg = assembleAgentConfig(req)
    // Use the assembled cache/store — accessing the store triggers the
    // disk-side lock acquire path on the very next mutation.
    const store = (cfg as unknown as { store?: { append: (e: unknown) => void } }).store
    // installCodexR2Wires attaches the store at `cfg.store`. If not present
    // on this build, the wire was at least invoked; we instead use the
    // session-resources we know are minted by the caller-owned path.
    if (store !== undefined) {
      store.append({
        kind: "context_update",
        field: "cwd",
        prev: "/a",
        next: "/b",
        at: 1,
        turnId: "t-P",
      })
    }
    const deadline = Date.now() + 2000
    let saw = false
    while (Date.now() < deadline) {
      saw = log.some((e) => e.kind === "increment" && e.name === "codex_r2.lock.acquire_success")
      if (saw) break
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(saw).toBe(true)
    await rm(dir, { recursive: true, force: true })
  })
})
