import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeTrustPersistence } from "@/apps/agent/trust-persist"
import { withExclusiveFileLock } from "@/auth/file-transaction/exclusive-lock"
import { createNodeLockFileStore } from "@/auth/node-lock-file-store"
import { type TrustPersistencePort, type TrustRecord, TrustStore } from "@/config"
import {
  isThrottled,
  loadMigrationLedgerDetailed,
  parseLedgerEntry,
  recordDisposition,
} from "@/migration/external-config/ledger"
import { persistConvertedItems } from "@/migration/external-config/persist"

describe("F-11 malformed ledger entries", () => {
  test("null/scalar entries do not throw isThrottled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "r02-ledger-"))
    await mkdir(join(dir, ".quanta"), { recursive: true })
    await writeFile(
      join(dir, ".quanta", "external_config_migration.json"),
      JSON.stringify({
        version: 1,
        entries: [
          null,
          3,
          { sourceKey: "ok", disposition: "offered", timestamp: "t", itemTypes: [] },
        ],
      }),
    )
    const loaded = await loadMigrationLedgerDetailed(dir)
    expect(loaded.diagnostic.dropped).toBe(2)
    expect(isThrottled(loaded.ledger, "ok")).toBe(true)
    expect(parseLedgerEntry(null)).toBeNull()
  })

  test("recordDisposition does not clobber an unparseable ledger", async () => {
    const dir = await mkdtemp(join(tmpdir(), "r02-ledger-torn-"))
    await mkdir(join(dir, ".quanta"), { recursive: true })
    const path = join(dir, ".quanta", "external_config_migration.json")
    const broken = '{"version":1,"entries":[{"sourceKey":"old"'
    await writeFile(path, broken)
    expect(await recordDisposition(dir, "new", "imported", ["settings"])).toBe(false)
    expect(await readFile(path, "utf8")).toBe(broken)
  })

  test("unreadable ledger refuses persist instead of re-importing", async () => {
    const home = await mkdtemp(join(tmpdir(), "r02-ledger-persist-"))
    const project = await mkdtemp(join(tmpdir(), "r02-ledger-proj-"))
    await mkdir(join(home, ".quanta"), { recursive: true })
    const path = join(home, ".quanta", "external_config_migration.json")
    const broken = '{"version":1,"entries":[{"sourceKey":"old"'
    await writeFile(path, broken)
    const r = await persistConvertedItems({
      enabled: true,
      homeDir: home,
      projectDir: project,
      sourceKey: "new-source",
      converted: [{ type: "settings", ok: true, value: { allow: ["Read"], deny: [], ask: [] } }],
    })
    expect(r.persisted).toBe(false)
    expect(r.warnings.length).toBeGreaterThan(0)
    expect(await readFile(path, "utf8")).toBe(broken)
  })
})

describe("F-04 CAS is not wedged by leftover claim files", () => {
  test("compareAndSwap succeeds after a leftover .cas file exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "r02-cas-"))
    const store = createNodeLockFileStore(dir)
    await writeFile(join(dir, "k.cas"), "orphan\n")
    expect(await store.writeExclusive("k", "v1")).toBe("ok")
    expect(await store.compareAndSwap("k", "v1", "v2")).toBe("ok")
    expect(await store.read("k")).toBe("v2")
  })
})

describe("F-03 leftover ledger lock", () => {
  test("orphan lock pathname does not permanently refuse recordDisposition", async () => {
    const dir = await mkdtemp(join(tmpdir(), "r02-f03-"))
    await mkdir(join(dir, ".quanta"), { recursive: true })
    await writeFile(join(dir, ".quanta", "external_config_migration.json.lock"), "orphan")
    expect(await recordDisposition(dir, "src", "imported", ["settings"])).toBe(true)
    expect(isThrottled((await loadMigrationLedgerDetailed(dir)).ledger, "src")).toBe(true)
  })
})

describe("F-10 settings/hooks union", () => {
  test("two OS processes merge distinct settings and hooks", async () => {
    const project = await mkdtemp(join(tmpdir(), "r02-f10-proj-"))
    const home = await mkdtemp(join(tmpdir(), "r02-f10-home-"))
    await writeFile(
      join(project, "settings.json"),
      `${JSON.stringify({ peer: 7, permissions: { allow: ["Existing"] } }, null, 2)}\n`,
    )
    const persistPath = join(
      import.meta.dir,
      "../../../../src/migration/external-config/persist.ts",
    )
    const script = join(project, "worker.ts")
    await writeFile(
      script,
      `import { persistConvertedItems } from ${JSON.stringify(persistPath)};
const kind = process.argv[2];
const projectDir = process.argv[3];
const homeDir = process.argv[4];
const converted = kind === "settings"
  ? [{ type: "settings", ok: true, value: { allow: ["Read"], deny: [], ask: [] } }]
  : [{ type: "hooks", ok: true, value: [{ event: "PreToolUse", matcher: "Bash", commands: ["g.sh"] }] }];
const r = await persistConvertedItems({ enabled: true, homeDir, projectDir, converted });
if (!r.writtenTypes.includes(kind)) process.exit(2);
`,
    )
    const repoRoot = join(import.meta.dir, "../../../..")
    const a = Bun.spawn(["bun", script, "settings", project, home], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    })
    const b = Bun.spawn(["bun", script, "hooks", project, home], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(await a.exited).toBe(0)
    expect(await b.exited).toBe(0)
    const parsed = JSON.parse(await readFile(join(project, "settings.json"), "utf8")) as {
      peer: number
      permissions: { allow: string[] }
      hooks: Record<string, unknown>
    }
    expect(parsed.peer).toBe(7)
    expect(parsed.permissions.allow).toEqual(expect.arrayContaining(["Existing", "Read"]))
    expect(parsed.hooks.PreToolUse).toBeDefined()
  })
})

describe("F-12 dirty-delta commit", () => {
  test("flush sends only newly granted keys", async () => {
    const commits: Array<Record<string, TrustRecord>> = []
    const port: TrustPersistencePort = {
      load: async () => ({ "/a": { trusted: true, grantedAt: 1 } }),
      commit: async (mutations) => {
        commits.push({ ...mutations })
      },
    }
    const store = await TrustStore.load(port)
    store.setTrusted("/b", 2)
    await store.flush()
    expect(Object.keys(commits[0] ?? {})).toEqual(["/b"])
  })

  test("two OS processes keep both grants", async () => {
    const dir = await mkdtemp(join(tmpdir(), "r02-f12-"))
    const file = join(dir, "trust.json")
    await writeFile(file, "{}")
    const trustMod = join(import.meta.dir, "../../../../src/config/trust-store.ts")
    const lockMod = join(import.meta.dir, "../../../../src/auth/file-transaction/exclusive-lock.ts")
    const script = join(dir, "grant.ts")
    await writeFile(
      script,
      `import { readFile, rename, writeFile } from "node:fs/promises";
import { TrustStore } from ${JSON.stringify(trustMod)};
import { withExclusiveFileLock } from ${JSON.stringify(lockMod)};
const file = process.argv[2];
const path = process.argv[3];
const store = await TrustStore.load({
  load: async () => JSON.parse(await readFile(file, "utf8")),
  commit: async (mutations) => {
    await withExclusiveFileLock(file + ".lock", {}, async () => {
      const current = JSON.parse(await readFile(file, "utf8"));
      const tmp = file + ".tmp";
      await writeFile(tmp, JSON.stringify({ ...current, ...mutations }));
      await rename(tmp, file);
    });
  },
});
store.setTrusted(path, 1);
await store.flush();
`,
    )
    const repoRoot = join(import.meta.dir, "../../../..")
    const spawnGrant = (path: string) =>
      Bun.spawn(["bun", script, file, path], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" })
    const a = spawnGrant("/proj-a")
    const b = spawnGrant("/proj-b")
    const [aCode, bCode] = await Promise.all([a.exited, b.exited])
    if (aCode !== 0 || bCode !== 0) {
      throw new Error(
        `grant workers: a=${aCode} ${await new Response(a.stderr).text()} b=${bCode} ${await new Response(b.stderr).text()}`,
      )
    }
    const saved = JSON.parse(await readFile(file, "utf8")) as Record<string, TrustRecord>
    expect(saved["/proj-a"]?.trusted).toBe(true)
    expect(saved["/proj-b"]?.trusted).toBe(true)
  })

  test("commit refuses to clobber a malformed trust file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "r02-f12-malformed-"))
    const file = join(dir, "trust.json")
    const broken = '{"/kept": {"trusted": true, "grantedAt": 1}'
    await writeFile(file, broken)
    const persist = makeTrustPersistence(file)
    await expect(persist.commit({ "/new": { trusted: true, grantedAt: 2 } })).rejects.toBeDefined()
    expect(await readFile(file, "utf8")).toBe(broken)
  })
})

describe("F-13 atomic writer", () => {
  test("persist-atomic has no EXDEV copyFile success path", () => {
    const src = readFileSync(
      join(import.meta.dir, "../../../../src/migration/external-config/persist-atomic.ts"),
      "utf8",
    )
    expect(src.includes("copyFile")).toBe(false)
  })

  test("two OS processes union distinct memory appends", async () => {
    const home = await mkdtemp(join(tmpdir(), "r02-f132-mem-"))
    const persistPath = join(
      import.meta.dir,
      "../../../../src/migration/external-config/persist.ts",
    )
    const script = join(home, "worker.ts")
    await writeFile(
      script,
      `import { persistConvertedItems } from ${JSON.stringify(persistPath)};
const homeDir = process.argv[2];
const sourcePath = process.argv[3];
const body = process.argv[4];
const r = await persistConvertedItems({
  enabled: true,
  homeDir,
  projectDir: homeDir,
  converted: [{ type: "memory", ok: true, value: { sourcePath, body } }],
});
if (!r.writtenTypes.includes("memory")) process.exit(2);
`,
    )
    const repoRoot = join(import.meta.dir, "../../../..")
    const spawnMem = (sourcePath: string, body: string) =>
      Bun.spawn(["bun", script, home, sourcePath, body], {
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "pipe",
      })
    const a = spawnMem("/mem-a.md", "BODY-A")
    const b = spawnMem("/mem-b.md", "BODY-B")
    const [aCode, bCode] = await Promise.all([a.exited, b.exited])
    if (aCode !== 0 || bCode !== 0) {
      throw new Error(
        `memory workers: a=${aCode} ${await new Response(a.stderr).text()} b=${bCode} ${await new Response(b.stderr).text()}`,
      )
    }
    const raw = await readFile(join(home, ".quanta", "memory", "raw_memories.md"), "utf8")
    expect(raw).toContain("<!-- quanta-imported-memory: /mem-a.md -->")
    expect(raw).toContain("BODY-A")
    expect(raw).toContain("<!-- quanta-imported-memory: /mem-b.md -->")
    expect(raw).toContain("BODY-B")
  })

  test("persistMemory does not clobber bytes after a non-ENOENT read failure", async () => {
    const home = await mkdtemp(join(tmpdir(), "r02-f132-eacces-"))
    const dir = join(home, ".quanta", "memory")
    await mkdir(dir, { recursive: true })
    const rawPath = join(dir, "raw_memories.md")
    const original = "KEEP-EXISTING-MEMORY\n"
    await writeFile(rawPath, original)
    await chmod(rawPath, 0o200)
    try {
      const r = await persistConvertedItems({
        enabled: true,
        homeDir: home,
        projectDir: home,
        converted: [{ type: "memory", ok: true, value: { sourcePath: "/x.md", body: "NEW" } }],
      })
      expect(r.persisted).toBe(false)
      expect(r.warnings.length).toBeGreaterThan(0)
    } finally {
      await chmod(rawPath, 0o644)
    }
    expect(await readFile(rawPath, "utf8")).toBe(original)
  })
})

describe("W0.3 flock live holder", () => {
  test("child kill releases lock; live holder is not stolen", async () => {
    const dir = await mkdtemp(join(tmpdir(), "r02-flock-"))
    const lockPath = join(dir, "res.lock")
    const holderPath = join(
      import.meta.dir,
      "../../../../src/auth/file-transaction/exclusive-lock.ts",
    )
    const script = join(dir, "holder.ts")
    await writeFile(
      script,
      `import { withExclusiveFileLock } from ${JSON.stringify(holderPath)};
const lockPath = process.argv[2];
await withExclusiveFileLock(lockPath, {}, async () => {
  process.stdout.write("HELD\\n");
  await Bun.sleep(20_000);
});
`,
    )
    const holder = Bun.spawn(["bun", script, lockPath], { stdout: "pipe", stderr: "pipe" })
    const reader = holder.stdout.getReader()
    const dec = new TextDecoder()
    let buf = ""
    const start = Date.now()
    while (Date.now() - start < 5000) {
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value)
      if (buf.includes("HELD")) break
    }
    expect(buf).toContain("HELD")
    let stolen = false
    try {
      await withExclusiveFileLock(lockPath, { timeoutMs: 200 }, async () => {
        stolen = true
      })
    } catch {
      stolen = false
    }
    expect(stolen).toBe(false)
    holder.kill("SIGKILL")
    await holder.exited
    let acquired = false
    await withExclusiveFileLock(lockPath, { timeoutMs: 2000 }, async () => {
      acquired = true
    })
    expect(acquired).toBe(true)
  })
})
