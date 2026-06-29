import { describe, expect, it } from "bun:test"
import type { SpawnFn, SpawnResult } from "../../src/apps/bench/remote/backend"
import {
  buildConfigRsyncArgs,
  buildSrcRsyncArgs,
  CONFIG_FILES,
  configDriftNeedsInstall,
  describeSrcSync,
  ensureBoxConfigCurrent,
  ensureBoxSrcCurrent,
  parseItemizedDeletions,
  parseItemizedTransfers,
  SRC_RSYNC_EXCLUDES,
} from "../../src/apps/bench/remote/box-session/src-sync-guard"

const SSH = "ssh -i /k.pem -o X"

describe("buildSrcRsyncArgs", () => {
  it("with NO opts is byte-identical to the historical bootstrap rsync argv", () => {
    expect(buildSrcRsyncArgs("/repo", "ubuntu@h", SSH)).toEqual([
      "-az",
      "--partial",
      "--exclude",
      "node_modules",
      "--exclude",
      "*.js",
      "--exclude",
      "*.test.ts",
      "--exclude",
      ".quanta",
      "-e",
      SSH,
      "/repo/src/",
      "ubuntu@h:~/quanta/src/",
    ])
  })

  it("checksum forces content compare; itemize surfaces transfers; del removes orphans", () => {
    const args = buildSrcRsyncArgs("/repo", "ubuntu@h", SSH, {
      checksum: true,
      itemize: true,
      del: true,
    })
    expect(args).toContain("--checksum")
    expect(args).toContain("--itemize-changes")
    expect(args).toContain("--delete")
    for (const ex of SRC_RSYNC_EXCLUDES) expect(args).toContain(ex)
    expect(args.at(-2)).toBe("/repo/src/")
    expect(args.at(-1)).toBe("ubuntu@h:~/quanta/src/")
  })

  it("does NOT add checksum/itemize/delete unless explicitly opted in (default-off)", () => {
    const args = buildSrcRsyncArgs("/repo", "ubuntu@h", SSH, {})
    expect(args).not.toContain("--checksum")
    expect(args).not.toContain("--itemize-changes")
    expect(args).not.toContain("--delete")
  })

  it("SSOT: seed-sync (no opts) and reuse self-heal share the SAME excludes + src/dst", () => {
    // The stale-code guard's whole correctness rests on the seed-sync (bootstrap)
    // and the verify-sync (reuse) shipping the identical file set. If they ever
    // diverge, a reused box could ship/exclude different files than its seed.
    const seed = buildSrcRsyncArgs("/repo", "ubuntu@h", SSH)
    const heal = buildSrcRsyncArgs("/repo", "ubuntu@h", SSH, {
      checksum: true,
      itemize: true,
      del: true,
    })
    const stripFlags = (a: string[]) => a.filter((x) => !x.startsWith("--checksum") && !x.startsWith("--itemize") && x !== "--delete")
    expect(stripFlags(heal)).toEqual(seed)
  })
})

describe("parseItemizedTransfers", () => {
  it("returns ONLY content-file transfers (send/recv/create), not dirs/attrs/deletes", () => {
    const out = [
      "sending incremental file list",
      "cd+++++++++ apps/bench/", // directory create — ignore
      ">f+++++++++ apps/bench/python-swebench.ts", // new file — COUNT
      ">f.st...... runner/batch/eval/driver.ts", // content change — COUNT
      ".f...p..... runner/batch/eval/gold-sanity.ts", // attr-only — ignore
      "*deleting   apps/bench/old.ts", // deletion — NOT a transfer
      "<f+++++++++ shared/recv.ts", // receive — COUNT (defensive)
      "",
      "sent 1,234 bytes  received 56 bytes",
    ].join("\n")
    expect(parseItemizedTransfers(out)).toEqual([
      "apps/bench/python-swebench.ts",
      "runner/batch/eval/driver.ts",
      "shared/recv.ts",
    ])
  })

  it("a CURRENT box (no transfer lines) parses to ZERO — the no-op signal", () => {
    const out = ["sending incremental file list", "", "sent 100 bytes  received 12 bytes"].join(
      "\n",
    )
    expect(parseItemizedTransfers(out)).toEqual([])
  })

  it("handles paths with spaces", () => {
    expect(parseItemizedTransfers(">f+++++++++ dir/a b c.ts")).toEqual(["dir/a b c.ts"])
  })
})

describe("parseItemizedDeletions", () => {
  it("extracts ONLY *deleting orphans (not transfers/dirs), trims trailing slash", () => {
    const out = [
      ">f+++++++++ apps/bench/new.ts", // transfer — NOT a deletion
      "*deleting   apps/bench/removed.ts",
      "*deleting   apps/bench/deadcode/", // dir orphan — slash trimmed
      "cd+++++++++ apps/bench/",
    ].join("\n")
    expect(parseItemizedDeletions(out)).toEqual(["apps/bench/removed.ts", "apps/bench/deadcode"])
  })

  it("a box with no orphans parses to ZERO", () => {
    expect(parseItemizedDeletions(">f+++++++++ a.ts\nsent 10 bytes")).toEqual([])
  })
})

describe("describeSrcSync", () => {
  it("is undefined when current (no false self-heal noise)", () => {
    expect(describeSrcSync({ wasStale: false, transferred: [], deleted: [] })).toBeUndefined()
  })
  it("names synced files and truncates past 8 with +N more", () => {
    const files = Array.from({ length: 10 }, (_, i) => `f${i}.ts`)
    const msg = describeSrcSync({ wasStale: true, transferred: files, deleted: [] }) ?? ""
    expect(msg).toContain("STALE")
    expect(msg).toContain("synced 10 file(s)")
    expect(msg).toContain("f0.ts")
    expect(msg).toContain("(+2 more)")
    expect(msg).not.toContain("f9.ts") // truncated
  })
  it("reports DELETED orphans distinctly from synced files", () => {
    const msg =
      describeSrcSync({ wasStale: true, transferred: ["a.ts"], deleted: ["old.ts", "dead.ts"] }) ??
      ""
    expect(msg).toContain("synced 1 file(s): a.ts")
    expect(msg).toContain("removed 2 orphan(s): old.ts, dead.ts")
  })
})

// ── wiring: ensureBoxSrcCurrent drives a checksum+delete rsync via injected spawn ──

const fakeSpawn = (res: SpawnResult, sink: { cmd?: string; args?: readonly string[] }): SpawnFn => {
  return async (cmd, args) => {
    sink.cmd = cmd
    sink.args = args
    return res
  }
}

describe("ensureBoxSrcCurrent (wiring)", () => {
  const base = { repoDir: "/repo", host: "ubuntu@h", keyPath: "/k.pem" }

  it("STALE box → checksum+itemize+delete rsync, reports wasStale + files, logs", async () => {
    const sink: { cmd?: string; args?: readonly string[] } = {}
    const logs: string[] = []
    const spawn = fakeSpawn(
      { code: 0, stdout: ">f.st...... apps/bench/python-swebench.ts\n", stderr: "" },
      sink,
    )
    const out = await ensureBoxSrcCurrent({ ...base, spawn, log: (m) => logs.push(m) })
    expect(sink.cmd).toBe("rsync")
    expect(sink.args).toContain("--checksum")
    expect(sink.args).toContain("--itemize-changes")
    expect(sink.args).toContain("--delete")
    expect(out.wasStale).toBe(true)
    expect(out.transferred).toEqual(["apps/bench/python-swebench.ts"])
    expect(logs.some((l) => l.includes("STALE") && l.includes("python-swebench.ts"))).toBe(true)
  })

  it("DELETION-only drift still counts as STALE (orphan removed from box)", async () => {
    const sink: { cmd?: string; args?: readonly string[] } = {}
    const logs: string[] = []
    const spawn = fakeSpawn(
      { code: 0, stdout: "*deleting   apps/bench/gone.ts\n", stderr: "" },
      sink,
    )
    const out = await ensureBoxSrcCurrent({ ...base, spawn, log: (m) => logs.push(m) })
    expect(out.wasStale).toBe(true)
    expect(out.transferred).toEqual([])
    expect(out.deleted).toEqual(["apps/bench/gone.ts"])
    expect(logs.some((l) => l.includes("removed 1 orphan(s)"))).toBe(true)
  })

  it("CURRENT box → wasStale false, NO log noise (idempotent no-op)", async () => {
    const sink: { cmd?: string; args?: readonly string[] } = {}
    const logs: string[] = []
    const spawn = fakeSpawn(
      { code: 0, stdout: "sending incremental file list\n", stderr: "" },
      sink,
    )
    const out = await ensureBoxSrcCurrent({ ...base, spawn, log: (m) => logs.push(m) })
    expect(out.wasStale).toBe(false)
    expect(out.transferred).toEqual([])
    expect(out.deleted).toEqual([])
    expect(logs).toEqual([])
  })

  it("rsync FAILURE throws (a box whose src cannot be verified MUST NOT grade)", async () => {
    const sink: { cmd?: string; args?: readonly string[] } = {}
    const spawn = fakeSpawn({ code: 23, stdout: "", stderr: "partial transfer" }, sink)
    await expect(ensureBoxSrcCurrent({ ...base, spawn, log: () => {} })).rejects.toThrow(
      /src self-heal rsync failed \(code 23\)/,
    )
  })
})

// ── config self-heal: re-sync build config + reinstall on dep-graph drift ──

describe("buildConfigRsyncArgs", () => {
  it("ships every config file with checksum+itemize to ~/quanta/", () => {
    const args = buildConfigRsyncArgs("/repo", "ubuntu@h", SSH)
    expect(args).toContain("--checksum")
    expect(args).toContain("--itemize-changes")
    for (const f of CONFIG_FILES) expect(args).toContain(`/repo/${f}`)
    expect(args.at(-1)).toBe("ubuntu@h:~/quanta/")
  })
})

describe("configDriftNeedsInstall", () => {
  it("package.json / bun.lock drift ⇒ reinstall", () => {
    expect(configDriftNeedsInstall(["package.json"])).toBe(true)
    expect(configDriftNeedsInstall(["bun.lock"])).toBe(true)
    expect(configDriftNeedsInstall(["tsconfig.json", "package.json"])).toBe(true)
  })
  it("tsconfig / bunfig-only drift ⇒ NO reinstall (re-sync suffices)", () => {
    expect(configDriftNeedsInstall(["tsconfig.json"])).toBe(false)
    expect(configDriftNeedsInstall(["bunfig.toml", "tsconfig.base.json"])).toBe(false)
    expect(configDriftNeedsInstall([])).toBe(false)
  })
})

describe("ensureBoxConfigCurrent (wiring)", () => {
  const base = { repoDir: "/repo", host: "ubuntu@h", keyPath: "/k.pem" }
  const recordingSsh = (code: number, sink: { cmd?: string }) => async (cmd: string) => {
    sink.cmd = cmd
    return { code, stderr: code === 0 ? "" : "install boom" }
  }

  it("CURRENT config → configStale false, NO install, NO log", async () => {
    const logs: string[] = []
    const sshSink: { cmd?: string } = {}
    const spawn = fakeSpawn({ code: 0, stdout: "sending incremental file list\n", stderr: "" }, {})
    const out = await ensureBoxConfigCurrent({
      ...base,
      spawn,
      ssh: recordingSsh(0, sshSink),
      log: (m) => logs.push(m),
    })
    expect(out.configStale).toBe(false)
    expect(out.reinstalled).toBe(false)
    expect(sshSink.cmd).toBeUndefined()
    expect(logs).toEqual([])
  })

  it("tsconfig drift → re-synced, but NO bun install (dep graph unchanged)", async () => {
    const logs: string[] = []
    const sshSink: { cmd?: string } = {}
    const spawn = fakeSpawn({ code: 0, stdout: ">f.st...... tsconfig.json\n", stderr: "" }, {})
    const out = await ensureBoxConfigCurrent({
      ...base,
      spawn,
      ssh: recordingSsh(0, sshSink),
      log: (m) => logs.push(m),
    })
    expect(out.configStale).toBe(true)
    expect(out.reinstalled).toBe(false)
    expect(sshSink.cmd).toBeUndefined() // install NOT triggered
    expect(logs.some((l) => l.includes("config was STALE"))).toBe(true)
  })

  it("package.json drift → re-synced AND bun install re-run", async () => {
    const logs: string[] = []
    const sshSink: { cmd?: string } = {}
    const spawn = fakeSpawn({ code: 0, stdout: ">f.st...... package.json\n", stderr: "" }, {})
    const out = await ensureBoxConfigCurrent({
      ...base,
      spawn,
      ssh: recordingSsh(0, sshSink),
      log: (m) => logs.push(m),
    })
    expect(out.configStale).toBe(true)
    expect(out.reinstalled).toBe(true)
    expect(sshSink.cmd).toContain("bun install")
  })

  it("bun install FAILURE throws (a box with a stale dep graph MUST NOT grade)", async () => {
    const spawn = fakeSpawn({ code: 0, stdout: ">f.st...... package.json\n", stderr: "" }, {})
    await expect(
      ensureBoxConfigCurrent({ ...base, spawn, ssh: recordingSsh(1, {}), log: () => {} }),
    ).rejects.toThrow(/config self-heal bun install failed \(code 1\)/)
  })

  it("config rsync FAILURE throws", async () => {
    const spawn = fakeSpawn({ code: 23, stdout: "", stderr: "boom" }, {})
    await expect(
      ensureBoxConfigCurrent({ ...base, spawn, ssh: recordingSsh(0, {}), log: () => {} }),
    ).rejects.toThrow(/config self-heal rsync failed \(code 23\)/)
  })
})
