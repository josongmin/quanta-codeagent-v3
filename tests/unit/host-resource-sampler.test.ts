import { describe, expect, it } from "bun:test"
import {
  DEFAULT_RESOURCE_THRESHOLDS,
  evaluateResourceAlert,
  parseMemInfoMb,
  type ResourceSnapshot,
  startHostResourceSampler,
  summarizeProcNames,
} from "../../src/apps/bench/host-resource-sampler"

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

describe("parseMemInfoMb", () => {
  it("parses kB fields into MB; missing → 0", () => {
    const m = parseMemInfoMb(
      "MemTotal:       32000000 kB\nMemFree:  200000 kB\nMemAvailable: 250000 kB\nAnonPages: 30000000 kB\nShmem: 2048 kB\n",
    )
    expect(m.totalMb).toBe(31250)
    expect(m.availableMb).toBe(244)
    expect(m.anonMb).toBe(29297)
    expect(m.shmemMb).toBe(2)
    expect(parseMemInfoMb("").freeMb).toBe(0)
  })
})

describe("summarizeProcNames", () => {
  it("counts and ranks names descending (the fork-storm culprit is #1)", () => {
    const names = [...Array(4700).fill("uv"), "bun", "node", "node", "dockerd"]
    const s = summarizeProcNames(names, 3)
    expect(s.nproc).toBe(4704)
    expect(s.top[0]).toEqual({ name: "uv", count: 4700 })
    expect(s.top[1]).toEqual({ name: "node", count: 2 })
    expect(s.top.length).toBe(3)
  })
})

describe("evaluateResourceAlert", () => {
  const base: ResourceSnapshot = {
    mem: { totalMb: 32000, freeMb: 16000, availableMb: 16000, anonMb: 4000, shmemMb: 2 },
    procs: { nproc: 250, top: [{ name: "bun", count: 5 }] },
  }
  it("no alert when healthy", () => {
    expect(evaluateResourceAlert(base)).toBeNull()
  })
  it("alerts on the fork-storm and names the culprit", () => {
    const stormed: ResourceSnapshot = {
      mem: { totalMb: 32000, freeMb: 200, availableMb: 200, anonMb: 30000, shmemMb: 2 },
      procs: { nproc: 4700, top: [{ name: "uv", count: 4690 }] },
    }
    const a = evaluateResourceAlert(stormed)
    expect(a).not.toBeNull()
    expect(a).toContain("procs=4700")
    expect(a).toContain("4690x uv") // the culprit is right there in the warn
    expect(a).toContain("availMb=200")
  })
  it("alerts on low available memory alone", () => {
    const lowMem = { ...base, mem: { ...base.mem, availableMb: 500 } }
    expect(evaluateResourceAlert(lowMem, DEFAULT_RESOURCE_THRESHOLDS)).toContain("availMb=500")
  })
})

describe("startHostResourceSampler", () => {
  it("logs info while healthy and WARN (with culprit) when a threshold trips", async () => {
    const snaps: ResourceSnapshot[] = [
      {
        mem: { totalMb: 32000, freeMb: 16000, availableMb: 16000, anonMb: 4000, shmemMb: 2 },
        procs: { nproc: 250, top: [{ name: "bun", count: 5 }] },
      },
      {
        mem: { totalMb: 32000, freeMb: 200, availableMb: 200, anonMb: 30000, shmemMb: 2 },
        procs: { nproc: 4700, top: [{ name: "uv", count: 4690 }] },
      },
    ]
    let i = 0
    const lines: Array<{ level: string; msg: string }> = []
    const h = startHostResourceSampler({
      intervalMs: 5,
      sampler: async () => snaps[Math.min(i++, snaps.length - 1)] ?? null,
      log: (level, msg) => lines.push({ level, msg }),
    })
    await wait(60)
    h.stop()
    expect(lines.some((l) => l.level === "info" && l.msg.includes("procs=250"))).toBe(true)
    const warn = lines.find((l) => l.level === "warn")
    expect(warn?.msg).toContain("WARN")
    expect(warn?.msg).toContain("4690x uv")
  })

  it("stops quietly when the sampler returns null (non-Linux / no procfs)", async () => {
    let polls = 0
    const h = startHostResourceSampler({
      intervalMs: 5,
      sampler: async () => {
        polls++
        return null
      },
      log: () => {
        throw new Error("must not log when /proc is absent")
      },
    })
    await wait(40)
    h.stop()
    expect(polls).toBe(1) // one null → stop, no busy loop
  })
})
