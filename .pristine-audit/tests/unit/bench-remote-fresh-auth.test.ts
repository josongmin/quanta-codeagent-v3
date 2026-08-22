import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { refreshRemoteAuthJson } from "@/apps/bench/remote/fresh-auth"

const TEMP_DIRS = new Set<string>()

const tempAuthFile = (body: Record<string, unknown>): string => {
  const dir = mkdtempSync(join(tmpdir(), "bench-remote-fresh-auth-"))
  TEMP_DIRS.add(dir)
  const path = join(dir, "chatgpt.json")
  writeFileSync(path, `${JSON.stringify(body)}\n`)
  return path
}

afterEach(() => {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true })
  TEMP_DIRS.clear()
})

describe("refreshRemoteAuthJson", () => {
  test("refreshes and persists the access token before remote ship", async () => {
    const path = tempAuthFile({
      access_token: "ACCESS-old",
      refresh_token: "REFRESH-local-only",
      expires_at: "2026-06-21T00:00:00.000Z",
      account_id: "acct-old",
    })
    const out = await refreshRemoteAuthJson(path, {
      env: {},
      nowMs: () => Date.parse("2026-06-21T00:00:00.000Z"),
      fetchImpl: async () =>
        new Response(JSON.stringify({ access_token: "ACCESS-new", expires_in: 3600 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    })

    const returned = JSON.parse(out) as Record<string, unknown>
    const persisted = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
    expect(returned.access_token).toBe("ACCESS-new")
    expect(returned.refresh_token).toBe("REFRESH-local-only")
    expect(persisted.access_token).toBe("ACCESS-new")
    expect(persisted.refresh_token).toBe("REFRESH-local-only")
    expect(persisted.expires_at).toBe("2026-06-21T01:00:00.000Z")
  })

  test("fails before provisioning when the refresh grant is revoked", async () => {
    const path = tempAuthFile({
      access_token: "ACCESS-old",
      refresh_token: "REFRESH-dead",
      expires_at: "2026-06-21T00:00:00.000Z",
    })

    await expect(
      refreshRemoteAuthJson(path, {
        env: {},
        fetchImpl: async () =>
          new Response(JSON.stringify({ error: "invalid_grant" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          }),
      }),
    ).rejects.toThrow(/token exchange failed: 401 invalid_grant/)

    const persisted = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
    expect(persisted.access_token).toBe("ACCESS-old")
  })
})
