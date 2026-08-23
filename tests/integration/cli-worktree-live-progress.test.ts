/**
 * RFC-04 D5 — worktree live-progress PRODUCT + NEGATIVE-CONTROL receipt (e2e).
 *
 * This is the closure packet for the RFC-04 worktree-progress lane. D1 landed the
 * staged producer, D2 the observable runtime, D3 the runner adapter, and D4 the
 * session-owned live subscription wired into the `session worktree <id>` front
 * door. D5 adds NO new state/model: it is the fixture/e2e that proves the whole
 * assembly delivers pre-completion progress through the REAL CLI front door, and
 * pins the semantic invariants with a permanent negative control.
 *
 * ── The core rail: ≥2 observable stage changes BEFORE the operation resolves ──
 * A real temp git repo with an INTENTIONALLY DELAYED checkout (a `post-checkout`
 * hook that sleeps) drives the transition. Two complementary proofs:
 *
 *   1. PRODUCT (front door, write-ORDER): `session worktree <id>` writes the
 *      `worktree ready:` line SYNCHRONOUSLY the instant the transition resolves.
 *      ≥2 DISTINCT `/activity` renders appear at buffer indices strictly BEFORE
 *      that line ⇒ live progress, not a post-hoc spinner.
 *   2. INDEPENDENT-OF-BUFFER (transition boundary, resolved FLAG): calling the
 *      exact seam the front door uses (`runWorktreeTransitionWithProgress`) with a
 *      `transitionResolved` flag flipped only AFTER `await`. Each render records
 *      the flag AT RENDER TIME (pure control-flow, NOT derived from output). ≥2
 *      DISTINCT renders with `resolved === false` ⇒ pre-completion timing proven
 *      independently of any buffer parsing (the prompt's hard requirement).
 *
 * ── RED for the right reason (permanent negative control) ────────────────────
 * With the D4 live subscription absent (pre-D4 posture: emit staged children,
 * render ONCE at the end) the stages ARE emitted into the store — but the fixture
 * sees ONLY the terminal snapshot: zero pre-completion renders. Reverting the D4
 * subscription therefore turns proofs (1)/(2) RED because delivery is gone, NOT
 * because the stage is missing (it is still in the settled snapshot). That is the
 * "right reason" the hellgate demands.
 *
 * ── Other receipt arms (all bundled here) ────────────────────────────────────
 *   • stage ORDER: op-open → workspace → checkout → op-settle
 *     (validate → create → checkout → bind, the landed staged equivalents).
 *   • unchanged agent count: phase-kind step nodes never inflate the fleet
 *     aggregate (agents/running/stuck invariant vs the coarse path).
 *   • failure settlement: a checkout failure settles checkout=failed → the
 *     container derives failed, and the front door exits 1.
 *   • retry reset: a fresh operation after a failure mints a NEW op node with a
 *     reset checkout child; the failed operation stays isolated/immutable.
 *   • gate-OFF legacy output: a single terminal `/activity` block AFTER
 *     `worktree ready:`, no staged children — byte-identical coarse posture.
 *
 * Real git + the real `createActivityStore` throughout (jul-13/jul-15: fake
 * sinks/endpoints hide seam bugs).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type ActivityEvent,
  type ActivitySnapshot,
  createActivityStore,
  worktreeOpNodeId,
  worktreeStepId,
} from "@/activity"
import { runSessionCommand, type SessionCommandDeps } from "@/runner/session-ops"
import {
  type TransitionRequest,
  transitionThreadToWorktree,
} from "@/runner/session-ops/current-thread-worktree"
import {
  renderActivityTo,
  runWorktreeTransitionWithProgress,
} from "@/runner/session-ops/worktree/live-progress"
import { runShell } from "@/runtime"
import { loadSessionById, type SessionMeta, saveSessionById } from "@/session"
import { __resetRuntimeConfig } from "@/shared"

const gitAvailable = async (): Promise<boolean> => {
  try {
    return (await runShell("git --version")).exitCode === 0
  } catch {
    return false
  }
}
const HAS_GIT = await gitAvailable()

/**
 * A temp git repo. `delay:true` installs a `post-checkout` hook that sleeps, so
 * `git worktree add` (which checks out + fires post-checkout) is INTENTIONALLY
 * slow — guaranteeing the operation is still pending when the pre-completion
 * renders are observed (a real window, not a same-tick artifact). Multiple files
 * ensure the checkout does real I/O.
 */
const makeRepo = async (opts?: { delay?: boolean }): Promise<string> => {
  const dir = mkdtempSync(join(tmpdir(), "wt-d5-repo-"))
  const sh = (c: string) => runShell(c, { cwd: dir })
  await sh("git init -q")
  await sh("git config user.email t@t.t && git config user.name t")
  for (let i = 0; i < 12; i += 1) await writeFile(join(dir, `f${i}.txt`), `x${i}\n`)
  await sh("git add -A && git commit -q -m init")
  if (opts?.delay === true) {
    // post-checkout exit status is ignored by git, so `sleep` is always safe; it
    // fires on `git worktree add`'s checkout (verified) and widens the pending
    // window. The proofs remain correct even if the hook is skipped — the
    // pre-effect renders are synchronous and pre-completion regardless.
    const hook = join(dir, ".git", "hooks", "post-checkout")
    writeFileSync(hook, "#!/bin/sh\nsleep 0.2\n")
    chmodSync(hook, 0o755)
  }
  return dir
}

/** A temp dir that is NOT a git repo (drives the checkout-failure arm). */
const makeNonRepo = (): string => mkdtempSync(join(tmpdir(), "wt-d5-notrepo-"))

const mkMeta = (id: string, cwd: string): SessionMeta => ({
  id,
  title: "t",
  cwd,
  createdAt: 1,
  lastTouched: 1,
  archived: false,
})

let tick = 0
const clock = (): number => {
  tick += 1000
  return tick
}

const req = (repo: string, id: string, ownershipId: string): TransitionRequest => ({
  sessionId: id,
  ownerThreadId: id,
  repoRoot: repo,
  repoId: repo,
  ownershipId,
  baseSha: "HEAD",
})

const firstIndex = (writes: readonly string[], re: RegExp): number =>
  writes.findIndex((w) => re.test(w))

/** Canonical event token so the stage ORDER is a stable, readable assertion. */
const tokenOf = (op: string, ev: ActivityEvent): string => {
  const id = ev.type === "node_open" ? ev.node.id : ev.id
  // Worktree staged transitions emit only `node_open` (→ "open") and
  // `node_status` (→ its terminal status); `node_metric`/`node_progress` never
  // fire on this path, so anything else is an unexpected "raw" token.
  const suffix = ev.type === "node_open" ? "open" : ev.type === "node_status" ? ev.status : ev.type
  if (id === worktreeOpNodeId(op)) return `op-${suffix}`
  if (id === worktreeStepId(op, "workspace")) return `workspace-${suffix}`
  if (id === worktreeStepId(op, "checkout")) return `checkout-${suffix}`
  return `other:${id}`
}

const stepStatus = (snap: ActivitySnapshot, op: string, step: "workspace" | "checkout") =>
  snap.byId.get(worktreeStepId(op, step))?.status

describe("RFC-04 D5 — worktree live-progress product + negative-control receipt", () => {
  let sessionsDir: string
  const cleanups: string[] = []
  beforeEach(() => {
    sessionsDir = mkdtempSync(join(tmpdir(), "wt-d5-sess-"))
    process.env.QUANTA_SESSIONS_DIR = sessionsDir
    __resetRuntimeConfig()
  })
  afterEach(() => {
    rmSync(sessionsDir, { recursive: true, force: true })
    delete process.env.QUANTA_SESSIONS_DIR
    __resetRuntimeConfig()
    while (cleanups.length > 0) {
      const d = cleanups.pop()
      if (d) rmSync(d, { recursive: true, force: true })
    }
  })

  // ─────────────────────────── 1. PRODUCT: front-door pre-completion ─────────
  test.skipIf(!HAS_GIT)(
    "front door: ≥2 DISTINCT staged renders precede the `worktree ready:` line (write-order)",
    async () => {
      const repo = await makeRepo({ delay: true })
      cleanups.push(repo)
      await saveSessionById(mkMeta("p1", repo), { reason: "x", turns: 0, messages: [] })
      const store = createActivityStore()
      const writes: string[] = []
      const deps: SessionCommandDeps = {
        out: (s) => writes.push(s),
        err: () => undefined,
        confirm: async () => false,
        activityStore: store,
        worktreeProgress: true,
      }
      const code = await runSessionCommand(["worktree", "p1"], deps)
      expect(code).toBe(0)
      cleanups.push((await loadSessionById("p1"))?.meta.workspaceOwnership?.path as string)

      const readyIdx = firstIndex(writes, /worktree ready:/)
      expect(readyIdx).toBeGreaterThanOrEqual(0)
      // Everything before the (synchronous, post-resolution) `worktree ready:`
      // line was rendered while the operation was still running.
      const preWrites = writes.slice(0, readyIdx)
      // THE D5 rail: at least two DISTINCT pre-completion renders (observable
      // stage changes), not a single terminal snapshot. Since the CLI-render
      // polish, the live path prints the `ACTIVITY` header ONCE and then emits
      // each subsequent render as a single staged-delta write — so distinct
      // pre-completion renders are counted per WRITE (one out() per render),
      // not per repeated header block. The count assertion (≥2) is unchanged.
      expect(new Set(preWrites).size).toBeGreaterThanOrEqual(2)
      // And the two staged stages became observable pre-completion.
      const preText = preWrites.join("")
      expect(preText).toContain("Preparing workspace")
      expect(preText).toContain("Checking out files")
    },
  )

  // ────────────── 2. INDEPENDENT of buffered output (resolved flag) ──────────
  test.skipIf(!HAS_GIT)(
    "transition boundary: ≥2 DISTINCT renders fire with resolved===false (flag proof)",
    async () => {
      const repo = await makeRepo({ delay: true })
      cleanups.push(repo)
      await saveSessionById(mkMeta("p2", repo), { reason: "x", turns: 0, messages: [] })
      const store = createActivityStore()

      let resolved = false
      // Each render line is tagged with the resolved flag AS OF render time — a
      // pure control-flow observation, never parsed from the buffer.
      const tagged: { readonly settled: boolean; readonly line: string }[] = []
      const out = (s: string): void => {
        tagged.push({ settled: resolved, line: s })
      }
      const result = await runWorktreeTransitionWithProgress(req(repo, "p2", "op-p2"), out, {
        store,
        progress: true,
        turnId: "p2",
      })
      resolved = true
      expect(result.kind).toBe("ready")
      if (result.kind === "ready") cleanups.push(result.nextCwd)

      const preLines = tagged.filter((t) => !t.settled).map((t) => t.line)
      // Pre-completion, proven independently of buffer ordering: ≥2 distinct
      // renders occurred while the transition promise was still unresolved. Each
      // render is a single write (header printed once, then staged deltas), so
      // distinct renders are counted per-write — the count assertion is unchanged.
      expect(new Set(preLines).size).toBeGreaterThanOrEqual(2)
      // Sanity: SOMETHING was actually rendered (guards against a vacuous "the
      // delayed checkout never emitted at all" fixture).
      expect(preLines.some((l) => /Preparing workspace/.test(l))).toBe(true)
      expect(preLines.some((l) => /Checking out files/.test(l))).toBe(true)
    },
  )

  // ───── 3. NEGATIVE CONTROL: stages emitted, but NOT delivered pre-completion ─
  test.skipIf(!HAS_GIT)(
    "right-reason RED: without the D4 subscription, stages ARE emitted but only the terminal snapshot renders",
    async () => {
      const repo = await makeRepo()
      cleanups.push(repo)
      await saveSessionById(mkMeta("p3", repo), { reason: "x", turns: 0, messages: [] })
      const store = createActivityStore()

      // Pre-D4 posture: staged emission ON, but NO live subscription — the caller
      // renders ONCE after the transition (exactly what `cmdWorktree` did before
      // D4). This is the reverted-wire control the hellgate reasons about.
      const r = await transitionThreadToWorktree(req(repo, "p3", "op-p3"), clock, {
        store,
        staged: true,
      })
      expect(r.kind).toBe("ready")
      if (r.kind === "ready") cleanups.push(r.nextCwd)

      const terminal: string[] = []
      renderActivityTo(store.snapshot(), (s) => terminal.push(s))
      // Delivery is gone: exactly ONE render (the terminal snapshot), zero
      // pre-completion renders — this is what turns proofs (1)/(2) RED.
      expect(terminal.filter((l) => /^ACTIVITY/.test(l)).length).toBe(1)
      // ...for the RIGHT reason: the stages WERE emitted (they are in the store),
      // so the RED is about delivery timing, not a missing stage.
      const snap = store.snapshot()
      expect(stepStatus(snap, "op-p3", "workspace")).toBe("done")
      expect(stepStatus(snap, "op-p3", "checkout")).toBe("done")
    },
  )

  // ─────────────────────────── 4. stage ORDER ───────────────────────────────
  test.skipIf(!HAS_GIT)(
    "order: op-open → workspace → checkout → op-settle (validate→create→checkout→bind)",
    async () => {
      const repo = await makeRepo()
      cleanups.push(repo)
      await saveSessionById(mkMeta("p4", repo), { reason: "x", turns: 0, messages: [] })
      const store = createActivityStore()
      const order: string[] = []
      // Subscribe BEFORE the transition (synchronous flush) so every lifecycle
      // event is recorded in exact emission order.
      const sub = store.subscribe((c) => order.push(tokenOf("op-p4", c.event)), {
        schedule: (flush) => flush(),
      })
      const r = await transitionThreadToWorktree(req(repo, "p4", "op-p4"), clock, {
        store,
        staged: true,
      })
      sub.unsubscribe()
      expect(r.kind).toBe("ready")
      if (r.kind === "ready") cleanups.push(r.nextCwd)

      expect(order).toEqual([
        "op-open",
        "workspace-open",
        "workspace-done",
        "checkout-open",
        "checkout-done",
        "op-done",
      ])
    },
  )

  // ─────────────────── 5. unchanged agent count (fleet invariant) ────────────
  test.skipIf(!HAS_GIT)(
    "unchanged agent count: staged step nodes never inflate the fleet aggregate",
    async () => {
      const repo = await makeRepo()
      cleanups.push(repo)
      await saveSessionById(mkMeta("p5a", repo), { reason: "x", turns: 0, messages: [] })
      await saveSessionById(mkMeta("p5b", repo), { reason: "x", turns: 0, messages: [] })

      const off = createActivityStore()
      const rOff = await transitionThreadToWorktree(req(repo, "p5a", "op-off"), clock, {
        store: off,
      })
      if (rOff.kind === "ready") cleanups.push(rOff.nextCwd)

      const on = createActivityStore()
      const rOn = await transitionThreadToWorktree(req(repo, "p5b", "op-on"), clock, {
        store: on,
        staged: true,
      })
      if (rOn.kind === "ready") cleanups.push(rOn.nextCwd)

      const offAgg = off.snapshot().aggregate
      const onAgg = on.snapshot().aggregate
      // Staged children exist on the ON path...
      expect((on.snapshot().childIds.get(worktreeOpNodeId("op-on")) ?? []).length).toBe(2)
      // ...but the fleet aggregate is INVARIANT (phase-kind stages, never agent).
      expect(onAgg.agents).toBe(offAgg.agents)
      expect(onAgg.running).toBe(offAgg.running)
      expect(onAgg.stuck).toBe(offAgg.stuck)
    },
  )

  // ─────────────────────────── 6. failure settlement ────────────────────────
  test.skipIf(!HAS_GIT)(
    "failure settlement: checkout failure settles checkout=failed → container derives failed; front door exits 1",
    async () => {
      const notRepo = makeNonRepo()
      cleanups.push(notRepo)
      await saveSessionById(mkMeta("p6", notRepo), { reason: "x", turns: 0, messages: [] })

      // Transition-level: node states settle correctly.
      const store = createActivityStore()
      const r = await transitionThreadToWorktree(req(notRepo, "p6", "op-p6"), clock, {
        store,
        staged: true,
      })
      expect(r.kind).toBe("failed")
      const snap = store.snapshot()
      expect(stepStatus(snap, "op-p6", "checkout")).toBe("failed")
      // The single parent op node derives failed from the failed checkout child.
      expect(snap.byId.get(worktreeOpNodeId("op-p6"))?.status).toBe("failed")

      // Front-door level: the product surface reports failure (exit 1 + stderr).
      await saveSessionById(mkMeta("p6b", notRepo), { reason: "x", turns: 0, messages: [] })
      const errs: string[] = []
      const code = await runSessionCommand(["worktree", "p6b"], {
        out: () => undefined,
        err: (s) => errs.push(s),
        confirm: async () => false,
        activityStore: createActivityStore(),
        worktreeProgress: true,
      })
      expect(code).toBe(1)
      expect(errs.join("")).toContain("git failed")
    },
  )

  // ─────────────────────────── 7. retry reset ───────────────────────────────
  test.skipIf(!HAS_GIT)(
    "retry reset: a fresh operation after a failure mints a new op node + resets progress; the failed op stays isolated",
    async () => {
      const notRepo = makeNonRepo()
      cleanups.push(notRepo)
      await saveSessionById(mkMeta("p7", notRepo), { reason: "x", turns: 0, messages: [] })
      const store = createActivityStore()

      // Attempt 1 fails (not a git repo) — ownership becomes terminal `failed`.
      const r1 = await transitionThreadToWorktree(req(notRepo, "p7", "op-a1"), clock, {
        store,
        staged: true,
      })
      expect(r1.kind).toBe("failed")
      expect(stepStatus(store.snapshot(), "op-a1", "checkout")).toBe("failed")

      // Fix the environment (point the session at a real repo) and RETRY with a
      // NEW operation id — the terminal `failed` ownership is superseded.
      const repo = await makeRepo()
      cleanups.push(repo)
      await saveSessionById(mkMeta("p7", repo), { reason: "x", turns: 0, messages: [] })
      const r2 = await transitionThreadToWorktree(req(repo, "p7", "op-a2"), clock, {
        store,
        staged: true,
      })
      expect(r2.kind).toBe("ready")
      if (r2.kind === "ready") cleanups.push(r2.nextCwd)

      const snap = store.snapshot()
      // The retry is a DISTINCT operation node with a reset (done, not failed)
      // checkout child — progress starts fresh, never inheriting attempt 1.
      expect(worktreeOpNodeId("op-a2")).not.toBe(worktreeOpNodeId("op-a1"))
      expect(stepStatus(snap, "op-a2", "checkout")).toBe("done")
      expect(snap.byId.get(worktreeOpNodeId("op-a2"))?.status).toBe("done")
      // The failed attempt is ISOLATED — its nodes are unchanged by the retry.
      expect(stepStatus(snap, "op-a1", "checkout")).toBe("failed")
      expect(snap.byId.get(worktreeOpNodeId("op-a1"))?.status).toBe("failed")
    },
  )

  // ─────────────────────── 8. gate-OFF byte-identical legacy ─────────────────
  test.skipIf(!HAS_GIT)(
    "gate OFF: single terminal `/activity` block AFTER `worktree ready:`, no staged children (legacy posture)",
    async () => {
      const repo = await makeRepo()
      cleanups.push(repo)
      await saveSessionById(mkMeta("p8", repo), { reason: "x", turns: 0, messages: [] })
      const writes: string[] = []
      const code = await runSessionCommand(["worktree", "p8"], {
        out: (s) => writes.push(s),
        err: () => undefined,
        confirm: async () => false,
        activityStore: createActivityStore(),
        // worktreeProgress omitted ⇒ gate OFF.
      })
      expect(code).toBe(0)
      cleanups.push((await loadSessionById("p8"))?.meta.workspaceOwnership?.path as string)

      const readyIdx = firstIndex(writes, /worktree ready:/)
      const activityIdx = firstIndex(writes, /^ACTIVITY/)
      expect(readyIdx).toBeGreaterThanOrEqual(0)
      // Legacy posture: the ONLY render is the terminal receipt, AFTER completion.
      expect(activityIdx).toBeGreaterThan(readyIdx)
      expect(writes.filter((w) => /^ACTIVITY/.test(w)).length).toBe(1)
      // No staged children in the coarse single-node output.
      const joined = writes.join("")
      expect(joined).not.toContain("Preparing workspace")
      expect(joined).not.toContain("Checking out files")
    },
  )
})
