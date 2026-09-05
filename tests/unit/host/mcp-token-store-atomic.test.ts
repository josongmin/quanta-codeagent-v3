import { describe, expect, test } from "bun:test"
import { mkdtemp, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFileMcpTokenStore } from "@/host/mcp-composition"

describe("mcp token store atomic", () => {
  test("two writers leave one complete MCP schema record", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quanta-mcp-atomic-"))
    const store = createFileMcpTokenStore(dir)
    await Promise.all([
      store.write("id", { accessToken: "a1", tokenType: "Bearer" }),
      store.write("id", { accessToken: "a2", tokenType: "Bearer" }),
    ])
    const rec = await store.read("id")
    expect(rec?.tokenType).toBe("Bearer")
    expect(rec?.accessToken === "a1" || rec?.accessToken === "a2").toBe(true)
    if (process.platform !== "win32") {
      const file = join(dir, "id.json")
      expect((await stat(file)).mode & 0o777).toBe(0o600)
    }
  })
})
