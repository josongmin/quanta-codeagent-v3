/**
 * Hardening tests for the permission-store (ADR-0046 3-pass audit).
 *
 *   - orphan `.tmp` from a crashed prior write is cleaned up
 *   - missing parent dir is auto-created
 *   - schema-version mismatch quarantines to `.unsupported-vN` sidecar
 *   - whitespace differences inside command strings ⇒ DIFFERENT signatures
 *     (documents the ADR-0046 §Risks §4 invariant)
 *   - concurrent writers (two stores on the same file) ⇒ last-write-wins
 *     but no torn JSON
 *   - idempotent set*() does not schedule an unnecessary disk write
 *   - reset() awaits in-flight write before unlinking (no resurrection)
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { computeActionSignature, createPermissionStore, type PermissionStore } from "@/permission"

let tmp: string
let store: PermissionStore

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "quanta-perm-hard-"))
  store = createPermissionStore({ filePath: join(tmp, "state.json"), debounceMs: 0 })
  await store.load()
})

afterEach(async () => {
  await store.flush()
  await rm(tmp, { recursive: true, force: true })
})

describe("permission-store — atomic write hardening", () => {
  test("orphan .tmp from a crashed prior write does not block a fresh write", async () => {
    const filePath = join(tmp, "state.json")
    // Simulate a crashed previous write that left a partial `.tmp` behind.
    await writeFile(`${filePath}.tmp`, "{not-the-real-payload}", "utf8")
    const s = createPermissionStore({ filePath, debounceMs: 0 })
    await s.load()
    s.setThread("t1", {
      approvalPolicy: "never",
      approvalsReviewer: "agent",
      sandboxPolicy: { type: "danger-full-access" },
    })
    await s.flush()
    // Final file must contain the new payload, not the orphan bytes.
    const written = await readFile(filePath, "utf8")
    expect(written).toContain('"t1"')
    expect(written).not.toContain("not-the-real-payload")
  })

  test("missing parent dir is created on first write", async () => {
    const filePath = join(tmp, "nested", "dir", "state.json")
    const s = createPermissionStore({ filePath, debounceMs: 0 })
    await s.load()
    s.setHost("h1", "read-only")
    await s.flush()
    // Both file AND its parent dirs must exist.
    await access(filePath)
    const st = await stat(dirname(filePath))
    expect(st.isDirectory()).toBe(true)
  })

  test("write failure cleans up partial .tmp (no orphan accumulation)", async () => {
    // Force a failure by pointing the store at a path whose parent is a FILE
    // (mkdir then fails). Verify the `.tmp` doesn't linger after the failed
    // write — best-effort cleanup branch in writeToDisk().
    const blocker = join(tmp, "blocker")
    await writeFile(blocker, "this is a file, not a dir", "utf8")
    const filePath = join(blocker, "state.json") // blocker is a file ⇒ mkdir fails
    const s = createPermissionStore({ filePath, debounceMs: 0 })
    await s.load()
    s.setHost("h1", "read-only")
    await s.flush()
    // Either the write succeeded (some platforms allow it) or it failed and
    // the .tmp was cleaned up. Both are acceptable — what we forbid is a
    // dangling `.tmp` next to the blocker file.
    let tmpFileExists = true
    try {
      await access(`${filePath}.tmp`)
    } catch {
      tmpFileExists = false
    }
    expect(tmpFileExists).toBe(false)
  })
})

describe("permission-store — schema versioning", () => {
  test("future version on disk ⇒ quarantine to .unsupported-vN sidecar + start empty", async () => {
    const filePath = join(tmp, "future-state.json")
    // Plant a state file with a SCHEMA VERSION the runtime doesn't know yet.
    await writeFile(
      filePath,
      JSON.stringify({ version: 999, perThread: { t1: "should-not-load" } }),
      "utf8",
    )
    const s = createPermissionStore({ filePath, debounceMs: 0 })
    await s.load()
    // In-memory state is empty — the future payload was NOT silently honored.
    expect(s.snapshot().perThread).toEqual({})
    // Quarantine sidecar exists so a future migrator can recover the bytes.
    await access(`${filePath}.unsupported-v999`)
  })

  test("string version on disk (legacy non-integer) ⇒ same quarantine path", async () => {
    const filePath = join(tmp, "string-version-state.json")
    await writeFile(filePath, JSON.stringify({ version: "1.0.0-beta" }), "utf8")
    const s = createPermissionStore({ filePath, debounceMs: 0 })
    await s.load()
    expect(s.snapshot().perThread).toEqual({})
    await access(`${filePath}.unsupported-v1.0.0-beta`)
  })

  test("missing version key ⇒ treated as mismatch (no silent acceptance)", async () => {
    const filePath = join(tmp, "noversion-state.json")
    await writeFile(filePath, JSON.stringify({ perThread: { t1: "bypass" } }), "utf8")
    const s = createPermissionStore({ filePath, debounceMs: 0 })
    await s.load()
    expect(s.snapshot().perThread).toEqual({})
  })
})

describe("actionSignature — adversarial inputs", () => {
  test("whitespace difference in cmd ⇒ DIFFERENT signature (documented in ADR-0046 §Risks §4)", () => {
    const a = computeActionSignature({
      tool: "bash",
      workdir: "/repo",
      args: { command: "ls" },
    })
    const b = computeActionSignature({
      tool: "bash",
      workdir: "/repo",
      args: { command: "ls " }, // trailing space
    })
    // Documented as expected behavior: post-denial override matches by exact
    // structural fingerprint. Tool-level schemas normalize before reaching
    // the signature path (see ADR §Risks §4).
    expect(a).not.toBe(b)
  })

  test("deeply nested args still canonicalize on key order", () => {
    const a = computeActionSignature({
      tool: "edit",
      workdir: "/repo",
      args: { meta: { author: "a", time: 1 }, body: "x" },
    })
    const b = computeActionSignature({
      tool: "edit",
      workdir: "/repo",
      args: { body: "x", meta: { time: 1, author: "a" } },
    })
    expect(a).toBe(b)
  })

  test("array order IS significant (positional semantics preserved)", () => {
    const a = computeActionSignature({
      tool: "bash",
      workdir: "/repo",
      args: { cmd: ["a", "b"] },
    })
    const b = computeActionSignature({
      tool: "bash",
      workdir: "/repo",
      args: { cmd: ["b", "a"] },
    })
    expect(a).not.toBe(b)
  })

  test("signature length is exactly 32 hex chars (128 bit truncation)", () => {
    const s = computeActionSignature({ tool: "x", workdir: "/", args: {} })
    expect(s.length).toBe(32)
    expect(/^[0-9a-f]{32}$/.test(s)).toBe(true)
  })
})

describe("permission-store — concurrency", () => {
  test("two stores on the same file → last-write-wins, no torn JSON", async () => {
    const filePath = join(tmp, "shared-state.json")
    const a = createPermissionStore({ filePath, debounceMs: 0 })
    const b = createPermissionStore({ filePath, debounceMs: 0 })
    await a.load()
    await b.load()
    a.setHost("h-a", "full-access")
    b.setHost("h-b", "read-only")
    await Promise.all([a.flush(), b.flush()])
    // File must be valid JSON (atomic rename prevented torn-write).
    const raw = await readFile(filePath, "utf8")
    const parsed = JSON.parse(raw) as { perHost: Record<string, string> }
    // Last-write-wins: one of the writes won; the loser is lost. ADR-0046
    // documents this as accepted (v3 = single-process assumption).
    const hosts = parsed.perHost
    const winnerCount =
      Number(hosts["h-a"] === "full-access") + Number(hosts["h-b"] === "read-only")
    // At least one winner is present; both could coincidentally land
    // (Promise.all serializes nothing, but the disk rename is atomic).
    expect(winnerCount).toBeGreaterThanOrEqual(1)
  })

  test("burst of writes serializes through pendingFlush (no concurrent rename)", async () => {
    // 50 rapid mutations should resolve to a single coherent final state,
    // not interleave/race. We can't directly observe rename concurrency, but
    // we CAN verify the final on-disk bytes match the last `set`.
    for (let i = 0; i < 50; i++) {
      store.setHost(`h-${i}`, i % 2 === 0 ? "read-only" : "full-access")
    }
    await store.flush()
    const filePath = join(tmp, "state.json")
    const raw = await readFile(filePath, "utf8")
    const parsed = JSON.parse(raw) as { perHost: Record<string, string> }
    expect(Object.keys(parsed.perHost)).toHaveLength(50)
    expect(parsed.perHost["h-49"]).toBe("full-access")
  })
})

describe("permission-store — idempotency", () => {
  test("setHost with the same mode twice ⇒ no second write", async () => {
    const filePath = join(tmp, "state.json")
    store.setHost("h1", "read-only")
    await store.flush()
    const mtimeAfterFirst = (await stat(filePath)).mtimeMs
    // Wait a tick so a fresh write would have a distinct mtime.
    await new Promise((r) => setTimeout(r, 5))
    store.setHost("h1", "read-only") // identical — should be a no-op
    await store.flush()
    const mtimeAfterSecond = (await stat(filePath)).mtimeMs
    expect(mtimeAfterSecond).toBe(mtimeAfterFirst)
  })

  test("setThread with structurally-equal perm twice ⇒ no second write", async () => {
    const filePath = join(tmp, "state.json")
    const perm = {
      approvalPolicy: "never" as const,
      approvalsReviewer: "agent" as const,
      sandboxPolicy: { type: "read-only" as const },
    }
    store.setThread("t1", perm)
    await store.flush()
    const mtimeAfterFirst = (await stat(filePath)).mtimeMs
    await new Promise((r) => setTimeout(r, 5))
    // Different object reference, same content.
    store.setThread("t1", { ...perm, sandboxPolicy: { ...perm.sandboxPolicy } })
    await store.flush()
    const mtimeAfterSecond = (await stat(filePath)).mtimeMs
    expect(mtimeAfterSecond).toBe(mtimeAfterFirst)
  })

  test("clear*() on a non-existent key ⇒ no write", async () => {
    const filePath = join(tmp, "state.json")
    store.setHost("h1", "read-only")
    await store.flush()
    const mtime1 = (await stat(filePath)).mtimeMs
    await new Promise((r) => setTimeout(r, 5))
    store.clearThread("never-existed") // no-op
    await store.flush()
    const mtime2 = (await stat(filePath)).mtimeMs
    expect(mtime2).toBe(mtime1)
  })
})

describe("permission-store — reset()", () => {
  test("reset() awaits queued write so the file does not resurrect", async () => {
    store.setHost("h1", "read-only")
    // Don't flush — let the queued write be in flight when reset() runs.
    await store.reset()
    // File should NOT exist (reset unlinked it AFTER the in-flight write
    // finished — without the await fix this could leave a stale file).
    const filePath = join(tmp, "state.json")
    let exists = true
    try {
      await access(filePath)
    } catch {
      exists = false
    }
    expect(exists).toBe(false)
  })

  test("reset() leaves store in a usable empty state", async () => {
    store.setHost("h1", "read-only")
    await store.reset()
    expect(store.getHost("h1")).toBeUndefined()
    // Loading a fresh state should work — no stuck `loaded` flag.
    await store.load()
    expect(store.snapshot().perHost).toEqual({})
  })
})

describe("permission-store — list APIs", () => {
  test("listThreads / listHosts return Map snapshots that reflect current state", () => {
    store.setHost("h1", "read-only")
    store.setHost("h2", "full-access")
    store.setThread("t1", {
      approvalPolicy: "never",
      approvalsReviewer: "agent",
      sandboxPolicy: { type: "danger-full-access" },
    })
    const hosts = store.listHosts()
    expect(hosts.size).toBe(2)
    expect(hosts.get("h1")).toBe("read-only")
    expect(hosts.get("h2")).toBe("full-access")
    const threads = store.listThreads()
    expect(threads.size).toBe(1)
    expect(threads.get("t1")?.sandboxPolicy.type).toBe("danger-full-access")
  })

  test("listThreadDenials filters to the named thread only", () => {
    const sigA = computeActionSignature({ tool: "edit", workdir: "/", args: { path: "a" } })
    const sigB = computeActionSignature({ tool: "edit", workdir: "/", args: { path: "b" } })
    store.recordDenial({
      threadId: "t1",
      actionSignature: sigA,
      deniedAt: 1,
      deniedReason: "x",
    })
    store.recordDenial({
      threadId: "t1",
      actionSignature: sigB,
      deniedAt: 2,
      deniedReason: "y",
    })
    store.recordDenial({
      threadId: "t2",
      actionSignature: sigA,
      deniedAt: 3,
      deniedReason: "z",
    })
    expect(store.listThreadDenials("t1")).toHaveLength(2)
    expect(store.listThreadDenials("t2")).toHaveLength(1)
    expect(store.listThreadDenials("never")).toHaveLength(0)
  })
})
