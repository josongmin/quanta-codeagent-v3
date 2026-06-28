/**
 * A1a — Per-candidate repro artifact sink (jun-28 oracle-first RFC).
 *
 * The sink is fs-FREE: it takes an injected `writeFile` port and lays out one
 * directory per candidate so the unselected breadth candidates leave durable RCA
 * evidence before they are discarded. Tests drive a FAKE port and assert the
 * exact write-set: candidate source, the verdict (outcome.json with a join-key
 * `sourceHash`), tail-bounded stdout/stderr, and the raw sidecar ONLY when present
 * (a missing sidecar is recorded as such, never fabricated).
 */

import { describe, expect, test } from "bun:test"
import {
  candidateIdOf,
  makeReproArtifactSink,
  REPRO_ARTIFACT_TAIL_BOUND,
  type ReproArtifactWritePort,
  sourceHashOf,
} from "../../src/runner/batch/eval/repro-artifacts-sink"

const fakePort = (): { port: ReproArtifactWritePort; writes: Map<string, string> } => {
  const writes = new Map<string, string>()
  return {
    writes,
    port: {
      writeFile: async (relPath, content) => {
        writes.set(relPath, content)
      },
    },
  }
}

describe("repro artifact sink", () => {
  test("canonical candidate WITH sidecar ⇒ full write-set under repro/<inst>/<id>/", async () => {
    const { port, writes } = fakePort()
    const sink = makeReproArtifactSink(port)
    await sink.persist({
      instanceId: "django__django-12345",
      index: 0,
      kind: "canonical",
      source: "import x\nassert False\n",
      stdout: "boom",
      stderr: "trace",
      outcome: "reproduced",
      sidecar: '{"schema":1,"collected":1,"exitstatus":1,"reports":[]}',
    })
    const base = "repro/django__django-12345/canonical-0"
    expect(writes.get(`${base}/candidate.py`)).toBe("import x\nassert False\n")
    expect(writes.get(`${base}/sidecar.json`)).toBe(
      '{"schema":1,"collected":1,"exitstatus":1,"reports":[]}',
    )
    expect(writes.get(`${base}/stdout.txt`)).toBe("boom")
    expect(writes.get(`${base}/stderr.txt`)).toBe("trace")
    const outcome = JSON.parse(writes.get(`${base}/outcome.json`) ?? "{}")
    expect(outcome.kind).toBe("canonical")
    expect(outcome.candidateId).toBe("canonical-0")
    expect(outcome.outcome).toBe("reproduced")
    expect(outcome.sidecarPresent).toBe(true)
    expect(outcome.sourceHash).toBe(sourceHashOf("import x\nassert False\n"))
    expect(typeof outcome.sourceHash).toBe("string")
  })

  test("missing sidecar ⇒ NO sidecar.json, recorded sidecarPresent:false, stdout/stderr still written", async () => {
    const { port, writes } = fakePort()
    const sink = makeReproArtifactSink(port)
    await sink.persist({
      instanceId: "inst",
      index: 2,
      kind: "canonical",
      source: "x",
      stdout: "out",
      stderr: "",
      outcome: "exec_failed",
      execFailure: "infra_unavailable",
      // no sidecar
    })
    const base = "repro/inst/canonical-2"
    expect(writes.has(`${base}/sidecar.json`)).toBe(false)
    expect(writes.get(`${base}/stdout.txt`)).toBe("out")
    expect(writes.get(`${base}/stderr.txt`)).toBe("")
    const outcome = JSON.parse(writes.get(`${base}/outcome.json`) ?? "{}")
    expect(outcome.sidecarPresent).toBe(false)
    expect(outcome.outcome).toBe("exec_failed")
    expect(outcome.execFailure).toBe("infra_unavailable")
  })

  test("stdout/stderr are TAIL-BOUNDED (no full dump)", async () => {
    const { port, writes } = fakePort()
    const sink = makeReproArtifactSink(port)
    const huge = "A".repeat(5000) + "TAILEND"
    await sink.persist({
      instanceId: "i",
      index: 0,
      kind: "hardening",
      source: "s",
      stdout: huge,
      stderr: "B".repeat(9000),
      outcome: "other",
    })
    const out = writes.get("repro/i/hardening-0/stdout.txt") ?? ""
    const err = writes.get("repro/i/hardening-0/stderr.txt") ?? ""
    expect(out.length).toBeLessThanOrEqual(REPRO_ARTIFACT_TAIL_BOUND)
    expect(err.length).toBeLessThanOrEqual(REPRO_ARTIFACT_TAIL_BOUND)
    // TAIL kept (the determinative error lives at the end)
    expect(out.endsWith("TAILEND")).toBe(true)
  })

  test("candidateIdOf is deterministic per kind+index (join-stable)", () => {
    expect(candidateIdOf("canonical", 0)).toBe("canonical-0")
    expect(candidateIdOf("hardening", 1)).toBe("hardening-1")
  })

  test("sourceHashOf is deterministic and content-sensitive (join key)", () => {
    expect(sourceHashOf("abc")).toBe(sourceHashOf("abc"))
    expect(sourceHashOf("abc")).not.toBe(sourceHashOf("abd"))
    expect(sourceHashOf("")).toMatch(/^[0-9a-f]+$/)
  })
})

// ── fs adapter (real disk roundtrip) ─────────────────────────────────────────
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeReproArtifactFsSink } from "../../src/runner/batch/eval/repro-artifacts-fs"

describe("repro artifact fs sink (real disk)", () => {
  test("writes candidate.py + outcome.json under <root>/repro/<inst>/<id>/", async () => {
    const root = await mkdtemp(join(tmpdir(), "repro-art-"))
    try {
      const sink = makeReproArtifactFsSink(root)
      await sink.persist({
        instanceId: "inst",
        index: 0,
        kind: "canonical",
        source: "print('x')\n",
        stdout: "o",
        stderr: "e",
        outcome: "resolved",
      })
      const base = join(root, "repro/inst/canonical-0")
      expect(await readFile(join(base, "candidate.py"), "utf8")).toBe("print('x')\n")
      const outcome = JSON.parse(await readFile(join(base, "outcome.json"), "utf8"))
      expect(outcome.outcome).toBe("resolved")
      expect(outcome.candidateId).toBe("canonical-0")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
