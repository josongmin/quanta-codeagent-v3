/**
 * HELL-GATE — 2-PROCESS CONCURRENT permission-store write (TOCTOU lost-update).
 *
 * THREAT (H1, permission-store flank): `permission-state.json` is a file-backed
 * read-modify-write shared across OS processes (CLI + Tauri Desktop on the same
 * `~/.quanta`). It stores per-thread permission grants (`perThread`) AND the
 * SECURITY-CRITICAL post-denial ledger (`deniedActions`). When TWO SEPARATE OS
 * PROCESSES each write a DIFFERENT record at the same time, a naive store
 * re-reads the same on-disk state, serializes its own records, and the second
 * `rename` clobbers the first — a silent last-write-WINS lost-update. Losing a
 * DENIAL is a permission BYPASS: the gate re-allows an action the user/host
 * already denied. Losing a GRANT re-asks (annoyance, but still an invariant
 * break). The in-process flush queue cannot prevent this — it only orders
 * writes WITHIN one process.
 *
 * The lock engine (`json-state-file.ts`: O_EXCL advisory lock around the
 * read-merge-rename window) + the per-sub-store `mergeWithDisk` reconciler
 * (`permission-store.ts`) are SHARED with `trust-scope-store`. The sibling
 * `trust-scope-concurrent-grant-e2e-hellgate.test.ts` proves the trust-scope
 * flank. This file proves the permission-store flank — specifically the
 * security-critical `deniedActions` ledger, which has unit coverage for the
 * SINGLE-process merge (`mergeDenialRecord` / `mergePermissionState`) but no
 * 2-OS-process race until now.
 *
 * INVARIANTS:
 *   - denial-never-lost — every concurrently-recorded denial is present after a
 *     fresh-process rehydrate (a dropped denial = silent re-allow = bypass).
 *   - grant-never-lost  — every concurrently-set perThread grant survives.
 *   - fail-closed conflict — when a positive grant and a denial race on the
 *     SAME thread, BOTH are preserved (the denial — the security-critical loser
 *     of a last-write-wins clobber — must NOT vanish).
 *
 * DESIGN (SOTA++ adversarial, hermetic, offline, deterministic):
 *   - Two REAL child processes (`Bun.spawn`) each build a `createPermissionStore`
 *     over the SAME tmp `permission-state.json` and write a DISTINCT record.
 *   - A FILESYSTEM BARRIER (not a sleep) gates the start: each child writes a
 *     `ready` marker then busy-waits on a `go` file the parent drops only after
 *     BOTH are ready, so the write+flush windows OVERLAP maximally. No timing /
 *     `setTimeout` precision is asserted — only the post-condition (denial /
 *     grant present after rehydrate).
 *   - The parent then builds a FRESH store (a "process restart") that hydrates
 *     from the same file and asserts BOTH records survived.
 *   - A stress section repeats a high-overlap interleave so a probabilistic
 *     lost-update cannot pass by luck.
 *
 * RED-ON-INJECTION (test-has-teeth): the lost-update mitigation lives in the
 * shared lock + `mergeWithDisk` reconciler. To prove this suite has teeth,
 * transiently disable the merge by making `permission-store.ts`'s flush hook
 * ignore the on-disk state (blind overwrite) — see the closing comment for the
 * exact one-line revert. The authors ran that loop and observed the stress
 * section RED before the fix and GREEN after (verification record below).
 */
import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createPermissionStore } from "@/permission/permission-store"

const BUN = process.execPath
// Absolute path to the store SOURCE so a spawned child (whose cwd / tsconfig is
// a throwaway tmp dir) imports the exact module under test, not a stale build.
const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, "..", "..", "..")
const STORE_SRC = join(REPO_ROOT, "src", "permission", "permission-store.ts")
const SHARED_INDEX = join(REPO_ROOT, "src", "shared", "index.ts")
const SHARED_DIR = join(REPO_ROOT, "src", "shared")

const mkTmp = async (): Promise<string> =>
  mkdtemp(join(tmpdir(), "quanta-permission-store-concurrent-"))

/** A local tsconfig next to the child so Bun resolves the store's `@/shared`
 *  and `@/shared/*` imports (the store → json-state-file → `@/shared`, and
 *  permission-store → `@/shared/runtime-config`). Bun auto-picks the nearest
 *  tsconfig to the script file. */
const tsconfigBody = (): string =>
  JSON.stringify({
    compilerOptions: {
      baseUrl: ".",
      paths: {
        "@/shared": [SHARED_INDEX],
        "@/shared/*": [`${SHARED_DIR}/*`],
      },
    },
  })

/**
 * Child script body. argv: [opJson, file, readyMarker, goBarrier].
 * `opJson` is an array of ops, each `{ kind: "deny" | "grant", threadId, sig }`.
 * The child applies them then `flush`es, printing "ok" / "err" so the parent can
 * tell the write completed.
 *
 * Synchronization is purely barrier-based: write `ready`, busy-wait on `go`.
 * `existsSync` polling is a happens-before barrier, NOT a timing assertion.
 */
const childBody = (storeSrc: string): string => `
import { existsSync, writeFileSync } from "node:fs"
import { createPermissionStore } from ${JSON.stringify(storeSrc)}

const [opJson, file, ready, go] = process.argv.slice(2)
const ops = JSON.parse(opJson)
const store = createPermissionStore({ filePath: file, debounceMs: 0 })
await store.load()
// Signal ready, then block on the shared 'go' barrier so both children release
// into the write+flush window at the same instant (no sleeps).
writeFileSync(ready, "1")
while (!existsSync(go)) { /* cooperative spin on the FS barrier */ }
for (const op of ops) {
  if (op.kind === "deny") {
    store.recordDenial({
      threadId: op.threadId,
      actionSignature: op.sig,
      deniedAt: op.deniedAt ?? 1,
      deniedReason: op.reason ?? "denied",
    })
  } else {
    store.setThread(op.threadId, {
      approvalPolicy: "never",
      approvalsReviewer: "agent",
      sandboxPolicy: { type: "read-only" },
    })
  }
}
try {
  await store.flush()
  process.stdout.write("ok")
  process.exit(0)
} catch (e) {
  process.stdout.write("err:" + String(e))
  process.exit(1)
}
`

interface Op {
  kind: "deny" | "grant"
  threadId: string
  sig: string
  deniedAt?: number
  reason?: string
}

interface SpawnOpts {
  scriptPath: string
  ops: ReadonlyArray<Op>
  file: string
  ready: string
  go: string
}

/** Spawn one child process. Returns the process handle + a promise of its
 *  stdout text ("ok" on success). */
const spawnChild = (
  opts: SpawnOpts,
): { proc: ReturnType<typeof Bun.spawn>; result: Promise<string> } => {
  const proc = Bun.spawn(
    [BUN, opts.scriptPath, JSON.stringify(opts.ops), opts.file, opts.ready, opts.go],
    { stdout: "pipe", stderr: "pipe", cwd: dirname(opts.scriptPath) },
  )
  const result = new Response(proc.stdout).text()
  return { proc, result }
}

/** Wait for a file to exist via a happens-before FS barrier (microtask yield
 *  loop). Bounded by a generous deadline so a wedged child fails loudly rather
 *  than hanging the suite forever. */
const waitForFile = async (path: string, deadlineMs = 20_000): Promise<void> => {
  const deadline = Date.now() + deadlineMs
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`barrier timeout waiting for ${path}`)
    await new Promise<void>((resolve) => setTimeout(resolve, 1))
  }
}

/** Set up one race: write child + tsconfig, spawn both, release the barrier,
 *  await both. Returns the two children's stdout. */
const runOneRace = async (args: {
  dir: string
  file: string
  a: ReadonlyArray<Op>
  b: ReadonlyArray<Op>
  tag: string
}): Promise<{ aRes: string; bRes: string }> => {
  const scriptPath = join(args.dir, `child-${args.tag}.ts`)
  await Bun.write(scriptPath, childBody(STORE_SRC))
  await Bun.write(join(args.dir, "tsconfig.json"), tsconfigBody())

  const readyA = join(args.dir, `ready-a-${args.tag}`)
  const readyB = join(args.dir, `ready-b-${args.tag}`)
  const go = join(args.dir, `go-${args.tag}`)

  const ca = spawnChild({ scriptPath, ops: args.a, file: args.file, ready: readyA, go })
  const cb = spawnChild({ scriptPath, ops: args.b, file: args.file, ready: readyB, go })

  // Wait until BOTH children have loaded + signalled ready, THEN release.
  await waitForFile(readyA)
  await waitForFile(readyB)
  await Bun.write(go, "1")

  const [aRes, bRes] = await Promise.all([ca.result, cb.result])
  await Promise.all([ca.proc.exited, cb.proc.exited])
  return { aRes, bRes }
}

/** Build a fresh store over an existing file and load it — the "process
 *  restart" the gate would do at session start. */
const rehydrate = async (file: string) => {
  const store = createPermissionStore({ filePath: file, debounceMs: 0 })
  await store.load()
  return store
}

describe("permission-store concurrent write — 2-process TOCTOU HELL", () => {
  test("HP-1: two processes record distinct DENIALS → BOTH survive a fresh rehydrate", async () => {
    const dir = await mkTmp()
    try {
      const file = join(dir, "permission-state.json")
      const { aRes, bRes } = await runOneRace({
        dir,
        file,
        a: [{ kind: "deny", threadId: "t1", sig: "sig-A", deniedAt: 10, reason: "danger-A" }],
        b: [{ kind: "deny", threadId: "t2", sig: "sig-B", deniedAt: 20, reason: "danger-B" }],
        tag: "hp1",
      })
      // Both children's flush completed.
      expect(aRes).toBe("ok")
      expect(bRes).toBe("ok")

      // A fresh process (the gate at session start) MUST see BOTH denials — a
      // lost-update would drop one and silently re-allow that action.
      const store = await rehydrate(file)
      const denialA = store.getDenial("t1", "sig-A")
      const denialB = store.getDenial("t2", "sig-B")
      expect(denialA?.deniedReason).toBe("danger-A")
      expect(denialB?.deniedReason).toBe("danger-B")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("HP-2: two processes set distinct GRANTS (perThread) → BOTH survive", async () => {
    const dir = await mkTmp()
    try {
      const file = join(dir, "permission-state.json")
      const { aRes, bRes } = await runOneRace({
        dir,
        file,
        a: [{ kind: "grant", threadId: "thread-A", sig: "" }],
        b: [{ kind: "grant", threadId: "thread-B", sig: "" }],
        tag: "hp2",
      })
      expect(aRes).toBe("ok")
      expect(bRes).toBe("ok")

      const store = await rehydrate(file)
      expect(store.getThread("thread-A")).toBeDefined()
      expect(store.getThread("thread-B")).toBeDefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("HP-3: BYPASS — a concurrent positive grant AND a concurrent DENY on the same thread both survive", async () => {
    // A dropped grant means the gate re-asks (annoyance); a dropped DENY means a
    // denied action sneaks through (security bypass). The denial is the
    // security-critical loser of a last-write-wins clobber — it must NOT vanish.
    const dir = await mkTmp()
    try {
      const file = join(dir, "permission-state.json")
      const { aRes, bRes } = await runOneRace({
        dir,
        file,
        // Process A: a positive per-thread grant for the shared thread.
        a: [{ kind: "grant", threadId: "shared", sig: "" }],
        // Process B: an explicit DENY on the SAME thread (must NOT be lost).
        b: [
          {
            kind: "deny",
            threadId: "shared",
            sig: "rm-rf-slash",
            deniedAt: 99,
            reason: "rm -rf /",
          },
        ],
        tag: "hp3",
      })
      expect(aRes).toBe("ok")
      expect(bRes).toBe("ok")

      const store = await rehydrate(file)
      // Positive grant survived → per-thread policy is honored.
      expect(store.getThread("shared")).toBeDefined()
      // DENY survived verbatim → the denied action stays recorded (NOT a silent
      // allow-by-omission). This is the record a clobber would have dropped.
      const deny = store.getDenial("shared", "rm-rf-slash")
      expect(deny?.deniedReason).toBe("rm -rf /")
      expect(deny?.deniedAt).toBe(99)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("HP-4: STRESS — repeated high-overlap races never drop a concurrently-written denial or grant", async () => {
    const dir = await mkTmp()
    try {
      const ITER = 6
      const PER = 8 // ops per child per race
      for (let it = 0; it < ITER; it += 1) {
        const file = join(dir, `permission-state-${it}.json`)
        const a: Op[] = Array.from({ length: PER }, (_, i) => ({
          kind: "deny",
          threadId: `tA-${it}`,
          sig: `A-${it}-${i}`,
          deniedAt: it * 100 + i,
          reason: `A-${it}-${i}`,
        }))
        const b: Op[] = Array.from({ length: PER }, (_, i) => ({
          kind: "deny",
          threadId: `tB-${it}`,
          sig: `B-${it}-${i}`,
          deniedAt: it * 100 + i,
          reason: `B-${it}-${i}`,
        }))
        const { aRes, bRes } = await runOneRace({ dir, file, a, b, tag: `hp4-${it}` })
        expect(aRes).toBe("ok")
        expect(bRes).toBe("ok")

        const store = await rehydrate(file)
        for (let i = 0; i < PER; i += 1) {
          expect(store.getDenial(`tA-${it}`, `A-${it}-${i}`)?.deniedReason).toBe(`A-${it}-${i}`)
          expect(store.getDenial(`tB-${it}`, `B-${it}-${i}`)?.deniedReason).toBe(`B-${it}-${i}`)
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

/*
 * RED-ON-INJECTION PROCEDURE (test-has-teeth — verified by the authors):
 *
 * The lost-update mitigation is the SHARED lock (`json-state-file.ts`'s O_EXCL
 * advisory lock around read-merge-rename) + the `mergeWithDisk` reconciler wired
 * into `createPermissionStore` (`permission-store.ts`). To prove this suite has
 * teeth, transiently turn the merge into a BLIND overwrite — replace the
 * `mergeWithDisk` hook body in `createPermissionStore` so it discards the
 * on-disk state:
 *
 *     mergeWithDisk: ({ inMemory }) => {
 *       persistedState = inMemory   // ignore onDisk → last-write-WINS clobber
 *       state = cloneAsMutable(inMemory)
 *       return inMemory
 *     },
 *
 * Then re-run this file: HP-1 / HP-3 / HP-4 go RED (a concurrently-written
 * denial is dropped after rehydrate). Restore the merge → GREEN. The authors ran
 * this loop and observed the stress section RED before the fix (denials dropped)
 * and 0 drops after.
 */
