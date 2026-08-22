/* Codex HITL 4-tier gate — classifier half of `hitl-tier.test.ts`.
 *
 * ADR-0297 (2026-05-25) — sandbox-driven HITL. The bash tier no longer
 * inspects the command string; it closes over the operator-chosen
 * `OsSandboxProfile`. The legacy `bashTool` singleton constructs with
 * profile `undefined` ⇒ tier degrades to `always-confirm` for ALL
 * commands (conservative posture: no sandbox = unknown risk).
 *
 * Cases that previously asserted pre-approval-ok via the regex miss path
 * (`ls -la`, `git status`, `bun test`, the 10-entry negative-control
 * block) now BREAK with the new semantics. Updated below: the existing
 * always-confirm cases stay green (the new tier is more conservative);
 * the legitimate-git negative-control block migrated to a `read-only`
 * profile fixture (where the OS itself blocks mutation, so confirm is
 * redundant — pre-approval-ok is the right answer there).
 *
 * Covers `inferToolTier`:
 *   - defaults from isReadOnly() when hitlTier() absent.
 *   - bash hitlTier() under each closed-enum profile + undefined.
 *   - sandbox=undefined ⇒ ALL bash commands → always-confirm (conservative).
 *   - sandbox=read-only ⇒ ALL bash commands → pre-approval-ok (OS gates).
 * Dispatch-level gating (HARD_DENY handoff, always-confirm enforcement,
 * legacy fallthrough) lives in `hitl-tier-dispatch.test.ts`. Detailed
 * sandbox-matrix coverage lives in `bash-hitl-sandbox-driven-hellgate.test.ts`.
 */

import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { inferToolTier } from "@/permission"
import type { Tool, ToolEvent } from "@/tool"
import { bashTool, makeBashTool } from "@/tool/bash"
import { editTool } from "@/tool/edit"
import { readTool } from "@/tool/read"
import { writeTool } from "@/tool/write"

/** Sandbox-aware bash tool for the legitimate-git negative-control block.
 *  Under `read-only`, the OS itself refuses mutation ⇒ confirmation is
 *  redundant ceremony ⇒ pre-approval-ok is the correct tier. */
const bashReadOnly = makeBashTool({ sandboxProfile: "read-only" })

const makeTool = (
  name: string,
  opts: {
    readOnly?: boolean
    schema?: z.ZodTypeAny
    run: () => AsyncIterable<ToolEvent>
    hitlTier?: (
      input: unknown,
    ) => "hand-off-required" | "always-confirm" | "pre-approval-ok" | "none"
  },
): Tool => ({
  name,
  description: `${name} test tool`,
  inputSchema: (opts.schema ?? z.object({})) as z.ZodType<unknown>,
  isReadOnly: () => opts.readOnly ?? false,
  isConcurrencySafe: () => opts.readOnly ?? false,
  execute: () => opts.run(),
  ...(opts.hitlTier ? { hitlTier: opts.hitlTier } : {}),
})

describe("inferToolTier", () => {
  test("read tool (read-only, no explicit hitlTier) ⇒ none", () => {
    expect(inferToolTier(readTool, { path: "x.ts" })).toBe("none")
  })

  test("write tool (mutating, EXPLICIT hitlTier='pre-approval-ok') ⇒ pre-approval-ok", () => {
    expect(inferToolTier(writeTool, { path: "x.ts", content: "y" })).toBe("pre-approval-ok")
  })

  test("edit tool (mutating, EXPLICIT hitlTier='pre-approval-ok') ⇒ pre-approval-ok", () => {
    expect(inferToolTier(editTool, { path: "x.ts", old_string: "a", new_string: "b" })).toBe(
      "pre-approval-ok",
    )
  })

  // V3-F1 fix: the previous two tests are misleading — they read like a
  // "no explicit hitlTier" check but the fixtures (`writeTool`, `editTool`)
  // ALL declare `hitlTier(): "pre-approval-ok"` explicitly (R3 secure-by-
  // default opt-in). The fail-closed fallback was therefore never executed
  // by any test. Reverting `inferToolTier`'s mutating fallback from
  // `"always-confirm"` to `"pre-approval-ok"` would NOT have caught a
  // regression. These two tests close that hole.
  test("FALLBACK: read-only tool WITHOUT hitlTier() ⇒ none (isReadOnly path)", () => {
    const noTierReadTool = {
      isReadOnly: () => true,
    } satisfies Parameters<typeof inferToolTier>[0]
    expect(inferToolTier(noTierReadTool, {})).toBe("none")
  })

  test("FALLBACK: MUTATING tool WITHOUT hitlTier() ⇒ always-confirm (secure-by-default)", () => {
    const noTierMutatingTool = {
      isReadOnly: () => false,
      // No hitlTier — exercises the actual fallback line in inferToolTier.
    } satisfies Parameters<typeof inferToolTier>[0]
    expect(inferToolTier(noTierMutatingTool, {})).toBe("always-confirm")
  })

  test("bash with `git push origin main` ⇒ always-confirm", () => {
    expect(inferToolTier(bashTool, { command: "git push origin main" })).toBe("always-confirm")
  })

  test("bash with `git push` (no remote) ⇒ always-confirm (mutating git egress)", () => {
    expect(inferToolTier(bashTool, { command: "git push" })).toBe("always-confirm")
  })

  // Round 2 finding: `git send-pack` is the plumbing command behind `git push`
  // — same network egress, same irreversibility. The Round 1 GIT_PREFIX fix
  // missed it; Round 2 adds a dedicated pattern so motivated bypass via
  // plumbing API hits the same always-confirm gate.
  test("bash with `git send-pack origin main` ⇒ always-confirm (push plumbing bypass)", () => {
    expect(inferToolTier(bashTool, { command: "git send-pack origin main" })).toBe("always-confirm")
  })

  test("bash with `git --no-pager send-pack origin main` ⇒ always-confirm", () => {
    expect(inferToolTier(bashTool, { command: "git --no-pager send-pack origin main" })).toBe(
      "always-confirm",
    )
  })

  test("bash with `curl https://x` ⇒ always-confirm (network egress)", () => {
    expect(inferToolTier(bashTool, { command: "curl https://example.com" })).toBe("always-confirm")
  })

  test("bash with `wget https://x` ⇒ always-confirm", () => {
    expect(inferToolTier(bashTool, { command: "wget https://example.com/file" })).toBe(
      "always-confirm",
    )
  })

  test("bash with `gh api repos/foo/bar` ⇒ always-confirm", () => {
    expect(inferToolTier(bashTool, { command: "gh api repos/foo/bar" })).toBe("always-confirm")
  })

  test("bash with `git commit --amend` ⇒ always-confirm", () => {
    expect(inferToolTier(bashTool, { command: "git commit --amend -m fix" })).toBe("always-confirm")
  })

  test("bash with `git reset --hard HEAD~1` ⇒ always-confirm", () => {
    expect(inferToolTier(bashTool, { command: "git reset --hard HEAD~1" })).toBe("always-confirm")
  })

  test("bash with `git fetch origin` ⇒ always-confirm", () => {
    expect(inferToolTier(bashTool, { command: "git fetch origin main" })).toBe("always-confirm")
  })

  // SECURITY: adversarial bypasses of the always-confirm gate via git's
  // global-option prefix tokens. Each of these previously slipped past
  // because the original prefix matcher only accepted tokens NOT starting
  // with `-`. They MUST escalate to always-confirm.
  describe("git global-option bypass hardening (always-confirm)", () => {
    test.each([
      ["git --no-pager push origin main", "long option --no-pager"],
      ["git -C /repo push origin main", "short option -C with operand"],
      ["git -c http.proxy=evil push", "short -c with config injection"],
      ["git -c foo.bar=baz push origin main", "short -c with extra arg"],
      ["git --git-dir=/x push origin main", "long --git-dir=value"],
      ["git --git-dir /x push origin main", "long --git-dir with separate value"],
      ["git --work-tree=/x push", "long --work-tree=value"],
      ["git --no-pager --git-dir=/x push", "two chained long options"],
      ["git\t--no-pager\tpush\torigin\tmain", "tab-separated tokens"],
      ["git    push    origin    main", "extra-whitespace tokens"],
    ])("`%s` ⇒ always-confirm (%s)", (command) => {
      expect(inferToolTier(bashTool, { command })).toBe("always-confirm")
    })

    // `git fetch` with NO remote fetches `origin` by default — the prior gate
    // required a literal `origin` substring, so `git fetch` and
    // `git fetch upstream` slipped past. Both now escalate.
    test.each([
      ["git fetch", "bare git fetch (defaults to origin)"],
      ["git fetch upstream", "git fetch non-origin remote"],
      ["git -C dir fetch", "git -C ... fetch"],
      ["git --no-pager fetch", "git --no-pager fetch"],
    ])("`%s` ⇒ always-confirm (%s)", (command) => {
      expect(inferToolTier(bashTool, { command })).toBe("always-confirm")
    })

    // `git commit --amend` / `git reset --hard` with global options also bypass.
    test.each([
      ["git --no-pager commit --amend -m x", "git --no-pager commit --amend"],
      ["git -C repo commit --amend", "git -C ... commit --amend"],
      ["git -c user.name=x commit --amend", "git -c ... commit --amend"],
      ["git -C repo reset --hard HEAD~1", "git -C ... reset --hard"],
      ["git --no-pager reset --hard origin/main", "git --no-pager reset --hard"],
    ])("`%s` ⇒ always-confirm (%s)", (command) => {
      expect(inferToolTier(bashTool, { command })).toBe("always-confirm")
    })

    // ADR-0297 — legitimate-git commands under a `read-only` sandbox.
    // OS itself refuses mutation ⇒ confirmation is redundant ceremony ⇒
    // pre-approval-ok is correct. Under the old regex code these slipped
    // through because the patterns didn't match; the new tier reaches the
    // same answer for a PRINCIPLED reason (sandbox-driven, not "miss").
    test.each([
      ["git status", "git status"],
      ["git log --oneline", "git log"],
      ["git diff", "git diff"],
      ["git --no-pager status", "git --no-pager status"],
      ["git -C /repo status", "git -C ... status"],
      ["git -c user.name=x status", "git -c ... status"],
      ["git --git-dir=/x log", "git --git-dir=value log"],
      ["git commit -m fix", "ordinary git commit (no --amend)"],
      ["git reset HEAD~1", "git reset without --hard"],
      ["git checkout -b feature/x", "git checkout"],
    ])("`%s` ⇒ pre-approval-ok under sandbox=read-only (%s)", (command) => {
      expect(inferToolTier(bashReadOnly, { command })).toBe("pre-approval-ok")
    })
  })

  // ADR-0297 BREAKING — the default `bashTool` singleton constructs with
  // profile `undefined` ⇒ tier is `always-confirm` for ALL commands. The
  // three cases below previously asserted `pre-approval-ok` because the
  // regex pattern list missed them; now the conservative posture applies
  // uniformly. Operators who want the legacy frictionless UX opt into
  // `QUANTA_SANDBOX=workspace-write` (or similar).
  test("bash with `ls -la` ⇒ always-confirm (unset sandbox = conservative)", () => {
    expect(inferToolTier(bashTool, { command: "ls -la" })).toBe("always-confirm")
  })

  test("bash with `git status` ⇒ always-confirm (unset sandbox = conservative)", () => {
    expect(inferToolTier(bashTool, { command: "git status" })).toBe("always-confirm")
  })

  test("bash with `bun test` ⇒ always-confirm (unset sandbox = conservative)", () => {
    expect(inferToolTier(bashTool, { command: "bun test" })).toBe("always-confirm")
  })

  test("bash with `ls -la` under sandbox=workspace-write ⇒ pre-approval-ok", () => {
    // The legacy frictionless UX is one env var away: operator opts into a
    // mutating sandbox and the bash tier returns pre-approval-ok uniformly.
    const t = makeBashTool({ sandboxProfile: "workspace-write" })
    expect(inferToolTier(t, { command: "ls -la" })).toBe("pre-approval-ok")
  })

  test("explicit hitlTier() wins over isReadOnly() inference", () => {
    const t = makeTool("custom", {
      readOnly: true,
      run: async function* () {
        yield { type: "result", result: { ok: true, output: "" } }
      },
      hitlTier: () => "always-confirm",
    })
    expect(inferToolTier(t, {})).toBe("always-confirm")
  })
})
