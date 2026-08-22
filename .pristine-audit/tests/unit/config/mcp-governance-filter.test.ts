/**
 * §12.4 LIVE-wire — pure MCP launch-policy filter (the ENFORCEMENT half of the
 * central-config MCP governance; the merge half resolves
 * `mcpEnabledServers`/`mcpDeniedServers` but until now NO launcher consumed
 * them — built-not-wired).
 *
 * Semantics (no behavior cliff):
 *   - `deniedServers` — HARD drop, always (tightening; mirrors permission deny).
 *   - `enabledServers` — when NON-EMPTY it is an exclusive allowlist for the
 *     project `.mcp.json` servers; when EMPTY/absent it filters NOTHING (legacy
 *     byte-identical — turning central-config on without configuring
 *     `mcp.enabledServers` must not silently kill existing servers).
 *   - deny wins over enable (defense-in-depth, same as the merge).
 * Pure: no gate read, no IO — the caller owns the centralConfig gate.
 */
import { describe, expect, test } from "bun:test"
import { filterMcpServersByPolicy } from "@/config"

const srv = (name: string) => ({ name, command: ["bun", `${name}.ts`] })

describe("filterMcpServersByPolicy — enforcement semantics", () => {
  test("no policy fields ⇒ identity (legacy byte-identical, same references)", () => {
    const servers = [srv("fs"), srv("git")]
    const r = filterMcpServersByPolicy(servers, { enabledServers: [], deniedServers: [] })
    expect(r.kept).toEqual(servers)
    expect(r.dropped).toEqual([])
  })

  test("deniedServers drops by name (hard governance)", () => {
    const r = filterMcpServersByPolicy([srv("fs"), srv("evil"), srv("git")], {
      enabledServers: [],
      deniedServers: ["evil"],
    })
    expect(r.kept.map((s) => s.name)).toEqual(["fs", "git"])
    expect(r.dropped).toEqual([{ name: "evil", reason: "denied" }])
  })

  test("non-empty enabledServers is an exclusive allowlist", () => {
    const r = filterMcpServersByPolicy([srv("fs"), srv("web"), srv("git")], {
      enabledServers: ["fs", "git"],
      deniedServers: [],
    })
    expect(r.kept.map((s) => s.name)).toEqual(["fs", "git"])
    expect(r.dropped).toEqual([{ name: "web", reason: "not-enabled" }])
  })

  test("deny wins over enable (defense-in-depth)", () => {
    const r = filterMcpServersByPolicy([srv("fs"), srv("git")], {
      enabledServers: ["fs", "git"],
      deniedServers: ["git"],
    })
    expect(r.kept.map((s) => s.name)).toEqual(["fs"])
    expect(r.dropped).toEqual([{ name: "git", reason: "denied" }])
  })

  test("empty server list ⇒ empty result, no throw", () => {
    const r = filterMcpServersByPolicy([], { enabledServers: ["x"], deniedServers: ["y"] })
    expect(r.kept).toEqual([])
    expect(r.dropped).toEqual([])
  })
})
