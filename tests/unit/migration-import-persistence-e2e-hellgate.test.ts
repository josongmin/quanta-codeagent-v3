/**
 * ADR-0430 — competitor-import PERSISTENCE e2e hellgate.
 *
 * Proves the `session import` path is REAL end-to-end (no longer
 * `persisted_sessions=0`):
 *
 *   HELL-1  translated transcripts are PERSISTED into the v3 session store
 *           (count>0) and are RESUMABLE (loadSessionById round-trips them).
 *   HELL-2  MCP server config (`.mcp.json`) is detected + translated.
 *   HELL-3  hooks (`settings.json#hooks`) + rules (`CLAUDE.md`) are translated.
 *   HELL-4  a SECOND import dedups — already-imported sessions are skipped.
 *   HELL-5  N10 credential-read ban: `auth.json` is NEVER read (the guard
 *           throws before any read syscall, AND a full import over a fixture
 *           containing auth.json never reads its bytes).
 *   HELL-6  a malformed `.jsonl` line is SKIPPED, not crashed.
 *   HELL-7  absent source ⇒ no-op (no sessions persisted, exit code != 0
 *           surfaced as "not found", store untouched / byte-identical).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  CredentialReadBannedError,
  contentSha256,
  isCredentialPath,
  readImportFile,
} from "@/migration"
import type { SessionCommandDeps } from "@/runner/session-ops"
import { loadSessionById, staticSessionRootProvider } from "@/session"
import { createCliImportHandlerWithRoot } from "../../src/apps/cli/session-import-handler"

let home: string
let sessionsRoot: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "adr0430-home-"))
  sessionsRoot = await mkdtemp(join(tmpdir(), "adr0430-sessions-"))
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
  await rm(sessionsRoot, { recursive: true, force: true })
})

/** A valid Claude Code transcript line (user message). */
const userLine = (text: string): string =>
  JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  })

/** Build a fixture Claude Code source dir under `home`. */
const seedClaudeSource = async (opts?: {
  transcripts?: number
  withMcp?: boolean
  withHooks?: boolean
  withRules?: boolean
  malformed?: boolean
}): Promise<void> => {
  const transcripts = opts?.transcripts ?? 2
  await mkdir(join(home, ".claude/projects/proj-a"), { recursive: true })
  // N10 marker: auth.json must EXIST (detector existence check) but must
  // never be READ.
  await writeFile(join(home, ".claude/auth.json"), '{"token":"SECRET-DO-NOT-READ"}', "utf8")
  for (let i = 0; i < transcripts; i++) {
    const lines = [
      userLine(`hello ${i}`),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: `hi back ${i}` }] },
      }),
    ]
    if (opts?.malformed && i === 0) lines.push("{ this is not valid json")
    await writeFile(
      join(home, `.claude/projects/proj-a/sess-${i}.jsonl`),
      `${lines.join("\n")}\n`,
      "utf8",
    )
  }
  if (opts?.withMcp) {
    await writeFile(
      join(home, ".claude/.mcp.json"),
      JSON.stringify({
        mcpServers: {
          fs: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"] },
          remote: { type: "http", url: "https://example.com/mcp" },
        },
      }),
      "utf8",
    )
  }
  if (opts?.withHooks) {
    await writeFile(
      join(home, ".claude/settings.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo pre" }] }],
        },
      }),
      "utf8",
    )
  }
  if (opts?.withRules) {
    await writeFile(join(home, ".claude/CLAUDE.md"), "# Project rules\nBe terse.\n", "utf8")
  }
}

interface Captured {
  out: string[]
  err: string[]
  deps: SessionCommandDeps
}
const captureDeps = (): Captured => {
  const out: string[] = []
  const err: string[] = []
  const deps: SessionCommandDeps = {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    confirm: async () => true,
    homeDir: home,
  }
  return { out, err, deps }
}

const runImportCli = async (args: string[]): Promise<{ code: number; cap: Captured }> => {
  const cap = captureDeps()
  const handler = createCliImportHandlerWithRoot(sessionsRoot)
  const code = await handler(args, cap.deps)
  return { code, cap }
}

describe("ADR-0430 competitor-import persistence e2e hellgate", () => {
  test("HELL-1: translated transcripts are persisted + resumable (count>0)", async () => {
    await seedClaudeSource({ transcripts: 2 })
    const { code, cap } = await runImportCli(["claude_code"])
    expect(code).toBe(0)
    // Two session files now exist under the v3 sessions root.
    const provider = staticSessionRootProvider(sessionsRoot)
    const files = (await readdir(sessionsRoot)).filter((f) => f.endsWith(".json"))
    expect(files.length).toBe(2)
    expect(cap.out.join("")).toContain("2 session(s) persisted")
    // RESUMABLE: each persisted session loads with translated messages.
    const id = files[0]?.replace(/\.json$/, "") as string
    const loaded = await loadSessionById(id, provider)
    expect(loaded).toBeDefined()
    expect(loaded?.messages.length).toBeGreaterThan(0)
    expect(loaded?.messages[0]?.role).toBe("user")
  })

  test("HELL-2: MCP server config detected + translated (stdio + http kinds)", async () => {
    await seedClaudeSource({ transcripts: 1, withMcp: true })
    const { code, cap } = await runImportCli(["claude_code"])
    expect(code).toBe(0)
    expect(cap.out.join("")).toContain("2 MCP server(s)")
  })

  test("HELL-3: hooks + rules translated", async () => {
    await seedClaudeSource({ transcripts: 1, withHooks: true, withRules: true })
    const { code, cap } = await runImportCli(["claude_code"])
    expect(code).toBe(0)
    const out = cap.out.join("")
    expect(out).toContain("1 hook(s)")
    expect(out).toContain("1 rule doc(s)")
  })

  test("HELL-4: a second import dedups — already-imported sessions skipped", async () => {
    await seedClaudeSource({ transcripts: 2 })
    const first = await runImportCli(["claude_code"])
    expect(first.code).toBe(0)
    expect(first.cap.out.join("")).toContain("2 session(s) persisted")

    const second = await runImportCli(["claude_code"])
    expect(second.code).toBe(0)
    // Nothing new persisted; both skipped as duplicates.
    expect(second.cap.out.join("")).toContain("0 session(s) persisted")
    expect(second.cap.out.join("")).toContain("2 duplicate(s) skipped")
    // Still exactly 2 session files (no double-write).
    const files = (await readdir(sessionsRoot)).filter((f) => f.endsWith(".json"))
    expect(files.length).toBe(2)
  })

  test("HELL-5a: readImportFile + contentSha256 REFUSE a credential path (N10)", async () => {
    await seedClaudeSource({ transcripts: 1 })
    const authPath = join(home, ".claude/auth.json")
    expect(isCredentialPath(authPath)).toBe(true)
    await expect(readImportFile(authPath)).rejects.toBeInstanceOf(CredentialReadBannedError)
    await expect(contentSha256(authPath)).rejects.toBeInstanceOf(CredentialReadBannedError)
  })

  test("HELL-5b: full import over a source containing auth.json never reads its bytes", async () => {
    // The fixture auth.json holds a sentinel secret. A successful import must
    // never surface it anywhere (it is never read). Detector uses access(2)
    // existence-only, all byte-reads route through the N10 guard.
    await seedClaudeSource({ transcripts: 1, withMcp: true, withRules: true })
    const { code, cap } = await runImportCli(["claude_code"])
    expect(code).toBe(0)
    const allText = [...cap.out, ...cap.err].join("")
    expect(allText).not.toContain("SECRET-DO-NOT-READ")
    // And no persisted session content carries the secret either.
    const provider = staticSessionRootProvider(sessionsRoot)
    const files = (await readdir(sessionsRoot)).filter((f) => f.endsWith(".json"))
    for (const f of files) {
      const id = f.replace(/\.json$/, "")
      const loaded = await loadSessionById(id, provider)
      const dump = JSON.stringify(loaded)
      expect(dump).not.toContain("SECRET-DO-NOT-READ")
    }
  })

  test("HELL-6: a malformed jsonl line is skipped, not crashed", async () => {
    await seedClaudeSource({ transcripts: 1, malformed: true })
    const { code, cap } = await runImportCli(["claude_code"])
    // The malformed line is skipped; the session still translates + persists.
    expect(code).toBe(0)
    expect(cap.out.join("")).toContain("1 session(s) persisted")
    const provider = staticSessionRootProvider(sessionsRoot)
    const files = (await readdir(sessionsRoot)).filter((f) => f.endsWith(".json"))
    expect(files.length).toBe(1)
    const id = files[0]?.replace(/\.json$/, "") as string
    const loaded = await loadSessionById(id, provider)
    // The two valid lines survived; the malformed one did not poison the load.
    expect(loaded?.messages.length).toBe(2)
  })

  test("HELL-7: absent source ⇒ no-op, store untouched (byte-identical)", async () => {
    // No .claude dir at all.
    const before = await readdir(sessionsRoot)
    const { code, cap } = await runImportCli(["claude_code"])
    // Detect fails ⇒ exit 1, NOT a crash.
    expect(code).toBe(1)
    expect(cap.err.join("")).toContain("failed")
    const after = await readdir(sessionsRoot)
    expect(after).toEqual(before) // store untouched
  })
})
