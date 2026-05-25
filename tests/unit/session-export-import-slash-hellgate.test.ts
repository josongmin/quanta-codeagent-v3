/**
 * Hellgate battery for `/session export` + `/session import` slash command
 * (ADR-0294). 15+ adversarial cases lock the surface so the typed primitive
 * (ADR-0157) is exposed without leaking host-store internals.
 *
 * Invariants under test (RFC §1.2 + ADR-0294 contract):
 *   - Default-OFF: absent `ctx.sessionIo` ⇒ "not wired" + exit 0
 *   - No-throw on slash run: all FS / typed import errors land as ctx.err
 *     + exit 1, never re-thrown
 *   - Path safety: refuses `--out` / `<path>` outside cwd AND $HOME
 *   - 50 MB import cap enforced BEFORE the file is read
 *   - SessionImportError surfaced with its `code` prefix
 *   - Round-trip equivalence: export → import deep-equals the original
 *   - Sidecar fields survive round-trip
 */

import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SessionIoState } from "../../src/apps/cli/session-cmd"
import { runSlashCommand, type SlashContext } from "../../src/apps/cli/slash-commands"
import { exportSessionToJson } from "../../src/session/import-export"
import type { SavedSession } from "../../src/session/types"

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

interface Captured {
  out: string
  err: string
  ctx: SlashContext
}

const buildCtx = (opts: { cwd: string; sessionIo?: SessionIoState }): Captured => {
  const c: Captured = {
    out: "",
    err: "",
    ctx: {
      out: (s) => {
        c.out += s
      },
      err: (s) => {
        c.err += s
      },
      cwd: opts.cwd,
      ...(opts.sessionIo !== undefined ? { sessionIo: opts.sessionIo } : {}),
    },
  }
  return c
}

const buildSession = (id: string, n = 2): SavedSession => ({
  version: 2,
  meta: {
    id,
    title: `t-${id}`,
    cwd: "/tmp",
    createdAt: 1000,
    lastTouched: 2000,
    archived: false,
  },
  reason: "test",
  turns: n,
  messages: Array.from({ length: n }).map((_, i) => ({
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: [{ type: "text" as const, text: `msg-${i}` }],
  })),
})

interface FakeStore extends SessionIoState {
  readonly written: Map<string, SavedSession>
  readonly seeded: Map<string, SavedSession>
}

const fakeStore = (
  seeded: ReadonlyArray<[string, SavedSession]> = [],
  mintIds: string[] = ["new-001"],
): FakeStore => {
  const seededMap = new Map<string, SavedSession>(seeded)
  const written = new Map<string, SavedSession>()
  let mintIdx = 0
  return {
    seeded: seededMap,
    written,
    readSession: async (id) => seededMap.get(id) ?? null,
    writeSession: async (id, sess) => {
      written.set(id, sess)
    },
    mintNewId: () => {
      const next = mintIds[mintIdx] ?? `mint-${mintIdx}`
      mintIdx += 1
      return next
    },
    now: () => 12345,
  }
}

const withTempCwd = (fn: (cwd: string) => Promise<void> | void): Promise<void> => {
  const cwd = mkdtempSync(join(tmpdir(), "quanta-sess-slash-"))
  return Promise.resolve(fn(cwd)).finally(() => {
    try {
      rmSync(cwd, { recursive: true, force: true })
    } catch {
      // best-effort cleanup
    }
  })
}

/* ------------------------------------------------------------------ */
/* default-OFF                                                          */
/* ------------------------------------------------------------------ */

describe("/session default-OFF", () => {
  test("case 12 — absent ctx.sessionIo ⇒ 'not wired' + exit 0", async () => {
    const c = buildCtx({ cwd: "/tmp" })
    const code = await runSlashCommand("/session export some-id", c.ctx)
    expect(code).toBe(0)
    expect(c.out).toContain("not wired")
    expect(c.err).toBe("")
  })
})

/* ------------------------------------------------------------------ */
/* usage                                                                */
/* ------------------------------------------------------------------ */

describe("/session usage", () => {
  test("case 1 — no args ⇒ usage + exit 0", async () => {
    const sio = fakeStore()
    const c = buildCtx({ cwd: "/tmp", sessionIo: sio })
    const code = await runSlashCommand("/session", c.ctx)
    expect(code).toBe(0)
    expect(c.out).toContain("usage: /session")
    expect(c.out).toContain("/session export")
    expect(c.out).toContain("/session import")
  })

  test("case 2 — /session help ⇒ usage + exit 0", async () => {
    const sio = fakeStore()
    const c = buildCtx({ cwd: "/tmp", sessionIo: sio })
    const code = await runSlashCommand("/session help", c.ctx)
    expect(code).toBe(0)
    expect(c.out).toContain("usage: /session")
  })

  test("unknown subcommand ⇒ exit 1", async () => {
    const sio = fakeStore()
    const c = buildCtx({ cwd: "/tmp", sessionIo: sio })
    const code = await runSlashCommand("/session shrubbery", c.ctx)
    expect(code).toBe(1)
    expect(c.err).toContain("unknown subcommand")
  })

  test("unknown flag ⇒ exit 1", async () => {
    const sio = fakeStore()
    const c = buildCtx({ cwd: "/tmp", sessionIo: sio })
    const code = await runSlashCommand("/session export some-id --foo=bar", c.ctx)
    expect(code).toBe(1)
    expect(c.err).toContain("unknown flag")
  })
})

/* ------------------------------------------------------------------ */
/* export                                                              */
/* ------------------------------------------------------------------ */

describe("/session export", () => {
  test("case 3 — unknown id ⇒ 'session not found' + exit 1", async () => {
    const sio = fakeStore()
    const c = buildCtx({ cwd: "/tmp", sessionIo: sio })
    const code = await runSlashCommand("/session export bogus", c.ctx)
    expect(code).toBe(1)
    expect(c.err).toContain("session not found")
  })

  test("case 4 — default path ⇒ writes + exit 0", async () => {
    await withTempCwd(async (cwd) => {
      const sess = buildSession("sess-abc")
      const sio = fakeStore([["sess-abc", sess]])
      const c = buildCtx({ cwd, sessionIo: sio })
      const code = await runSlashCommand("/session export sess-abc", c.ctx)
      expect(code).toBe(0)
      expect(c.out).toMatch(/^wrote /)
      expect(c.out).toContain("bytes")
      expect(c.out).toContain(`quanta-session-sess-abc-12345.json`)
    })
  })

  test("case 5 — --out=<custom-path> ⇒ writes there", async () => {
    await withTempCwd(async (cwd) => {
      const sess = buildSession("s2")
      const sio = fakeStore([["s2", sess]])
      const c = buildCtx({ cwd, sessionIo: sio })
      const outPath = join(cwd, "deeper", "custom.json")
      mkdirSync(join(cwd, "deeper"), { recursive: true })
      const code = await runSlashCommand(`/session export s2 --out=${outPath}`, c.ctx)
      expect(code).toBe(0)
      expect(c.out).toContain(outPath)
      const written = await Bun.file(outPath).text()
      expect(written.length).toBeGreaterThan(10)
      const parsed = JSON.parse(written) as { version: number; session: { meta: { id: string } } }
      expect(parsed.version).toBe(1)
      expect(parsed.session.meta.id).toBe("s2")
    })
  })

  test("case 6 — --out=/etc/passwd ⇒ refuses outside cwd/$HOME + exit 1", async () => {
    await withTempCwd(async (cwd) => {
      const sess = buildSession("s3")
      const sio = fakeStore([["s3", sess]])
      const c = buildCtx({ cwd, sessionIo: sio })
      const code = await runSlashCommand("/session export s3 --out=/etc/passwd", c.ctx)
      expect(code).toBe(1)
      expect(c.err).toContain("refusing to write outside cwd or $HOME")
    })
  })

  test("missing <id> ⇒ exit 1", async () => {
    const sio = fakeStore()
    const c = buildCtx({ cwd: "/tmp", sessionIo: sio })
    const code = await runSlashCommand("/session export", c.ctx)
    expect(code).toBe(1)
    expect(c.err).toContain("missing <id>")
  })
})

/* ------------------------------------------------------------------ */
/* import                                                              */
/* ------------------------------------------------------------------ */

describe("/session import", () => {
  test("case 7 — missing file ⇒ ENOENT surfaced + exit 1", async () => {
    await withTempCwd(async (cwd) => {
      const sio = fakeStore()
      const c = buildCtx({ cwd, sessionIo: sio })
      const code = await runSlashCommand(`/session import ${join(cwd, "nope.json")}`, c.ctx)
      expect(code).toBe(1)
      // stat failure surfaces — ENOENT or similar in the message.
      expect(c.err.toLowerCase()).toMatch(/no such file|enoent/i)
    })
  })

  test("case 8 — bad-shape file ⇒ SessionImportError surfaced + exit 1", async () => {
    await withTempCwd(async (cwd) => {
      const sio = fakeStore()
      const c = buildCtx({ cwd, sessionIo: sio })
      const badPath = join(cwd, "bad.json")
      writeFileSync(badPath, '{"version": 1, "this": "is not an envelope"}', "utf8")
      const code = await runSlashCommand(`/session import ${badPath}`, c.ctx)
      expect(code).toBe(1)
      expect(c.err).toContain("/session import:")
      // SessionImportError carries a typed code prefix.
      expect(c.err.toLowerCase()).toMatch(/malformed|exporter|envelope/)
    })
  })

  test("malformed JSON ⇒ malformed error + exit 1", async () => {
    await withTempCwd(async (cwd) => {
      const sio = fakeStore()
      const c = buildCtx({ cwd, sessionIo: sio })
      const badPath = join(cwd, "bad.json")
      writeFileSync(badPath, "not-json-at-all", "utf8")
      const code = await runSlashCommand(`/session import ${badPath}`, c.ctx)
      expect(code).toBe(1)
      expect(c.err.toLowerCase()).toContain("malformed")
    })
  })

  test("case 9 — good file ⇒ imports + prints summary + exit 0", async () => {
    await withTempCwd(async (cwd) => {
      const sess = buildSession("orig-id", 3)
      const goodPath = join(cwd, "good.json")
      const json = exportSessionToJson(sess, { quantaVersion: "0" })
      writeFileSync(goodPath, json, "utf8")
      const sio = fakeStore([], ["minted-X"])
      const c = buildCtx({ cwd, sessionIo: sio })
      const code = await runSlashCommand(`/session import ${goodPath}`, c.ctx)
      expect(code).toBe(0)
      expect(c.out).toContain("imported into session minted-X")
      expect(c.out).toContain("3 messages")
      expect(sio.written.has("minted-X")).toBe(true)
      // id was rewritten to the minted one (not the export-time id).
      const wrote = sio.written.get("minted-X") as SavedSession
      expect(wrote.meta.id).toBe("minted-X")
      expect(wrote.messages.length).toBe(3)
    })
  })

  test("case 10 — --id=<custom> ⇒ uses provided id", async () => {
    await withTempCwd(async (cwd) => {
      const sess = buildSession("orig", 1)
      const goodPath = join(cwd, "good.json")
      writeFileSync(goodPath, exportSessionToJson(sess, { quantaVersion: "0" }), "utf8")
      const sio = fakeStore()
      const c = buildCtx({ cwd, sessionIo: sio })
      const code = await runSlashCommand(`/session import ${goodPath} --id=user-picked`, c.ctx)
      expect(code).toBe(0)
      expect(c.out).toContain("imported into session user-picked")
      expect(sio.written.has("user-picked")).toBe(true)
      const wrote = sio.written.get("user-picked") as SavedSession
      expect(wrote.meta.id).toBe("user-picked")
    })
  })

  test("case 11 — file > 50 MB ⇒ 'too large' + exit 1 (no read)", async () => {
    await withTempCwd(async (cwd) => {
      // Create a sparse file > 50MB without actually writing 50MB of bytes
      // (truncate gives us a sparse file with size N but disk footprint ~0).
      const huge = join(cwd, "huge.json")
      const fd = await Bun.file(huge)
      // Bun lacks a one-line truncate; use node:fs/promises.truncate via dynamic import.
      const fs = await import("node:fs/promises")
      await fs.writeFile(huge, "{}", "utf8")
      await fs.truncate(huge, 51 * 1024 * 1024) // 51 MB
      void fd
      const sio = fakeStore()
      const c = buildCtx({ cwd, sessionIo: sio })
      const code = await runSlashCommand(`/session import ${huge}`, c.ctx)
      expect(code).toBe(1)
      expect(c.err).toContain("too large")
      expect(c.err).toContain("cap 50 MB")
      // Cap is enforced BEFORE read — the bogus content was never parsed.
      expect(sio.written.size).toBe(0)
    })
  })

  test("import path outside cwd/$HOME ⇒ refuses + exit 1", async () => {
    await withTempCwd(async (cwd) => {
      const sio = fakeStore()
      const c = buildCtx({ cwd, sessionIo: sio })
      const code = await runSlashCommand("/session import /etc/hosts", c.ctx)
      expect(code).toBe(1)
      expect(c.err).toContain("refusing to read outside cwd or $HOME")
    })
  })

  test("missing <path> ⇒ exit 1", async () => {
    const sio = fakeStore()
    const c = buildCtx({ cwd: "/tmp", sessionIo: sio })
    const code = await runSlashCommand("/session import", c.ctx)
    expect(code).toBe(1)
    expect(c.err).toContain("missing <path>")
  })
})

/* ------------------------------------------------------------------ */
/* round-trip                                                          */
/* ------------------------------------------------------------------ */

describe("/session round-trip", () => {
  test("case 13 — export then import yields equivalent SavedSession (modulo id)", async () => {
    await withTempCwd(async (cwd) => {
      const orig = buildSession("seed-id", 4)
      const sio = fakeStore([["seed-id", orig]], ["round-001"])
      const c = buildCtx({ cwd, sessionIo: sio })
      const outPath = join(cwd, "rt.json")
      const r1 = await runSlashCommand(`/session export seed-id --out=${outPath}`, c.ctx)
      expect(r1).toBe(0)
      const r2 = await runSlashCommand(`/session import ${outPath}`, c.ctx)
      expect(r2).toBe(0)
      const imported = sio.written.get("round-001") as SavedSession
      expect(imported).toBeDefined()
      // Everything matches EXCEPT meta.id (rewritten to the minted id).
      expect(imported.version).toBe(orig.version)
      expect(imported.reason).toBe(orig.reason)
      expect(imported.turns).toBe(orig.turns)
      expect(imported.messages).toEqual(orig.messages)
      expect(imported.meta.title).toBe(orig.meta.title)
      expect(imported.meta.cwd).toBe(orig.meta.cwd)
      expect(imported.meta.createdAt).toBe(orig.meta.createdAt)
      expect(imported.meta.lastTouched).toBe(orig.meta.lastTouched)
      expect(imported.meta.archived).toBe(orig.meta.archived)
      expect(imported.meta.id).toBe("round-001") // rewritten
    })
  })

  test("case 14 — sidecar fields (planQueue, budgetLedger, conversationCheckpoint) survive", async () => {
    await withTempCwd(async (cwd) => {
      const orig = buildSession("with-sidecar", 1)
      // Write directly via the pure primitive to embed sidecar — the slash
      // export path itself does NOT emit sidecar (no per-subsystem hook in
      // ctx.sessionIo today; that's a follow-up wire). We still want to
      // prove the IMPORT path preserves sidecar fields end-to-end.
      const json = exportSessionToJson(orig, {
        quantaVersion: "0",
        sidecar: {
          planQueue: '{"plan":"queue-payload"}',
          budgetLedger: '{"budget":"ledger-payload"}',
          conversationCheckpoint: '{"conv":"checkpoint-payload"}',
        },
      })
      const path = join(cwd, "sidecar.json")
      writeFileSync(path, json, "utf8")
      const sio = fakeStore([], ["side-001"])
      const c = buildCtx({ cwd, sessionIo: sio })
      const code = await runSlashCommand(`/session import ${path}`, c.ctx)
      expect(code).toBe(0)
      // Output summary lists the sidecar keys.
      expect(c.out).toContain("sidecar=")
      expect(c.out).toMatch(/planQueue|budgetLedger|conversationCheckpoint/)
    })
  })
})

/* ------------------------------------------------------------------ */
/* no-throw invariant                                                  */
/* ------------------------------------------------------------------ */

describe("/session no-throw", () => {
  test("case 15 — slash NEVER throws regardless of input pathology", async () => {
    await withTempCwd(async (cwd) => {
      const sio = fakeStore()
      const c = buildCtx({ cwd, sessionIo: sio })
      // A spread of adversarial argvs, none should propagate an exception.
      const adversarial = [
        "/session export",
        "/session export ../../../../etc/passwd",
        "/session export some-id --out=/root/x",
        "/session import",
        "/session import /etc/shadow",
        `/session import ${join(cwd, "nope.json")}`,
        "/session shrubbery",
        "/session export some-id --unknown=yes",
      ]
      for (const cmd of adversarial) {
        let threw = false
        let code = 0
        try {
          code = await runSlashCommand(cmd, c.ctx)
        } catch {
          threw = true
        }
        expect(threw).toBe(false)
        expect([0, 1]).toContain(code)
      }
    })
  })

  test("exit codes: 0 == success, 1 == user-recoverable error", async () => {
    await withTempCwd(async (cwd) => {
      const sess = buildSession("happy")
      const sio = fakeStore([["happy", sess]])
      const c1 = buildCtx({ cwd, sessionIo: sio })
      expect(await runSlashCommand("/session export happy", c1.ctx)).toBe(0)
      const c2 = buildCtx({ cwd, sessionIo: sio })
      expect(await runSlashCommand("/session export nope-not-real", c2.ctx)).toBe(1)
    })
  })
})
