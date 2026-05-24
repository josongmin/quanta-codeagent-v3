/**
 * `/snapshot` (ADR-0122 shadow-store CLI surface) hellgate.
 *
 * Naming: the task asked for `/rewind`; the existing `/rewind` command rewinds
 * the SESSION TRANSCRIPT (Claude Code v1.7196 pattern) and is locked in by
 * `tests/unit/cli/rewind-cmd.test.ts`. Registering a second `/rewind` would
 * silently shadow it via `BUILTINS_BY_NAME` (last-write-wins Map) — so the
 * shadow-store UX was registered as `/snapshot`. This battery seals BOTH
 * the surface contract AND the naming decision (case 0).
 *
 * Cases lifted from the task spec:
 *   1. no shadowOdb → "not configured" + exit 0.
 *   2. empty store → "(no snapshots)".
 *   3. N snapshots → numbered list (sha + ts + ref).
 *   4. /snapshot 1 --yes → rewindToLast invoked.
 *   5. /snapshot 1 src/foo.ts --yes → restorePartial invoked with that path.
 *   6. /snapshot diff 1 → diff preview (delegates to diffSinceLast).
 *   6b. /snapshot diff 2 → documented deferral (port lacks diffSinceRef).
 *   7. /snapshot 999 → graceful out-of-range error.
 *   8. /snapshot --target=verified 1 --yes → rewindToVerified.
 *   plus: argv hellgate (bad ordinal, bad target, too many args, --yes gate).
 */

import { describe, expect, test } from "bun:test"
import { runSlashCommand, type SlashContext } from "../../src/apps/cli/slash-commands"
import {
  __test,
  parseSnapshotArgs,
  pickByOrdinal,
  renderSnapshotList,
  snapshotCmd,
} from "../../src/apps/cli/snapshot-cmd"
import {
  type RewindOptions,
  type ShadowInitResult,
  type ShadowOdb,
  ShadowOdbError,
  type SnapshotMetadata,
} from "../../src/storage/shadow-odb"

/* ------------------------------------------------------------------ */
/* test scaffolding                                                    */
/* ------------------------------------------------------------------ */

interface CallLog {
  rewindToLast: { cwd: string; opts: RewindOptions | undefined }[]
  rewindToVerified: { cwd: string; opts: RewindOptions | undefined }[]
  restorePartial: { cwd: string; paths: readonly string[]; opts: RewindOptions | undefined }[]
  diffSinceLast: { cwd: string }[]
  listSnapshots: { cwd: string }[]
}

const emptyLog = (): CallLog => ({
  rewindToLast: [],
  rewindToVerified: [],
  restorePartial: [],
  diffSinceLast: [],
  listSnapshots: [],
})

/** Build a `ShadowOdb` fake that records every call. `snaps` controls the
 *  list response; `diff` controls the diffSinceLast response. */
const buildOdb = (opts: {
  snaps?: readonly SnapshotMetadata[]
  diff?: string
  listThrows?: unknown
  rewindThrows?: unknown
  log: CallLog
}): ShadowOdb => ({
  init: async (_root): Promise<ShadowInitResult> => ({
    shadowDir: "/fake",
    workspaceHash: "0".repeat(16),
  }),
  registerHead: async () => "0".repeat(40),
  diffSinceLast: async (cwd) => {
    opts.log.diffSinceLast.push({ cwd })
    return opts.diff ?? ""
  },
  diffWorkspaceSinceLast: async () => "",
  rewindToLast: async (cwd, o) => {
    if (opts.rewindThrows !== undefined) throw opts.rewindThrows
    opts.log.rewindToLast.push({ cwd, opts: o })
  },
  listSnapshots: async (cwd) => {
    opts.log.listSnapshots.push({ cwd })
    if (opts.listThrows !== undefined) throw opts.listThrows
    return opts.snaps ?? []
  },
  cleanup: async () => 0,
  restorePartial: async (cwd, paths, o) => {
    opts.log.restorePartial.push({ cwd, paths, opts: o })
  },
  markVerified: async () => {
    /* no-op */
  },
  rewindToVerified: async (cwd, o) => {
    opts.log.rewindToVerified.push({ cwd, opts: o })
  },
})

interface Cap {
  out: string
  err: string
  ctx: SlashContext
}

const buildCtx = (odb?: ShadowOdb): Cap => {
  const c: Cap = {
    out: "",
    err: "",
    ctx: {
      out: (s) => {
        c.out += s
      },
      err: (s) => {
        c.err += s
      },
      cwd: "/tmp/fake-cwd",
      ...(odb !== undefined ? { shadowOdb: odb } : {}),
    },
  }
  return c
}

const mkSnap = (i: number): SnapshotMetadata => ({
  ref: `refs/quanta/snapshots/test-${i}`,
  sha: `${i.toString().padStart(2, "0")}deadbeef${"f".repeat(28)}`,
  timestampSec: 1_700_000_000 + i * 60,
})

/* ------------------------------------------------------------------ */
/* registration + naming hellgate                                      */
/* ------------------------------------------------------------------ */

describe("/snapshot registration", () => {
  test("registered with the documented metadata + category", () => {
    expect(snapshotCmd.name).toBe("/snapshot")
    expect(snapshotCmd.category).toBe("session")
    expect(snapshotCmd.describe.toLowerCase()).toContain("snapshot")
  })

  test("does NOT shadow the existing /rewind command (naming decision lock)", async () => {
    // `/rewind` resolves to a DIFFERENT command (session-transcript rewind).
    // It prints `/rewind: no active session` when ctx.rewindSession is absent
    // — proves the shadow-store handler didn't capture the name.
    const c = buildCtx(buildOdb({ log: emptyLog() }))
    const code = await runSlashCommand("/rewind", c.ctx)
    expect(code).toBe(1)
    expect(c.err).toContain("/rewind:")
    expect(c.err).not.toContain("/snapshot:")
  })
})

/* ------------------------------------------------------------------ */
/* default-OFF                                                         */
/* ------------------------------------------------------------------ */

describe("/snapshot default-OFF", () => {
  test("case 1: no shadowOdb ⇒ 'not configured' + exit 0", async () => {
    const c = buildCtx() // no odb
    const code = await runSlashCommand("/snapshot", c.ctx)
    expect(code).toBe(0)
    expect(c.out).toContain("shadow store not configured")
    expect(c.err).toBe("")
  })
})

/* ------------------------------------------------------------------ */
/* list                                                                */
/* ------------------------------------------------------------------ */

describe("/snapshot list", () => {
  test("case 2: empty store ⇒ '(no snapshots)'", async () => {
    const log = emptyLog()
    const c = buildCtx(buildOdb({ snaps: [], log }))
    const code = await runSlashCommand("/snapshot", c.ctx)
    expect(code).toBe(0)
    expect(c.out).toContain("(no snapshots)")
    expect(log.listSnapshots.length).toBe(1)
    expect(log.listSnapshots[0]?.cwd).toBe("/tmp/fake-cwd")
  })

  test("case 3: N snapshots ⇒ numbered list with sha + ts + ref", async () => {
    const snaps = [mkSnap(3), mkSnap(2), mkSnap(1)] // newest-first per port
    const log = emptyLog()
    const c = buildCtx(buildOdb({ snaps, log }))
    expect(await runSlashCommand("/snapshot", c.ctx)).toBe(0)
    expect(c.out).toContain("3 snapshots:")
    expect(c.out).toContain("  1. 03deadbeeff")
    expect(c.out).toContain("  2. 02deadbeeff")
    expect(c.out).toContain("  3. 01deadbeeff")
    // ISO-Z form, ms stripped.
    expect(c.out).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/)
    expect(c.out).toContain("refs/quanta/snapshots/test-3")
  })

  test("renderSnapshotList is pure", () => {
    expect(renderSnapshotList([])).toBe("(no snapshots)\n")
    const out = renderSnapshotList([mkSnap(1)])
    expect(out).toContain("1 snapshot:")
    expect(out).toContain("01deadbeeff")
  })
})

/* ------------------------------------------------------------------ */
/* rewind (case 4 + --yes gate + --target=verified case 8)             */
/* ------------------------------------------------------------------ */

describe("/snapshot <N>", () => {
  test("without --yes ⇒ confirm preview, NO mutation", async () => {
    const log = emptyLog()
    const c = buildCtx(buildOdb({ snaps: [mkSnap(1)], log }))
    expect(await runSlashCommand("/snapshot 1", c.ctx)).toBe(0)
    expect(c.out).toContain("[rewind:")
    expect(c.out).toContain("re-run with --yes")
    expect(log.rewindToLast.length).toBe(0)
    expect(log.rewindToVerified.length).toBe(0)
  })

  test("case 4: /snapshot 1 --yes ⇒ rewindToLast invoked", async () => {
    const log = emptyLog()
    const c = buildCtx(buildOdb({ snaps: [mkSnap(1), mkSnap(2)], log }))
    expect(await runSlashCommand("/snapshot 1 --yes", c.ctx)).toBe(0)
    expect(log.rewindToLast.length).toBe(1)
    expect(log.rewindToLast[0]?.cwd).toBe("/tmp/fake-cwd")
    expect(log.rewindToVerified.length).toBe(0)
    expect(c.out).toContain("rewound to #1")
  })

  test("case 7: /snapshot 999 ⇒ graceful out-of-range error", async () => {
    const log = emptyLog()
    const c = buildCtx(buildOdb({ snaps: [mkSnap(1)], log }))
    const code = await runSlashCommand("/snapshot 999 --yes", c.ctx)
    expect(code).toBe(1)
    expect(c.err).toContain("out of range")
    expect(c.err).toContain("have 1 snapshot")
    expect(log.rewindToLast.length).toBe(0)
  })

  test("case 8: /snapshot --target=verified 1 --yes ⇒ rewindToVerified", async () => {
    const log = emptyLog()
    const c = buildCtx(buildOdb({ snaps: [mkSnap(1)], log }))
    expect(await runSlashCommand("/snapshot --target=verified 1 --yes", c.ctx)).toBe(0)
    expect(log.rewindToVerified.length).toBe(1)
    expect(log.rewindToLast.length).toBe(0)
  })

  test("typed ShadowOdbError surfaces with <code>: <message>", async () => {
    const log = emptyLog()
    const c = buildCtx(
      buildOdb({
        snaps: [mkSnap(1)],
        rewindThrows: new ShadowOdbError("merge-in-progress", "abort merge first"),
        log,
      }),
    )
    const code = await runSlashCommand("/snapshot 1 --yes", c.ctx)
    expect(code).toBe(1)
    expect(c.err).toContain("merge-in-progress: abort merge first")
  })
})

/* ------------------------------------------------------------------ */
/* restore-partial (case 5)                                            */
/* ------------------------------------------------------------------ */

describe("/snapshot <N> <file>", () => {
  test("case 5: /snapshot 1 src/foo.ts --yes ⇒ restorePartial with that path", async () => {
    const log = emptyLog()
    const c = buildCtx(buildOdb({ snaps: [mkSnap(1)], log }))
    expect(await runSlashCommand("/snapshot 1 src/foo.ts --yes", c.ctx)).toBe(0)
    expect(log.restorePartial.length).toBe(1)
    expect(log.restorePartial[0]?.paths).toEqual(["src/foo.ts"])
    expect(c.out).toContain("restored src/foo.ts from #1")
  })

  test("without --yes ⇒ confirm preview, NO mutation", async () => {
    const log = emptyLog()
    const c = buildCtx(buildOdb({ snaps: [mkSnap(1)], log }))
    expect(await runSlashCommand("/snapshot 1 src/foo.ts", c.ctx)).toBe(0)
    expect(c.out).toContain("[restore-partial:")
    expect(c.out).toContain("file: src/foo.ts")
    expect(log.restorePartial.length).toBe(0)
  })

  test("--target=verified partial restore ⇒ no-verified-anchor (v1 restriction)", async () => {
    const log = emptyLog()
    const c = buildCtx(buildOdb({ snaps: [mkSnap(1)], log }))
    const code = await runSlashCommand("/snapshot --target=verified 1 src/foo.ts --yes", c.ctx)
    expect(code).toBe(1)
    expect(c.err).toContain("no-verified-anchor")
    expect(log.restorePartial.length).toBe(0)
  })
})

/* ------------------------------------------------------------------ */
/* diff (case 6)                                                       */
/* ------------------------------------------------------------------ */

describe("/snapshot diff <N>", () => {
  test("case 6: /snapshot diff 1 ⇒ diff preview from diffSinceLast", async () => {
    const log = emptyLog()
    const c = buildCtx(
      buildOdb({ snaps: [mkSnap(1)], diff: "--- a/x\n+++ b/x\n@@\n-old\n+new\n", log }),
    )
    expect(await runSlashCommand("/snapshot diff 1", c.ctx)).toBe(0)
    expect(c.out).toContain("--- a/x")
    expect(c.out).toContain("+new")
    expect(log.diffSinceLast.length).toBe(1)
  })

  test("case 6: diff 1 with no changes ⇒ friendly clean-tree message", async () => {
    const log = emptyLog()
    const c = buildCtx(buildOdb({ snaps: [mkSnap(1)], diff: "", log }))
    expect(await runSlashCommand("/snapshot diff 1", c.ctx)).toBe(0)
    expect(c.out).toContain("no changes")
  })

  test("case 6b: diff <N> for N>1 ⇒ documented deferral (port lacks diffSinceRef)", async () => {
    const log = emptyLog()
    const c = buildCtx(buildOdb({ snaps: [mkSnap(1), mkSnap(2)], log }))
    expect(await runSlashCommand("/snapshot diff 2", c.ctx)).toBe(0)
    expect(c.out).toContain("only #1")
    expect(c.out).toContain("follow-up")
    expect(log.diffSinceLast.length).toBe(0)
  })
})

/* ------------------------------------------------------------------ */
/* argv hellgate                                                       */
/* ------------------------------------------------------------------ */

describe("parseSnapshotArgs", () => {
  test("no args ⇒ list", () => {
    expect(parseSnapshotArgs([])).toEqual({ kind: "list" })
  })

  test("/snapshot 3 ⇒ rewind ordinal=3 target=last yes=false", () => {
    expect(parseSnapshotArgs(["3"])).toEqual({
      kind: "rewind",
      ordinal: 3,
      target: "last",
      yes: false,
    })
  })

  test("/snapshot 3 --yes ⇒ yes=true", () => {
    const r = parseSnapshotArgs(["3", "--yes"])
    expect(r.kind === "rewind" && r.yes).toBe(true)
  })

  test("/snapshot --target=verified 3 ⇒ target=verified", () => {
    const r = parseSnapshotArgs(["--target=verified", "3"])
    expect(r.kind === "rewind" && r.target === "verified").toBe(true)
  })

  test("/snapshot 3 src/foo.ts ⇒ restore-partial", () => {
    expect(parseSnapshotArgs(["3", "src/foo.ts"])).toEqual({
      kind: "restore-partial",
      ordinal: 3,
      path: "src/foo.ts",
      target: "last",
      yes: false,
    })
  })

  test("/snapshot diff 2 ⇒ diff", () => {
    expect(parseSnapshotArgs(["diff", "2"])).toEqual({ kind: "diff", ordinal: 2 })
  })

  test("invalid ordinal (zero / negative / non-int) ⇒ err", () => {
    expect(parseSnapshotArgs(["0"]).kind).toBe("err")
    expect(parseSnapshotArgs(["-1"]).kind).toBe("err")
    expect(parseSnapshotArgs(["1.5"]).kind).toBe("err")
    expect(parseSnapshotArgs(["abc"]).kind).toBe("err")
  })

  test("invalid --target ⇒ err", () => {
    const r = parseSnapshotArgs(["--target=bogus", "1"])
    expect(r.kind).toBe("err")
    if (r.kind === "err") expect(r.message).toContain("invalid --target")
  })

  test("unknown flag ⇒ err", () => {
    const r = parseSnapshotArgs(["--bogus"])
    expect(r.kind).toBe("err")
    if (r.kind === "err") expect(r.message).toContain("unknown flag")
  })

  test("too many positional args ⇒ err", () => {
    const r = parseSnapshotArgs(["1", "a.ts", "b.ts"])
    expect(r.kind).toBe("err")
  })

  test("diff without ordinal ⇒ err", () => {
    const r = parseSnapshotArgs(["diff"])
    expect(r.kind).toBe("err")
  })

  test("diff with non-int ordinal ⇒ err", () => {
    const r = parseSnapshotArgs(["diff", "x"])
    expect(r.kind).toBe("err")
  })
})

describe("pickByOrdinal", () => {
  test("1-based hit", () => {
    const r = pickByOrdinal([mkSnap(1), mkSnap(2)], 2)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.snap.ref).toBe("refs/quanta/snapshots/test-2")
  })

  test("out of range ⇒ structured error", () => {
    const r = pickByOrdinal([mkSnap(1)], 99)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.err).toContain("out of range")
  })

  test("ordinal 0 ⇒ out of range", () => {
    const r = pickByOrdinal([mkSnap(1)], 0)
    expect(r.ok).toBe(false)
  })

  test("empty list ⇒ out of range with `0 snapshots`", () => {
    const r = pickByOrdinal([], 1)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.err).toContain("0 snapshots")
  })
})

describe("__test pure helpers", () => {
  test("parseOrdinal", () => {
    expect(__test.parseOrdinal("3")).toBe(3)
    expect(__test.parseOrdinal("0")).toBeNull()
    expect(__test.parseOrdinal("1.5")).toBeNull()
    expect(__test.parseOrdinal("abc")).toBeNull()
    expect(__test.parseOrdinal("")).toBeNull()
  })

  test("shortSha caps at 12", () => {
    expect(__test.shortSha("abcdef")).toBe("abcdef")
    expect(__test.shortSha("0123456789abcdef")).toBe("0123456789ab")
  })

  test("fmtTs is deterministic + ms-stripped", () => {
    expect(__test.fmtTs(1_700_000_000)).toBe("2023-11-14T22:13:20Z")
  })
})

/* ------------------------------------------------------------------ */
/* listSnapshots error surfacing                                       */
/* ------------------------------------------------------------------ */

describe("/snapshot error surfaces", () => {
  test("listSnapshots throws ShadowOdbError ⇒ <code>: <msg> on err + exit 1", async () => {
    const log = emptyLog()
    const c = buildCtx(
      buildOdb({
        listThrows: new ShadowOdbError("uninitialized", "shadow store not initialized"),
        log,
      }),
    )
    const code = await runSlashCommand("/snapshot", c.ctx)
    expect(code).toBe(1)
    expect(c.err).toContain("uninitialized: shadow store not initialized")
  })

  test("non-ShadowOdbError on listSnapshots bubbles (programmer-bug convention)", async () => {
    const log = emptyLog()
    const c = buildCtx(
      buildOdb({
        listThrows: new TypeError("unexpected"),
        log,
      }),
    )
    let caught: unknown
    try {
      await runSlashCommand("/snapshot", c.ctx)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(TypeError)
  })
})
