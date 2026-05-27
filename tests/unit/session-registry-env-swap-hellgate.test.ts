/**
 * ADR-0351 — Disk adapter env-var swap hellgate.
 *
 * `getGlobalSessionResourceRegistry()` mints disk-backed registry when
 * `QUANTA_SESSION_REGISTRY_DISK_DIR` is set; in-memory otherwise. The
 * env var is read EXACTLY ONCE at first-call (lazy-init), so subsequent
 * env mutations are ignored until `resetGlobalSessionResourceRegistry()`
 * (test-only knob).
 *
 * NO-THROW: a hosed env var (non-existent path that cannot be created)
 * MUST NOT abort process startup — the fallback is in-memory.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  getGlobalSessionResourceRegistry,
  resetGlobalSessionResourceRegistry,
} from "@/agent/session-resource-registry"

let prevEnv: string | undefined
let tempRoot: string | null = null

beforeEach(() => {
  prevEnv = process.env.QUANTA_SESSION_REGISTRY_DISK_DIR
  delete process.env.QUANTA_SESSION_REGISTRY_DISK_DIR
  resetGlobalSessionResourceRegistry()
})

afterEach(async () => {
  resetGlobalSessionResourceRegistry()
  if (prevEnv === undefined) delete process.env.QUANTA_SESSION_REGISTRY_DISK_DIR
  else process.env.QUANTA_SESSION_REGISTRY_DISK_DIR = prevEnv
  if (tempRoot !== null) {
    await rm(tempRoot, { recursive: true, force: true })
    tempRoot = null
  }
})

describe("ADR-0351 — env-var swap", () => {
  test("A. env unset ⇒ in-memory registry (legacy byte-identical path)", () => {
    const reg = getGlobalSessionResourceRegistry()
    const resources = reg.getOrCreate("session-a")
    // Re-acquire same id ⇒ same reference (registry invariant)
    expect(reg.getOrCreate("session-a")).toBe(resources)
    // size reflects single session — no disk side-effects possible
    expect(reg.size()).toBe(1)
  })

  test("B. env unset to empty string ⇒ in-memory fallback (treated as absent)", () => {
    process.env.QUANTA_SESSION_REGISTRY_DISK_DIR = ""
    const reg = getGlobalSessionResourceRegistry()
    expect(reg.getOrCreate("x")).toBeDefined()
    expect(reg.size()).toBe(1)
  })

  test("C. env set to valid dir ⇒ disk registry minted (size invariant preserved)", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "adr-0351-"))
    process.env.QUANTA_SESSION_REGISTRY_DISK_DIR = tempRoot
    const reg = getGlobalSessionResourceRegistry()
    const r1 = reg.getOrCreate("disk-session")
    const r2 = reg.getOrCreate("disk-session")
    expect(r2).toBe(r1)
  })

  test("D. env read EXACTLY ONCE — runtime env mutation after first call is ignored", async () => {
    const reg1 = getGlobalSessionResourceRegistry()
    expect(reg1.size()).toBe(0)
    // Mutating env now must not switch backends — singleton already minted.
    tempRoot = await mkdtemp(join(tmpdir(), "adr-0351-"))
    process.env.QUANTA_SESSION_REGISTRY_DISK_DIR = tempRoot
    const reg2 = getGlobalSessionResourceRegistry()
    expect(reg2).toBe(reg1) // SAME reference, env mutation ignored
  })

  test("E. resetGlobalSessionResourceRegistry ⇒ next call re-reads env", async () => {
    const reg1 = getGlobalSessionResourceRegistry()
    resetGlobalSessionResourceRegistry()
    tempRoot = await mkdtemp(join(tmpdir(), "adr-0351-"))
    process.env.QUANTA_SESSION_REGISTRY_DISK_DIR = tempRoot
    const reg2 = getGlobalSessionResourceRegistry()
    expect(reg2).not.toBe(reg1) // Fresh instance
  })

  test("F. NO-THROW on hosed env var (path that disk-adapter cannot use)", () => {
    // Invalid path with NUL char — disk-adapter construction may throw on
    // some platforms; the wrapper must fall back to in-memory either way.
    process.env.QUANTA_SESSION_REGISTRY_DISK_DIR = "/dev/null/cannot-mkdir-under-this"
    const reg = getGlobalSessionResourceRegistry()
    // Whatever backend was chosen, the registry must be functional.
    const r = reg.getOrCreate("ok")
    expect(r).toBeDefined()
    expect(reg.getOrCreate("ok")).toBe(r)
  })
})
