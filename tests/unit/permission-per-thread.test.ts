/**
 * Unit tests for the permission stack (ADR-0046).
 *
 *   - per-thread set/get round-trip
 *   - per-host set/get round-trip
 *   - precedence resolver: post-denial > thread > host > global
 *   - actionSignature determinism
 *
 * Each test uses an isolated store (`createPermissionStore({ filePath })`)
 * pointed at a per-test tmp file so there's NO interference with the
 * singleton or with other parallel test files.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  computeActionSignature,
  createPermissionStore,
  evaluateStack,
  type PermissionStore,
  recordDenial,
  recordRiskSeen,
  recordUserOverride,
  setHostMode,
  setThreadPermission,
  type ThreadPermission,
} from "@/permission"

let tmp: string
let store: PermissionStore

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "quanta-perm-"))
  store = createPermissionStore({ filePath: join(tmp, "state.json"), debounceMs: 0 })
  await store.load()
})

afterEach(async () => {
  // Drain any queued writes BEFORE removing the tmp dir — otherwise a
  // debounced flush races the rmdir and surfaces an ENOENT warn.
  await store.flush()
  await rm(tmp, { recursive: true, force: true })
})

const READ_ONLY_FULL: ThreadPermission = {
  approvalPolicy: "never",
  approvalsReviewer: "agent",
  sandboxPolicy: { type: "read-only" },
}

const FULL_ACCESS: ThreadPermission = {
  approvalPolicy: "never",
  approvalsReviewer: "agent",
  sandboxPolicy: { type: "danger-full-access" },
}

const WORKSPACE_WRITE_ROOTS: ThreadPermission = {
  approvalPolicy: "on-request",
  approvalsReviewer: "user",
  sandboxPolicy: { type: "workspace-write", writableRoots: ["/tmp/work"] },
}

describe("per-thread permission store — round-trip", () => {
  test("set then get returns the same record", () => {
    setThreadPermission("t1", FULL_ACCESS, store)
    expect(store.getThread("t1")).toEqual(FULL_ACCESS)
  })

  test("setting a record overwrites prior", () => {
    setThreadPermission("t1", FULL_ACCESS, store)
    setThreadPermission("t1", READ_ONLY_FULL, store)
    expect(store.getThread("t1")).toEqual(READ_ONLY_FULL)
  })

  test("clearing a record removes it", () => {
    setThreadPermission("t1", FULL_ACCESS, store)
    store.clearThread("t1")
    expect(store.getThread("t1")).toBeUndefined()
  })

  test("threads are independent", () => {
    setThreadPermission("t1", FULL_ACCESS, store)
    setThreadPermission("t2", READ_ONLY_FULL, store)
    expect(store.getThread("t1")).toEqual(FULL_ACCESS)
    expect(store.getThread("t2")).toEqual(READ_ONLY_FULL)
  })
})

describe("per-host mode store — round-trip", () => {
  test("set then get returns the same mode", () => {
    setHostMode("localhost", "full-access", store)
    expect(store.getHost("localhost")).toBe("full-access")
  })

  test("setting overwrites prior", () => {
    setHostMode("h1", "full-access", store)
    setHostMode("h1", "read-only", store)
    expect(store.getHost("h1")).toBe("read-only")
  })

  test("clearing removes the mode", () => {
    setHostMode("h1", "full-access", store)
    store.clearHost("h1")
    expect(store.getHost("h1")).toBeUndefined()
  })

  test("hosts are independent", () => {
    setHostMode("a", "full-access", store)
    setHostMode("b", "read-only", store)
    expect(store.getHost("a")).toBe("full-access")
    expect(store.getHost("b")).toBe("read-only")
  })
})

describe("actionSignature — determinism + structural identity", () => {
  test("same input ⇒ same signature", () => {
    const a = computeActionSignature({
      tool: "bash",
      workdir: "/repo",
      args: { command: "ls", cwd: "/repo" },
    })
    const b = computeActionSignature({
      tool: "bash",
      workdir: "/repo",
      args: { command: "ls", cwd: "/repo" },
    })
    expect(a).toBe(b)
    expect(a.length).toBe(32)
  })

  test("argument key order does NOT change the signature (canonicalization)", () => {
    const a = computeActionSignature({
      tool: "edit",
      workdir: "/repo",
      args: { path: "foo", content: "bar" },
    })
    const b = computeActionSignature({
      tool: "edit",
      workdir: "/repo",
      args: { content: "bar", path: "foo" },
    })
    expect(a).toBe(b)
  })

  test("different tool ⇒ different signature", () => {
    const a = computeActionSignature({ tool: "bash", workdir: "/repo", args: {} })
    const b = computeActionSignature({ tool: "edit", workdir: "/repo", args: {} })
    expect(a).not.toBe(b)
  })

  test("different workdir ⇒ different signature", () => {
    const a = computeActionSignature({ tool: "bash", workdir: "/a", args: {} })
    const b = computeActionSignature({ tool: "bash", workdir: "/b", args: {} })
    expect(a).not.toBe(b)
  })
})

describe("evaluateStack — precedence ordering", () => {
  const mutatingAction = {
    tool: "edit",
    input: { path: "x" },
    isReadOnly: false,
  }
  const stackCtx = {
    threadId: "t1",
    hostId: "h1",
    actionSignature: "deadbeefdeadbeefdeadbeefdeadbeef",
    workdir: "/repo",
  }

  test("read-only action ⇒ allow regardless of stack", () => {
    setThreadPermission("t1", READ_ONLY_FULL, store)
    const d = evaluateStack(
      { tool: "read", input: {}, isReadOnly: true },
      { mode: "default" },
      stackCtx,
      { store },
    )
    expect(d.kind).toBe("allow")
  })

  test("per-thread read-only DENIES a mutating action even if host is full-access", () => {
    setThreadPermission("t1", READ_ONLY_FULL, store)
    setHostMode("h1", "full-access", store)
    const d = evaluateStack(mutatingAction, { mode: "bypass" }, stackCtx, { store })
    expect(d.kind).toBe("deny")
    if (d.kind === "deny") expect(d.stackSource).toBe("per-thread")
  })

  test("per-thread full-access ALLOWS even when host is read-only", () => {
    setThreadPermission("t1", FULL_ACCESS, store)
    setHostMode("h1", "read-only", store)
    const d = evaluateStack(mutatingAction, { mode: "default" }, stackCtx, { store })
    expect(d.kind).toBe("allow")
  })

  test("per-host read-only DENIES when no per-thread record exists", () => {
    setHostMode("h1", "read-only", store)
    const d = evaluateStack(mutatingAction, { mode: "bypass" }, stackCtx, { store })
    expect(d.kind).toBe("deny")
    if (d.kind === "deny") expect(d.stackSource).toBe("per-host")
  })

  test("per-host full-access ALLOWS when no per-thread record exists", () => {
    setHostMode("h1", "full-access", store)
    const d = evaluateStack(mutatingAction, { mode: "default" }, stackCtx, { store })
    expect(d.kind).toBe("allow")
  })

  test("no thread + no host ⇒ falls through to global default policy", () => {
    // default mode ⇒ mutating action ⇒ ask
    const askResult = evaluateStack(mutatingAction, { mode: "default" }, stackCtx, { store })
    expect(askResult.kind).toBe("ask")
    // bypass mode ⇒ allow
    const allowResult = evaluateStack(mutatingAction, { mode: "bypass" }, stackCtx, { store })
    expect(allowResult.kind).toBe("allow")
  })

  test("post-denial override beats per-thread read-only", () => {
    setThreadPermission("t1", READ_ONLY_FULL, store)
    const sig = recordDenial(
      { threadId: "t1", tool: "edit", workdir: "/repo", args: { path: "x" } },
      "test denial",
      { store, clock: { now: () => 100 } },
    )
    recordRiskSeen(
      { threadId: "t1", tool: "edit", workdir: "/repo", args: { path: "x" } },
      { store, clock: { now: () => 200 } },
    )
    recordUserOverride(
      { threadId: "t1", tool: "edit", workdir: "/repo", args: { path: "x" } },
      { store, clock: { now: () => 300 } },
    )
    const d = evaluateStack(
      mutatingAction,
      { mode: "default" },
      { ...stackCtx, actionSignature: sig },
      { store },
    )
    expect(d.kind).toBe("allow")
  })

  test("HARD_DENY beats post-denial override (security boundary)", () => {
    // bash with `rm -rf /` — HARD_DENY rule fires regardless of stack.
    const sig = computeActionSignature({
      tool: "bash",
      workdir: "/repo",
      args: { command: "rm -rf /" },
    })
    recordDenial(
      { threadId: "t1", tool: "bash", workdir: "/repo", args: { command: "rm -rf /" } },
      "denied",
      { store, clock: { now: () => 1 } },
    )
    recordRiskSeen(
      { threadId: "t1", tool: "bash", workdir: "/repo", args: { command: "rm -rf /" } },
      { store, clock: { now: () => 2 } },
    )
    recordUserOverride(
      { threadId: "t1", tool: "bash", workdir: "/repo", args: { command: "rm -rf /" } },
      { store, clock: { now: () => 3 } },
    )
    const d = evaluateStack(
      {
        tool: "bash",
        input: { command: "rm -rf /" },
        isReadOnly: false,
        shellCommand: "rm -rf /",
      },
      { mode: "bypass" },
      { ...stackCtx, actionSignature: sig },
      { store },
    )
    expect(d.kind).toBe("deny")
  })

  test("workspace-write with writableRoots ALLOWS only matching workdirs", () => {
    setThreadPermission("t1", WORKSPACE_WRITE_ROOTS, store)
    const allowed = evaluateStack(
      mutatingAction,
      { mode: "default" },
      { ...stackCtx, workdir: "/tmp/work/sub" },
      { store },
    )
    expect(allowed.kind).toBe("allow")
    const denied = evaluateStack(
      mutatingAction,
      { mode: "default" },
      { ...stackCtx, workdir: "/tmp/other" },
      { store },
    )
    expect(denied.kind).toBe("deny")
  })
})

describe("permission-store — persistence round-trip", () => {
  test("setThreadPermission survives flush + fresh store load", async () => {
    setThreadPermission("t1", FULL_ACCESS, store)
    setHostMode("hostA", "read-only", store)
    await store.flush()
    // Build a NEW store pointed at the same file — simulates process restart.
    const reborn = createPermissionStore({
      filePath: join(tmp, "state.json"),
      debounceMs: 0,
    })
    await reborn.load()
    expect(reborn.getThread("t1")).toEqual(FULL_ACCESS)
    expect(reborn.getHost("hostA")).toBe("read-only")
  })

  test("clearThread is persisted (record gone on reload)", async () => {
    setThreadPermission("t1", FULL_ACCESS, store)
    await store.flush()
    store.clearThread("t1")
    await store.flush()
    const reborn = createPermissionStore({
      filePath: join(tmp, "state.json"),
      debounceMs: 0,
    })
    await reborn.load()
    expect(reborn.getThread("t1")).toBeUndefined()
  })

  test("corrupt state file is quarantined to .corrupt sidecar (no crash)", async () => {
    const { writeFile, access } = await import("node:fs/promises")
    const file = join(tmp, "corrupt-state.json")
    await writeFile(file, "{not-json}", "utf8")
    const s = createPermissionStore({ filePath: file, debounceMs: 0 })
    await s.load() // must not throw
    // Sidecar created — recoverable.
    await access(`${file}.corrupt`) // throws if missing
    // Store comes up empty.
    expect(s.getThread("t1")).toBeUndefined()
    expect(s.getHost("h1")).toBeUndefined()
  })

  test("missing file ⇒ empty store, no error", async () => {
    const file = join(tmp, "does-not-exist.json")
    const s = createPermissionStore({ filePath: file, debounceMs: 0 })
    await s.load()
    expect(s.snapshot().perThread).toEqual({})
    expect(s.snapshot().perHost).toEqual({})
    expect(s.snapshot().deniedActions).toEqual({})
  })

  test("denial record survives reload (post-denial precedence is durable)", async () => {
    recordDenial({ threadId: "t1", tool: "edit", workdir: "/repo", args: { path: "x" } }, "test", {
      store,
      clock: { now: () => 100 },
    })
    recordRiskSeen(
      { threadId: "t1", tool: "edit", workdir: "/repo", args: { path: "x" } },
      { store, clock: { now: () => 200 } },
    )
    recordUserOverride(
      { threadId: "t1", tool: "edit", workdir: "/repo", args: { path: "x" } },
      { store, clock: { now: () => 300 } },
    )
    await store.flush()
    const reborn = createPermissionStore({
      filePath: join(tmp, "state.json"),
      debounceMs: 0,
    })
    await reborn.load()
    const sig = computeActionSignature({
      tool: "edit",
      workdir: "/repo",
      args: { path: "x" },
    })
    expect(reborn.hasPostDenialOverride("t1", sig)).toBe(true)
  })
})
