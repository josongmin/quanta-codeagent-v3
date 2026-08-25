/**
 * THE LAST HOP — the receipt is a FILE, and nothing tested the file.
 *
 * The port, the ProMax adapter and the receipt layer are all covered, and none
 * of that says the bytes reach disk. The persist block lived inline in
 * `executeGradeChunk`, reachable only by driving a whole ssh session, so the
 * only thing standing between a correct receipt and an absent one was reading
 * the code — which is exactly how a commit shipped claiming to record image
 * digests while the port had no field for them.
 *
 * So this drives the extracted last hop and reads back what landed, with
 * `QUANTA_BENCH_HOME` redirected so nothing touches the operator's artifacts.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PROMAX_V1_SNAPSHOT } from "@/apps/bench/promax/provenance/frozen-snapshot"
import { persistBoxGradeArtifacts } from "@/apps/bench/remote/box-session"
import type { FamilyBoxGradeObservation } from "@/apps/bench/remote/box-session/family-box-grade"
import { __resetRuntimeConfig } from "@/shared/runtime-config"

const DIGEST = `key4127/refactor-dockerhub@sha256:${"e".repeat(64)}`
const ID = "aws__s2n-tls-5464"

const PASS_RATE = JSON.stringify([
  {
    instance_id: ID,
    language: "c",
    passed: true,
    model: { final_result: "success", raw_reason: "success", returncode: 0, script_exit_code: 0 },
    golden: { final_result: "success", raw_reason: "success", returncode: 0, script_exit_code: 0 },
  },
])

const observation = (): FamilyBoxGradeObservation => ({
  argv: ["/opt/quanta/promax/venv/bin/python", "/opt/quanta/promax/upstream/x/test_run.py"],
  cwd: "/opt/quanta/promax/upstream",
  exitCode: 0,
  stdout: "EVAL-OUT",
  stderr: "EVAL-ERR",
  evaluatorSha256: PROMAX_V1_SNAPSHOT.evaluator_sha256,
  images: [{ instanceId: ID, imageName: "key4127/refactor-dockerhub", repoDigest: DIGEST }],
})

const temps: string[] = []
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true })
  delete process.env.QUANTA_BENCH_HOME
  __resetRuntimeConfig()
})

/** Persist into an isolated bench home and hand back what landed. */
const persist = (
  family: "promax" | "verified",
  obs: FamilyBoxGradeObservation = observation(),
): {
  receiptPath: string | undefined
  receipt: string | undefined
  passRate: string | undefined
} => {
  const dir = mkdtempSync(join(tmpdir(), "promax-receipt-disk-"))
  temps.push(dir)
  process.env.QUANTA_BENCH_HOME = join(dir, "bench")
  __resetRuntimeConfig()
  const out = persistBoxGradeArtifacts({
    datasetFamily: family,
    artifactSuffix: `disk-${family}`,
    assignedInstanceIds: [ID],
    boxGrade: { artifactText: PASS_RATE, observation: obs },
    log: () => {},
  })
  return {
    receiptPath: out.receiptPath,
    receipt:
      out.receiptPath !== undefined && existsSync(out.receiptPath)
        ? readFileSync(out.receiptPath, "utf8")
        : undefined,
    passRate:
      out.artifactPath !== undefined && existsSync(out.artifactPath)
        ? readFileSync(out.artifactPath, "utf8")
        : undefined,
  }
}

describe("the grade receipt lands on disk with its provenance intact", () => {
  test("🔴 the WRITTEN receipt names the image digest", () => {
    const { receipt } = persist("promax")
    expect(receipt, "no receipt file was written at all").toBeDefined()
    expect(receipt ?? "", "the persisted receipt cannot say which image ran").toContain(DIGEST)
    expect(receipt ?? "").toContain(ID)
  })

  test("the WRITTEN receipt names the evaluator bytes, argv and cwd", () => {
    const { receipt } = persist("promax")
    const r = receipt ?? ""
    expect(r).toContain(PROMAX_V1_SNAPSHOT.evaluator_sha256)
    expect(r).toContain("/opt/quanta/promax/upstream")
    expect(r).toContain("EVAL-OUT")
  })

  test("the pass-rate document lands BESIDE it, unmodified", () => {
    const { passRate } = persist("promax")
    expect(passRate).toBe(PASS_RATE)
  })

  test("PAIRED CONTROL: a family with no receipt port writes the document only", () => {
    // without this, "a receipt was written" could pass for a path that writes
    // one for everybody, which is not what the port means
    const out = persist("verified")
    expect(out.receiptPath).toBeUndefined()
    expect(out.passRate).toBe(PASS_RATE)
  })

  test("🔴 an unusable image pin REFUSES rather than writing a receipt", () => {
    // the fail-closed rule has to hold at the last hop too, or the file is
    // written with provenance that cannot be replayed
    expect(() =>
      persist("promax", {
        ...observation(),
        images: [{ instanceId: ID, imageName: "x", repoDigest: "x:latest" }],
      }),
    ).toThrow(/image|receipt/i)
  })
})
