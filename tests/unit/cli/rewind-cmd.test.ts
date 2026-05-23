import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Message } from "@/llm"
import { __test, isRewindEnabled, type RewindSlashState } from "../../../src/apps/cli/rewind-cmd"
import type { SlashContext } from "../../../src/apps/cli/slash-commands"
import {
  loadSessionById,
  type SavePayload,
  type SessionMeta,
  saveSessionById,
} from "../../../src/session"
import { __resetRuntimeConfig } from "../../../src/shared"

/**
 * `/rewind` + `/fork` slash command tests.
 *
 * The actual rewind/fork logic is covered in `tests/unit/session/rewind*.ts`;
 * here we lock in:
 *   - argv parsing (list / id / --to-last / --yes / --restore-files / --title)
 *   - confirmation gate (without --yes, no mutation occurs)
 *   - default-OFF for `--restore-files` (env knob + port presence)
 *   - "no active session" error when SlashContext.rewindSession absent
 *   - `QUANTA_REWIND=0` disables registration (and command refuses if bypassed)
 */

const mkMeta = (overrides: Partial<SessionMeta> = {}): SessionMeta => ({
  id: overrides.id ?? "cli-rewind-default",
  title: overrides.title ?? "T",
  cwd: overrides.cwd ?? "/tmp/work",
  createdAt: overrides.createdAt ?? 1_000,
  lastTouched: overrides.lastTouched ?? 1_000,
  archived: overrides.archived ?? false,
  ...(overrides.gitSha !== undefined ? { gitSha: overrides.gitSha } : {}),
})

const mkMessage = (text: string, role: "user" | "assistant", id: string): Message => ({
  role,
  content: [{ type: "text", text }],
  id,
})

const seed = async (id: string, opts?: Partial<SessionMeta>): Promise<void> => {
  const messages: Message[] = [
    mkMessage("hello", "user", "m0"),
    mkMessage("hi back", "assistant", "m1"),
    mkMessage("how about X", "user", "m2"),
    mkMessage("here is X", "assistant", "m3"),
    mkMessage("any followup?", "user", "m4"),
  ]
  const payload: SavePayload = { reason: "ok", turns: 3, messages }
  await saveSessionById(mkMeta({ id, ...opts }), payload)
}

interface Captured {
  out: string
  err: string
  ctx: SlashContext
}

const buildCtx = (state?: RewindSlashState): Captured => {
  const cap = { out: "", err: "" }
  const ctx: SlashContext = {
    out: (s) => {
      cap.out += s
    },
    err: (s) => {
      cap.err += s
    },
    cwd: "/tmp/work",
    ...(state !== undefined ? { rewindSession: state } : {}),
  }
  return {
    ...cap,
    ctx,
    get out() {
      return cap.out
    },
    get err() {
      return cap.err
    },
  } as Captured
}

// We need to import lazily AFTER setting env (so isRewindEnabled snapshots
// the right value at module load). The default path uses the live registry,
// which has already been frozen — so we exercise the commands via their
// exported handle from `rewindCommands`.
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rewind-cli-"))
  process.env.QUANTA_SESSIONS_DIR = dir
  __resetRuntimeConfig()
})
afterEach(() => {
  delete process.env.QUANTA_SESSIONS_DIR
  __resetRuntimeConfig()
  rmSync(dir, { recursive: true, force: true })
})

const importCmds = async () => {
  return await import("../../../src/apps/cli/rewind-cmd")
}

describe("isRewindEnabled (env-gate)", () => {
  test("default on", () => {
    expect(isRewindEnabled({})).toBe(true)
  })
  test("QUANTA_REWIND=0 disables", () => {
    expect(isRewindEnabled({ QUANTA_REWIND: "0" })).toBe(false)
  })
  test("QUANTA_REWIND=false / off / no all disable", () => {
    expect(isRewindEnabled({ QUANTA_REWIND: "false" })).toBe(false)
    expect(isRewindEnabled({ QUANTA_REWIND: "off" })).toBe(false)
    expect(isRewindEnabled({ QUANTA_REWIND: "no" })).toBe(false)
  })
  test("any other value enables", () => {
    expect(isRewindEnabled({ QUANTA_REWIND: "yes" })).toBe(true)
    expect(isRewindEnabled({ QUANTA_REWIND: "1" })).toBe(true)
  })
})

describe("parseRewindArgs / parseForkArgs", () => {
  test("/rewind no args ⇒ list mode (no idPrefix, no flags)", () => {
    const p = __test.parseRewindArgs([])
    expect(typeof p).not.toBe("string")
    if (typeof p === "string") throw new Error("unreachable")
    expect(p.idPrefix).toBeUndefined()
    expect(p.toLast).toBe(false)
    expect(p.yes).toBe(false)
    expect(p.restoreFiles).toBe(false)
  })
  test("/rewind <id> --yes parses", () => {
    const p = __test.parseRewindArgs(["m2", "--yes"])
    if (typeof p === "string") throw new Error("unexpected string: " + p)
    expect(p.idPrefix).toBe("m2")
    expect(p.yes).toBe(true)
  })
  test("/rewind --to-last accepted", () => {
    const p = __test.parseRewindArgs(["--to-last"])
    if (typeof p === "string") throw new Error("unexpected string: " + p)
    expect(p.toLast).toBe(true)
  })
  test("/rewind unknown flag rejected", () => {
    expect(__test.parseRewindArgs(["--bogus"])).toBe("unknown flag: --bogus")
  })
  test("/rewind two positionals rejected", () => {
    expect(__test.parseRewindArgs(["m1", "m2"])).toBe("unexpected extra argument: m2")
  })
  test("/fork no args ⇒ list mode", () => {
    const p = __test.parseForkArgs([])
    if (typeof p === "string") throw new Error("unexpected string")
    expect(p.idPrefix).toBeUndefined()
    expect(p.title).toBeUndefined()
  })
  test("/fork <id> --title T parses", () => {
    const p = __test.parseForkArgs(["m2", "--title", "experiment"])
    if (typeof p === "string") throw new Error("unexpected string")
    expect(p.idPrefix).toBe("m2")
    expect(p.title).toBe("experiment")
  })
  test("/fork --title without value rejected", () => {
    expect(__test.parseForkArgs(["m2", "--title"])).toBe("--title requires a value")
  })
})

describe("/rewind dispatch", () => {
  test("no active session ⇒ exit 1 with clear error", async () => {
    const { rewindCommands } = await importCmds()
    const cmd = rewindCommands[0]
    if (cmd === undefined) throw new Error("expected /rewind")
    const cap = buildCtx() // no rewindSession state
    const code = await cmd.run([], cap.ctx)
    expect(code).toBe(1)
    expect(cap.err).toContain("no active session")
  })

  test("no args ⇒ list mode prints recent ids + usage", async () => {
    await seed("s-list")
    const { rewindCommands } = await importCmds()
    const cmd = rewindCommands[0]
    if (cmd === undefined) throw new Error("expected /rewind")
    const state: RewindSlashState = { sessionId: "s-list", env: { QUANTA_REWIND: "1" } }
    const cap = buildCtx(state)
    const code = await cmd.run([], cap.ctx)
    expect(code).toBe(0)
    expect(cap.out).toContain("rewind targets")
    // Most-recent (m4 → user) printed first; renders short id (first 8 chars).
    expect(cap.out).toContain("m4")
    expect(cap.out).toContain("usage:")
  })

  test("<id-prefix> without --yes ⇒ confirm line, no mutation", async () => {
    await seed("s-confirm")
    const { rewindCommands } = await importCmds()
    const cmd = rewindCommands[0]
    if (cmd === undefined) throw new Error("expected /rewind")
    const state: RewindSlashState = { sessionId: "s-confirm", env: { QUANTA_REWIND: "1" } }
    const cap = buildCtx(state)
    const code = await cmd.run(["m1"], cap.ctx)
    expect(code).toBe(0)
    expect(cap.out).toContain("rewind to m1")
    expect(cap.out).toContain("drop")
    expect(cap.out).toContain("--yes")
    // No mutation: original 5 messages still present.
    const reloaded = await loadSessionById("s-confirm")
    expect(reloaded?.messages.length).toBe(5)
  })

  test("<id-prefix> --yes ⇒ mutation happens", async () => {
    await seed("s-do")
    const { rewindCommands } = await importCmds()
    const cmd = rewindCommands[0]
    if (cmd === undefined) throw new Error("expected /rewind")
    const state: RewindSlashState = { sessionId: "s-do", env: { QUANTA_REWIND: "1" } }
    const cap = buildCtx(state)
    const code = await cmd.run(["m2", "--yes"], cap.ctx)
    expect(code).toBe(0)
    expect(cap.out).toContain("rewound to m2")
    const reloaded = await loadSessionById("s-do")
    expect(reloaded?.messages.length).toBe(3)
  })

  test("--to-last --yes ⇒ rewinds to before last user message", async () => {
    await seed("s-tolast")
    const { rewindCommands } = await importCmds()
    const cmd = rewindCommands[0]
    if (cmd === undefined) throw new Error("expected /rewind")
    const state: RewindSlashState = { sessionId: "s-tolast", env: { QUANTA_REWIND: "1" } }
    const cap = buildCtx(state)
    const code = await cmd.run(["--to-last", "--yes"], cap.ctx)
    expect(code).toBe(0)
    // Last user msg is m4; the prior one is m3. So we rewind to m3 ⇒ 1 dropped.
    const reloaded = await loadSessionById("s-tolast")
    expect(reloaded?.messages.length).toBe(4)
    expect(reloaded?.messages.at(-1)?.id).toBe("m3")
  })

  test("--restore-files without QUANTA_REWIND_GIT=1 ⇒ refused", async () => {
    await seed("s-rfile-off", { gitSha: "abc123" })
    const { rewindCommands } = await importCmds()
    const cmd = rewindCommands[0]
    if (cmd === undefined) throw new Error("expected /rewind")
    const state: RewindSlashState = {
      sessionId: "s-rfile-off",
      env: { QUANTA_REWIND: "1" /* QUANTA_REWIND_GIT NOT set */ },
    }
    const cap = buildCtx(state)
    const code = await cmd.run(["m0", "--yes", "--restore-files"], cap.ctx)
    expect(code).toBe(1)
    expect(cap.err).toContain("QUANTA_REWIND_GIT=1")
    // No mutation.
    const reloaded = await loadSessionById("s-rfile-off")
    expect(reloaded?.messages.length).toBe(5)
  })

  test("--restore-files with knob but no port ⇒ refused", async () => {
    await seed("s-rfile-no-port", { gitSha: "abc123" })
    const { rewindCommands } = await importCmds()
    const cmd = rewindCommands[0]
    if (cmd === undefined) throw new Error("expected /rewind")
    const state: RewindSlashState = {
      sessionId: "s-rfile-no-port",
      env: { QUANTA_REWIND: "1", QUANTA_REWIND_GIT: "1" },
    }
    const cap = buildCtx(state)
    const code = await cmd.run(["m0", "--yes", "--restore-files"], cap.ctx)
    expect(code).toBe(1)
    expect(cap.err).toContain("no git port wired")
  })

  test("ambiguous prefix ⇒ exit 1 with clear error", async () => {
    // Seed with two ids that share a prefix.
    const messages: Message[] = [
      mkMessage("a", "user", "abc-1"),
      mkMessage("b", "assistant", "abc-2"),
    ]
    await saveSessionById(mkMeta({ id: "s-ambig" }), { reason: "ok", turns: 1, messages })
    const { rewindCommands } = await importCmds()
    const cmd = rewindCommands[0]
    if (cmd === undefined) throw new Error("expected /rewind")
    const state: RewindSlashState = { sessionId: "s-ambig", env: { QUANTA_REWIND: "1" } }
    const cap = buildCtx(state)
    const code = await cmd.run(["abc", "--yes"], cap.ctx)
    expect(code).toBe(1)
    expect(cap.err).toContain("ambiguous")
  })

  test("QUANTA_REWIND=0 ⇒ command refuses even if dispatched", async () => {
    await seed("s-disabled")
    const { rewindCommands } = await importCmds()
    const cmd = rewindCommands[0]
    if (cmd === undefined) throw new Error("expected /rewind")
    const state: RewindSlashState = { sessionId: "s-disabled", env: { QUANTA_REWIND: "0" } }
    const cap = buildCtx(state)
    const code = await cmd.run(["m0", "--yes"], cap.ctx)
    expect(code).toBe(1)
    expect(cap.err).toContain("QUANTA_REWIND=0")
  })
})

describe("/fork dispatch", () => {
  test("no args ⇒ list mode prints fork points + usage", async () => {
    await seed("s-fork-list")
    const { rewindCommands } = await importCmds()
    const cmd = rewindCommands[1]
    if (cmd === undefined) throw new Error("expected /fork")
    const state: RewindSlashState = { sessionId: "s-fork-list", env: { QUANTA_REWIND: "1" } }
    const cap = buildCtx(state)
    const code = await cmd.run([], cap.ctx)
    expect(code).toBe(0)
    expect(cap.out).toContain("fork points")
    expect(cap.out).toContain("/fork <id-prefix>")
  })

  test("<id> ⇒ creates new session, prints id, source untouched", async () => {
    await seed("s-fork-do")
    const { rewindCommands } = await importCmds()
    const cmd = rewindCommands[1]
    if (cmd === undefined) throw new Error("expected /fork")
    const state: RewindSlashState = { sessionId: "s-fork-do", env: { QUANTA_REWIND: "1" } }
    const cap = buildCtx(state)
    const code = await cmd.run(["m2"], cap.ctx)
    expect(code).toBe(0)
    expect(cap.out).toContain("forked at m2")
    expect(cap.out).toContain("new session")
    // Source unchanged.
    const src = await loadSessionById("s-fork-do")
    expect(src?.messages.length).toBe(5)
  })

  test("<id> --title T ⇒ custom title applied", async () => {
    await seed("s-fork-title")
    const { rewindCommands } = await importCmds()
    const cmd = rewindCommands[1]
    if (cmd === undefined) throw new Error("expected /fork")
    const state: RewindSlashState = { sessionId: "s-fork-title", env: { QUANTA_REWIND: "1" } }
    const cap = buildCtx(state)
    const code = await cmd.run(["m1", "--title", "experiment-A"], cap.ctx)
    expect(code).toBe(0)
    // Extract the new id from the printed message.
    const m = cap.out.match(/new session (\S+)/)
    expect(m).not.toBeNull()
    const newId = m?.[1]
    if (typeof newId !== "string") throw new Error("expected new session id in output")
    const fork = await loadSessionById(newId)
    expect(fork?.meta.title).toBe("experiment-A")
  })

  test("bad id ⇒ exit 1, no new session created", async () => {
    await seed("s-fork-bad")
    const { rewindCommands } = await importCmds()
    const cmd = rewindCommands[1]
    if (cmd === undefined) throw new Error("expected /fork")
    const state: RewindSlashState = { sessionId: "s-fork-bad", env: { QUANTA_REWIND: "1" } }
    const cap = buildCtx(state)
    const code = await cmd.run(["nope"], cap.ctx)
    expect(code).toBe(1)
    expect(cap.err).toContain("messageId not found")
  })

  test("no active session ⇒ exit 1", async () => {
    const { rewindCommands } = await importCmds()
    const cmd = rewindCommands[1]
    if (cmd === undefined) throw new Error("expected /fork")
    const cap = buildCtx()
    const code = await cmd.run(["m0"], cap.ctx)
    expect(code).toBe(1)
    expect(cap.err).toContain("no active session")
  })
})

describe("__test helpers", () => {
  test("shortId truncates to 8 chars", () => {
    expect(__test.shortId("abcdefghijklmnop")).toBe("abcdefgh")
    expect(__test.shortId("short")).toBe("short")
  })
  test("previewMessage handles text, tool_use, empty", () => {
    expect(
      __test.previewMessage({
        role: "user",
        content: [{ type: "text", text: "hello world" }],
      }),
    ).toBe("hello world")
    expect(
      __test.previewMessage({
        role: "assistant",
        content: [{ type: "tool_use", name: "Read" }],
      }),
    ).toBe("[tool:Read]")
    expect(__test.previewMessage({ role: "user", content: [] })).toBe("(empty)")
  })
  test("previewMessage truncates long text to 80 chars + ellipsis", () => {
    const long = "x".repeat(200)
    const out = __test.previewMessage({ role: "user", content: [{ type: "text", text: long }] })
    expect(out.length).toBe(80)
    expect(out.endsWith("...")).toBe(true)
  })
  test("findToLastTarget returns id before last user msg", () => {
    const saved = {
      messages: [
        { role: "user", content: [{ type: "text", text: "a" }], id: "m0" },
        { role: "assistant", content: [{ type: "text", text: "b" }], id: "m1" },
        { role: "user", content: [{ type: "text", text: "c" }], id: "m2" },
      ],
    }
    // biome-ignore lint/suspicious/noExplicitAny: minimal duck-typed shim
    expect(__test.findToLastTarget(saved as any)).toBe("m1")
  })
})
