#!/usr/bin/env bun

/**
 * mutation-check — a proof-rail quality gate for the May-31 bugbash hellgates.
 *
 * THE PROBLEM IT SOLVES: a hellgate that stays GREEN after you revert the
 * production fix it claims to guard is a BLIND SPOT. That is exactly how the
 * `turn.cancel`-window bug survived its first pass — the hellgate stepped over
 * the controller-registration window, so reverting the fix did not turn it red.
 *
 * WHAT IT DOES: for each entry in {@link MUTATIONS}, it
 *   1. applies a surgical REVERT to the production src (an exact find/replace
 *      that restores the pre-fix shape),
 *   2. runs the guarding hellgate (optionally filtered to one test name),
 *   3. asserts the gate now FAILS (red-on-revert), and
 *   4. RESTORES the src verbatim — no matter what (try/finally).
 *
 * A mutation whose gate stays green is reported as a BLIND SPOT (exit 1) so CI
 * can fail the proof rail. Every `find` string is asserted present before the
 * revert is applied, so a drifted src (the fix moved/renamed) is a hard error
 * rather than a silent no-op that would falsely read as "blind spot".
 *
 * Run:  bun run mutation-check              # all critical hellgates
 *       bun run mutation-check <id-substr>  # one entry by id
 *
 * ⚠️ THIS TOOL IS MANUAL. Nothing in `bun test` and nothing in CI runs it, so
 * its guards are only as real as the last time a human typed the command. The
 * checks that CAN be enforced without spawning — every entry has an `only`, its
 * `gate` file exists, its `only` compiles as a regex, its `find` string is
 * present exactly once — are exported as pure functions and asserted by
 * `tests/unit/_arch/mutation-check-drift-ratchet.test.ts`, which does run.
 * Prefer adding a check there over adding one here.
 *
 * SAFETY: this script MUTATES tracked source files in place and restores them.
 * It refuses to run if any target src file already has uncommitted changes that
 * collide with a revert window, and it always writes the original bytes back in
 * a `finally`. Still — run it on a clean worktree.
 */

import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

/** One mutation: revert a single production fix and prove its hellgate dies. */
export interface Mutation {
  /** Stable id (also used as the cli substring filter). */
  readonly id: string
  /** Severity from the bugbash audit (CRITICAL/HIGH/MED). */
  readonly severity: "CRITICAL" | "HIGH" | "MED"
  /** The bugbash ticket + audit tag this guards (for the report). */
  readonly guards: string
  /** Production src file, repo-relative. */
  readonly src: string
  /** Exact text present at HEAD that encodes the fix. MUST be unique. */
  readonly find: string
  /** Pre-fix shape — the revert. */
  readonly replace: string
  /** Hellgate test file, repo-relative. */
  readonly gate: string
  /**
   * `-t` name filter selecting THE ONE case this fix guards.
   *
   * Optional in the TYPE only — the drift-ratchet test builds partial fixtures —
   * but REQUIRED in practice: {@link assertLeafAnchored} refuses an entry with
   * no filter, because an absent filter runs the whole gate file and every
   * unrelated failure in it reads as this mutant being killed.
   *
   * `bun test -t` is a REGEX matched against the FULL name — the enclosing
   * `describe` text concatenated with the test text. A filter that reads like a
   * description of the behaviour is therefore usually a substring of the
   * describe, which selects EVERY test in that block. When a block contains
   * ALLOW-direction paired controls (it should), a mutant that only breaks an
   * allow-case still turns the filtered run red and reads as a kill. Anchor to
   * the leaf test name, and remember the value is a regex (escape `(`, `)`).
   */
  readonly only?: string
}

/**
 * THE CRITICAL-HELLGATE LIST. Mined from the May-31 bugbash commits:
 *   T02 4ac7bf3f · T03 c8a7bce5 · T05 c500bd93 · T08 75411b0d
 *   R1 35d8be1a  · R2 9721a021  · regression-guards d169d2e7 / 4e7596ad
 */
export const MUTATIONS: readonly Mutation[] = [
  // ── T03 kernel cancel ──────────────────────────────────────────────────
  {
    id: "t03-reducer-cancel-not-inert",
    severity: "CRITICAL",
    guards: "T03 L5 C-1 — reducer turn.cancel is no longer an inert no-op",
    src: "src/kernel/session/reducer.ts",
    // Pin repoint (drift repair): the cancel handler was extracted into its own
    // top-level reducer function, so the SAME two statements now sit at 2-space
    // indent instead of 6. Text drift only — the fix is intact.
    find: `  const hasActiveTurn = state.status === "running" || state.status === "awaiting_approval"
  if (!hasActiveTurn) {
    return { state, hostAction: { kind: "cancel_turn" }, events: [] }
  }`,
    // Pre-T03 shape: the cancel handler returned an inert no-op for EVERY state.
    replace: `  const hasActiveTurn = state.status === "running" || state.status === "awaiting_approval"
  if (hasActiveTurn || !hasActiveTurn) {
    return { state, hostAction: { kind: "none" } as never, events: [] }
  }`,
    gate: "src/kernel/session/__tests__/kernel-cancel.hellgate.test.ts",
    only: "turn.cancel is no longer an inert no-op",
  },
  {
    id: "t03-cancel-aborts-live-controller",
    severity: "CRITICAL",
    guards: "T03 L5 H-? — turn.cancel aborts the SAME signal the host observes",
    // Path repoint (aug-23 god-module split): `runTurn` + the `activeTurnControllers`
    // registry moved out of `scheduler.ts` into `scheduler-turn-execution.ts`.
    // The pinned `find` text is unchanged — only its home moved.
    src: "src/kernel/session/scheduler-turn-execution.ts",
    // The turn-owned controller registration is what the cancel fast-path
    // aborts. Reverting the runTurn-side registration to a fresh, UNregistered
    // controller means turn.cancel can never reach the live signal.
    find: `  const turnController = args.turnController ?? new AbortController()
  // When the dispatch arm pre-registered the controller (audit R2 H1) do NOT
  // re-register; otherwise install it now. The \`finally\` teardown is identical.
  if (args.turnController === undefined) {
    activeTurnControllers.set(sessionId, turnController)
  }`,
    // Pre-fix: a private controller never published under the session id, so a
    // concurrent turn.cancel finds nothing to abort.
    replace: `  const turnController = new AbortController()
  // [mutation] do NOT publish the controller — cancel can't reach it.
  if (sessionId === "\\u0000never") {
    activeTurnControllers.set(sessionId, turnController)
  }`,
    gate: "src/kernel/session/__tests__/kernel-cancel.hellgate.test.ts",
    only: "turn.cancel aborts the SAME signal the in-flight host turn observes",
  },
  {
    id: "t03-r2h1-preregister-before-append",
    severity: "HIGH",
    guards: "R2 H1 — turn.cancel in the controller-registration window (pre-host append)",
    src: "src/kernel/session/scheduler.ts",
    // Pin repoint (drift repair): the awaited append + its drop-the-controller
    // compensation were extracted into `commitOrDropController`, the dispatch
    // block moved one nesting level deeper (4sp -> 6sp), and `turn.submit`
    // joined `turn.run` as a pre-registering command. What is pinned is still
    // the SAME load-bearing ordering: pre-register, THEN await persistence.
    find: `      let preRegisteredController: AbortController | undefined
      if (command.type === "turn.run" || command.type === "turn.submit") {
        preRegisteredController = new AbortController()
        activeTurnControllers.set(state.sessionId, preRegisteredController)
      }
      await commitOrDropController(`,
    // Pre-R2 order: never pre-register, so registration happens only later
    // inside `runTurn` (i.e. AFTER the awaited append) — a window in which
    // turn.cancel finds NO controller, falls to lease.runWith, throws.
    // `commitOrDropController` receives `undefined` and its compensation arm
    // is a no-op, exactly as before the fix existed.
    replace: `      const preRegisteredController: AbortController | undefined = undefined
      await commitOrDropController(`,
    gate: "src/kernel/session/__tests__/kernel-cancel.hellgate.test.ts",
    only: "turn.cancel during the pre-host event-log-write window",
  },
  {
    id: "t03-h8-aborted-signal-shortcircuit",
    severity: "HIGH",
    guards: "T03 H-8 — already-aborted ctx.signal short-circuits at the DISPATCH boundary",
    src: "src/kernel/session/scheduler.ts",
    // NOTE: there are TWO H-8 gates. The DISPATCH-level gate (this one) fires
    // FIRST and is the real guard the cx-5 hellgate exercises — `turn.run`
    // never reaches `runTurn` on a pre-aborted signal. Mutating the runTurn-side
    // gate left cx-5 green (a mutation-targeting blind spot), so we revert the
    // dispatch gate, which is the actual headline behaviour.
    find: `    if (command.type === "turn.run" && ctx.signal?.aborted === true) {`,
    // Pre-fix: the signal was merely forwarded to the host with no dispatch
    // guard, so an already-dead signal still started host work.
    replace: `    if (false && command.type === "turn.run" && ctx.signal?.aborted === true) {`,
    gate: "src/kernel/session/__tests__/kernel-cancel.hellgate.test.ts",
    only: "already-aborted ctx.signal short-circuits turn.run",
  },
  {
    id: "t03-m5-oncommitted-no-throw-sink",
    severity: "HIGH",
    guards: "T03 M-5 — observer/onCommitted failure must not redefine turn outcome",
    // Path repoint (aug-23 god-module split): `notifyCommitted` + the observer
    // sink moved out of `scheduler.ts` into `scheduler-append-isolation.ts`.
    // The pinned `find` text is unchanged — only its home moved.
    src: "src/kernel/session/scheduler-append-isolation.ts",
    find: `  if (ctx.onCommitted === undefined) return
  try {
    await ctx.onCommitted(args)
  } catch (error) {
    observerErrorSink(error)
  }`,
    // Pre-fix: an onCommitted throw propagates and corrupts the turn outcome.
    replace: `  if (ctx.onCommitted === undefined) return
  await ctx.onCommitted(args)`,
    gate: "src/kernel/session/__tests__/kernel-cancel.hellgate.test.ts",
    only: "a throwing onCommitted does NOT flip a completed turn",
  },

  // ── T03 approval lease isolation ───────────────────────────────────────
  {
    id: "t03-lease-turn-scoped-clear",
    severity: "HIGH",
    guards: "T03 L5 H-1 — an approved grant does not leak across the turn boundary",
    src: "src/host/runtime/internal/context-binding/approval-protocol.ts",
    find: `    slot.current = previous
    if (pushedSurface) deps.surfaceConfirms.pop()
    for (const approvalId of armedAtEntry) deps.leases.delete(approvalId)`,
    // Pre-fix: grants were a session-lifetime Set — never cleared at scope exit,
    // so an approval leaked to a later turn.
    replace: `    slot.current = previous
    if (pushedSurface) deps.surfaceConfirms.pop()
    void armedAtEntry`,
    gate: "src/host/runtime/internal/__tests__/approval-lease-isolation.hellgate.test.ts",
    only: "good for exactly ONE turn",
  },
  {
    id: "t03-lease-fail-closed-shell-extract",
    severity: "HIGH",
    guards: "T03 L5 H-1 — a throwing extractShellCommand fails closed (forces prompt)",
    src: "src/host/runtime/internal/context-binding/approval-support.ts",
    find: `  } catch {
    return SHELL_EXTRACT_FAILED
  }`,
    // Pre-fix: a throwing extraction collapsed to a broad tool-name-only key
    // that a stale lease could match.
    replace: `  } catch {
    shellCommand = null
  }`,
    gate: "src/host/runtime/internal/__tests__/approval-lease-isolation.hellgate.test.ts",
    only: "throwing extractShellCommand forces a prompt",
  },

  // ── T02 turn-closeout authority ────────────────────────────────────────
  {
    id: "t02-m2-strip-orphan-tool-use",
    severity: "HIGH",
    guards: "T02 L1 M2 — refusal strips un-dispatched orphan tool_use blocks",
    src: "src/agent/turn-closeout.ts",
    find: `  const kept = message.content.filter((b) => b.type !== "tool_use")`,
    // Pre-fix: orphan tool_use blocks were persisted (invalid transcript).
    replace: `  const kept = message.content.filter(() => true)`,
    gate: "tests/unit/agent/turn-closeout-hellgate.test.ts",
    only: "refusal ⇒ no orphan tool_use persisted",
  },
  {
    id: "t02-h2-append-pending-tool-results",
    severity: "HIGH",
    guards: "T02 L1 H2 — budget exhaustion at a tool turn appends pending tool_result",
    src: "src/agent/turn-closeout.ts",
    find: `  if (resultBlocks.length === 0) return
  wm.append({ role: "user", content: resultBlocks })`,
    // Pre-fix: the matching tool_result blocks were never appended on the
    // budget-exhaustion path, leaving an unmatched tool_use.
    replace: `  if (resultBlocks.length === 0 || resultBlocks.length >= 0) return
  wm.append({ role: "user", content: resultBlocks })`,
    gate: "tests/unit/agent/turn-closeout-hellgate.test.ts",
    only: "budget trip at tool turn ⇒ no orphan tool_use",
  },
  {
    id: "t02-h1-abort-classification",
    severity: "CRITICAL",
    guards: "T02 L1 H1 — mid-stream abort classifies as aborted (NOT error/RUNTIME_UNKNOWN)",
    src: "src/agent/loop/stream-consume.ts",
    find: `  if (
    config.signal.aborted ||
    (e instanceof LLMError && e.kind === "aborted") ||
    abortReason === "abort"
  )
    return { status: "aborted", result: { aborted: true } }`,
    // Pre-fix: an abort thrown mid-stream fell through to {error} →
    // classifyLLMError("aborted")="fatal" → reported as a runtime failure.
    replace: `  if (
    false &&
    (config.signal.aborted ||
      (e instanceof LLMError && e.kind === "aborted") ||
      abortReason === "abort")
  )
    return { status: "aborted", result: { aborted: true } }`,
    gate: "tests/unit/agent/turn-closeout-hellgate.test.ts",
    only: "mid-stream abort ⇒ reason aborted",
  },

  // ── T08 permission fail-closed base ────────────────────────────────────
  {
    id: "t08-h1-destructive-reset-protected-branch",
    severity: "HIGH",
    guards: "T08 L8 H1 — destructive reset on a protected branch is DENIED (no ref needed)",
    src: "src/permission/branch-only.ts",
    // Pin repoint (drift repair): the reset rules were extracted from the
    // `decideBranchOnly` switch into a top-level `resetVerdict` helper, so the
    // SAME two statements now sit at 2-space indent instead of 4.
    find: `  const isDestructive = allToks.some((t) => t === "--hard" || t === "--merge" || t === "--keep")
  if (isDestructive && currentBranch && protectedBranches.includes(currentBranch)) {`,
    // Pre-fix: only an explicit protected-branch REF target was denied, so a
    // bare `git reset --hard HEAD~3` on main fell through to allow.
    replace: `  const isDestructive = allToks.some((t) => t === "--hard" || t === "--merge" || t === "--keep")
  if (false && isDestructive && currentBranch && protectedBranches.includes(currentBranch)) {`,
    gate: "src/permission/__tests__/fail-closed-base.hellgate.test.ts",
    // Anchored to the LEAF test, not the describe. The old filter was a
    // substring of the enclosing describe name, so it selected all 6 of its
    // tests — including two ALLOW-direction paired controls (FEATURE-branch
    // reset, `--soft` on main) that this mutant does not touch. A failure
    // anywhere in that block would have read as this mutant being killed.
    only: "bare `git reset --hard HEAD~3` on main is DENIED",
  },
  {
    id: "t08-h3-lexical-traversal",
    severity: "HIGH",
    guards: "T08 L8 H3 — lexical `..` traversal cannot escape an allow-root",
    src: "src/permission/access-check.ts",
    // Reverting ONLY the leading `resolve()` is too shallow — the downstream
    // `relative()` + `is-path-inside` BOTH resolve internally (defence in
    // depth), so the gate stayed green. We must restore the genuine PRE-FIX
    // shape: a raw byte-PREFIX match (the old `pathPrefixMatches`), which is the
    // exact fail-open the audit named (`/repo/../etc/passwd` byte-prefixes
    // `/repo/` ⇒ wrongly granted).
    find: `  if (!isAbsolute(entryPath) || !isAbsolute(candidate)) return false
  const root = resolve(entryPath)
  const target = resolve(candidate)
  if (root === target) return true
  // Defense-in-depth: even though \`is-path-inside\` resolves internally, assert
  // the post-resolution relation does NOT begin with a \`..\` segment.
  const rel = relative(root, target)
  if (rel === ".." || rel.startsWith(\`..\${sep}\`) || isAbsolute(rel)) {
    return false
  }
  return isPathInside(target, root)`,
    replace: `  // [mutation] pre-T08 raw byte-prefix match — fails OPEN on lexical traversal.
  void resolve
  void relative
  void isPathInside
  void sep
  if (entryPath === candidate) return true
  const boundary = entryPath.endsWith("/") ? entryPath : \`\${entryPath}/\`
  return candidate.startsWith(boundary)`,
    gate: "src/permission/__tests__/fail-closed-base.hellgate.test.ts",
    // Leaf-anchored: the old filter was the describe name verbatim (6 tests,
    // two of them ALLOW-direction controls). This is the single case that
    // exercises the reverted byte-prefix fail-open.
    only: "`/repo/../etc/passwd` is DENIED despite byte-prefixing",
  },
  {
    id: "t08-h4-empty-writable-roots-deny",
    severity: "HIGH",
    guards: "T08 L8 H4 — empty writableRoots is DENY, not writable-anywhere",
    src: "src/permission/per-thread-store.ts",
    find: `      const roots = perm.sandboxPolicy.writableRoots
      if (!roots || roots.length === 0) return false`,
    // Pre-fix: an empty writableRoots list returned `true` — writable anywhere.
    replace: `      const roots = perm.sandboxPolicy.writableRoots
      if (!roots || roots.length === 0) return true`,
    gate: "src/permission/__tests__/fail-closed-base.hellgate.test.ts",
    // Leaf-anchored: the old filter matched the describe (3 tests, one of them
    // an ALLOW-direction control). This is the arm the revert flips.
    only: "workspace-write with EMPTY writableRoots denies a write",
  },
  {
    id: "t08-h5-custom-host-mode-defer",
    severity: "HIGH",
    guards: "T08 L8 H5 — `custom` host mode is DEFER, never an implicit allow",
    src: "src/permission/per-host-mode.ts",
    find: `    case "custom":
      return "defer"`,
    // Pre-fix: `custom` mapped to allow (legacy boolean adapter returned true),
    // so a host marked "custom — restrict me later" was silently writable.
    replace: `    case "custom":
      return "allow"`,
    gate: "src/permission/__tests__/fail-closed-base.hellgate.test.ts",
    // `-t` is a REGEX over the FULL name (describe + test). Bare "custom" also
    // matched the enclosing describe, selecting all 3 of its tests — including
    // one that never touches the `custom` arm — so an unrelated failure could
    // read as this mutant being killed. Pinned to the single test that asserts
    // the mutated branch; parens escaped because the filter is a regex.
    only: "hostMutationVerdict\\(.custom.\\) === .defer.",
  },
]

/* ─── runner ──────────────────────────────────────────────────────────── */

interface Result {
  readonly mutation: Mutation
  readonly redOnRevert: boolean
  readonly note: string
}

const runGate = (gate: string, only?: string): { failed: boolean; raw: string; ran: number } => {
  const args = ["test", join(repoRoot, gate)]
  if (only !== undefined) args.push("-t", only)
  const out = spawnSync("bun", args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0" },
  })
  const raw = `${out.stdout ?? ""}${out.stderr ?? ""}`
  // bun test exits non-zero on any failing test; also parse the summary as a
  // belt-and-braces signal (a thrown/rejected case may exit non-zero with no
  // `N fail` line).
  const failMatch = raw.match(/(\d+) fail/)
  const failed = (out.status ?? 0) !== 0 || (failMatch !== null && Number(failMatch[1]) > 0)
  // Selection width: how many tests the `-t` filter actually ran. A missing
  // summary line reads as -1 so the leaf-anchor guard treats it as "not one".
  const passCount = Number(raw.match(/(\d+) pass/)?.[1] ?? Number.NaN)
  const failCount = Number(failMatch?.[1] ?? Number.NaN)
  const ran =
    Number.isNaN(passCount) && Number.isNaN(failCount)
      ? -1
      : (Number.isNaN(passCount) ? 0 : passCount) + (Number.isNaN(failCount) ? 0 : failCount)
  return { failed, raw, ran }
}

/**
 * STATIC PRE-FLIGHT — the part of the leaf-anchor rule that needs NO spawning.
 *
 * WHY THIS IS SPLIT OUT. The width measurement below ({@link assertLeafAnchored})
 * costs one `bun test` spawn per entry (14 entries today; a single filtered gate
 * spawn measured 2.4-2.7s on 2026-08-28, so the pre-flight is tens of seconds),
 * which is why it lives in a tool and not in the suite — and a guard that lives
 * only in a tool, on a repo whose CI has been billing-blocked for weeks, RUNS
 * NOWHERE. Measured: gutting the width guard to `if (ran >= 0)` left the only
 * test covering this file at 5 pass / 0 fail — it SURVIVED. So the checks that
 * are PURE are pulled out here, where
 * `tests/unit/_arch/mutation-check-drift-ratchet.test.ts` calls them and
 * `bun test` enforces them on every run.
 *
 * What is pure, and therefore actually enforced:
 *   1. every entry HAS an `only` filter (an absent filter runs the whole gate
 *      file, so ANY failure in it reads as this mutant being killed),
 *   2. every entry's `gate` file EXISTS — this used to be reported as an
 *      over-broad `only`, naming the wrong input entirely, and
 *   3. every `only` COMPILES as a regex (`-t` takes a regex; one that throws or
 *      matches nothing is an unkillable green).
 *
 * `gateExists` is injected so the ratchet can push synthetic entries through
 * THIS function rather than through a re-implementation of the rule.
 */
export interface MutationStaticProblem {
  readonly id: string
  /** Which field of the entry is actually at fault. Attribution is the point. */
  readonly field: "only" | "gate"
  readonly problem: string
}

export const findStaticProblems = (
  mutations: readonly Mutation[],
  gateExists: (gate: string) => boolean = (gate) => existsSync(join(repoRoot, gate)),
): readonly MutationStaticProblem[] => {
  const problems: MutationStaticProblem[] = []
  for (const m of mutations) {
    if (!gateExists(m.gate)) {
      // ATTRIBUTION. The width check cannot tell "no such file" from "the filter
      // matched nothing" — both produce no `N pass` summary line — so it blamed
      // `only` and told you to anchor a filter that was never the problem.
      problems.push({
        id: m.id,
        field: "gate",
        problem: `gate file DOES NOT EXIST: ${m.gate} — the gate moved or was renamed. Repoint \`gate\`.`,
      })
    }
    if (m.only === undefined) {
      problems.push({
        id: m.id,
        field: "only",
        problem:
          `has NO \`only\` filter — the whole of ${m.gate} runs, so ANY ` +
          `failure in that file reads as this mutant being killed. Anchor it to one leaf test.`,
      })
      continue
    }
    try {
      new RegExp(m.only)
    } catch (err) {
      problems.push({
        id: m.id,
        field: "only",
        problem:
          `\`only\` is not a valid regex (${String(err)}) — \`bun test -t\` takes a REGEX, ` +
          `so this selects nothing and every mutant under it reads as green: ${JSON.stringify(m.only)}`,
      })
    }
  }
  return problems
}

const reportProblems = (problems: readonly string[]): never => {
  console.error(`\n✗ over-broad (or dead) mutation filters — refusing to mutate:`)
  for (const p of problems) console.error(`  ${p}`)
  process.exit(2)
}

/**
 * WIDTH MEASUREMENT — every entry's `only` must select EXACTLY ONE test.
 *
 * ⚠️ THIS CHECK IS MANUAL. It spawns `bun test` once per entry and is reached
 * ONLY from {@link main} — i.e. only when a human runs `bun run mutation-check`
 * or types the tool's path. Nothing in `bun test` and nothing in CI calls it.
 * Do not read its existence as coverage; the falsifiable half of the rule is
 * {@link findStaticProblems}, which the drift ratchet does run.
 *
 * The width cannot be made cheap. `bun test` has no dry-run/list mode (checked
 * `bun test --help`, 1.3.14), and reading test names statically is UNSOUND in
 * this repo because gate files generate names at runtime — e.g.
 * `tests/unit/_arch/ts-exports-ssot.test.ts` builds `AST: ${fx.name}` in a loop
 * — so a static reader would measure a template string, not a test name.
 *
 * `ran !== 1` covers both directions: a filter matching a describe (too wide),
 * and a filter matching nothing after a test rename (too narrow), which would
 * otherwise read as an unkillable green.
 *
 * KNOWN AND DELIBERATELY OPEN: width 1 does not prove the RIGHT test. A filter
 * can select exactly one UNRELATED leaf and pass here (measured: the
 * `hostMutationVerdict full/read-only/undefined` leaf selects 1 over the
 * empty-`writableRoots` entry's gate). That is FAIL-LOUD, not fail-silent — an
 * unrelated test does not touch the reverted `src`, so it stays green under the
 * revert and the entry is reported as a BLIND SPOT (exit 1). Closing it would
 * need per-test coverage attribution; a name/shape check would just be the
 * hand-written list this rail exists to delete.
 */
export const assertLeafAnchored = (mutations: readonly Mutation[]): void => {
  const statics = findStaticProblems(mutations)
  const problems: string[] = statics.map((p) => `[${p.id}] (${p.field}) ${p.problem}`)
  const brokenIds = new Set(statics.map((p) => p.id))
  for (const m of mutations) {
    // Do not spawn for an entry already known bad: running a filter against a
    // missing gate is exactly what produced the misattributed message.
    if (m.only === undefined || brokenIds.has(m.id)) continue
    const { ran } = runGate(m.gate, m.only)
    if (ran === 1) {
      console.log(`✓ leaf-anchored (selects 1): ${m.id}`)
      continue
    }
    problems.push(
      `[${m.id}] (only) \`only\` selected ${ran === -1 ? "an unreadable count" : `${ran} tests`}, ` +
        `must select exactly 1. Filter: ${JSON.stringify(m.only)} over ${m.gate}. ` +
        `\`-t\` is a REGEX over describe+test — anchor it to the LEAF test name.`,
    )
  }
  if (problems.length > 0) reportProblems(problems)
}

/**
 * The pin check, SEPARATED from the write so a guard can call it.
 *
 * `applyRevert` used to inline this, which meant the drift ratchet had to
 * re-implement `split(find).length - 1` locally — a test auditing its own copy
 * of the rule, which is the anti-pattern the ratchet exists to close. Both now
 * call this.
 *
 * Returns the occurrence count; the caller decides what 0 or >1 means.
 */
export const findOccurrences = (source: string, find: string): number =>
  source.split(find).length - 1

const applyRevert = (m: Mutation): string => {
  const abs = join(repoRoot, m.src)
  const original = readFileSync(abs, "utf8")
  const count = findOccurrences(original, m.find)
  if (count === 0) {
    throw new Error(
      `[${m.id}] find-string NOT PRESENT in ${m.src} — fix drifted (rename/move). ` +
        `Update the mutation entry. (This is a HARD error, never a blind spot.)`,
    )
  }
  if (count > 1 && m.find !== m.replace) {
    throw new Error(`[${m.id}] find-string is NOT UNIQUE in ${m.src} (${count}×) — tighten it.`)
  }
  if (m.find !== m.replace) {
    writeFileSync(abs, original.replace(m.find, m.replace), "utf8")
  }
  return original
}

const restore = (m: Mutation, original: string): void => {
  writeFileSync(join(repoRoot, m.src), original, "utf8")
}

const main = async (): Promise<void> => {
  const filter = process.argv[2]
  const selected = filter ? MUTATIONS.filter((m) => m.id.includes(filter)) : [...MUTATIONS]
  if (selected.length === 0) {
    console.error(`no mutation matches "${filter}"`)
    process.exit(2)
  }

  // STATIC pre-flight FIRST. A missing gate file makes `bun test` exit 1, which
  // the baseline loop below would report as "baseline FAILED" and the width
  // check would report as an over-broad `only` — two wrong names for the same
  // input. Naming it here, before any spawn, is also the half of this rail that
  // `bun test` enforces (see findStaticProblems).
  const statics = findStaticProblems(selected)
  if (statics.length > 0) reportProblems(statics.map((p) => `[${p.id}] (${p.field}) ${p.problem}`))

  // Sanity: every gate must be GREEN at HEAD before we mutate anything.
  console.log("── baseline (HEAD, no mutation) ──")
  const baselineGates = new Map<string, boolean>()
  for (const gate of new Set(selected.map((m) => m.gate))) {
    const { failed, raw } = runGate(gate)
    if (failed) {
      console.error(`✗ baseline FAILED for ${gate} — refusing to mutate. Excerpt:`)
      console.error(raw.split("\n").slice(-12).join("\n"))
      process.exit(2)
    }
    baselineGates.set(gate, true)
    console.log(`✓ baseline green: ${gate}`)
  }

  // Pre-flight, on the UNMUTATED tree: every filter must select exactly one
  // test. Runs after the baseline (so a red gate is reported as a red gate, not
  // as a bad filter) and before the first revert.
  console.log("\n── leaf-anchor pre-flight (every `only` must select exactly 1 test) ──")
  assertLeafAnchored(selected)

  const results: Result[] = []
  for (const m of selected) {
    process.stdout.write(`\n▶ ${m.id} (${m.severity}) … `)
    if (m.find === m.replace) {
      console.log("SKIP (no revert encoded — placeholder)")
      results.push({ mutation: m, redOnRevert: false, note: "no-revert-encoded" })
      continue
    }
    let original: string | undefined
    try {
      original = applyRevert(m)
      const { failed } = runGate(m.gate, m.only)
      results.push({
        mutation: m,
        redOnRevert: failed,
        note: failed ? "REAL (red on revert)" : "BLIND SPOT (stayed green)",
      })
      console.log(failed ? "RED ✓ (real proof rail)" : "GREEN ✗ (BLIND SPOT)")
    } finally {
      if (original !== undefined) restore(m, original)
    }
  }

  console.log("\n── summary ──")
  const blind = results.filter((r) => r.note.startsWith("BLIND"))
  for (const r of results) {
    console.log(
      `${r.redOnRevert ? "RED " : "GREEN"}  ${r.mutation.severity.padEnd(8)} ${r.mutation.id}`,
    )
  }
  console.log(
    `\n${results.length - blind.length}/${results.length} hellgates are REAL proof rails; ` +
      `${blind.length} BLIND SPOT(s).`,
  )
  if (blind.length > 0) {
    console.log("BLIND SPOTS:", blind.map((b) => b.mutation.id).join(", "))
    process.exit(1)
  }
}

if (import.meta.main) {
  await main()
}
