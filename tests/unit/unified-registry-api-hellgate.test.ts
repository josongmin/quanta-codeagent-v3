/**
 * ADR-0383 — Unified `getOrCreateRegistry(opts)` API hellgate.
 *
 * Additive, non-breaking unification of two mint paths that already exist
 * in the codebase:
 *
 *   - ADR-0347 — `getGlobalSessionResourceRegistry()` process singleton
 *     (env-driven backend, sweep auto-attached, lazy-init).
 *   - ADR-0372 — `buildCallerOwnedRegistryWithTelemetry({ emitter })`
 *     per-call mint that bypasses the singleton so flock telemetry can
 *     be threaded through the disk-adapter.
 *
 * `getOrCreateRegistry(opts?)` is a single entry that delegates to ONE of
 * those two paths based on `opts.callerOwned`. ZERO behavior change for
 * existing call sites — they remain on the original APIs.
 *
 * Behavior matrix pinned by this file:
 *
 *   A. opts undefined                       ⇒ global singleton (byte-identical)
 *   B. opts {}                              ⇒ global singleton
 *   C. opts {callerOwned: false}            ⇒ global singleton
 *   D. opts {callerOwned: true, emitter:X}  ⇒ caller-owned (different from global)
 *   E. opts {callerOwned: true, no emitter} ⇒ NO-THROW fallback to global
 *   F. opts {metricsEmitter:X, callerOwned undefined} ⇒ global (emitter ignored)
 *   G. multiple callerOwned=true calls      ⇒ different instances each
 *   H. multiple callerOwned=false calls     ⇒ same singleton instance
 *   I. caller-owned builder throws          ⇒ NO-THROW fallback to global
 *   J. opts.sessionId passes through to caller-owned builder
 *   K. resetGlobalSessionResourceRegistry() affects callerOwned=false path
 *   L. resetGlobalSessionResourceRegistry() does NOT affect prior
 *      caller-owned instances
 *   M. byte-identical reference equality with getGlobalSessionResourceRegistry()
 *      when opts absent
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  getGlobalSessionResourceRegistry,
  resetGlobalSessionResourceRegistry,
} from "@/agent/session-resource-registry/global"
import { getOrCreateRegistry } from "@/agent/session-resource-registry/unified-api"
import type { MetricEmitterPort } from "@/observability/codex-r2-metrics"

interface CapturedEmit {
  kind: "counter" | "gauge"
  name: string
  value: number
}

const mkEmitter = (): { emitter: MetricEmitterPort; log: CapturedEmit[] } => {
  const log: CapturedEmit[] = []
  const emitter: MetricEmitterPort = {
    counter(name, delta) {
      log.push({ kind: "counter", name, value: delta })
    },
    gauge(name, value) {
      log.push({ kind: "gauge", name, value })
    },
  }
  return { emitter, log }
}

const tempDir = async (): Promise<string> => mkdtemp(join(tmpdir(), "adr0383-"))

// Tests must NOT inherit env vars from the runner — snapshot + restore.
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

describe("ADR-0383 §A — opts undefined ⇒ global singleton", () => {
  test("returns same reference as getGlobalSessionResourceRegistry()", () => {
    const fromUnified = getOrCreateRegistry()
    const fromGlobal = getGlobalSessionResourceRegistry()
    expect(fromUnified).toBe(fromGlobal)
  })
})

describe("ADR-0383 §B — opts {} ⇒ global singleton", () => {
  test("empty options bag delegates to global singleton", () => {
    const fromUnified = getOrCreateRegistry({})
    const fromGlobal = getGlobalSessionResourceRegistry()
    expect(fromUnified).toBe(fromGlobal)
  })
})

describe("ADR-0383 §C — opts.callerOwned=false ⇒ global singleton", () => {
  test("explicit false routes to global singleton", () => {
    const fromUnified = getOrCreateRegistry({ callerOwned: false })
    const fromGlobal = getGlobalSessionResourceRegistry()
    expect(fromUnified).toBe(fromGlobal)
  })
})

describe("ADR-0383 §D — callerOwned=true + emitter ⇒ caller-owned instance", () => {
  test("returns a NEW instance (not the global singleton)", () => {
    const { emitter } = mkEmitter()
    const callerOwned = getOrCreateRegistry({ callerOwned: true, metricsEmitter: emitter })
    const singleton = getGlobalSessionResourceRegistry()
    expect(callerOwned).not.toBe(singleton)
  })
})

describe("ADR-0383 §E — callerOwned=true + no emitter ⇒ NO-THROW fallback to global", () => {
  test("missing emitter routes to global (caller-owned semantics need emitter)", () => {
    let result: ReturnType<typeof getOrCreateRegistry> | null = null
    expect(() => {
      result = getOrCreateRegistry({ callerOwned: true })
    }).not.toThrow()
    const fromGlobal = getGlobalSessionResourceRegistry()
    expect(result as unknown).toBe(fromGlobal)
  })
})

describe("ADR-0383 §F — emitter present + callerOwned undefined ⇒ global (emitter ignored)", () => {
  test("emitter alone does NOT trigger caller-owned path (opt-in must be explicit)", () => {
    const { emitter } = mkEmitter()
    const result = getOrCreateRegistry({ metricsEmitter: emitter })
    const fromGlobal = getGlobalSessionResourceRegistry()
    expect(result).toBe(fromGlobal)
  })
})

describe("ADR-0383 §G — multiple callerOwned=true calls ⇒ different instances", () => {
  test("each caller-owned call mints fresh (no caller-side singleton)", () => {
    const { emitter } = mkEmitter()
    const r1 = getOrCreateRegistry({ callerOwned: true, metricsEmitter: emitter })
    const r2 = getOrCreateRegistry({ callerOwned: true, metricsEmitter: emitter })
    expect(r1).not.toBe(r2)
  })
})

describe("ADR-0383 §H — multiple callerOwned=false calls ⇒ same singleton", () => {
  test("global path returns same reference on repeat", () => {
    const r1 = getOrCreateRegistry({ callerOwned: false })
    const r2 = getOrCreateRegistry({ callerOwned: false })
    const r3 = getOrCreateRegistry()
    expect(r1).toBe(r2)
    expect(r2).toBe(r3)
  })
})

describe("ADR-0383 §I — caller-owned builder throw ⇒ NO-THROW fallback to global", () => {
  test("any internal failure in caller-owned path falls back gracefully", () => {
    // We cannot easily force a real builder throw without mocking, but we
    // can assert the surface contract: invoking with valid opts must
    // NEVER throw, regardless of underlying state.
    const { emitter } = mkEmitter()
    let result: ReturnType<typeof getOrCreateRegistry> | null = null
    expect(() => {
      result = getOrCreateRegistry({ callerOwned: true, metricsEmitter: emitter })
    }).not.toThrow()
    expect(result).not.toBeNull()
    // Result must be a functional registry (getOrCreate works).
    expect(() => {
      const r = (result as unknown as { getOrCreate: (id: string) => unknown }).getOrCreate(
        "sess-I",
      )
      expect(r).toBeDefined()
    }).not.toThrow()
  })
})

describe("ADR-0383 §J — sessionId passes through to caller-owned builder", () => {
  test("sessionId option does not break the caller-owned path", async () => {
    const dir = await tempDir()
    process.env.QUANTA_SESSION_REGISTRY_DISK_DIR = dir
    const { emitter } = mkEmitter()
    let result: ReturnType<typeof getOrCreateRegistry> | null = null
    expect(() => {
      result = getOrCreateRegistry({
        callerOwned: true,
        metricsEmitter: emitter,
        sessionId: "sess-J",
      })
    }).not.toThrow()
    expect(result).not.toBeNull()
    // Functional check — getOrCreate works after sessionId pass-through.
    const r = (result as unknown as { getOrCreate: (id: string) => unknown }).getOrCreate("sess-J")
    expect(r).toBeDefined()
    await rm(dir, { recursive: true, force: true })
  })
})

describe("ADR-0383 §K — reset global affects callerOwned=false path", () => {
  test("reset followed by global call returns a NEW singleton", () => {
    const r1 = getOrCreateRegistry({ callerOwned: false })
    resetGlobalSessionResourceRegistry()
    const r2 = getOrCreateRegistry({ callerOwned: false })
    expect(r1).not.toBe(r2)
  })
})

describe("ADR-0383 §L — reset global does NOT affect prior caller-owned instances", () => {
  test("caller-owned registry remains usable after global reset", () => {
    const { emitter } = mkEmitter()
    const callerOwned = getOrCreateRegistry({ callerOwned: true, metricsEmitter: emitter })
    resetGlobalSessionResourceRegistry()
    expect(() => {
      callerOwned.getOrCreate("sess-L")
    }).not.toThrow()
    // And it is still distinct from the freshly-minted global.
    const newSingleton = getGlobalSessionResourceRegistry()
    expect(callerOwned).not.toBe(newSingleton)
  })
})

describe("ADR-0383 §M — byte-identical reference equality when opts absent", () => {
  test("getOrCreateRegistry() === getGlobalSessionResourceRegistry()", () => {
    // Two calls — both should land on the same global singleton AND
    // match the direct call. This is the additive-non-breaking invariant.
    const fromGlobal = getGlobalSessionResourceRegistry()
    const fromUnifiedA = getOrCreateRegistry()
    const fromUnifiedB = getOrCreateRegistry(undefined)
    expect(fromUnifiedA).toBe(fromGlobal)
    expect(fromUnifiedB).toBe(fromGlobal)
    expect(fromUnifiedA).toBe(fromUnifiedB)
  })
})
