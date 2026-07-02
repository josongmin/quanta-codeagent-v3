import { describe, expect, test } from "bun:test"
import {
  buildTbReport,
  durationMsFromResult,
  scanHarborTree,
  type TbInstance,
  taskNameFromDir,
} from "./tb-report-emit"

describe("taskNameFromDir — strip harbor `<task>__<hash>` suffix", () => {
  test("splits on the LAST __ (task names may contain hyphens/digits)", () => {
    expect(taskNameFromDir("/x/nginx-request-logging__UosydHa")).toBe("nginx-request-logging")
    expect(taskNameFromDir("polyglot-c-py__aB12")).toBe("polyglot-c-py")
  })
  test("no __ ⇒ verbatim", () => {
    expect(taskNameFromDir("bare-task")).toBe("bare-task")
  })
})

describe("durationMsFromResult", () => {
  test("finished − started in ms", () => {
    expect(
      durationMsFromResult({
        started_at: "2026-07-02T16:18:09.000",
        finished_at: "2026-07-02T16:20:21.000",
      }),
    ).toBe(132_000)
  })
  test("missing finished ⇒ 0 (no negative / NaN)", () => {
    expect(durationMsFromResult({ started_at: "2026-07-02T16:18:09.000" })).toBe(0)
    expect(durationMsFromResult(null)).toBe(0)
  })
})

describe("buildTbReport — SSOT IR the dashboard consumes", () => {
  const insts: TbInstance[] = [
    { id: "kv-store-grpc", passed: true, durationMs: 200_000 },
    { id: "compile-compcert", passed: false, durationMs: 30_000 },
  ]
  const rep = buildTbReport(insts, { preset: "TB +levers", model: "gpt-5.5", timestamp: "T" })

  test("datasetFamily is terminal-bench (the 4th family)", () => {
    expect(rep.datasetFamily).toBe("terminal-bench")
  })
  test("perInstance matches the dashboard's {id,passed} contract", () => {
    // Dashboard buildRunFromFile REQUIRES perInstance array with id + passed===true.
    expect(Array.isArray(rep.perInstance)).toBe(true)
    const resolved = rep.perInstance.filter((p) => p.passed).length
    expect(resolved).toBe(1)
    const kv = rep.perInstance.find((p) => p.id === "kv-store-grpc")
    expect(kv?.passed).toBe(true)
    expect(kv?.durationMs).toBe(200_000)
  })
  test("carries preset + model + provenance so the dashboard labels it", () => {
    expect(rep.knobs.preset).toBe("TB +levers")
    expect(rep.model).toBe("gpt-5.5")
    expect(rep.source).toBe("terminal-bench-harbor")
  })
  test("dedups to ONE verdict per task, any-pass wins (relaunch semantics)", () => {
    const dupes: TbInstance[] = [
      { id: "t", passed: false, durationMs: 10 },
      { id: "t", passed: true, durationMs: 999 }, // a later PASS must win over an earlier FAIL
    ]
    const r = buildTbReport(dupes, { preset: "p", model: "m", timestamp: "T" })
    expect(r.perInstance).toHaveLength(1)
    expect(r.perInstance[0]?.passed).toBe(true)
  })
})

describe("scanHarborTree — read reward.txt over an injected fs seam", () => {
  // Fixture: root/<jobTs>/<task>__<hash>/verifier/reward.txt (+ result.json)
  const files: Record<string, string> = {
    "/r/2026/nginx__h1/verifier/reward.txt": "1\n",
    "/r/2026/nginx__h1/result.json": JSON.stringify({
      started_at: "2026-07-02T16:18:09.000",
      finished_at: "2026-07-02T16:20:21.000",
    }),
    "/r/2026/compile__h2/verifier/reward.txt": "0\n",
  }
  const dirs = new Set<string>([
    "/r",
    "/r/2026",
    "/r/2026/nginx__h1",
    "/r/2026/nginx__h1/verifier",
    "/r/2026/compile__h2",
    "/r/2026/compile__h2/verifier",
  ])
  const childrenOf = (p: string): string[] => {
    const kids = new Set<string>()
    for (const d of dirs) {
      if (d !== p && d.startsWith(`${p}/`)) {
        const rest = d.slice(p.length + 1)
        if (!rest.includes("/")) kids.add(rest)
      }
    }
    return [...kids]
  }
  const fs = {
    readdir: (p: string): string[] => childrenOf(p),
    isDir: (p: string): boolean => dirs.has(p),
    readFile: (p: string): string | null => files[p] ?? null,
    exists: (p: string): boolean => dirs.has(p) || p in files,
  }

  test("reward 1 ⇒ passed, reward 0 ⇒ fail; duration parsed", () => {
    const got = scanHarborTree("/r", fs).sort((a, b) => a.id.localeCompare(b.id))
    expect(got).toEqual([
      { id: "compile", passed: false, durationMs: 0 },
      { id: "nginx", passed: true, durationMs: 132_000 },
    ])
  })
  test("missing root ⇒ empty (no throw)", () => {
    expect(scanHarborTree("/nope", fs)).toEqual([])
  })
})
