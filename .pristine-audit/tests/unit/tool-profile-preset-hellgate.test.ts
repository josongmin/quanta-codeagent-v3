/**
 * Tool profile preset hellgate (ADR-0213).
 *
 * Adversarial battery locking the 4-preset bundle (write / ask / minimal /
 * code-only) + composition with a baseline admissibility.
 *
 * Wire order:
 *   HELL-TP-01 — write preset: every tool allow (read-only AND mutating)
 *   HELL-TP-02 — ask preset: read-only=allow, mutating=confirm
 *   HELL-TP-03 — minimal preset: only LSP-read + git-read allow; everything else deny
 *   HELL-TP-04 — code-only preset: web/image/voice deny; file-edit allow
 *   HELL-TP-05 — unknown profile name throws UnknownToolProfileError
 *   HELL-TP-06 — composeWithBaseline: deny wins over allow/confirm
 *   HELL-TP-07 — composeWithBaseline: confirm wins over allow (UP-nudge)
 *   HELL-TP-08 — composeWithBaseline: allow+allow = allow (no UP-nudge)
 *   HELL-TP-09 — registry: hasPreset narrows the type at runtime
 *   HELL-TP-10 — registry: names() returns all 4 in deterministic order
 *   HELL-TP-11 — explicit override beats category default (per-tool precedence)
 *   HELL-TP-12 — reason field surfaces the profile name (for deny messaging)
 *   HELL-TP-13 — OFF parity: write preset is admissibility-neutral (all allow)
 *   HELL-TP-14 — exhaustive: every named profile yields a defined policy for
 *                a read-only and a mutating fixture (no orphan profile)
 */
import { describe, expect, test } from "bun:test"
import { parseAgentArgs } from "@/../src/apps/agent/cli-args"
import {
  ALL_TOOL_PROFILE_NAMES,
  composeToolProfileWithBaseline,
  defaultToolProfileRegistry,
  defaultToolProfileResolver,
  isToolProfileName,
  PROFILE_PRESETS,
  type ToolProfileName,
  UnknownToolProfileError,
} from "@/agent/tool-profile"

describe("tool-profile preset hellgate (ADR-0213)", () => {
  test("HELL-TP-01 — write preset: every tool allow", () => {
    const r = defaultToolProfileResolver()
    const ro = r.resolve({ profileName: "write", toolName: "read", isReadOnly: true })
    const mut = r.resolve({ profileName: "write", toolName: "edit", isReadOnly: false })
    expect(ro.kind).toBe("allow")
    expect(mut.kind).toBe("allow")
  })

  test("HELL-TP-02 — ask preset: read-only=allow, mutating=confirm", () => {
    const r = defaultToolProfileResolver()
    const ro = r.resolve({ profileName: "ask", toolName: "read", isReadOnly: true })
    const mut = r.resolve({ profileName: "ask", toolName: "edit", isReadOnly: false })
    const bash = r.resolve({ profileName: "ask", toolName: "bash", isReadOnly: false })
    expect(ro.kind).toBe("allow")
    expect(mut.kind).toBe("confirm")
    expect(bash.kind).toBe("confirm")
  })

  test("HELL-TP-03 — minimal preset: only LSP-read + git-read allow", () => {
    const r = defaultToolProfileResolver()
    expect(
      r.resolve({ profileName: "minimal", toolName: "lsp_definition", isReadOnly: true }).kind,
    ).toBe("allow")
    expect(
      r.resolve({ profileName: "minimal", toolName: "git_status", isReadOnly: true }).kind,
    ).toBe("allow")
    // Read-only tool NOT in the minimal allowlist → deny
    expect(r.resolve({ profileName: "minimal", toolName: "read", isReadOnly: true }).kind).toBe(
      "deny",
    )
    // Mutating tool → deny
    expect(r.resolve({ profileName: "minimal", toolName: "edit", isReadOnly: false }).kind).toBe(
      "deny",
    )
  })

  test("HELL-TP-04 — code-only preset: web/image/voice deny; file-edit allow", () => {
    const r = defaultToolProfileResolver()
    expect(
      r.resolve({ profileName: "code-only", toolName: "web_fetch", isReadOnly: true }).kind,
    ).toBe("deny")
    expect(
      r.resolve({ profileName: "code-only", toolName: "web_search", isReadOnly: true }).kind,
    ).toBe("deny")
    expect(
      r.resolve({ profileName: "code-only", toolName: "read_image", isReadOnly: true }).kind,
    ).toBe("deny")
    expect(
      r.resolve({ profileName: "code-only", toolName: "voice_input", isReadOnly: true }).kind,
    ).toBe("deny")
    expect(r.resolve({ profileName: "code-only", toolName: "edit", isReadOnly: false }).kind).toBe(
      "allow",
    )
    expect(r.resolve({ profileName: "code-only", toolName: "bash", isReadOnly: false }).kind).toBe(
      "allow",
    )
    expect(
      r.resolve({ profileName: "code-only", toolName: "lsp_hover", isReadOnly: true }).kind,
    ).toBe("allow")
  })

  test("HELL-TP-05 — unknown profile name throws typed error", () => {
    const r = defaultToolProfileResolver()
    expect(() =>
      r.resolve({
        profileName: "made-up" as unknown as ToolProfileName,
        toolName: "read",
        isReadOnly: true,
      }),
    ).toThrow(UnknownToolProfileError)
  })

  test("HELL-TP-06 — composeWithBaseline: deny wins over allow + confirm", () => {
    expect(composeToolProfileWithBaseline("allow", "deny")).toBe("deny")
    expect(composeToolProfileWithBaseline("deny", "allow")).toBe("deny")
    expect(composeToolProfileWithBaseline("confirm", "deny")).toBe("deny")
    expect(composeToolProfileWithBaseline("deny", "confirm")).toBe("deny")
  })

  test("HELL-TP-07 — composeWithBaseline: confirm beats allow (UP-nudge only)", () => {
    expect(composeToolProfileWithBaseline("allow", "confirm")).toBe("confirm")
    expect(composeToolProfileWithBaseline("confirm", "allow")).toBe("confirm")
  })

  test("HELL-TP-08 — composeWithBaseline: allow+allow = allow (no nudge)", () => {
    expect(composeToolProfileWithBaseline("allow", "allow")).toBe("allow")
  })

  test("HELL-TP-09 — registry: hasPreset is a type guard at runtime", () => {
    const reg = defaultToolProfileRegistry()
    expect(reg.hasPreset("ask")).toBe(true)
    expect(reg.hasPreset("write")).toBe(true)
    expect(reg.hasPreset("not-a-real-profile")).toBe(false)
    // isToolProfileName mirrors the registry check
    expect(isToolProfileName("ask")).toBe(true)
    expect(isToolProfileName(42)).toBe(false)
  })

  test("HELL-TP-10 — registry: names() returns all 4 in deterministic order", () => {
    const reg = defaultToolProfileRegistry()
    expect([...reg.names()]).toEqual(["write", "ask", "minimal", "code-only"])
    expect(ALL_TOOL_PROFILE_NAMES.length).toBe(4)
  })

  test("HELL-TP-11 — explicit per-tool override beats category default", () => {
    // code-only's category default for read-only is allow; the explicit
    // web_fetch=deny entry MUST override that.
    const preset = PROFILE_PRESETS["code-only"]
    expect(preset.defaultReadOnly).toBe("allow")
    expect(preset.tools.web_fetch).toBe("deny")
    const r = defaultToolProfileResolver()
    expect(
      r.resolve({ profileName: "code-only", toolName: "web_fetch", isReadOnly: true }).kind,
    ).toBe("deny")
  })

  test("HELL-TP-12 — reason field surfaces the profile name (for deny messaging)", () => {
    const r = defaultToolProfileResolver()
    const policy = r.resolve({
      profileName: "minimal",
      toolName: "edit",
      isReadOnly: false,
    })
    expect(policy.reason).toContain("minimal")
  })

  test("HELL-TP-13 — OFF parity: write preset is admissibility-neutral", () => {
    // The write preset is the DEFAULT; folding it into any baseline must
    // be a no-op (the baseline wins). compose(baseline, allow) == baseline.
    expect(composeToolProfileWithBaseline("allow", "allow")).toBe("allow")
    expect(composeToolProfileWithBaseline("confirm", "allow")).toBe("confirm")
    expect(composeToolProfileWithBaseline("deny", "allow")).toBe("deny")
  })

  test("HELL-TP-14 — exhaustive: every named profile yields a defined policy for ro+mut", () => {
    const r = defaultToolProfileResolver()
    for (const name of ALL_TOOL_PROFILE_NAMES) {
      const ro = r.resolve({ profileName: name, toolName: "read", isReadOnly: true })
      const mut = r.resolve({ profileName: name, toolName: "edit", isReadOnly: false })
      // Every profile must produce a defined kind for both shapes —
      // catches "preset registered but rules missing" drift.
      expect(["allow", "confirm", "deny"]).toContain(ro.kind)
      expect(["allow", "confirm", "deny"]).toContain(mut.kind)
    }
  })

  test("HELL-TP-15 — CLI parser token set stays in parity with ALL_TOOL_PROFILE_NAMES", () => {
    for (const name of ALL_TOOL_PROFILE_NAMES) {
      const parsed = parseAgentArgs(["--mode", "interactive", "--tool-profile", name])
      expect(parsed.toolProfile).toBe(name)
    }
    expect(() =>
      parseAgentArgs(["--mode", "interactive", "--tool-profile", "definitely-not-a-profile"]),
    ).toThrow()
  })
})
