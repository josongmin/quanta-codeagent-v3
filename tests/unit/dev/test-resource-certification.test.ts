import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  auditResourceCertifications,
  certificationDigest,
  inferResourceClaimCandidates,
  loadTestResourceCertifications,
  resolveResourceCertification,
  resourceClaimSetsOverlap,
  sourceSha256,
  type TestResourceCertification,
} from "../../../tools/dev/test-resource-certification"

const certification = (source: string): TestResourceCertification => ({
  testId: "tests/integration/example.test.ts",
  sourceSha256: sourceSha256(source),
  owner: "verification",
  reason: "Synthetic certification fixture with explicit isolation ownership.",
  status: "certified",
  isolation: "process",
  claims: [{ key: "port:ephemeral", mode: "exclusive" }],
})

describe("test resource certification", () => {
  test("missing and source-drift certifications fail closed", () => {
    const source = "Bun.listen({ port: 0 })"
    expect(
      resolveResourceCertification({
        testId: "tests/integration/example.test.ts",
        source,
        certifications: [],
      }),
    ).toEqual({
      kind: "exclusive-fallback",
      reason: "missing",
      claims: [{ key: "unknown", mode: "exclusive" }],
    })
    expect(
      resolveResourceCertification({
        testId: "tests/integration/example.test.ts",
        source: `${source}\n// changed`,
        certifications: [certification(source)],
      }).kind,
    ).toBe("exclusive-fallback")
  })

  test("an exact source digest exposes only the reviewed claims", () => {
    const source = "Bun.listen({ port: 0 })"
    const resolved = resolveResourceCertification({
      testId: "tests/integration/example.test.ts",
      source,
      certifications: [certification(source)],
    })
    expect(resolved.kind).toBe("certified")
    expect(resolved.claims).toEqual([{ key: "port:ephemeral", mode: "exclusive" }])
  })

  test("candidate scan requires live uses and has a non-vacuous defect corpus", () => {
    expect(inferResourceClaimCandidates("import { spawn } from 'node:child_process'")).toEqual([])
    const candidates = inferResourceClaimCandidates(`
      process.env.QUANTA_HOME = "/tmp/q"
      Bun.spawn(["git", "status"])
      Bun.listen({ port: 0 })
      writeFileSync(join(REPO_ROOT, "x"), "bad")
      run("git worktree add /tmp/w")
    `)
    expect(candidates.length).toBeGreaterThanOrEqual(5)
    expect(candidates).toContainEqual({ key: "process-env:QUANTA_HOME", mode: "exclusive" })
    expect(candidates).toContainEqual({ key: "child-process", mode: "shared" })
    expect(candidates).toContainEqual({ key: "port:ephemeral", mode: "exclusive" })
    expect(candidates).toContainEqual({ key: "checkout", mode: "exclusive" })
    expect(candidates).toContainEqual({ key: "git-common", mode: "exclusive" })
  })

  test("registry rejects duplicate ids and intentionally-exclusive without an exclusive claim", () => {
    const root = mkdtempSync(join(tmpdir(), "resource-certification-"))
    const path = join(root, "registry.json")
    const row = certification("source")
    try {
      writeFileSync(
        path,
        JSON.stringify({
          schema: "quanta.test-resource-certifications.v1",
          certifications: [row, row],
        }),
      )
      expect(() => loadTestResourceCertifications(path)).toThrow(/duplicate resource certification/)

      writeFileSync(
        path,
        JSON.stringify({
          schema: "quanta.test-resource-certifications.v1",
          certifications: [{ ...row, status: "intentionally-exclusive", claims: [] }],
        }),
      )
      expect(() => loadTestResourceCertifications(path)).toThrow(/requires an exclusive claim/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("certification digest is order independent", () => {
    const left = certification("left")
    const right = { ...certification("right"), testId: "tests/integration/right.test.ts" }
    expect(certificationDigest([left, right])).toBe(certificationDigest([right, left]))
  })

  test("audit sorts the full input and keeps missing separate from reviewed claims", () => {
    const source = "Bun.listen({ port: 0 })"
    const rows = auditResourceCertifications(
      [
        { testId: "tests/integration/z.test.ts", source: "plain" },
        { testId: "tests/integration/example.test.ts", source },
      ],
      [certification(source)],
    )
    expect(rows.map(({ testId }) => testId)).toEqual([
      "tests/integration/example.test.ts",
      "tests/integration/z.test.ts",
    ])
    expect(rows[0]?.status).toBe("certified")
    expect(rows[1]?.status).toBe("missing")
    expect(rows[1]?.claims).toEqual([{ key: "unknown", mode: "exclusive" }])
  })

  test("claim compatibility allows shared peers and rejects exclusive or unknown overlap", () => {
    expect(
      resourceClaimSetsOverlap(
        [{ key: "child-process", mode: "shared" }],
        [{ key: "child-process", mode: "shared" }],
      ),
    ).toBe(true)
    expect(
      resourceClaimSetsOverlap(
        [{ key: "port:4317", mode: "exclusive" }],
        [{ key: "port:4317", mode: "shared" }],
      ),
    ).toBe(false)
    expect(resourceClaimSetsOverlap([], [{ key: "port:4317", mode: "exclusive" }])).toBe(true)
    expect(resourceClaimSetsOverlap([], [{ key: "unknown", mode: "exclusive" }])).toBe(false)
  })
})
