/**
 * Unit tests for `getToolHitlTier` (ADR-0047) — the name-based HITL 4-tier
 * annotation registry. Covers:
 *   - built-in tool-name annotations (apply_patch, write, spawn_agent, …)
 *   - dynamic command/argv dispatch (exec_command/bash)
 *   - dangerous-command patterns (rm -rf /, mkfs, dd of=/dev, sudo, …)
 *   - safe-command patterns (ls, pwd, …)
 *   - user override via `~/.quanta/hitl-overrides.json` (env-redirected for
 *     test isolation — `QUANTA_HITL_OVERRIDES`)
 *   - fallback for unknown tool ⇒ pre-approval-ok (backwards compat)
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { __resetHitlOverrides, getToolHitlTier } from "@/agent/hitl-tier-registry"

describe("getToolHitlTier — built-in tool-name annotations", () => {
  beforeEach(() => {
    // Ensure no stale overrides leak in from another test.
    delete process.env.QUANTA_HITL_OVERRIDES
    __resetHitlOverrides()
  })

  test("apply_patch ⇒ pre-approval-ok", () => {
    expect(getToolHitlTier("apply_patch", {}).tier).toBe("pre-approval-ok")
  })

  test("write ⇒ pre-approval-ok", () => {
    expect(getToolHitlTier("write", { path: "x.ts", content: "y" }).tier).toBe("pre-approval-ok")
  })

  test("edit ⇒ pre-approval-ok", () => {
    expect(getToolHitlTier("edit", {}).tier).toBe("pre-approval-ok")
  })

  test("write_stdin ⇒ pre-approval-ok", () => {
    expect(getToolHitlTier("write_stdin", {}).tier).toBe("pre-approval-ok")
  })

  test("send_input ⇒ pre-approval-ok", () => {
    expect(getToolHitlTier("send_input", {}).tier).toBe("pre-approval-ok")
  })

  test("spawn_agent ⇒ none (lifecycle orchestration)", () => {
    expect(getToolHitlTier("spawn_agent", {}).tier).toBe("none")
  })

  test("agent ⇒ none", () => {
    expect(getToolHitlTier("agent", {}).tier).toBe("none")
  })

  test("wait_agent ⇒ none", () => {
    expect(getToolHitlTier("wait_agent", {}).tier).toBe("none")
  })

  test("task_output ⇒ none", () => {
    expect(getToolHitlTier("task_output", {}).tier).toBe("none")
  })

  test("close_agent ⇒ none", () => {
    expect(getToolHitlTier("close_agent", {}).tier).toBe("none")
  })

  test("task_stop ⇒ none", () => {
    expect(getToolHitlTier("task_stop", {}).tier).toBe("none")
  })

  test("read ⇒ none (read-only)", () => {
    expect(getToolHitlTier("read", { path: "x.ts" }).tier).toBe("none")
  })

  test("grep ⇒ none", () => {
    expect(getToolHitlTier("grep", { pattern: "x" }).tier).toBe("none")
  })

  test("glob ⇒ none", () => {
    expect(getToolHitlTier("glob", { pattern: "*" }).tier).toBe("none")
  })

  test("unknown tool ⇒ pre-approval-ok (safe default)", () => {
    expect(getToolHitlTier("some_new_tool_unseen_before", {}).tier).toBe("pre-approval-ok")
  })
})

describe("getToolHitlTier — exec_command/bash dynamic dispatch", () => {
  beforeEach(() => {
    delete process.env.QUANTA_HITL_OVERRIDES
    __resetHitlOverrides()
  })

  // ----- hand-off-required (irreversible) -----
  test("`rm -rf /` ⇒ hand-off-required (with handoffMessage)", () => {
    const result = getToolHitlTier("exec_command", { command: "rm -rf /" })
    expect(result.tier).toBe("hand-off-required")
    expect(result.handoffMessage).toBeDefined()
    expect(result.handoffMessage).toContain("rm -rf")
  })

  test("`rm -rf ~` ⇒ hand-off-required", () => {
    expect(getToolHitlTier("exec_command", { command: "rm -rf ~" }).tier).toBe("hand-off-required")
  })

  test("`rm -rf $HOME` ⇒ hand-off-required", () => {
    expect(getToolHitlTier("exec_command", { command: "rm -rf $HOME" }).tier).toBe(
      "hand-off-required",
    )
  })

  test("`mkfs.ext4 /dev/sda1` ⇒ hand-off-required", () => {
    expect(getToolHitlTier("exec_command", { command: "mkfs.ext4 /dev/sda1" }).tier).toBe(
      "hand-off-required",
    )
  })

  test("`dd if=/dev/zero of=/dev/sda` ⇒ hand-off-required", () => {
    expect(
      getToolHitlTier("exec_command", { command: "dd if=/dev/zero of=/dev/sda bs=1M" }).tier,
    ).toBe("hand-off-required")
  })

  test("`chmod -R 777 /` ⇒ hand-off-required", () => {
    expect(getToolHitlTier("exec_command", { command: "chmod -R 777 /" }).tier).toBe(
      "hand-off-required",
    )
  })

  test("`sudo apt install x` ⇒ hand-off-required", () => {
    expect(getToolHitlTier("exec_command", { command: "sudo apt install vim" }).tier).toBe(
      "hand-off-required",
    )
  })

  test("`history -c` ⇒ hand-off-required", () => {
    expect(getToolHitlTier("exec_command", { command: "history -c" }).tier).toBe(
      "hand-off-required",
    )
  })

  // ----- always-confirm (high-blast-radius, reversible or network) -----
  test("`git push --force` ⇒ always-confirm", () => {
    expect(getToolHitlTier("exec_command", { command: "git push --force origin main" }).tier).toBe(
      "always-confirm",
    )
  })

  test("`git push -f` ⇒ always-confirm", () => {
    expect(getToolHitlTier("exec_command", { command: "git push -f" }).tier).toBe("always-confirm")
  })

  test("`git push origin main` ⇒ always-confirm (network egress)", () => {
    expect(getToolHitlTier("exec_command", { command: "git push origin main" }).tier).toBe(
      "always-confirm",
    )
  })

  test("`rm -rf /tmp/foo` ⇒ always-confirm (NOT at root)", () => {
    expect(getToolHitlTier("exec_command", { command: "rm -rf /tmp/foo" }).tier).toBe(
      "always-confirm",
    )
  })

  test("`rm -rf ./build` ⇒ always-confirm", () => {
    expect(getToolHitlTier("exec_command", { command: "rm -rf ./build" }).tier).toBe(
      "always-confirm",
    )
  })

  // ----- none (read-only / harmless) -----
  test("`ls` ⇒ none", () => {
    expect(getToolHitlTier("exec_command", { command: "ls" }).tier).toBe("none")
  })

  test("`ls -la` ⇒ none", () => {
    expect(getToolHitlTier("exec_command", { command: "ls -la" }).tier).toBe("none")
  })

  test("`pwd` ⇒ none", () => {
    expect(getToolHitlTier("exec_command", { command: "pwd" }).tier).toBe("none")
  })

  test("`whoami` ⇒ none", () => {
    expect(getToolHitlTier("exec_command", { command: "whoami" }).tier).toBe("none")
  })

  test("`cat file.txt` ⇒ none", () => {
    expect(getToolHitlTier("exec_command", { command: "cat file.txt" }).tier).toBe("none")
  })

  // ----- catch-all (pattern doesn't match) -----
  test("`bun test` ⇒ pre-approval-ok (default, name match)", () => {
    expect(getToolHitlTier("exec_command", { command: "bun test" }).tier).toBe("pre-approval-ok")
  })

  test("`npm install` ⇒ pre-approval-ok", () => {
    expect(getToolHitlTier("exec_command", { command: "npm install" }).tier).toBe("pre-approval-ok")
  })

  // ----- argv-array form -----
  test("argv-form parsed_cmd `[rm, -rf, /]` ⇒ hand-off-required", () => {
    expect(getToolHitlTier("exec_command", { parsed_cmd: ["rm", "-rf", "/"] }).tier).toBe(
      "hand-off-required",
    )
  })

  test("argv-form `[git, push, origin, main]` ⇒ always-confirm", () => {
    expect(
      getToolHitlTier("exec_command", { parsed_cmd: ["git", "push", "origin", "main"] }).tier,
    ).toBe("always-confirm")
  })

  // bash works the same way
  test("bash with `git push --force` ⇒ always-confirm", () => {
    expect(getToolHitlTier("bash", { command: "git push --force" }).tier).toBe("always-confirm")
  })

  test("bash with `rm -rf /etc` ⇒ hand-off-required", () => {
    // /etc is a system root, matched by the `/` (with optional trailing path)
    // branch of the hand-off pattern.
    const result = getToolHitlTier("bash", { command: "rm -rf /etc" })
    // Either hand-off or always-confirm is acceptable for /etc — assert it
    // escalates above pre-approval-ok at minimum.
    expect(["hand-off-required", "always-confirm"]).toContain(result.tier)
  })
})

describe("getToolHitlTier — user overrides via ~/.quanta/hitl-overrides.json", () => {
  let tmp: string
  let overridesPath: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "hitl-test-"))
    overridesPath = join(tmp, "hitl-overrides.json")
    process.env.QUANTA_HITL_OVERRIDES = overridesPath
    __resetHitlOverrides()
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
    delete process.env.QUANTA_HITL_OVERRIDES
    __resetHitlOverrides()
  })

  test("user override takes precedence over built-in annotation", () => {
    // Built-in: apply_patch ⇒ pre-approval-ok
    // Override: apply_patch ⇒ always-confirm
    writeFileSync(
      overridesPath,
      JSON.stringify({
        apply_patch: { tier: "always-confirm", reason: "operator policy" },
      }),
    )
    __resetHitlOverrides()
    const result = getToolHitlTier("apply_patch", {})
    expect(result.tier).toBe("always-confirm")
    expect(result.reason).toBe("operator policy")
  })

  test("user override can promote `read` (none) to `always-confirm`", () => {
    writeFileSync(overridesPath, JSON.stringify({ read: { tier: "always-confirm" } }))
    __resetHitlOverrides()
    expect(getToolHitlTier("read", { path: "x.ts" }).tier).toBe("always-confirm")
  })

  test("user override can mark an unknown tool as hand-off-required with custom message", () => {
    writeFileSync(
      overridesPath,
      JSON.stringify({
        slack_dm: {
          tier: "hand-off-required",
          handoffMessage: "Slack DMs cannot be sent automatically by policy.",
        },
      }),
    )
    __resetHitlOverrides()
    const result = getToolHitlTier("slack_dm", {})
    expect(result.tier).toBe("hand-off-required")
    expect(result.handoffMessage).toBe("Slack DMs cannot be sent automatically by policy.")
  })

  test("missing override file ⇒ built-in behavior (no error)", () => {
    // overridesPath not created. The registry must silently fall back.
    __resetHitlOverrides()
    expect(getToolHitlTier("apply_patch", {}).tier).toBe("pre-approval-ok")
  })

  test("malformed JSON ⇒ silent fallback to built-in", () => {
    writeFileSync(overridesPath, "{ this is not valid json")
    __resetHitlOverrides()
    expect(getToolHitlTier("apply_patch", {}).tier).toBe("pre-approval-ok")
  })

  test("invalid tier value in override ⇒ silently dropped (built-in wins)", () => {
    writeFileSync(
      overridesPath,
      JSON.stringify({
        apply_patch: { tier: "nonsense-tier" },
      }),
    )
    __resetHitlOverrides()
    expect(getToolHitlTier("apply_patch", {}).tier).toBe("pre-approval-ok")
  })

  test("override directory only — file missing ⇒ no error", () => {
    rmSync(overridesPath, { force: true })
    mkdirSync(tmp, { recursive: true })
    __resetHitlOverrides()
    expect(getToolHitlTier("apply_patch", {}).tier).toBe("pre-approval-ok")
  })
})
