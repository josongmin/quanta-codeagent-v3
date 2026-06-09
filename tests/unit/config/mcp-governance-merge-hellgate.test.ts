/**
 * E2 + E1-sub — MCP governance in the central-config merge (extends ADR-0497).
 * Mirrors the existing permission allow/deny + managed-non-overridable pattern
 * for MCP servers:
 *   - `deniedServers` is TIGHTENING: it removes a server from the enabled set
 *     (deny wins over enable) and — like permission `deny` — applies EVEN for an
 *     UNTRUSTED repo layer (§4.c asymmetry: narrowing is always safe).
 *   - `allowManagedMcpServersOnly` (managed layer) is managed-non-overridable:
 *     when set, ONLY managed-layer enabledServers apply (mirrors
 *     allowManagedHooksOnly).
 * Default-OFF byte-identical: neither field/flag set ⇒ resolved is unchanged.
 */
import { describe, expect, test } from "bun:test"
import { mergeSettings } from "@/config"
import type { SettingsLayer } from "@/config"

const mcp = (over: { enabled?: string[]; denied?: string[]; managedOnly?: boolean }): SettingsLayer => ({
  security: {
    mcp: {
      ...(over.enabled !== undefined ? { enabledServers: over.enabled } : {}),
      ...(over.denied !== undefined ? { deniedServers: over.denied } : {}),
      ...(over.managedOnly !== undefined ? { allowManagedMcpServersOnly: over.managedOnly } : {}),
    },
  },
})

describe("MCP governance — denylist (tightening) + managed-only", () => {
  test("byte-identical: only enabledServers ⇒ union (unchanged behavior)", () => {
    const r = mergeSettings({ user: mcp({ enabled: ["fs", "git"] }), project: mcp({ enabled: ["web"] }) }, true)
    expect([...r.mcpEnabledServers].sort()).toEqual(["fs", "git", "web"])
  })

  test("deniedServers removes from enabled — deny wins over enable", () => {
    const r = mergeSettings(
      { user: mcp({ enabled: ["fs", "git", "web"] }), managed: mcp({ denied: ["web"] }) },
      true,
    )
    expect(r.mcpEnabledServers).not.toContain("web")
    expect([...r.mcpEnabledServers].sort()).toEqual(["fs", "git"])
  })

  test("TIGHTENING asymmetry: a repo (project) deniedServers applies EVEN when UNTRUSTED", () => {
    // Untrusted ⇒ the repo's enabledServers (loosening) are dropped, but its
    // deniedServers (tightening) still removes from the machine-owned set.
    const r = mergeSettings(
      { user: mcp({ enabled: ["fs", "git"] }), project: mcp({ enabled: ["evil"], denied: ["git"] }) },
      false,
    )
    expect(r.mcpEnabledServers).not.toContain("git") // repo deny survived
    expect(r.mcpEnabledServers).not.toContain("evil") // repo enable dropped (untrusted)
    expect(r.mcpEnabledServers).toContain("fs")
  })

  test("allowManagedMcpServersOnly: managed sets it ⇒ ONLY managed enabledServers apply", () => {
    const r = mergeSettings(
      {
        managed: { security: { mcp: { enabledServers: ["corp-mcp"], allowManagedMcpServersOnly: true } } },
        user: mcp({ enabled: ["fs"] }),
        project: mcp({ enabled: ["web"] }),
      },
      true, // even a TRUSTED repo cannot add when managed-only is set
    )
    expect([...r.mcpEnabledServers].sort()).toEqual(["corp-mcp"])
  })

  test("denylist exposed in resolved for visibility", () => {
    const r = mergeSettings({ managed: mcp({ denied: ["web", "evil"] }) }, true)
    expect([...r.mcpDeniedServers].sort()).toEqual(["evil", "web"])
  })
})
