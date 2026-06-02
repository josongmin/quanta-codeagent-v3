/**
 * ADR-0430 — competitor-import FULL ROUND-TRIP + adversarial hellgate.
 *
 * Goes BEYOND the persistence e2e hellgate (which proves count>0 +
 * resumability): this suite closes the loop with DETERMINISTIC, exact
 * assertions — no heuristics, no arbitrary thresholds.
 *
 *   RT-1  FULL round-trip: build a complete Claude Code source
 *         (projects/*.jsonl + .mcp.json + settings.json#hooks + CLAUDE.md),
 *         run the CLI import handler, then LOAD the persisted session back
 *         from the quanta session store and assert MESSAGE FIDELITY — exact
 *         role + content-block equality, not just "a message exists".
 *   RT-2  re-import is idempotent via content-hash dedup: a second run
 *         persists EXACTLY 0 new sessions, and the on-disk session-file set
 *         is byte-for-byte the SAME set (no double-write, no churn).
 *   RT-3  N10 syscall-level proof: spy on `node:fs/promises.readFile` — the
 *         ONLY byte-read path the migration slice uses — and assert ZERO
 *         reads are ever attempted against the source `auth.json` path. The
 *         guard throws before the syscall, so the path never reaches readFile.
 *   RT-4  a malformed `.jsonl` line is skipped WITHOUT aborting the batch:
 *         with one transcript carrying a malformed line and a second clean
 *         transcript, BOTH still persist (exact count = 2), and the malformed
 *         transcript keeps exactly its valid messages.
 *   RT-5  partial source (missing `.mcp.json`) imports what EXISTS: sessions +
 *         hooks + rules persist/translate with exact counts; MCP count is 0.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import * as fsp from "node:fs/promises"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { ContentBlock } from "@/llm"
import type { SessionCommandDeps } from "@/runner/session-ops"
import { loadSessionById, staticSessionRootProvider } from "@/session"
import { createCliImportHandlerWithRoot } from "../../src/apps/cli/session-import-handler"

let home: string
let sessionsRoot: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "adr0430-rt-home-"))
  sessionsRoot = await mkdtemp(join(tmpdir(), "adr0430-rt-sessions-"))
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
  await rm(sessionsRoot, { recursive: true, force: true })
})

const claudeRoot = (): string => join(home, ".claude")
const projectsDir = (): string => join(claudeRoot(), "projects", "proj-a")
const authPath = (): string => join(claudeRoot(), "auth.json")

/** A Claude Code user-message transcript line. */
const userLine = (text: string): string =>
  JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } })

/** A Claude Code assistant-message transcript line. */
const asstLine = (text: string): string =>
  JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
  })

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

const sessionFiles = async (): Promise<string[]> =>
  (await readdir(sessionsRoot)).filter((f) => f.endsWith(".json")).sort()

describe("ADR-0430 competitor-import round-trip + adversarial hellgate", () => {
  test("RT-1: FULL round-trip — persisted session reloads with EXACT message fidelity", async () => {
    await mkdir(projectsDir(), { recursive: true })
    // Credential file present (detector existence marker) — never read.
    await writeFile(authPath(), '{"token":"SECRET-NEVER-READ"}', "utf8")
    // A deterministic two-message transcript.
    const lines = [userLine("explain the bug"), asstLine("it is an off-by-one")]
    await writeFile(join(projectsDir(), "sess-0.jsonl"), `${lines.join("\n")}\n`, "utf8")
    // Full set of non-session artifacts.
    await writeFile(
      join(claudeRoot(), ".mcp.json"),
      JSON.stringify({ mcpServers: { fs: { command: "npx", args: ["-y", "srv"] } } }),
      "utf8",
    )
    await writeFile(
      join(claudeRoot(), "settings.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo pre" }] }],
        },
      }),
      "utf8",
    )
    await writeFile(join(claudeRoot(), "CLAUDE.md"), "# Rules\nBe terse.\n", "utf8")

    const { code, cap } = await runImportCli(["claude_code"])
    expect(code).toBe(0)

    // Exactly one session persisted; summary reflects every artifact kind.
    const files = await sessionFiles()
    expect(files.length).toBe(1)
    const out = cap.out.join("")
    expect(out).toContain("1 session(s) persisted")
    expect(out).toContain("1 MCP server(s)")
    expect(out).toContain("1 hook(s)")
    expect(out).toContain("1 rule doc(s)")

    // Close the loop: load the persisted session back and assert EXACT
    // message fidelity (the whole point — resumable, not just translated).
    const id = files[0]?.replace(/\.json$/, "") as string
    const loaded = await loadSessionById(id, staticSessionRootProvider(sessionsRoot))
    expect(loaded).toBeDefined()
    const expectedMessages: Array<{ role: string; content: ContentBlock[] }> = [
      { role: "user", content: [{ type: "text", text: "explain the bug" }] },
      { role: "assistant", content: [{ type: "text", text: "it is an off-by-one" }] },
    ]
    expect(loaded?.messages).toEqual(expectedMessages)
  })

  test("RT-2: re-import is idempotent — second run persists EXACTLY 0, same file set", async () => {
    await mkdir(projectsDir(), { recursive: true })
    await writeFile(authPath(), '{"token":"x"}', "utf8")
    await writeFile(
      join(projectsDir(), "a.jsonl"),
      `${[userLine("alpha"), asstLine("ack alpha")].join("\n")}\n`,
      "utf8",
    )
    await writeFile(
      join(projectsDir(), "b.jsonl"),
      `${[userLine("beta"), asstLine("ack beta")].join("\n")}\n`,
      "utf8",
    )

    const first = await runImportCli(["claude_code"])
    expect(first.code).toBe(0)
    expect(first.cap.out.join("")).toContain("2 session(s) persisted")
    const filesAfterFirst = await sessionFiles()
    expect(filesAfterFirst.length).toBe(2)

    const second = await runImportCli(["claude_code"])
    expect(second.code).toBe(0)
    // EXACTLY 0 new + both recognized as duplicates.
    expect(second.cap.out.join("")).toContain("0 session(s) persisted")
    expect(second.cap.out.join("")).toContain("2 duplicate(s) skipped")
    // The on-disk session-file SET is identical (no double-write, no churn).
    const filesAfterSecond = await sessionFiles()
    expect(filesAfterSecond).toEqual(filesAfterFirst)
  })

  test("RT-3: N10 syscall proof — auth.json is NEVER passed to readFile", async () => {
    await mkdir(projectsDir(), { recursive: true })
    await writeFile(authPath(), '{"token":"SECRET-NEVER-READ"}', "utf8")
    await writeFile(
      join(projectsDir(), "s.jsonl"),
      `${[userLine("hi"), asstLine("yo")].join("\n")}\n`,
      "utf8",
    )
    // Also seed every other artifact so the importer exercises every read path.
    await writeFile(
      join(claudeRoot(), ".mcp.json"),
      JSON.stringify({ mcpServers: { fs: { command: "x" } } }),
      "utf8",
    )
    await writeFile(
      join(claudeRoot(), "settings.json"),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "c" }] }] } }),
      "utf8",
    )
    await writeFile(join(claudeRoot(), "CLAUDE.md"), "# r\nbody\n", "utf8")

    // The migration slice's ONLY byte-read primitive routes through
    // node:fs/promises.readFile (dedup.readImportFile / contentSha256). Spy on
    // it and call through to the real implementation, recording every path.
    const spy = spyOn(fsp, "readFile")
    try {
      const { code } = await runImportCli(["claude_code"])
      expect(code).toBe(0)

      const bannedAbs = resolve(authPath())
      const readPaths = spy.mock.calls.map((c) => {
        const arg = c[0]
        const p = typeof arg === "string" ? arg : String(arg)
        return resolve(p)
      })
      // The importer DID read transcript bytes (proves the spy is live).
      expect(readPaths.some((p) => p.endsWith("s.jsonl"))).toBe(true)
      // ZERO reads ever targeted the credential file (N10, deterministic).
      expect(readPaths.filter((p) => p === bannedAbs).length).toBe(0)
    } finally {
      spy.mockRestore()
    }
  })

  test("RT-4: malformed jsonl line skipped WITHOUT aborting the batch", async () => {
    await mkdir(projectsDir(), { recursive: true })
    await writeFile(authPath(), '{"token":"x"}', "utf8")
    // Transcript 0 carries a malformed middle line between two valid ones.
    await writeFile(
      join(projectsDir(), "0-dirty.jsonl"),
      `${[userLine("q0"), "{ not valid json", asstLine("a0")].join("\n")}\n`,
      "utf8",
    )
    // Transcript 1 is fully clean — it MUST still import (batch not aborted).
    await writeFile(
      join(projectsDir(), "1-clean.jsonl"),
      `${[userLine("q1"), asstLine("a1")].join("\n")}\n`,
      "utf8",
    )

    const { code, cap } = await runImportCli(["claude_code"])
    expect(code).toBe(0)
    // BOTH transcripts persisted (the malformed line did not abort the batch).
    expect(cap.out.join("")).toContain("2 session(s) persisted")
    const files = await sessionFiles()
    expect(files.length).toBe(2)

    // The dirty transcript kept EXACTLY its two valid messages; the malformed
    // line was dropped (not partially parsed, not poisoning the load).
    const provider = staticSessionRootProvider(sessionsRoot)
    const loaded = await Promise.all(
      files.map(async (f) => loadSessionById(f.replace(/\.json$/, ""), provider)),
    )
    const lengths = loaded.map((s) => s?.messages.length).sort()
    expect(lengths).toEqual([2, 2])
    // And every persisted message is a recognized role (no garbage line leaked).
    for (const s of loaded) {
      for (const m of s?.messages ?? []) {
        expect(["user", "assistant"]).toContain(m.role)
      }
    }
  })

  test("RT-5: partial source (no .mcp.json) imports what EXISTS, MCP count = 0", async () => {
    await mkdir(projectsDir(), { recursive: true })
    await writeFile(authPath(), '{"token":"x"}', "utf8")
    await writeFile(
      join(projectsDir(), "p.jsonl"),
      `${[userLine("hi"), asstLine("ok")].join("\n")}\n`,
      "utf8",
    )
    // Hooks + rules present, but DELIBERATELY no .mcp.json.
    await writeFile(
      join(claudeRoot(), "settings.json"),
      JSON.stringify({
        hooks: {
          PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "fmt" }] }],
        },
      }),
      "utf8",
    )
    await writeFile(join(claudeRoot(), "CLAUDE.md"), "# rules\nbody\n", "utf8")

    const { code, cap } = await runImportCli(["claude_code"])
    expect(code).toBe(0)
    const out = cap.out.join("")
    // What exists imported with exact counts; the absent MCP file ⇒ exactly 0.
    expect(out).toContain("1 session(s) persisted")
    expect(out).toContain("0 MCP server(s)")
    expect(out).toContain("1 hook(s)")
    expect(out).toContain("1 rule doc(s)")
    const files = await sessionFiles()
    expect(files.length).toBe(1)
  })
})
