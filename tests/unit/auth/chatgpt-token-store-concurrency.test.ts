import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type TokenRecord, writeToken } from "@/auth/chatgpt-oauth"
import { createFileMcpTokenStore } from "@/host/mcp-composition"

const rec = (n: number): TokenRecord => ({
  access_token: `access-fixture-${n}`,
  refresh_token: `refresh-fixture-${n}`,
  expires_at: new Date(Date.now() + 60_000).toISOString(),
})

describe("chatgpt token store concurrency", () => {
  test("two writers leave one complete JSON record and never leak token bytes in errors", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quanta-chatgpt-token-"))
    const path = join(dir, "chatgpt.json")
    const errors: string[] = []
    await Promise.all(
      [1, 2].map(async (n) => {
        try {
          await writeToken(path, rec(n))
        } catch (e) {
          errors.push(String(e))
        }
      }),
    )
    const raw = await readFile(path, "utf8")
    const parsed = JSON.parse(raw) as TokenRecord
    expect(parsed.access_token.startsWith("access-fixture-")).toBe(true)
    expect(parsed.refresh_token.startsWith("refresh-fixture-")).toBe(true)
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600)
    }
    expect(errors.join("")).not.toContain("access-fixture")
    expect(errors.join("")).not.toContain("refresh-fixture")
  })
})

describe("mcp token store atomic", () => {
  test("public schema adapter writes accessToken JSON at 0600", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quanta-mcp-token-"))
    const store = createFileMcpTokenStore(dir)
    await store.write("srv", {
      accessToken: "mcp-access-fixture",
      tokenType: "Bearer",
    })
    const read = await store.read("srv")
    expect(read?.accessToken).toBe("mcp-access-fixture")
    expect(read?.tokenType).toBe("Bearer")
  })
})
