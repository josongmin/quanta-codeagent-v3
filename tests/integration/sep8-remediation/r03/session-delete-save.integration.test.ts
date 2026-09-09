import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  deleteSession,
  loadSessionById,
  readSessionByIdTyped,
  type SessionMeta,
  saveSessionById,
} from "@/session"
import { __resetRuntimeConfig } from "@/shared"

let root: string
let prior: string | undefined

beforeEach(() => {
  prior = process.env.QUANTA_SESSIONS_DIR
  root = mkdtempSync(join(tmpdir(), "r03-int-"))
  process.env.QUANTA_SESSIONS_DIR = root
  __resetRuntimeConfig()
})

afterEach(() => {
  if (prior === undefined) delete process.env.QUANTA_SESSIONS_DIR
  else process.env.QUANTA_SESSIONS_DIR = prior
  __resetRuntimeConfig()
  rmSync(root, { recursive: true, force: true })
})

describe("R03 delete/save on a real sessions dir", () => {
  test("delete then save without create does not resurrect", async () => {
    const meta: SessionMeta = {
      id: "s1",
      title: "t",
      cwd: "/tmp",
      createdAt: 1,
      lastTouched: 1,
      archived: false,
    }
    await saveSessionById(meta, { reason: "done", turns: 1, messages: [] }, undefined, {
      create: true,
    })
    await deleteSession("s1")
    await expect(
      saveSessionById(meta, { reason: "done", turns: 2, messages: [] }),
    ).rejects.toMatchObject({ name: "StaleSessionGenerationError" })
    expect(await loadSessionById("s1")).toBeUndefined()
  })

  test("delete tombstone fences a stale save in a different OS process", async () => {
    const meta: SessionMeta = {
      id: "cross-process",
      title: "original",
      cwd: "/tmp",
      createdAt: 1,
      lastTouched: 1,
      archived: false,
    }
    await saveSessionById(meta, { reason: "done", turns: 1, messages: [] }, undefined, {
      create: true,
    })
    const sessionModule = join(import.meta.dir, "../../../../src/session/index.ts")
    const worker = join(root, "session-worker.ts")
    writeFileSync(
      worker,
      `import { deleteSession, saveSessionById } from ${JSON.stringify(sessionModule)};
const mode = process.argv[2];
const meta = { id: "cross-process", title: mode, cwd: "/tmp", createdAt: 1, lastTouched: 1, archived: false };
if (mode === "delete") await deleteSession(meta.id);
else {
  try {
    await saveSessionById(meta, { reason: "done", turns: mode === "create" ? 3 : 2, messages: [] }, undefined, mode === "create" ? { create: true } : undefined);
    if (mode === "stale") process.exit(2);
  } catch (error) {
    if (mode === "stale" && error instanceof Error && error.name === "StaleSessionGenerationError") process.exit(0);
    throw error;
  }
}
`,
    )
    const run = async (mode: "delete" | "stale" | "create"): Promise<number> => {
      const child = Bun.spawn(["bun", worker, mode], {
        cwd: join(import.meta.dir, "../../../.."),
        env: { ...process.env, QUANTA_SESSIONS_DIR: root },
        stdout: "pipe",
        stderr: "pipe",
      })
      return child.exited
    }

    expect(await run("delete")).toBe(0)
    expect(await run("stale")).toBe(0)
    expect(await loadSessionById(meta.id)).toBeUndefined()

    expect(await run("create")).toBe(0)
    expect((await loadSessionById(meta.id))?.turns).toBe(3)
  })

  test("corrupt durable generation refuses reads and writes without touching snapshot bytes", async () => {
    const meta: SessionMeta = {
      id: "corrupt-generation",
      title: "original",
      cwd: "/tmp",
      createdAt: 1,
      lastTouched: 1,
      archived: false,
    }
    await saveSessionById(meta, { reason: "done", turns: 1, messages: [] }, undefined, {
      create: true,
    })
    const snapshot = join(root, `${meta.id}.json`)
    const before = readFileSync(snapshot, "utf8")
    writeFileSync(join(root, ".generations", `${meta.id}.json`), "{broken")

    expect(await readSessionByIdTyped(meta.id)).toMatchObject({ kind: "corrupt" })
    await expect(
      saveSessionById(meta, { reason: "done", turns: 2, messages: [] }),
    ).rejects.toMatchObject({ name: "SessionGenerationStateError", kind: "corrupt" })
    expect(readFileSync(snapshot, "utf8")).toBe(before)
  })

  test("unsupported POSIX locking fails session mutation and index RMW closed", async () => {
    const sessionModule = join(import.meta.dir, "../../../../src/session/index.ts")
    const indexModule = join(import.meta.dir, "../../../../src/session/index-store.ts")
    const worker = join(root, "unsupported-lock-worker.ts")
    writeFileSync(
      worker,
      `Object.defineProperty(process, "platform", { value: "win32" });
const session = await import(${JSON.stringify(sessionModule)});
const indexStore = await import(${JSON.stringify(indexModule)});
const provider = session.staticSessionRootProvider(${JSON.stringify(join(root, "unsupported"))});
const meta = { id: "closed", title: "closed", cwd: "/tmp", createdAt: 1, lastTouched: 1, archived: false };
const mustRefuse = async (run) => {
  try { await run(); return false; }
  catch (error) { return error instanceof Error && error.message.includes("POSIX flock is unavailable"); }
};
if (!(await mustRefuse(() => session.saveSessionById(meta, { reason: "done", turns: 1, messages: [] }, provider)))) process.exit(2);
if (!(await mustRefuse(() => indexStore.upsertMeta(meta, provider)))) process.exit(3);
`,
    )
    const child = Bun.spawn(["bun", worker], {
      cwd: join(import.meta.dir, "../../../.."),
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(await child.exited).toBe(0)
  })
})
