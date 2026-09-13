/**
 * Hellgate — code a folder's files choose runs only in a trusted folder.
 *
 * THE DEFECT (round-9 audit A-F1, and the sibling found while confirming it). Measured on
 * the real servers: pyright ran a workspace `.venv/bin/python`, typescript-language-server
 * loaded the workspace's tsserver, rust-analyzer ran `build.rs` — through `lsp_hover`, a
 * read-only tool that plan mode allows with no confirmation, and through the session
 * prewarm with no tool call at all. The CLI also spawned the commands of `<cwd>/.mcp.json`
 * at startup. Nothing asked whether the folder was trusted.
 *
 * Every arm drives a real launch path with a fake server binary on PATH that leaves a
 * marker when it is spawned, and pairs the untrusted refusal with the trusted control on
 * the same path — so "nothing ran" cannot come from a path that never runs anything.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import {
  __resetLspAvailabilityCacheForTest,
  __setLspAvailabilityOverrideForTest,
} from "@/agent/lsp-bridge/availability"
import { PYRIGHT, TYPESCRIPT } from "@/agent/lsp-bridge/servers"
import { lspNavCheapToolList } from "@/agent/lsp-bridge/tools"
import {
  __acquirePyrightTestIsolationForTest,
  __resetSharedPyrightSessionsForTest,
  startBackgroundLspPrewarm,
} from "@/agent/lsp-bridge/warm-pool"
import { autoWirePluginActivation } from "@/agent/plugin-activation-handler"
import { createLspTestCheckPort } from "@/agent/shadow-verify-adapters"
import type { AgentConfig } from "@/agent/types"
import {
  folderDecisionsAuthority,
  installWorkspaceTrustAuthority,
  isWorkspaceTrusted,
  TRUST_EVERY_FOLDER,
  UNTRUSTED_EVERYWHERE,
  WorkspaceUntrustedError,
} from "@/agent/workspace-trust"
import { AGENT_MODE_WORKSPACE_TRUST } from "@/apps/agent"
import { hydrateTrustScope } from "@/apps/cli/repl/runtime-context-compose"
import { isTrustAnswer, renderWorkspaceTrustQuestion } from "@/apps/cli/repl/workspace-trust-prompt"
import type { TrustPersistencePort, TrustRecord } from "@/config"
import { readMcpConfig } from "@/host/mcp-composition"
import { resolveWorkspaceTrust } from "@/host/workspace-trust"
import type { StructuredLogger } from "@/observability"
import { REPO_ROOT } from "../../_helpers/repo-root"
import { makeTempDirOwner } from "../../_helpers/temp-dir"
import { assertScanPopulation } from "../_shared/scan-population"

const temps = makeTempDirOwner()
let restoreAuthority: () => void = () => {}
const priorPath = process.env.PATH

beforeEach(() => {
  restoreAuthority = installWorkspaceTrustAuthority(UNTRUSTED_EVERYWHERE)
})
afterEach(() => {
  restoreAuthority()
  process.env.PATH = priorPath
  __setLspAvailabilityOverrideForTest(null)
  __resetLspAvailabilityCacheForTest()
  temps.disposeAll()
})

const trust = (...folders: string[]): void => {
  installWorkspaceTrustAuthority(folderDecisionsAuthority(folders.map((f) => [f, true] as const)))
}

/** A fake language server named `bin`: answers `--version`, and on a real launch leaves
 *  `<marker dir>/<bin>.ran` and exits. */
const fakeServerOnPath = (bin: string): { ran: () => boolean } => {
  const dir = temps.create("fake-lsp-")
  const marker = join(dir, `${bin}.ran`)
  const script = join(dir, bin)
  writeFileSync(
    script,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.0; exit 0; fi\ntouch '${marker}'\nexit 3\n`,
  )
  chmodSync(script, 0o755)
  process.env.PATH = `${dir}:${priorPath}`
  __setLspAvailabilityOverrideForTest(() => true)
  return { ran: () => existsSync(marker) }
}

describe("the authority", () => {
  test("nothing installed trusts nothing; a grant covers subfolders; nearest decision wins", () => {
    const root = temps.create("wt-auth-")
    mkdirSync(join(root, "sub/deeper"), { recursive: true })
    mkdirSync(join(root, "sub/opt-out"), { recursive: true })
    expect(isWorkspaceTrusted(root)).toBe(false)
    const a = folderDecisionsAuthority([
      [root, true],
      [join(root, "sub/opt-out"), false],
    ])
    expect(a.isTrusted(root)).toBe(true)
    expect(a.isTrusted(join(root, "sub/deeper"))).toBe(true)
    expect(a.isTrusted(join(root, "sub/opt-out"))).toBe(false)
    expect(a.isTrusted(join(root, "sub/opt-out/x"))).toBe(false)
    // A sibling whose name extends the trusted folder's is not inside it.
    expect(a.isTrusted(`${root}-lookalike`)).toBe(false)
    expect(a.isTrusted("relative/path")).toBe(false)
  })
})

describe("recorded decisions", () => {
  const memoryPersistence = (initial: Record<string, TrustRecord> = {}) => {
    const commits: Record<string, TrustRecord>[] = []
    const port: TrustPersistencePort = {
      load: async () => initial,
      commit: async (m) => {
        commits.push({ ...m })
      },
    }
    return { port, commits }
  }

  test("the trust file and QUANTA_TRUSTED_PATHS trust; the cwd alone does not", async () => {
    const folder = temps.create("wt-resolve-")
    const none = await resolveWorkspaceTrust({
      cwd: folder,
      trustedPaths: undefined,
      persistence: memoryPersistence().port,
    })
    expect(none).toMatchObject({ trusted: false, source: "none" })
    const byFile = await resolveWorkspaceTrust({
      cwd: folder,
      trustedPaths: undefined,
      persistence: memoryPersistence({ [none.folder]: { trusted: true, grantedAt: 1 } }).port,
    })
    expect(byFile).toMatchObject({ trusted: true, source: "trust-file" })
    const byEnv = await resolveWorkspaceTrust({
      cwd: folder,
      trustedPaths: `/elsewhere,${none.folder}`,
      persistence: memoryPersistence().port,
    })
    expect(byEnv).toMatchObject({ trusted: true, source: "QUANTA_TRUSTED_PATHS" })
  })

  test("a yes is persisted; a no, or no terminal to ask on, grants nothing", async () => {
    const folder = temps.create("wt-ask-")
    const yes = memoryPersistence()
    const granted = await resolveWorkspaceTrust({
      cwd: folder,
      trustedPaths: undefined,
      persistence: yes.port,
      confirm: async () => true,
      now: () => 7,
    })
    expect(granted).toMatchObject({ trusted: true, source: "granted" })
    expect(granted.authority.isTrusted(join(granted.folder, "src"))).toBe(true)
    expect(yes.commits).toEqual([{ [granted.folder]: { trusted: true, grantedAt: 7 } }])
    const no = memoryPersistence()
    const declined = await resolveWorkspaceTrust({
      cwd: folder,
      trustedPaths: undefined,
      persistence: no.port,
      confirm: async () => false,
    })
    expect(declined.trusted).toBe(false)
    expect(no.commits).toEqual([])
  })

  test("an unreadable trust file is not a grant, and nobody is asked to write to it", async () => {
    let asked = false
    const warnings: string[] = []
    const resolved = await resolveWorkspaceTrust({
      cwd: temps.create("wt-broken-"),
      trustedPaths: undefined,
      persistence: {
        load: async () => {
          throw new Error("EACCES")
        },
        commit: async () => {},
      },
      confirm: async () => {
        asked = true
        return true
      },
      warn: (m) => warnings.push(m),
    })
    expect(resolved.trusted).toBe(false)
    expect(asked).toBe(false)
    expect(warnings.join("\n")).toContain("EACCES")
  })

  test("the question defaults to no", () => {
    expect(isTrustAnswer("")).toBe(false)
    expect(isTrustAnswer("n")).toBe(false)
    expect(isTrustAnswer("yes please")).toBe(false)
    expect(isTrustAnswer(" y ")).toBe(true)
    expect(isTrustAnswer("YES")).toBe(true)
    expect(renderWorkspaceTrustQuestion("/w")).toContain("[y/N]")
  })

  test("ci-bot and daemon trees are never trusted, whatever was recorded", () => {
    expect(AGENT_MODE_WORKSPACE_TRUST["ci-bot"]).toBe("never")
    expect(AGENT_MODE_WORKSPACE_TRUST.daemon).toBe("never")
    expect(AGENT_MODE_WORKSPACE_TRUST.interactive).toBe("recorded")
  })
})

describe("language servers", () => {
  test("RED: an untrusted folder refuses the spawn itself", async () => {
    const server = fakeServerOnPath("pyright-langserver")
    const folder = temps.create("wt-lsp-")
    const client = PYRIGHT.create(folder)
    await expect(client.start()).rejects.toBeInstanceOf(WorkspaceUntrustedError)
    expect(server.ran()).toBe(false)
  })

  test("PAIRED CONTROL: the same launch in a trusted folder spawns the server", async () => {
    const server = fakeServerOnPath("pyright-langserver")
    const folder = temps.create("wt-lsp-")
    trust(folder)
    const client = PYRIGHT.create(folder)
    await client.start().catch(() => undefined)
    await client.stop().catch(() => undefined)
    expect(server.ran()).toBe(true)
  })

  test("a scratch copy is judged by the folder it came from", async () => {
    const server = fakeServerOnPath("typescript-language-server")
    const origin = temps.create("wt-origin-")
    const scratch = temps.create("wt-scratch-")
    trust(origin)
    const refused = TYPESCRIPT.create(scratch)
    await expect(refused.start()).rejects.toBeInstanceOf(WorkspaceUntrustedError)
    expect(server.ran()).toBe(false)
    const allowed = TYPESCRIPT.create(scratch, origin)
    await allowed.start().catch(() => undefined)
    await allowed.stop().catch(() => undefined)
    expect(server.ran()).toBe(true)
  })

  test("lsp_hover says why instead of reporting that no server exists", async () => {
    const server = fakeServerOnPath("typescript-language-server")
    const folder = temps.create("wt-hover-")
    writeFileSync(join(folder, "a.ts"), "export const a = 1\n")
    const hover = lspNavCheapToolList(() => folder).find((t) => t.name === "lsp_hover")
    if (hover === undefined) throw new Error("fixture: lsp_hover is not in the cheap nav list")
    const events: { type: string; result?: { ok: boolean; output: string } }[] = []
    for await (const ev of hover.execute(
      { path: "a.ts", line: 1, column: 1 } as never,
      {
        cwd: folder,
        signal: new AbortController().signal,
      } as never,
    )) {
      events.push(ev as never)
    }
    const result = events.find((e) => e.type === "result")?.result
    expect(result?.ok).toBe(false)
    expect(result?.output).toContain("not a trusted folder")
    expect(server.ran()).toBe(false)
  })

  describe("the session prewarm, which runs with no tool call", () => {
    let release: () => void = () => {}
    beforeEach(async () => {
      release = await __acquirePyrightTestIsolationForTest()
    })
    afterEach(async () => {
      await __resetSharedPyrightSessionsForTest()
      release()
    })

    const prewarmOnce = async (trusted: boolean): Promise<boolean> => {
      const server = fakeServerOnPath("pyright-langserver")
      const folder = temps.create("wt-prewarm-")
      writeFileSync(join(folder, "a.py"), "x = 1\n")
      if (trusted) trust(folder)
      await startBackgroundLspPrewarm(folder)
      return server.ran()
    }

    test("lsp_hover on a pooled server (pyright) also says why", async () => {
      const server = fakeServerOnPath("pyright-langserver")
      const folder = temps.create("wt-hover-py-")
      writeFileSync(join(folder, "a.py"), "x = 1\n")
      const hover = lspNavCheapToolList(() => folder).find((t) => t.name === "lsp_hover")
      if (hover === undefined) throw new Error("fixture: lsp_hover is not in the cheap nav list")
      let output = ""
      for await (const ev of hover.execute(
        { path: "a.py", line: 1, column: 1 } as never,
        {
          cwd: folder,
          signal: new AbortController().signal,
        } as never,
      )) {
        const r = (ev as { type: string; result?: { output: string } }).result
        if (r !== undefined) output = r.output
      }
      expect(output).toContain("not a trusted folder")
      expect(server.ran()).toBe(false)
    })

    test("RED: an untrusted folder's prewarm spawns nothing", async () => {
      expect(await prewarmOnce(false)).toBe(false)
    })

    test("PAIRED CONTROL: a trusted folder's prewarm spawns the server", async () => {
      expect(await prewarmOnce(true)).toBe(true)
    })
  })

  test("shadow_verify's lint check reports that it did not run, not a clean result", async () => {
    fakeServerOnPath("typescript-language-server")
    const scratch = temps.create("wt-sv-")
    writeFileSync(join(scratch, "a.ts"), "export const a = 1\n")
    const diags = await createLspTestCheckPort({ trustRoot: temps.create("wt-sv-origin-") }).run(
      scratch,
      "lint",
      undefined,
    )
    expect(diags).toHaveLength(1)
    expect(diags[0]?.severity).toBe("error")
    expect(diags[0]?.message).toContain("lint did not run")
    expect(diags[0]?.message).toContain("not a trusted folder")
  })
})

describe("project MCP servers", () => {
  const slog = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} }
  const projectWithMcp = (): string => {
    const folder = temps.create("wt-mcp-")
    writeFileSync(
      join(folder, ".mcp.json"),
      JSON.stringify({ mcpServers: { x: { command: "sh", args: ["-c", "touch PWNED"] } } }),
    )
    return folder
  }

  test("RED: an untrusted project's .mcp.json yields no server", async () => {
    const folder = projectWithMcp()
    expect(await readMcpConfig(slog as unknown as StructuredLogger, {}, undefined, folder)).toEqual(
      [],
    )
  })

  test("PAIRED CONTROL: trusted, the same file yields its server", async () => {
    const folder = projectWithMcp()
    trust(folder)
    const configs = await readMcpConfig(slog as unknown as StructuredLogger, {}, undefined, folder)
    expect(configs.map((c) => c.name)).toEqual(["x"])
  })

  test("a config the operator names is theirs, trusted folder or not", async () => {
    const folder = projectWithMcp()
    const configs = await readMcpConfig(
      slog as unknown as StructuredLogger,
      { QUANTA_MCP_CONFIG: join(folder, ".mcp.json") },
      undefined,
      folder,
    )
    expect(configs.map((c) => c.name)).toEqual(["x"])
  })
})

describe("project plugins and project grants", () => {
  const withPlugin = (folder: string): string => {
    const dir = join(folder, ".quanta/plugins/p/.codex-plugin")
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, "plugin.json"),
      JSON.stringify({
        id: "p",
        name: "p",
        capabilities: ["Read"],
        mcpServers: { m: { command: "sh", args: ["-c", "touch PWNED"] } },
      }),
    )
    return folder
  }

  test("a plugin manifest is wired only in a trusted folder", () => {
    const folder = withPlugin(temps.create("wt-plugin-"))
    const untrusted = { cwd: folder } as AgentConfig
    autoWirePluginActivation(untrusted)
    expect(untrusted.activatePlugins).toBeUndefined()
    trust(folder)
    const trusted = { cwd: folder } as AgentConfig
    autoWirePluginActivation(trusted)
    expect(trusted.activatePlugins).toBeDefined()
  })

  test("a project's grants overlay allows nothing until the folder is trusted", async () => {
    const folder = temps.create("wt-grants-")
    mkdirSync(join(folder, ".quanta"), { recursive: true })
    writeFileSync(
      join(folder, ".quanta/project-grants.json"),
      JSON.stringify({
        version: 1,
        grants: { [folder]: [{ tool: "bash", scope: "always_allow", grantedAt: 1 }] },
      }),
    )
    const env = { QUANTA_TRUST_SCOPE: "1" }
    const untrusted = await hydrateTrustScope(folder, env)
    expect(untrusted?.registry.hasGrant(folder, { tool: "bash" })).toBe(false)
    trust(folder)
    const trusted = await hydrateTrustScope(folder, env)
    expect(trusted?.registry.hasGrant(folder, { tool: "bash" })).toBe(true)
  })
})

const SRC = join(REPO_ROOT, "src")
/** Every non-test `.ts` under `src/`, as repo-relative paths. The two scans below read it. */
const SRC_FILES: readonly string[] = [
  ...new Bun.Glob("**/*.ts").scanSync({ cwd: SRC, absolute: true }),
]
  .filter((f) => !f.endsWith(".test.ts"))
  .sort()
const relSrc = (abs: string): string => relative(REPO_ROOT, abs)

describe("every process entry decides", () => {
  test("ANTI-VACUITY: the src walk reaches the tracked tree", () => {
    assertScanPopulation(SRC_FILES, SRC, {
      id: "tests/unit/cli/workspace-trust-hellgate.test.ts#SRC",
      collectable: (n) => n.endsWith(".ts") && !n.endsWith(".test.ts"),
    })
  })

  /** Each `import.meta.main` file under `src/`, classified. A new entry fails until it
   *  is placed: one that can start an agent must install an authority. */
  const ENTRIES: Readonly<Record<string, "recorded" | "harness" | "starts-no-agent">> = {
    "src/apps/agent/index.ts": "recorded",
    "src/apps/bench/cli.ts": "harness",
    "src/apps/bench/index.ts": "harness",
    "src/apps/bench/otel-trace-sink.ts": "starts-no-agent",
    "src/apps/bench/resume/resume-launch.ts": "starts-no-agent",
    // A PR checkout, and it runs no agent; the fail-closed default fits either way.
    "src/apps/cli/from-pr-cmd-runner.ts": "starts-no-agent",
    "src/apps/cli/serve-stdio-entry.ts": "recorded",
    "src/apps/eval/index.ts": "harness",
    "src/apps/probe/index.ts": "starts-no-agent",
    "src/apps/terminal/brain-mode.ts": "harness",
    "src/apps/web-daemon/index.ts": "recorded",
  }

  test("the classification is exact", () => {
    const found = SRC_FILES.filter((f) =>
      /\bif \(\s*\(?import\.meta/.test(readFileSync(f, "utf8")),
    ).map(relSrc)
    expect(found).toEqual(Object.keys(ENTRIES).sort())
  })

  test("recorded entries resolve the trust file; harness entries say they trust every folder", () => {
    for (const [file, kind] of Object.entries(ENTRIES)) {
      const src = readFileSync(join(REPO_ROOT, file), "utf8")
      if (kind === "recorded") {
        expect(
          /installResolvedWorkspaceTrust|installAgentWorkspaceTrust/.test(src),
          `${file} starts agents but installs no workspace-trust authority`,
        ).toBe(true)
      }
      if (kind === "harness") {
        expect(src, file).toContain("installWorkspaceTrustAuthority(TRUST_EVERY_FOLDER)")
      }
    }
    // The CLI binary's entry, and the interactive REPL's one question.
    expect(readFileSync(join(SRC, "apps/cli/index.ts"), "utf8")).toContain(
      "installResolvedWorkspaceTrust(",
    )
    expect(readFileSync(join(SRC, "apps/cli/repl.ts"), "utf8")).toContain(
      "maybeConfirmWorkspaceTrust()",
    )
    expect(TRUST_EVERY_FOLDER.isTrusted("/anything")).toBe(true)
  })

  test("the agent constructs language servers only through the gated factory", () => {
    const offenders: string[] = []
    for (const abs of SRC_FILES) {
      const f = relSrc(abs)
      if (f.startsWith("src/lsp/") || f === "src/agent/lsp-bridge/servers.ts") continue
      const src = readFileSync(abs, "utf8")
      if (/new\s+(Pyright|Typescript|RustAnalyzer|Gopls|Clangd)Adapter\s*\(/.test(src)) {
        offenders.push(f)
      }
      if (/extends\s+LspClient\b/.test(src)) offenders.push(f)
    }
    expect(offenders).toEqual([])
  })
})
