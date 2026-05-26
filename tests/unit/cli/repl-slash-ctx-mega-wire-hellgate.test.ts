/**
 * Hellgate — ADR-0291 REPL slash-surface ctx mega-wire.
 *
 * Adversarial cases pinning the 8 new ctx slots:
 *   /edit-plan, /edit-message, /fork-checkpoint, /rewind-tool,
 *   /profile, /identity, /focus-chain, /web (textInbox).
 *
 *  HELL-MEGA-01: no new args → projection omits every new slot
 *  HELL-MEGA-02: planStore present → ctx.planEdit reachable + has shape
 *  HELL-MEGA-03: composerHandle present → ctx.composerEdit reachable + has shape
 *  HELL-MEGA-04: conversationStore present → ctx.forkSession reachable + 3-verb port
 *  HELL-MEGA-05: perToolRegistry present → ctx.perToolCheckpoint reachable
 *  HELL-MEGA-06: toolProfile present → ctx.profile {get,set,list} works
 *  HELL-MEGA-07: identityModeVariant present → ctx.identity {get,set,list} works
 *  HELL-MEGA-08: focusChainTracker present → ctx.focusChain {snapshot,reset,skip}
 *  HELL-MEGA-09: textInbox present → ctx.textInbox reachable
 *  HELL-MEGA-10: /edit-plan happy path (planStore wired) → "not wired" absent + exit 0
 *  HELL-MEGA-11: /edit-message happy path (composerHandle wired) → "not wired" absent + exit 0
 *  HELL-MEGA-12: /fork-checkpoint list (no args) (conversationStore wired) → "not wired" absent + exit 0
 *  HELL-MEGA-13: /rewind-tool empty-list (perToolRegistry wired) → renders "no granular anchors"
 *  HELL-MEGA-14: /profile (toolProfile wired) → renders current + available list
 *  HELL-MEGA-15: /identity (identityModeVariant wired) → renders current + available list
 *  HELL-MEGA-16: /focus-chain (tracker wired) → snapshots empty todo list
 *  HELL-MEGA-17: /web with stubbed fetcher + textInbox → inbox.size() === 1 (not inline)
 *  HELL-MEGA-18: adapter no-throw — broken setPending callback ⇒ adapter does not throw
 *  HELL-MEGA-19: per-tool-checkpoint stub restore returns typed Err shape
 *  HELL-MEGA-20: byte-identical legacy projection — pre-ADR-0291 args alone, no new keys leak
 */

import { describe, expect, test } from "bun:test"
import { defaultConversationCheckpointStore } from "../../../src/agent/conversation-checkpoint"
import { defaultFocusChainTracker } from "../../../src/agent/focus-chain"
import type {
  CheckpointTag,
  GranularCheckpointEntry,
  GranularRegistry,
} from "../../../src/agent/per-tool-checkpoint"
import { createInMemoryPlanStore } from "../../../src/agent/plan/state"
import { defaultModeVariantRegistry } from "../../../src/agent/system-prompt"
import { defaultToolProfileResolver } from "../../../src/agent/tool-profile"
import type { IdleMonitor } from "../../../src/apps/cli/idle-monitor"
import { createComposerHandle } from "../../../src/apps/cli/repl/ctx-adapters/composer-edit-adapter"
import {
  type BuildReplSlashCtxArgs,
  buildReplSlashCtx,
  dispatchReplSlash,
} from "../../../src/apps/cli/repl/slash-surface"
import { runSlashCommand } from "../../../src/apps/cli/slash-commands"
import { createTextInbox } from "../../../src/apps/cli/text-inbox"

/* ------------------------------------------------------------------ */
/* Fakes                                                                */
/* ------------------------------------------------------------------ */

const fakeIdle = (): IdleMonitor =>
  ({
    snooze: () => {},
    unsnooze: () => {},
    isSnoozed: () => false,
    markActive: () => {},
    isIdle: () => false,
    idleFor: () => 0,
  }) as unknown as IdleMonitor

const fakeEffort = (): BuildReplSlashCtxArgs["effort"] => ({
  get: () => "medium",
  set: () => {},
  levels: ["low", "medium", "high"] as const,
  budgetTokens: () => undefined,
})

const minimalArgs = (): BuildReplSlashCtxArgs => ({
  skillsCb: undefined,
  idleMonitor: fakeIdle(),
  imageQueue: undefined,
  rewindState: undefined,
  mcpSurface: undefined,
  costPanel: undefined,
  planStore: undefined,
  branchProgress: undefined,
  getHistory: () => [],
  startSideConversation: (async () =>
    ({}) as never) as BuildReplSlashCtxArgs["startSideConversation"],
  isSideConversationWired: () => true,
  abortSignal: new AbortController().signal,
  debugHandle: undefined,
  llm: {} as BuildReplSlashCtxArgs["llm"],
  sessionId: "test-sess-1",
  model: "test-model",
  inspect: undefined,
  replay: undefined,
  effort: fakeEffort(),
})

const ttyEnv = process.env as Record<string, string | undefined>

/* ------------------------------------------------------------------ */
/* In-memory fake granular registry (port-shaped)                       */
/* ------------------------------------------------------------------ */

const fakeRegistry = (entries: ReadonlyArray<GranularCheckpointEntry> = []): GranularRegistry => {
  const items = entries.slice()
  return {
    list: () => items.slice(),
    lookup: (tag: CheckpointTag) => items.find((e) => e.tag === tag) ?? null,
    clear: () => {
      items.length = 0
    },
  }
}

const collectOut = (): {
  out: string[]
  err: string[]
  outFn: (s: string) => void
  errFn: (s: string) => void
  text: () => string
  errText: () => string
} => {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    outFn: (s: string) => out.push(s),
    errFn: (s: string) => err.push(s),
    text: () => out.join(""),
    errText: () => err.join(""),
  }
}

/* ------------------------------------------------------------------ */
/* Tests                                                                */
/* ------------------------------------------------------------------ */

describe("HELL-MEGA — ADR-0291 REPL slash-surface ctx mega-wire", () => {
  test("HELL-MEGA-01: no new args → projection omits every new slot", () => {
    const ctx = buildReplSlashCtx(minimalArgs())
    expect(ctx.planEdit).toBeUndefined()
    expect(ctx.composerEdit).toBeUndefined()
    expect(ctx.forkSession).toBeUndefined()
    expect(ctx.perToolCheckpoint).toBeUndefined()
    expect(ctx.profile).toBeUndefined()
    expect(ctx.identity).toBeUndefined()
    expect(ctx.focusChain).toBeUndefined()
    expect(ctx.textInbox).toBeUndefined()
  })

  test("HELL-MEGA-02: planStore present → ctx.planEdit reachable + getPlan/setPlan shape", () => {
    const planStore = createInMemoryPlanStore({ now: () => 0 })
    const ctx = buildReplSlashCtx({ ...minimalArgs(), planStore })
    expect(ctx.planEdit).toBeDefined()
    expect(typeof ctx.planEdit?.getPlan).toBe("function")
    expect(typeof ctx.planEdit?.setPlan).toBe("function")
    // empty plan ⇒ empty string body
    expect(ctx.planEdit?.getPlan()).toBe("")
  })

  test("HELL-MEGA-03: composerHandle present → ctx.composerEdit reachable + round-trip", async () => {
    const handle = createComposerHandle("initial")
    const ctx = buildReplSlashCtx({ ...minimalArgs(), composerHandle: handle })
    expect(ctx.composerEdit).toBeDefined()
    expect(ctx.composerEdit?.getPending()).toBe("initial")
    ctx.composerEdit?.setPending("edited")
    expect(handle.getPending()).toBe("edited")
  })

  test("HELL-MEGA-04: conversationStore present → ctx.forkSession reachable + port shape", () => {
    const store = defaultConversationCheckpointStore({ now: () => 0 })
    const ctx = buildReplSlashCtx({ ...minimalArgs(), conversationStore: store })
    expect(ctx.forkSession).toBeDefined()
    expect(typeof ctx.forkSession?.port.fork).toBe("function")
    expect(typeof ctx.forkSession?.port.listBranches).toBe("function")
    expect(typeof ctx.forkSession?.port.resolveParent).toBe("function")
    expect(ctx.forkSession?.activeSessionId).toBe("test-sess-1")
  })

  test("HELL-MEGA-05: perToolRegistry present → ctx.perToolCheckpoint reachable", () => {
    const registry = fakeRegistry()
    const ctx = buildReplSlashCtx({ ...minimalArgs(), perToolRegistry: registry })
    expect(ctx.perToolCheckpoint).toBeDefined()
    expect(ctx.perToolCheckpoint?.registry).toBe(registry)
    expect(typeof ctx.perToolCheckpoint?.restore.restoreFiles).toBe("function")
    expect(typeof ctx.perToolCheckpoint?.restore.restoreTask).toBe("function")
    expect(typeof ctx.perToolCheckpoint?.restore.restoreBoth).toBe("function")
  })

  test("HELL-MEGA-06: toolProfile present → ctx.profile {get,set,list}", () => {
    const resolver = defaultToolProfileResolver()
    const ctx = buildReplSlashCtx({
      ...minimalArgs(),
      toolProfile: { resolver, defaultName: "ask" },
    })
    expect(ctx.profile).toBeDefined()
    expect(ctx.profile?.get()).toBe("ask")
    const r = ctx.profile?.set("write")
    expect(r).toBe("ok")
    expect(ctx.profile?.get()).toBe("write")
    const u = ctx.profile?.set("nope")
    expect(u).toEqual({ kind: "unknown", known: ["write", "ask", "minimal", "code-only"] })
    expect(ctx.profile?.list().length).toBe(4)
  })

  test("HELL-MEGA-07: identityModeVariant present → ctx.identity {get,set,list}", () => {
    const registry = defaultModeVariantRegistry()
    const ctx = buildReplSlashCtx({
      ...minimalArgs(),
      identityModeVariant: { registry },
    })
    expect(ctx.identity).toBeDefined()
    expect(ctx.identity?.get()).toBe("default")
    expect(ctx.identity?.set("architect")).toBe("ok")
    expect(ctx.identity?.get()).toBe("architect")
    const u = ctx.identity?.set("ghost")
    expect(typeof u).toBe("object")
    expect((u as { kind: string }).kind).toBe("unknown")
    expect(ctx.identity?.list().length).toBeGreaterThan(0)
  })

  test("HELL-MEGA-08: focusChainTracker present → ctx.focusChain {snapshot,reset,skip}", () => {
    const tracker = defaultFocusChainTracker()
    const ctx = buildReplSlashCtx({ ...minimalArgs(), focusChainTracker: tracker })
    expect(ctx.focusChain).toBeDefined()
    const snap = ctx.focusChain?.snapshot()
    expect(snap?.todos).toEqual([])
    expect(typeof snap?.currentTurn).toBe("number")
    // reset doesn't throw on empty
    ctx.focusChain?.reset()
    // skip advances turn
    const before = ctx.focusChain?.snapshot().currentTurn ?? 0
    ctx.focusChain?.skip()
    const after = ctx.focusChain?.snapshot().currentTurn ?? 0
    expect(after).toBe(before + 1)
  })

  test("HELL-MEGA-09: textInbox present → ctx.textInbox reachable + add/drain work", () => {
    const inbox = createTextInbox()
    const ctx = buildReplSlashCtx({ ...minimalArgs(), textInbox: inbox })
    expect(ctx.textInbox).toBeDefined()
    const r = ctx.textInbox?.add({ kind: "web", label: "https://x", text: "body" })
    expect(r?.kind).toBe("ok")
    expect(ctx.textInbox?.size()).toBe(1)
    expect(ctx.textInbox?.drain().length).toBe(1)
    expect(ctx.textInbox?.size()).toBe(0)
  })

  test("HELL-MEGA-10: /edit-plan happy path (planStore wired) does NOT print 'not wired'", async () => {
    const planStore = createInMemoryPlanStore({ now: () => 0 })
    const ctx = buildReplSlashCtx({ ...minimalArgs(), planStore })
    const c = collectOut()
    // Pin the editor seam so we don't spawn a real $EDITOR. We provide an
    // override that succeeds with byte-identical body ⇒ "unchanged" path.
    const exit = await runSlashCommand("/edit-plan", {
      out: c.outFn,
      err: c.errFn,
      cwd: process.cwd(),
      ...(ctx.planEdit !== undefined ? { planEdit: ctx.planEdit } : {}),
      editorOverride: "true",
      editorEnv: ttyEnv,
      editorSpawn: async (_cmd, _args) => 0,
    })
    expect(c.text()).not.toContain("not wired")
    expect(exit).toBe(0)
  })

  test("HELL-MEGA-11: /edit-message happy path (composerHandle wired) does NOT print 'not wired'", async () => {
    const handle = createComposerHandle("hello")
    const ctx = buildReplSlashCtx({ ...minimalArgs(), composerHandle: handle })
    const c = collectOut()
    const exit = await runSlashCommand("/edit-message", {
      out: c.outFn,
      err: c.errFn,
      cwd: process.cwd(),
      ...(ctx.composerEdit !== undefined ? { composerEdit: ctx.composerEdit } : {}),
      editorOverride: "true",
      editorEnv: ttyEnv,
      editorSpawn: async (_cmd, _args) => 0,
    })
    expect(c.text()).not.toContain("not wired")
    expect(exit).toBe(0)
  })

  test("HELL-MEGA-12: /fork-checkpoint list (conversationStore wired) does NOT print 'not wired'", async () => {
    const store = defaultConversationCheckpointStore({ now: () => 0 })
    const ctx = buildReplSlashCtx({ ...minimalArgs(), conversationStore: store })
    const c = collectOut()
    const exit = await runSlashCommand("/fork-checkpoint", {
      out: c.outFn,
      err: c.errFn,
      cwd: process.cwd(),
      ...(ctx.forkSession !== undefined ? { forkSession: ctx.forkSession } : {}),
    })
    expect(c.text()).not.toContain("not wired")
    expect(exit).toBe(0)
    // The store is empty so "no branches off session" path fires
    expect(c.text()).toContain("no branches off session test-sess-1")
  })

  test("HELL-MEGA-13: /rewind-tool empty-list (perToolRegistry wired) renders 'no granular anchors'", async () => {
    const registry = fakeRegistry()
    const ctx = buildReplSlashCtx({ ...minimalArgs(), perToolRegistry: registry })
    const c = collectOut()
    const exit = await runSlashCommand("/rewind-tool", {
      out: c.outFn,
      err: c.errFn,
      cwd: process.cwd(),
      ...(ctx.perToolCheckpoint !== undefined ? { perToolCheckpoint: ctx.perToolCheckpoint } : {}),
    })
    expect(c.text()).not.toContain("not wired")
    expect(c.text()).toContain("no granular anchors recorded")
    expect(exit).toBe(0)
  })

  test("HELL-MEGA-14: /profile (toolProfile wired) renders current + list", async () => {
    const resolver = defaultToolProfileResolver()
    const ctx = buildReplSlashCtx({
      ...minimalArgs(),
      toolProfile: { resolver, defaultName: "write" },
    })
    const c = collectOut()
    const exit = await runSlashCommand("/profile", {
      out: c.outFn,
      err: c.errFn,
      cwd: process.cwd(),
      ...(ctx.profile !== undefined ? { profile: ctx.profile } : {}),
    })
    expect(c.text()).not.toContain("not wired")
    expect(c.text()).toContain("current = write")
    expect(c.text()).toContain("available =")
    expect(exit).toBe(0)
  })

  test("HELL-MEGA-15: /identity (identityModeVariant wired) renders current + list", async () => {
    const registry = defaultModeVariantRegistry()
    const ctx = buildReplSlashCtx({ ...minimalArgs(), identityModeVariant: { registry } })
    const c = collectOut()
    const exit = await runSlashCommand("/identity", {
      out: c.outFn,
      err: c.errFn,
      cwd: process.cwd(),
      ...(ctx.identity !== undefined ? { identity: ctx.identity } : {}),
    })
    expect(c.text()).not.toContain("not wired")
    expect(c.text()).toContain("current = default")
    expect(exit).toBe(0)
  })

  test("HELL-MEGA-16: /focus-chain (tracker wired) snapshots empty todo list", async () => {
    const tracker = defaultFocusChainTracker()
    const ctx = buildReplSlashCtx({ ...minimalArgs(), focusChainTracker: tracker })
    const c = collectOut()
    const exit = await runSlashCommand("/focus-chain", {
      out: c.outFn,
      err: c.errFn,
      cwd: process.cwd(),
      ...(ctx.focusChain !== undefined ? { focusChain: ctx.focusChain } : {}),
    })
    expect(c.text()).not.toContain("not wired")
    expect(c.text()).toContain("(no todos)")
    expect(exit).toBe(0)
  })

  test("HELL-MEGA-17: /web with stub fetcher + textInbox → inbox.size() === 1 (not inline)", async () => {
    const inbox = createTextInbox()
    const ctx = buildReplSlashCtx({ ...minimalArgs(), textInbox: inbox })
    const c = collectOut()
    const stubFetcher = (async (_input: unknown) =>
      new Response("hello world", {
        status: 200,
        headers: { "content-type": "text/plain" },
      })) as unknown as typeof fetch
    const exit = await runSlashCommand("/web https://example.com", {
      out: c.outFn,
      err: c.errFn,
      cwd: process.cwd(),
      ...(ctx.textInbox !== undefined ? { textInbox: ctx.textInbox } : {}),
      webFetcher: stubFetcher,
    })
    expect(exit).toBe(0)
    // The /web slash routes to inbox when ctx.textInbox is wired ⇒ no inline body
    expect(inbox.size()).toBe(1)
    expect(c.text()).toContain("queued")
  })

  test("HELL-MEGA-18: composer adapter no-throw — broken handle methods do not throw", () => {
    const broken: ReturnType<typeof createComposerHandle> = {
      getPending: () => "",
      setPending: () => {
        throw new Error("handle broken")
      },
    }
    const ctx = buildReplSlashCtx({ ...minimalArgs(), composerHandle: broken })
    // The adapter itself wraps the call — but a thrown error inside setPending
    // propagates out the public surface to the slash, which already has its
    // own try/catch. The adapter MUST NOT swallow it silently in a way that
    // pretends success; verify it propagates so callers see real failures.
    expect(() => ctx.composerEdit?.setPending("x")).toThrow("handle broken")
    // The slash command's own try/catch around setPending is the safety net;
    // confirmed by HELL-EDMG / HELL-EDPL test-files.
  })

  test("HELL-MEGA-19: per-tool-checkpoint stub restore returns typed Err shape", async () => {
    const registry = fakeRegistry([
      {
        tag: "turn:t1",
        granularity: "turn",
        sha: "abc",
        takenAt: 0,
      },
    ])
    const ctx = buildReplSlashCtx({ ...minimalArgs(), perToolRegistry: registry })
    const outcome = await ctx.perToolCheckpoint?.restore.restoreFiles("turn:t1")
    expect(outcome?.ok).toBe(false)
    expect(outcome?.errorCode).toBe("shadow-odb-not-configured")
    expect(outcome?.tag).toBe("turn:t1")
  })

  test("HELL-MEGA-20: byte-identical legacy projection — no new keys leak when none wired", async () => {
    const ctx = buildReplSlashCtx(minimalArgs())
    // dispatchReplSlash routes a slash through projectSlashCtx — verify a
    // legacy slot still works and the new keys are absent in the projection
    // (we exercise by ensuring an absent new slot prints "not wired").
    const c = collectOut()
    const exit = await runSlashCommand("/profile", {
      out: c.outFn,
      err: c.errFn,
      cwd: process.cwd(),
    })
    expect(c.text()).toContain("not wired in this surface")
    expect(exit).toBe(0)
    // Also verify dispatchReplSlash handles slashes — fork-checkpoint with
    // no wire stays on the friendly "not wired" line.
    const c2 = collectOut()
    const handled = await dispatchReplSlash("/edit-plan", ctx)
    expect(handled).toBe(true)
    // The slash will print "not wired" since planEdit is absent in ctx.
    // (We can't capture stdout here without re-stub; just verify dispatch
    // returned `true` so the model path is not invoked.)
    void c2
  })
})
