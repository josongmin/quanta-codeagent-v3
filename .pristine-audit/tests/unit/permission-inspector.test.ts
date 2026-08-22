/**
 * Unit tests for the permission inspector (ADR-0046 follow-up).
 *
 *   - list*() reflects what was set on the store
 *   - explainResolution returns the correct `source` per axis
 *   - explainResolution matches the verdict shape of evaluateStack
 *     (same precedence, same outcome — inspector is the "why" sibling)
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  computeActionSignature,
  createPermissionStore,
  evaluateStack,
  getPermissionInspector,
  type PermissionStore,
  recordDenial,
  recordRiskSeen,
  recordUserOverride,
} from "@/permission"

let tmp: string
let store: PermissionStore

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "quanta-perm-insp-"))
  store = createPermissionStore({ filePath: join(tmp, "state.json"), debounceMs: 0 })
  await store.load()
})

afterEach(async () => {
  await store.flush()
  await rm(tmp, { recursive: true, force: true })
})

describe("inspector — list APIs", () => {
  test("listThreadPermissions reflects every record set via the store", () => {
    store.setThread("t1", {
      approvalPolicy: "never",
      approvalsReviewer: "agent",
      sandboxPolicy: { type: "read-only" },
    })
    store.setThread("t2", {
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "danger-full-access" },
    })
    const insp = getPermissionInspector({ store })
    const list = insp.listThreadPermissions()
    expect(list.size).toBe(2)
    expect(list.get("t1")?.sandboxPolicy.type).toBe("read-only")
    expect(list.get("t2")?.sandboxPolicy.type).toBe("danger-full-access")
  })

  test("listHostModes reflects every host set", () => {
    store.setHost("localhost", "full-access")
    store.setHost("h-prod", "read-only")
    const insp = getPermissionInspector({ store })
    const list = insp.listHostModes()
    expect(list.size).toBe(2)
    expect(list.get("localhost")).toBe("full-access")
    expect(list.get("h-prod")).toBe("read-only")
  })

  test("listPostDenialOverrides returns ALL denial records for the thread (any stage)", () => {
    const action1 = { threadId: "t1", tool: "edit", workdir: "/", args: { path: "a" } }
    const action2 = { threadId: "t1", tool: "edit", workdir: "/", args: { path: "b" } }
    const action3 = { threadId: "t2", tool: "edit", workdir: "/", args: { path: "a" } }
    recordDenial(action1, "test", { store, clock: { now: () => 1 } })
    recordDenial(action2, "test", { store, clock: { now: () => 2 } })
    recordDenial(action3, "test", { store, clock: { now: () => 3 } })
    // Advance one to completion
    recordRiskSeen(action1, { store, clock: { now: () => 4 } })
    recordUserOverride(action1, { store, clock: { now: () => 5 } })
    const insp = getPermissionInspector({ store })
    const t1Denials = insp.listPostDenialOverrides("t1")
    expect(t1Denials).toHaveLength(2)
    // One of them is fully overridden
    const completed = t1Denials.filter(
      (d) => d.seenRiskAt !== undefined && d.userOverrideAt !== undefined,
    )
    expect(completed).toHaveLength(1)
    expect(insp.listPostDenialOverrides("t2")).toHaveLength(1)
    expect(insp.listPostDenialOverrides("never")).toHaveLength(0)
  })
})

describe("inspector — explainResolution sources", () => {
  test("read-only ⇒ source = read-only-bypass", () => {
    const insp = getPermissionInspector({ store })
    const r = insp.explainResolution({
      tool: "read",
      workdir: "/repo",
      args: {},
      threadId: "t1",
      hostId: "h1",
      isReadOnly: true,
    })
    expect(r.outcome).toBe("allow")
    expect(r.source).toBe("read-only-bypass")
  })

  test("per-thread record decides ⇒ source = per-thread", () => {
    store.setThread("t1", {
      approvalPolicy: "never",
      approvalsReviewer: "agent",
      sandboxPolicy: { type: "read-only" },
    })
    store.setHost("h1", "full-access")
    const insp = getPermissionInspector({ store })
    const r = insp.explainResolution({
      tool: "edit",
      workdir: "/repo",
      args: { path: "x" },
      threadId: "t1",
      hostId: "h1",
    })
    expect(r.outcome).toBe("deny")
    expect(r.source).toBe("per-thread")
    expect(r.reason).toContain("Per-thread")
  })

  test("no per-thread + per-host decides ⇒ source = per-host", () => {
    store.setHost("h1", "read-only")
    const insp = getPermissionInspector({ store })
    const r = insp.explainResolution({
      tool: "edit",
      workdir: "/repo",
      args: { path: "x" },
      threadId: "t1",
      hostId: "h1",
    })
    expect(r.outcome).toBe("deny")
    expect(r.source).toBe("per-host")
    expect(r.reason).toContain("Per-host")
  })

  test("no record on either axis ⇒ source = global-default, outcome = ask", () => {
    const insp = getPermissionInspector({ store })
    const r = insp.explainResolution({
      tool: "edit",
      workdir: "/repo",
      args: {},
      threadId: "t1",
      hostId: "h1",
    })
    expect(r.outcome).toBe("ask")
    expect(r.source).toBe("global-default")
  })

  test("post-denial override active ⇒ source = post-denial-override", () => {
    store.setThread("t1", {
      approvalPolicy: "never",
      approvalsReviewer: "agent",
      sandboxPolicy: { type: "read-only" },
    })
    const action = { threadId: "t1", tool: "edit", workdir: "/repo", args: { path: "x" } }
    recordDenial(action, "test", { store, clock: { now: () => 100 } })
    recordRiskSeen(action, { store, clock: { now: () => 200 } })
    recordUserOverride(action, { store, clock: { now: () => 300 } })
    const insp = getPermissionInspector({ store })
    const r = insp.explainResolution({
      tool: "edit",
      workdir: "/repo",
      args: { path: "x" },
      threadId: "t1",
      hostId: "h1",
    })
    expect(r.outcome).toBe("allow")
    expect(r.source).toBe("post-denial-override")
  })

  test("actionSignature returned matches computeActionSignature for the same input", () => {
    const insp = getPermissionInspector({ store })
    const r = insp.explainResolution({
      tool: "edit",
      workdir: "/repo",
      args: { path: "x" },
      threadId: "t1",
      hostId: "h1",
    })
    const direct = computeActionSignature({
      tool: "edit",
      workdir: "/repo",
      args: { path: "x" },
    })
    expect(r.actionSignature).toBe(direct)
  })
})

describe("inspector — agreement with evaluateStack", () => {
  test("explain.outcome matches evaluateStack.kind for every axis", () => {
    store.setHost("h1", "read-only")
    const insp = getPermissionInspector({ store })
    const stackCtx = {
      threadId: "t1",
      hostId: "h1",
      actionSignature: computeActionSignature({ tool: "edit", workdir: "/", args: {} }),
      workdir: "/",
    }
    const stack = evaluateStack(
      { tool: "edit", input: {}, isReadOnly: false },
      { mode: "default" },
      stackCtx,
      { store },
    )
    const explain = insp.explainResolution({
      tool: "edit",
      workdir: "/",
      args: {},
      threadId: "t1",
      hostId: "h1",
    })
    expect(explain.outcome).toBe(stack.kind === "deny" ? "deny" : "allow")
    expect(explain.source).toBe("per-host")
  })
})
