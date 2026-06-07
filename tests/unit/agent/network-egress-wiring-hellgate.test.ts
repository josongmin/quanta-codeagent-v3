/**
 * Network-egress enforcement WIRING hellgate (Track A1).
 *
 * Audit found the parts shipped but were never wired: `NetworkPolicy` +
 * `isHostAllowed` + `checkHostAllowlist` + `defaultDispatchGuard` existed, but
 * NOTHING set `config.dispatchGuard`, so egress was defined-but-not-enforced.
 *
 * This battery seals the wiring seam (`buildNetworkDispatchGuard`) AND the
 * end-to-end enforcement path through `dispatchTool` (the same path
 * `assembleAgentConfig` installs the guard into):
 *
 *   HELL-NET-01  posture `open`   → undefined (default-OFF, slot left unset).
 *   HELL-NET-02  posture `allowlist` → on-list host allowed, off-list denied.
 *   HELL-NET-03  `*.suffix` wildcard matches STRICT subdomain only.
 *   HELL-NET-04  posture `denied` → ALL egress denied (empty allowlist).
 *   HELL-NET-05  `perRequestApproval` → off-list host routes to `ask`, not deny.
 *   HELL-NET-06  posture mirror — NetworkPosture ≡ NetworkLever["kind"].
 *   HELL-NET-07  end-to-end: open-posture guard absent ⇒ web_fetch executes.
 *   HELL-NET-08  end-to-end: allowlist guard denies off-list URL at dispatch.
 *   HELL-NET-09  end-to-end: perRequestApproval guard → preview "guard-ask".
 */

import { describe, expect, test } from "bun:test"
import { z } from "zod"
import type { AgentConfig } from "@/agent"
import { MODE_PRESETS } from "@/agent"
import { dispatchTool } from "@/agent/dispatch"
import { buildNetworkDispatchGuard, type NetworkPosture } from "@/agent/dispatch-guard"
import type { ToolUseBlock } from "@/llm"
import type { PermissionContext } from "@/permission"
import type { Tool, ToolEvent } from "@/tool"
import { ToolRegistry } from "@/tool"

// ---------------------------------------------------------------------------
// HELL-NET-01..05: pure wiring seam (buildNetworkDispatchGuard).
// ---------------------------------------------------------------------------

describe("HELL-NET-01 open posture → undefined (default-OFF)", () => {
  test("open ⇒ no guard (slot stays unset ⇒ byte-identical)", () => {
    expect(buildNetworkDispatchGuard({ posture: "open" })).toBeUndefined()
    // hosts / perRequestApproval are irrelevant for `open`.
    expect(
      buildNetworkDispatchGuard({
        posture: "open",
        hosts: ["api.github.com"],
        perRequestApproval: true,
      }),
    ).toBeUndefined()
  })
})

describe("HELL-NET-02 allowlist posture enforces host filter", () => {
  const guard = buildNetworkDispatchGuard({
    posture: "allowlist",
    hosts: ["api.github.com", "*.githubusercontent.com"],
  })
  test("guard is defined", () => {
    expect(guard).toBeDefined()
  })
  test("on-list host → allow", () => {
    expect(guard?.check("web_fetch", { url: "https://api.github.com/repos" }).kind).toBe("allow")
  })
  test("off-list host → deny (hardDeny)", () => {
    const d = guard?.check("web_fetch", { url: "https://evil.example.com/x" })
    expect(d?.kind).toBe("deny")
    if (d?.kind === "deny") expect(d.hardDeny).toBe(true)
  })
  test("empty hosts in allowlist posture → deny everything", () => {
    const g = buildNetworkDispatchGuard({ posture: "allowlist", hosts: [] })
    expect(g?.check("web_fetch", { url: "https://api.github.com/x" }).kind).toBe("deny")
  })
  test("absent hosts in allowlist posture → deny everything (strictest)", () => {
    const g = buildNetworkDispatchGuard({ posture: "allowlist" })
    expect(g?.check("web_fetch", { url: "https://api.github.com/x" }).kind).toBe("deny")
  })
})

describe("HELL-NET-03 `*.suffix` matches strict subdomain only", () => {
  const guard = buildNetworkDispatchGuard({
    posture: "allowlist",
    hosts: ["*.githubusercontent.com"],
  })
  test("subdomain matches", () => {
    expect(guard?.check("web_fetch", { url: "https://raw.githubusercontent.com/x" }).kind).toBe(
      "allow",
    )
  })
  test("bare apex does NOT match the wildcard", () => {
    // `*.githubusercontent.com` must NOT admit the apex `githubusercontent.com`.
    expect(guard?.check("web_fetch", { url: "https://githubusercontent.com/x" }).kind).toBe("deny")
  })
})

describe("HELL-NET-04 denied posture blocks ALL egress", () => {
  const guard = buildNetworkDispatchGuard({ posture: "denied" })
  test("guard defined", () => {
    expect(guard).toBeDefined()
  })
  test("any URL denied (even a would-be-allowlisted host)", () => {
    expect(guard?.check("web_fetch", { url: "https://api.github.com/x" }).kind).toBe("deny")
    expect(guard?.check("web_fetch", { url: "https://example.com/x" }).kind).toBe("deny")
  })
  test("denied posture IGNORES hosts (categorical refusal)", () => {
    const g = buildNetworkDispatchGuard({ posture: "denied", hosts: ["api.github.com"] })
    expect(g?.check("web_fetch", { url: "https://api.github.com/x" }).kind).toBe("deny")
  })
  test("denied posture IGNORES perRequestApproval (never asks)", () => {
    const g = buildNetworkDispatchGuard({
      posture: "denied",
      perRequestApproval: true,
    })
    expect(g?.check("web_fetch", { url: "https://api.github.com/x" }).kind).toBe("deny")
  })
})

describe("HELL-NET-05 perRequestApproval routes off-list host to ask", () => {
  const guard = buildNetworkDispatchGuard({
    posture: "allowlist",
    hosts: ["api.github.com"],
    perRequestApproval: true,
  })
  test("off-list host → ask (NOT deny)", () => {
    const d = guard?.check("web_fetch", { url: "https://evil.example.com/x" })
    expect(d?.kind).toBe("ask")
  })
  test("on-list host → allow (approval not needed)", () => {
    expect(guard?.check("web_fetch", { url: "https://api.github.com/x" }).kind).toBe("allow")
  })
})

describe("HELL-NET-06 every mode's network lever is a valid NetworkPosture", () => {
  test("each MODE_PRESETS network.kind is consumable by buildNetworkDispatchGuard", () => {
    // The wiring posture mirror must accept every kind a mode preset can bind:
    // open ⇒ undefined, allowlist/denied ⇒ a guard. This pins NetworkPosture in
    // lock-step with the run-mode NetworkLever via the real preset matrix.
    for (const policy of Object.values(MODE_PRESETS)) {
      const posture = policy.network.kind as NetworkPosture
      const guard = buildNetworkDispatchGuard({ posture, hosts: ["api.github.com"] })
      if (posture === "open") expect(guard).toBeUndefined()
      else expect(guard).toBeDefined()
    }
  })
})

// ---------------------------------------------------------------------------
// HELL-NET-07..09: end-to-end through dispatchTool (the assemble install path).
// ---------------------------------------------------------------------------

const makeTool = (name: string, readOnly: boolean): Tool => ({
  name,
  description: `${name} test tool`,
  inputSchema: z.object({}).passthrough() as z.ZodType<unknown>,
  isReadOnly: () => readOnly,
  isConcurrencySafe: () => readOnly,
  execute: async function* (): AsyncIterable<ToolEvent> {
    yield { type: "result", result: { ok: true, output: "fetched" } }
  },
})

const config = (over: Partial<AgentConfig> = {}): AgentConfig =>
  ({
    registry: new ToolRegistry([makeTool("web_fetch", true)]),
    cwd: "/repo",
    signal: new AbortController().signal,
    planMode: false,
    permission: { mode: "acceptEdits" } as PermissionContext,
    ...over,
  }) as AgentConfig

const perm: PermissionContext = { mode: "acceptEdits" }
const call = (name: string, input: unknown): ToolUseBlock => ({
  type: "tool_use",
  id: "c1",
  name,
  input,
})

describe("HELL-NET-07 open posture ⇒ no guard ⇒ egress executes", () => {
  test("no dispatchGuard wired → web_fetch runs (ok=true), no guard tag", async () => {
    const guard = buildNetworkDispatchGuard({ posture: "open" })
    const cfg = config(guard !== undefined ? { dispatchGuard: guard } : {})
    const res = await dispatchTool(
      call("web_fetch", { url: "https://evil.example.com/x" }),
      cfg,
      perm,
    )
    expect(res.ok).toBe(true)
    expect(res.preview).not.toBe("guard-deny")
    expect(res.preview).not.toBe("guard-ask")
  })
})

describe("HELL-NET-08 allowlist posture ⇒ off-list URL denied at dispatch", () => {
  test("off-list URL → guard-deny, tool never executes", async () => {
    const guard = buildNetworkDispatchGuard({
      posture: "allowlist",
      hosts: ["api.github.com"],
    })
    expect(guard).toBeDefined()
    const cfg = config(guard !== undefined ? { dispatchGuard: guard } : {})
    const res = await dispatchTool(
      call("web_fetch", { url: "https://evil.example.com/x" }),
      cfg,
      perm,
    )
    expect(res.ok).toBe(false)
    expect(res.preview).toBe("guard-deny")
  })
  test("on-list URL → executes", async () => {
    const guard = buildNetworkDispatchGuard({
      posture: "allowlist",
      hosts: ["api.github.com"],
    })
    expect(guard).toBeDefined()
    const cfg = config(guard !== undefined ? { dispatchGuard: guard } : {})
    const res = await dispatchTool(
      call("web_fetch", { url: "https://api.github.com/x" }),
      cfg,
      perm,
    )
    expect(res.ok).toBe(true)
  })
})

describe("HELL-NET-09 perRequestApproval ⇒ off-list URL routes to guard-ask", () => {
  test("off-list URL → guard-ask preview tag", async () => {
    const guard = buildNetworkDispatchGuard({
      posture: "allowlist",
      hosts: ["api.github.com"],
      perRequestApproval: true,
    })
    expect(guard).toBeDefined()
    const cfg = config(guard !== undefined ? { dispatchGuard: guard } : {})
    const res = await dispatchTool(
      call("web_fetch", { url: "https://evil.example.com/x" }),
      cfg,
      perm,
    )
    expect(res.ok).toBe(false)
    expect(res.preview).toBe("guard-ask")
  })
})
