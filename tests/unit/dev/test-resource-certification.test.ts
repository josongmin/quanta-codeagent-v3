import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  CERTIFICATION_SCHEMA,
  certificationCoversDerived,
  certificationDigest,
  loadTestResourceCertifications,
  loadTestResourceCertificationsSafe,
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
  analyzer: "quanta.test-resource-analysis.v1",
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

  test("a registry that will not parse yields zero certifications, not an exception", () => {
    // The registry is read from the policy layer, the planner AND the audit. A
    // throw here would take out every gate in the repository over a stray
    // comma; zero certifications degrades to "nothing is certified", which is
    // the behaviour the corpus already has.
    const root = mkdtempSync(join(tmpdir(), "resource-certification-"))
    const path = join(root, "registry.json")
    try {
      writeFileSync(path, "{ not json")
      const broken = loadTestResourceCertificationsSafe(path)
      expect(broken.certifications).toEqual([])
      expect(broken.error).toBeDefined()
      // PAIRED CONTROL — a well-formed registry still loads, so the safe
      // loader is not simply always empty.
      writeFileSync(
        path,
        JSON.stringify({ schema: CERTIFICATION_SCHEMA, certifications: [certification("s")] }),
      )
      const good = loadTestResourceCertificationsSafe(path)
      expect(good.certifications).toHaveLength(1)
      expect(good.error).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("a claim key outside the vocabulary is rejected, not silently accepted", () => {
    // A typo'd key names a resource nothing else ever claims, so it conflicts
    // with nobody — a claim that reads like a lock and behaves like none.
    const root = mkdtempSync(join(tmpdir(), "resource-certification-"))
    const path = join(root, "registry.json")
    try {
      writeFileSync(
        path,
        JSON.stringify({
          schema: CERTIFICATION_SCHEMA,
          certifications: [
            { ...certification("s"), claims: [{ key: "portt:4317", mode: "exclusive" }] },
          ],
        }),
      )
      expect(() => loadTestResourceCertifications(path)).toThrow(/invalid resource key/)
      // PAIRED CONTROL — the correctly spelled key loads.
      writeFileSync(
        path,
        JSON.stringify({
          schema: CERTIFICATION_SCHEMA,
          certifications: [
            { ...certification("s"), claims: [{ key: "port:4317", mode: "exclusive" }] },
          ],
        }),
      )
      expect(loadTestResourceCertifications(path).certifications).toHaveLength(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("registry rejects duplicate ids and intentionally-exclusive without an exclusive claim", () => {
    const root = mkdtempSync(join(tmpdir(), "resource-certification-"))
    const path = join(root, "registry.json")
    const row = certification("source")
    try {
      writeFileSync(
        path,
        JSON.stringify({
          schema: CERTIFICATION_SCHEMA,
          certifications: [row, row],
        }),
      )
      expect(() => loadTestResourceCertifications(path)).toThrow(/duplicate resource certification/)

      writeFileSync(
        path,
        JSON.stringify({
          schema: CERTIFICATION_SCHEMA,
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

  test("a certified row that still says `unknown` falls back, whatever its status", () => {
    // `status: certified` asserts a COMPLETE enumeration; `unknown` is the
    // marker for an incomplete one. When a row says both, the marker wins.
    const source = "Bun.listen({ port: 0 })"
    const resolved = resolveResourceCertification({
      testId: "tests/integration/example.test.ts",
      source,
      certifications: [
        { ...certification(source), claims: [{ key: "unknown", mode: "exclusive" }] },
      ],
    })
    expect(resolved.kind).toBe("exclusive-fallback")
    expect(resolved.kind === "exclusive-fallback" && resolved.reason).toBe("unknown-claim")
  })

  test("the gate checks CONTAINMENT of the derived closure, in one direction only", () => {
    const certified = [
      { key: "checkout", mode: "exclusive" },
      { key: "child-process", mode: "shared" },
    ] as const
    // A closure that SHED a claim is over-declared, which is safe.
    expect(certificationCoversDerived(certified, [{ key: "checkout", mode: "exclusive" }])).toBe(
      true,
    )
    // A closure that GREW one is under-declared, which is the unsafe direction.
    expect(
      certificationCoversDerived(certified, [
        { key: "checkout", mode: "exclusive" },
        { key: "port:ephemeral", mode: "exclusive" },
      ]),
    ).toBe(false)
    // Same key, stricter mode: `shared` certified does not cover `exclusive`.
    expect(
      certificationCoversDerived(certified, [{ key: "child-process", mode: "exclusive" }]),
    ).toBe(false)
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
