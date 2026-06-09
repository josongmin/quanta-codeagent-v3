/**
 * §12.4 LIVE-wire hellgate — central-config MCP governance END-TO-END through
 * the REAL `resolveMcpLaunchPolicy` + `readMcpConfig` (the previously-inert
 * `mcpEnabledServers`/`mcpDeniedServers` now gate which `.mcp.json` servers
 * materialize). Real temp dirs + real settings/trust/mcp files; no mocks of
 * the modules under test.
 *
 * red-on-injection: reverting the `loadFeatures`/`readMcpConfig` policy
 * plumbing turns these RED (denied server would materialize again).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { StructuredLogger } from "@/observability"
import { __resetRuntimeConfig } from "@/shared"
import { readMcpConfig, resolveMcpLaunchPolicy } from "../../src/apps/cli/internal"

const slogEvents: { event: string; data: Record<string, unknown> }[] = []
const slog = {
  info: (event: string, data?: Record<string, unknown>) => slogEvents.push({ event, data: data ?? {} }),
  warn: (event: string, data?: Record<string, unknown>) => slogEvents.push({ event, data: data ?? {} }),
  error: (event: string, data?: Record<string, unknown>) => slogEvents.push({ event, data: data ?? {} }),
} as unknown as StructuredLogger

let dir: string
let envSnapshot: NodeJS.ProcessEnv
let savedCwd: string

const MCP_JSON = JSON.stringify({
  mcpServers: {
    fs: { command: "bun", args: ["fs.ts"] },
    evil: { command: "bun", args: ["evil.ts"] },
    web: { command: "bun", args: ["web.ts"] },
  },
})

beforeEach(() => {
  envSnapshot = { ...process.env }
  savedCwd = process.cwd()
  dir = mkdtempSync(join(tmpdir(), "mcp-gov-"))
  slogEvents.length = 0
  __resetRuntimeConfig()
})
afterEach(() => {
  process.chdir(savedCwd)
  rmSync(dir, { recursive: true, force: true })
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) delete process.env[key]
  }
  Object.assign(process.env, envSnapshot)
  __resetRuntimeConfig()
})

/** Lay down a project with .mcp.json + user-layer settings + (optional) trust. */
const project = (opts: {
  userSettings?: object
  projectSettings?: object
  trustCwd?: boolean
}): { cwd: string } => {
  const cwd = join(dir, "repo")
  const userDir = join(dir, "usercfg")
  mkdirSync(cwd, { recursive: true })
  mkdirSync(userDir, { recursive: true })
  writeFileSync(join(cwd, ".mcp.json"), MCP_JSON)
  process.env.QUANTA_MCP_CONFIG = join(cwd, ".mcp.json")
  if (opts.userSettings) writeFileSync(join(userDir, "settings.json"), JSON.stringify(opts.userSettings))
  if (opts.projectSettings) {
    mkdirSync(join(cwd, ".quanta"), { recursive: true })
    writeFileSync(join(cwd, ".quanta", "settings.json"), JSON.stringify(opts.projectSettings))
  }
  process.env.QUANTA_CENTRAL_CONFIG = "1"
  process.env.QUANTA_CONFIG_DIR = userDir
  // realpath the trust grant — the resolver compares against realpath(cwd)
  // (macOS tmpdir is a symlink: /var/folders → /private/var/folders).
  if (opts.trustCwd) process.env.QUANTA_TRUSTED_PATHS = realpathSync(cwd)
  process.chdir(cwd)
  __resetRuntimeConfig()
  return { cwd }
}

const names = (servers: readonly { name: string }[]): string[] => servers.map((s) => s.name).sort()

describe("§12.4 LIVE — MCP governance end-to-end", () => {
  test("gate OFF ⇒ policy undefined ⇒ ALL servers materialize (byte-identical legacy)", async () => {
    const cwd = join(dir, "repo")
    mkdirSync(cwd, { recursive: true })
    writeFileSync(join(cwd, ".mcp.json"), MCP_JSON)
    process.env.QUANTA_MCP_CONFIG = join(cwd, ".mcp.json")
    process.chdir(cwd)
    delete process.env.QUANTA_CENTRAL_CONFIG
    __resetRuntimeConfig()
    const policy = await resolveMcpLaunchPolicy(slog)
    expect(policy).toBeUndefined()
    const servers = await readMcpConfig(slog, process.env, policy)
    expect(names(servers)).toEqual(["evil", "fs", "web"])
  })

  test("gate ON + NO mcp policy configured ⇒ undefined ⇒ no behavior cliff", async () => {
    project({ userSettings: { permissions: { allow: ["ls"] } } })
    expect(await resolveMcpLaunchPolicy(slog)).toBeUndefined()
  })

  test("user-layer deniedServers ⇒ denied server NEVER materializes + slog'd", async () => {
    project({ userSettings: { mcp: { deniedServers: ["evil"] } } })
    const policy = await resolveMcpLaunchPolicy(slog)
    expect(policy?.deniedServers).toEqual(["evil"])
    const servers = await readMcpConfig(slog, process.env, policy)
    expect(names(servers)).toEqual(["fs", "web"])
    const drop = slogEvents.find((e) => e.event === "mcp.governance.dropped")
    expect(drop?.data.server).toBe("evil")
    expect(drop?.data.reason).toBe("denied")
  })

  test("TRUSTED repo enabledServers ⇒ exclusive allowlist enforced", async () => {
    project({
      projectSettings: { mcp: { enabledServers: ["fs"] } },
      trustCwd: true,
    })
    const policy = await resolveMcpLaunchPolicy(slog)
    expect(policy?.enabledServers).toEqual(["fs"])
    const servers = await readMcpConfig(slog, process.env, policy)
    expect(names(servers)).toEqual(["fs"])
  })

  test("MANAGED allowManagedMcpServersOnly ⇒ even a TRUSTED repo cannot add servers", async () => {
    const { cwd } = project({
      projectSettings: { mcp: { enabledServers: ["evil", "web"] } },
      trustCwd: true,
    })
    // OS-managed lockdown layer (operator-owned), via the env override the
    // managed-path resolver honors.
    const managedPath = join(dir, "managed-settings.json")
    writeFileSync(
      managedPath,
      JSON.stringify({ mcp: { enabledServers: ["fs"], allowManagedMcpServersOnly: true } }),
    )
    process.env.QUANTA_MANAGED_SETTINGS_PATH = managedPath
    __resetRuntimeConfig()
    const policy = await resolveMcpLaunchPolicy(slog)
    // ONLY the managed grant applies — the trusted repo's adds are blocked.
    expect(policy?.enabledServers).toEqual(["fs"])
    const servers = await readMcpConfig(slog, process.env, policy)
    expect(names(servers)).toEqual(["fs"])
    expect(cwd).toBeTruthy()
  })

  test("UNTRUSTED repo: enabledServers grant dropped, but deniedServers (tightening) SURVIVES", async () => {
    project({
      projectSettings: { mcp: { enabledServers: ["evil"], deniedServers: ["web"] } },
      // NOT trusted
    })
    const policy = await resolveMcpLaunchPolicy(slog)
    // The repo's enable grant is dropped (untrusted) — only the deny survives.
    expect(policy?.enabledServers ?? []).toEqual([])
    expect(policy?.deniedServers).toEqual(["web"])
    const servers = await readMcpConfig(slog, process.env, policy)
    expect(names(servers)).toEqual(["evil", "fs"]) // web denied; no allowlist active
  })
})
