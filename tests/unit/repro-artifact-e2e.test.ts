/**
 * A1 END-TO-END (real disk): drive the ACTUAL driver persist path
 * (`prepareReproTestDetailed` → executeReproCandidateTests → persistReproArtifacts)
 * with a REAL fs sink (`makeReproArtifactFsSink`) and deterministic generate/execute
 * — no LLM / network. Asserts the full on-disk artifact tree the unit + wiring tests
 * cover only piecewise: canonical + hardening dirs, no per-kind collision, and the
 * RAW pytest sidecar (sidecar.json) actually reaches disk from a sample's
 * `sidecarReport`. This is the e2e the second-pass audit flagged as missing.
 */

import { describe, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LLMPort, StreamEvent, StreamInput } from "../../src/llm"
import { prepareReproTestDetailed } from "../../src/runner/batch/eval/driver"
import { makeReproArtifactFsSink } from "../../src/runner/batch/eval/repro-artifacts-fs"
import type { Instance } from "../../src/runner/batch/types"

class StubLLM implements LLMPort {
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", delta: "x" }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

const REPORT =
  '{"schema":1,"collected":1,"exitstatus":1,"reports":[{"nodeid":"t.py::test_x","when":"call","outcome":"failed","exc_type":"AssertionError"}]}'

const instance = {
  id: "django__django-12345",
  repoPath: "/tmp/x",
  problemStatement: "bug in foo.py",
  testCmd: "true",
} as Instance

describe("A1 e2e — driver persists the full artifact tree to real disk", () => {
  test("canonical + hardening dirs, full file-set, raw sidecar on disk", async () => {
    const root = await mkdtemp(join(tmpdir(), "a1-e2e-"))
    try {
      await prepareReproTestDetailed(instance, "/tmp/sb", 2, {
        llm: new StubLLM(),
        adversarial: true, // generate BOTH canonical + hardening
        generate: async ({ kind }) => [`# ${kind} a\nassert False`, `# ${kind} b\nassert False`],
        execute: async ({ tests }) =>
          tests.map((source) => ({
            source,
            stdout: "1 failed",
            stderr: "tb",
            outcome: "reproduced" as const,
            sidecarReport: REPORT,
          })),
        reproArtifactSink: makeReproArtifactFsSink(root),
      })

      const instDir = join(root, "repro/django__django-12345")
      const dirs = (await readdir(instDir)).sort()
      // 2 canonical + 2 hardening, per-kind indexed, no collision.
      expect(dirs).toEqual(["canonical-0", "canonical-1", "hardening-0", "hardening-1"])

      // each dir carries the full 5-file set.
      for (const d of dirs) {
        const files = (await readdir(join(instDir, d))).sort()
        expect(files).toEqual([
          "candidate.py",
          "outcome.json",
          "sidecar.json",
          "stderr.txt",
          "stdout.txt",
        ])
      }

      // outcome.json carries the original id + join key; sidecar present.
      const outcome = JSON.parse(await readFile(join(instDir, "canonical-0/outcome.json"), "utf8"))
      expect(outcome.instanceId).toBe("django__django-12345")
      expect(outcome.candidateId).toBe("canonical-0")
      expect(typeof outcome.sourceHash).toBe("string")
      expect(outcome.sidecarPresent).toBe(true)

      // the RAW pytest report reached disk verbatim (node-level RCA signal).
      const sidecar = await readFile(join(instDir, "hardening-1/sidecar.json"), "utf8")
      expect(sidecar).toBe(REPORT)
      expect(JSON.parse(sidecar).reports[0].nodeid).toBe("t.py::test_x")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
