/**
 * SEP5-04B — two Bun child processes, one counting issuer, one token file.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const CHILD = fileURLToPath(new URL("../fixtures/chatgpt-refresh-child.ts", import.meta.url))

describe("chatgpt refresh cross-process", () => {
  const procs: Bun.Subprocess[] = []
  afterAll(() => {
    for (const p of procs) {
      try {
        p.kill()
      } catch {
        /* ignore */
      }
    }
  })

  test("two children, one issuer hit, identical winner, no leftover lock", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chatgpt-xproc-"))
    const tokenPath = join(dir, "chatgpt.json")
    const lockDir = join(dir, "locks")
    const expired = {
      access_token: "old",
      refresh_token: "refresh-fixture",
      expires_at: new Date(0).toISOString(),
    }
    await writeFile(tokenPath, `${JSON.stringify(expired, null, 2)}\n`, { mode: 0o600 })
    let hits = 0
    const server = Bun.serve({
      port: 0,
      fetch: async () => {
        hits++
        return Response.json({
          access_token: "winner-access",
          refresh_token: "winner-refresh",
          expires_in: 3600,
        })
      },
    })
    try {
      const url = `http://127.0.0.1:${server.port}`
      const spawnChild = () => {
        const proc = Bun.spawn(["bun", CHILD, tokenPath, lockDir, url], {
          stdout: "pipe",
          stderr: "pipe",
          env: { PATH: process.env.PATH ?? "/usr/bin" },
        })
        procs.push(proc)
        return proc
      }
      const a = spawnChild()
      const b = spawnChild()
      const [ra, rb] = await Promise.all([a.exited, b.exited])
      const outA = await new Response(a.stdout).text()
      const outB = await new Response(b.stdout).text()
      expect(ra).toBe(0)
      expect(rb).toBe(0)
      expect(hits).toBe(1)
      expect(outA.trim()).toBe("winner-access")
      expect(outB.trim()).toBe("winner-access")
      const final = JSON.parse(await readFile(tokenPath, "utf8")) as { access_token: string }
      expect(final.access_token).toBe("winner-access")
      expect(await readdir(lockDir)).toEqual([])
    } finally {
      server.stop(true)
      await rm(dir, { recursive: true, force: true })
    }
  })
})
