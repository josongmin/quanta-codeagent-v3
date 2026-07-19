/**
 * AUDIT (04 fidelity + H1 symmetry) — the web-daemon thread DB holds full
 * session transcripts (prompts, tool I/O, and under `QUANTA_SESSION_FULL_
 * FIDELITY` the untruncated tool payloads). It must be owner-only (0o600) —
 * symmetric with the JSONL event log's H1 fix — never world-readable on a
 * multi-user host. bun:sqlite creates the file under the process umask
 * (0o644 on 022), so the store must clamp it explicitly.
 *
 * red-on-injection: delete the `chmodSync(dbPath, 0o600)` in persistence-
 * sqlite.ts and the mode assertion goes red.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openThreadStore } from "@/apps/web-daemon/persistence-sqlite"
import { __resetRuntimeConfig } from "@/shared/runtime-config"

const dirs: string[] = []
const prior = process.env.QUANTA_WEB_DB_DIR
afterEach(() => {
  if (prior === undefined) delete process.env.QUANTA_WEB_DB_DIR
  else process.env.QUANTA_WEB_DB_DIR = prior
  __resetRuntimeConfig()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const noGroupOther = (path: string): number => statSync(path).mode & 0o077

describe("web-daemon thread DB is owner-only (0o600) — transcript privacy", () => {
  test("threads.db and its dir are owner-only after openThreadStore", () => {
    const dir = mkdtempSync(join(tmpdir(), "quanta-webdb-perms-"))
    dirs.push(dir)
    const webDir = join(dir, "web-daemon")
    process.env.QUANTA_WEB_DB_DIR = webDir
    __resetRuntimeConfig()

    const store = openThreadStore()
    store.upsertThread({ id: "t1", title: "secret" })

    // Direct mode-bit inspection (umask-independent red-on-injection).
    expect(noGroupOther(join(webDir, "threads.db"))).toBe(0)
    expect(noGroupOther(webDir)).toBe(0)
  })
})
