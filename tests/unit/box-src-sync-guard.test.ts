import { describe, expect, it } from "bun:test"
import type { SpawnFn, SpawnResult } from "../../src/apps/bench/remote/backend"
import {
  buildSrcRsyncArgs,
  describeSrcSync,
  ensureBoxSrcCurrent,
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

  it("checksum opt forces CONTENT compare; itemize opt surfaces transfers", () => {
    const args = buildSrcRsyncArgs("/repo", "ubuntu@h", SSH, { checksum: true, itemize: true })
    expect(args).toContain("--checksum")
    expect(args).toContain("--itemize-changes")
    // still excludes every SSOT path + ends with the same src→dst pair
    for (const ex of SRC_RSYNC_EXCLUDES) expect(args).toContain(ex)
    expect(args.at(-2)).toBe("/repo/src/")
    expect(args.at(-1)).toBe("ubuntu@h:~/quanta/src/")
  })

  it("does NOT add checksum/itemize unless explicitly opted in (default-off)", () => {
    const args = buildSrcRsyncArgs("/repo", "ubuntu@h", SSH, {})
    expect(args).not.toContain("--checksum")
    expect(args).not.toContain("--itemize-changes")
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
      "*deleting   apps/bench/old.ts", // deletion — ignore
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

describe("describeSrcSync", () => {
  it("is undefined when current (no false self-heal noise)", () => {
    expect(describeSrcSync({ wasStale: false, transferred: [] })).toBeUndefined()
  })
  it("names the stale files and truncates past 8 with a +N more", () => {
    const files = Array.from({ length: 10 }, (_, i) => `f${i}.ts`)
    const msg = describeSrcSync({ wasStale: true, transferred: files }) ?? ""
    expect(msg).toContain("self-healed 10 file(s)")
    expect(msg).toContain("f0.ts")
    expect(msg).toContain("(+2 more)")
    expect(msg).not.toContain("f9.ts") // truncated
  })
})

// ── wiring: ensureBoxSrcCurrent drives a checksum rsync via the injected spawn ──

const fakeSpawn = (res: SpawnResult, sink: { cmd?: string; args?: readonly string[] }): SpawnFn => {
  return async (cmd, args) => {
    sink.cmd = cmd
    sink.args = args
    return res
  }
}

describe("ensureBoxSrcCurrent (wiring)", () => {
  const base = { repoDir: "/repo", host: "ubuntu@h", keyPath: "/k.pem" }

  it("STALE box → issues a checksum+itemize rsync, reports wasStale + the files, logs", async () => {
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
    expect(out.wasStale).toBe(true)
    expect(out.transferred).toEqual(["apps/bench/python-swebench.ts"])
    expect(logs.some((l) => l.includes("STALE") && l.includes("self-healed 1"))).toBe(true)
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
    expect(logs).toEqual([])
  })

  it("rsync FAILURE throws (a box whose src cannot be verified MUST NOT grade)", async () => {
    const sink: { cmd?: string; args?: readonly string[] } = {}
    const spawn = fakeSpawn({ code: 23, stdout: "", stderr: "partial transfer" }, sink)
    await expect(ensureBoxSrcCurrent({ ...base, spawn, log: () => {} })).rejects.toThrow(
      /self-heal rsync failed \(code 23\)/,
    )
  })
})
