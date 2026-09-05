#!/usr/bin/env bun
import { readFile, writeFile } from "node:fs/promises"
import { refreshTokenTransaction } from "../../src/auth/chatgpt-oauth/refresh-transaction.ts"
import { isExpired, type TokenRecord } from "../../src/auth/chatgpt-oauth/token-store.ts"
import { FileBasedLock } from "../../src/auth/lock-file-based.ts"
import { createNodeLockFileStore } from "../../src/auth/node-lock-file-store.ts"

const [tokenPath, lockDir, issuer] = process.argv.slice(2)
if (tokenPath === undefined || lockDir === undefined || issuer === undefined) {
  process.stderr.write("usage: chatgpt-refresh-child.ts <token> <lockDir> <issuer>\n")
  process.exit(2)
}

const readCurrent = async (): Promise<TokenRecord | null> => {
  try {
    return JSON.parse(await readFile(tokenPath, "utf8")) as TokenRecord
  } catch {
    return null
  }
}

const next = await refreshTokenTransaction(tokenPath, {
  lock: new FileBasedLock({
    store: createNodeLockFileStore(lockDir),
    clock: { now: () => Date.now() },
    pid: process.pid,
  }),
  holderId: `${process.pid}`,
  nowMs: () => Date.now(),
  sleep: (ms) => Bun.sleep(ms),
  readCurrent,
  persist: async (token) => {
    await writeFile(tokenPath, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 })
  },
  refresh: async (_current) => {
    const res = await fetch(issuer, { method: "POST" })
    const body = (await res.json()) as {
      access_token: string
      refresh_token: string
      expires_in: number
    }
    return {
      access_token: body.access_token,
      refresh_token: body.refresh_token,
      expires_at: new Date(Date.now() + body.expires_in * 1000).toISOString(),
      last_refresh: new Date().toISOString(),
    } satisfies TokenRecord
  },
})
if (isExpired(next, Date.now(), 0)) process.exit(3)
process.stdout.write(`${next.access_token}\n`)
