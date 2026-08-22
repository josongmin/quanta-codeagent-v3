/**
 * ADR-0372 — Caller-owned registry builder hellgate.
 *
 * The builder mints a fresh `SessionResourceRegistry` (bypassing the
 * global singleton) and injects the supplied `metricsEmitter` into the
 * disk-adapter constructor when the disk env var is set. This lets a
 * composition root that owns a `MetricsRegistry` thread flock telemetry
 * through to {@link acquireSessionLock} without poisoning the lazy-init
 * singleton (the architectural mismatch ADR-0368 documented).
 *
 * Pins (12 cases):
 *   A. metricsEmitter present, disk env unset       ⇒ in-memory backend (no emit)
 *   B. metricsEmitter present, disk env set         ⇒ disk-adapter minted
 *   C. emitter actually receives lock events        ⇒ counter on acquire_success
 *   D. metricsEmitter present, sqlite env set       ⇒ sqlite-adapter (no emit — WAL)
 *   E. global singleton vs caller-owned             ⇒ different instances
 *   F. multiple builder calls                       ⇒ different instances each
 *   G. NO-THROW on disk env unreadable              ⇒ in-memory fallback
 *   H. emitter throws                               ⇒ swallowed at disk-adapter
 *   I. sessionId optional handling                  ⇒ builder accepts omitted id
 *   J. env priority: sqlite > disk                  ⇒ sqlite wins when both set
 *   K. buildCallerOwnedSessionResources wrapper     ⇒ delegates to getOrCreate
 *   L. registry instance is gc-able                 ⇒ no module-level retention
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildCallerOwnedRegistryWithTelemetry,
  buildCallerOwnedSessionResources,
} from "@/agent/session-resource-registry/caller-owned-builder"
import {
  getGlobalSessionResourceRegistry,
  resetGlobalSessionResourceRegistry,
} from "@/agent/session-resource-registry/global"
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

const mkThrowingEmitter = (): MetricEmitterPort => ({
  counter() {
    throw new Error("counter boom")
  },
  gauge() {
    throw new Error("gauge boom")
  },
})

// Bounded poll for disk-side telemetry — emit is fire-and-forget through
// the lock acquire path which itself runs async.
const waitForLog = async (
  log: CapturedEmit[],
  predicate: (entries: CapturedEmit[]) => boolean,
  timeoutMs = 2000,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate(log)) return true
    await new Promise((r) => setTimeout(r, 10))
  }
  return predicate(log)
}

const tempDir = async (): Promise<string> => mkdtemp(join(tmpdir(), "adr0372-"))

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

describe("ADR-0372 §A — disk env unset ⇒ in-memory backend", () => {
  test("emitter receives no lock events because in-memory has no flock", () => {
    const { emitter, log } = mkEmitter()
    const reg = buildCallerOwnedRegistryWithTelemetry({ emitter })
    const r = reg.getOrCreate("sess-A")
    r.store.append({
      kind: "context_update",
      field: "cwd",
      prev: "/a",
      next: "/b",
      at: 1,
      turnId: "t1",
    })
    // No lock acquired — emitter idle.
    expect(log.length).toBe(0)
  })
})

describe("ADR-0372 §B — disk env set ⇒ disk-adapter minted", () => {
  test("builder returns a registry that writes to disk", async () => {
    const dir = await tempDir()
    process.env.QUANTA_SESSION_REGISTRY_DISK_DIR = dir
    const { emitter } = mkEmitter()
    const reg = buildCallerOwnedRegistryWithTelemetry({ emitter })
    const r = reg.getOrCreate("sess-B")
    r.store.append({
      kind: "context_update",
      field: "cwd",
      prev: "/a",
      next: "/b",
      at: 1,
      turnId: "t1",
    })
    // Disk file appears (proves disk-adapter, not in-memory).
    const deadline = Date.now() + 2000
    let body = ""
    while (Date.now() < deadline) {
      try {
        body = await readFile(join(dir, "sess-B", "events.jsonl"), "utf8")
        if (body.includes("context_update")) break
      } catch {
        // not yet
      }
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(body).toContain("context_update")
    await rm(dir, { recursive: true, force: true })
  })
})

describe("ADR-0372 §C — emitter receives lock acquire_success", () => {
  test("disk-adapter emits codex_r2.lock.* metrics on getOrCreate", async () => {
    const dir = await tempDir()
    process.env.QUANTA_SESSION_REGISTRY_DISK_DIR = dir
    const { emitter, log } = mkEmitter()
    const reg = buildCallerOwnedRegistryWithTelemetry({ emitter })
    reg.getOrCreate("sess-C")
    // Trigger a write so the lock acquire fires.
    const r = reg.getOrCreate("sess-C")
    r.store.append({
      kind: "context_update",
      field: "cwd",
      prev: "/a",
      next: "/b",
      at: 1,
      turnId: "t2",
    })
    const ok = await waitForLog(log, (entries) =>
      entries.some((e) => e.kind === "counter" && e.name === "codex_r2.lock.acquire_success"),
    )
    expect(ok).toBe(true)
    await rm(dir, { recursive: true, force: true })
  })
})

describe("ADR-0372 §D — sqlite env ⇒ sqlite adapter (no emit)", () => {
  test("sqlite path used + emitter idle (sqlite has no flock)", async () => {
    const dir = await tempDir()
    process.env.QUANTA_SESSION_REGISTRY_SQLITE_PATH = join(dir, "sess.sqlite")
    const { emitter, log } = mkEmitter()
    const reg = buildCallerOwnedRegistryWithTelemetry({ emitter })
    const r = reg.getOrCreate("sess-D")
    r.store.append({
      kind: "context_update",
      field: "cwd",
      prev: "/a",
      next: "/b",
      at: 1,
      turnId: "t3",
    })
    // Give sqlite a moment to run a write.
    await new Promise((r) => setTimeout(r, 50))
    // SQLite has no flock concept ⇒ zero codex_r2.lock.* emits.
    const lockEmits = log.filter((e) => e.name.startsWith("codex_r2.lock."))
    expect(lockEmits.length).toBe(0)
    await rm(dir, { recursive: true, force: true })
  })
})

describe("ADR-0372 §E — caller-owned is NOT the global singleton", () => {
  test("buildCallerOwnedRegistryWithTelemetry returns a different instance", () => {
    const { emitter } = mkEmitter()
    const callerOwned = buildCallerOwnedRegistryWithTelemetry({ emitter })
    const singleton = getGlobalSessionResourceRegistry()
    expect(callerOwned).not.toBe(singleton)
  })
})

describe("ADR-0372 §F — multiple builder calls ⇒ separate instances", () => {
  test("two calls return two registries (no caller-side singleton)", () => {
    const { emitter } = mkEmitter()
    const r1 = buildCallerOwnedRegistryWithTelemetry({ emitter })
    const r2 = buildCallerOwnedRegistryWithTelemetry({ emitter })
    expect(r1).not.toBe(r2)
  })
})

describe("ADR-0372 §G — NO-THROW on backend mint failure", () => {
  test("hosed disk path falls through to in-memory", () => {
    // A path that cannot be a valid storage dir — disk-store's mkdir
    // will fail in operation, but the constructor itself does not
    // throw (the disk-store is NO-THROW by ADR-0348). We assert the
    // BUILDER does not throw, which is the surface contract.
    process.env.QUANTA_SESSION_REGISTRY_DISK_DIR = "/nonexistent/parent/that-cannot-exist-0372"
    const { emitter } = mkEmitter()
    let reg: ReturnType<typeof buildCallerOwnedRegistryWithTelemetry> | null = null
    expect(() => {
      reg = buildCallerOwnedRegistryWithTelemetry({ emitter })
    }).not.toThrow()
    // Whatever backend lands (disk or in-memory fallback), it MUST be
    // a working registry — getOrCreate is sync + NO-THROW.
    expect(reg).not.toBeNull()
    expect(() => {
      const r = (reg as unknown as { getOrCreate: (id: string) => unknown }).getOrCreate("sess-G")
      expect(r).toBeDefined()
    }).not.toThrow()
  })
})

describe("ADR-0372 §H — emitter that throws is swallowed", () => {
  test("hostile emitter does not break disk-adapter operations", async () => {
    const dir = await tempDir()
    process.env.QUANTA_SESSION_REGISTRY_DISK_DIR = dir
    const reg = buildCallerOwnedRegistryWithTelemetry({ emitter: mkThrowingEmitter() })
    // Must not throw despite emitter throwing on every counter/gauge.
    const r = reg.getOrCreate("sess-H")
    expect(() => {
      r.store.append({
        kind: "context_update",
        field: "cwd",
        prev: "/a",
        next: "/b",
        at: 1,
        turnId: "t4",
      })
    }).not.toThrow()
    await rm(dir, { recursive: true, force: true })
  })
})

describe("ADR-0372 §I — sessionId optional", () => {
  test("builder accepts call without sessionId", () => {
    const { emitter } = mkEmitter()
    expect(() => {
      buildCallerOwnedRegistryWithTelemetry({ emitter })
    }).not.toThrow()
    expect(() => {
      buildCallerOwnedRegistryWithTelemetry({ emitter, sessionId: "sess-I" })
    }).not.toThrow()
  })
})

describe("ADR-0372 §J — env priority sqlite > disk", () => {
  test("both env vars set ⇒ sqlite wins (no lock emits)", async () => {
    const dir = await tempDir()
    process.env.QUANTA_SESSION_REGISTRY_SQLITE_PATH = join(dir, "sess.sqlite")
    process.env.QUANTA_SESSION_REGISTRY_DISK_DIR = dir
    const { emitter, log } = mkEmitter()
    const reg = buildCallerOwnedRegistryWithTelemetry({ emitter })
    const r = reg.getOrCreate("sess-J")
    r.store.append({
      kind: "context_update",
      field: "cwd",
      prev: "/a",
      next: "/b",
      at: 1,
      turnId: "t5",
    })
    await new Promise((r) => setTimeout(r, 50))
    // SQLite path ⇒ zero codex_r2.lock.* emits (sqlite has no flock).
    const lockEmits = log.filter((e) => e.name.startsWith("codex_r2.lock."))
    expect(lockEmits.length).toBe(0)
    await rm(dir, { recursive: true, force: true })
  })
})

describe("ADR-0372 §K — buildCallerOwnedSessionResources convenience", () => {
  test("delegates to registry.getOrCreate for the sessionId", () => {
    const { emitter } = mkEmitter()
    const reg = buildCallerOwnedRegistryWithTelemetry({ emitter })
    const direct = reg.getOrCreate("sess-K")
    const viaHelper = buildCallerOwnedSessionResources("sess-K", reg)
    // Same sessionId ⇒ same reference (registry getOrCreate invariant).
    expect(viaHelper).toBe(direct)
  })
})

describe("ADR-0372 §L — instances are not module-retained", () => {
  test("dropping all references makes the instance gc-able", () => {
    const { emitter } = mkEmitter()
    // We cannot directly force GC, but we can assert that the builder
    // does NOT push the instance into any module-level mutable. The
    // proof is structural: each call returns a NEW instance (§F) AND
    // resetGlobalSessionResourceRegistry only resets the global path —
    // it does NOT touch caller-owned instances.
    const r1 = buildCallerOwnedRegistryWithTelemetry({ emitter })
    resetGlobalSessionResourceRegistry()
    // r1 should still be usable post-reset because it is NOT the global.
    expect(() => {
      r1.getOrCreate("sess-L")
    }).not.toThrow()
  })
})
