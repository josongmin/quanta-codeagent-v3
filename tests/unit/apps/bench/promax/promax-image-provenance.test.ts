/**
 * PMX-04 — A GRADE MUST RECORD WHICH IMAGES IT RAN AGAINST.
 *
 * The on-box grade produced a receipt naming the evaluator bytes, the argv and
 * the cwd — but nothing about the IMAGES. Every ProMax verdict is decided inside
 * a container built from a per-instance image, so "which image" is as much a part
 * of what produced the number as "which evaluator". Gate 2's evidence requires an
 * image freeze covering the assigned set with digest pins, and this path supplied
 * none: the grade ran against whatever `docker pull` happened to fetch, with no
 * record.
 *
 * The image name is NOT guessed. The pinned evaluator resolves it as
 * `golden_entry.get("image_name") or f"key4127/refactor-dockerhub:{instance_id}"`,
 * and the golden document is IN the checkout — inside the grader window, already
 * hash-verified. So the names are read from the same source the evaluator reads,
 * and the digests come from the daemon that actually ran them.
 *
 * A tag is not provenance: `key4127/refactor-dockerhub:x` can point at different
 * bytes tomorrow. The RepoDigest is what pins it.
 */
import { describe, expect, test } from "bun:test"
import {
  buildProMaxImageProvenanceCommand,
  parseProMaxImageProvenance,
} from "@/apps/bench/harness/promax/image-provenance"

const CHECKOUT = "/opt/quanta/promax/upstream"

describe("the command that asks the box which images it used", () => {
  test("🔴 it reads the image names from the CHECKOUT's golden, not from a guess", () => {
    const cmd = buildProMaxImageProvenanceCommand({
      checkoutRoot: CHECKOUT,
      venvPython: `${CHECKOUT}/../venv/bin/python`,
      instanceIds: ["a-1", "b-2"],
    })
    expect(cmd).toContain(CHECKOUT)
    // the same fallback the pinned evaluator uses, so the two can never disagree
    expect(cmd).toContain("key4127/refactor-dockerhub:")
    expect(cmd).toContain("image_name")
  })

  test("🔴 it asks for the DIGEST, not the tag", () => {
    const cmd = buildProMaxImageProvenanceCommand({
      checkoutRoot: CHECKOUT,
      venvPython: `${CHECKOUT}/../venv/bin/python`,
      instanceIds: ["a-1"],
    })
    expect(cmd).toMatch(/RepoDigests/)
    expect(cmd).toContain("docker image inspect")
  })
})

describe("parsing what the box answered", () => {
  test("🔴 KNOWN-ITEM FLOOR: a well-formed answer becomes per-instance records", () => {
    const out = parseProMaxImageProvenance(
      [
        "a-1\tkey4127/refactor-dockerhub:a-1\tkey4127/refactor-dockerhub@sha256:" + "1".repeat(64),
        "b-2\tkey4127/refactor-dockerhub:b-2\tkey4127/refactor-dockerhub@sha256:" + "2".repeat(64),
      ].join("\n"),
      ["a-1", "b-2"],
    )
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.images).toHaveLength(2)
    expect(out.images[0]?.instanceId).toBe("a-1")
    expect(out.images[0]?.repoDigest).toContain("sha256:")
  })

  test("🔴 an instance with NO digest is a FAULT, never silently dropped", () => {
    // A missing digest means the grade ran against something unpinnable. Dropping
    // it would leave a receipt that looks complete while covering less than it
    // claims.
    const out = parseProMaxImageProvenance(["a-1\tkey4127/refactor-dockerhub:a-1\t"].join("\n"), [
      "a-1",
      "b-2",
    ])
    expect(out.ok).toBe(false)
    if (out.ok) return
    const text = out.faults.join(" ")
    expect(text).toContain("a-1") // no digest
    expect(text).toContain("b-2") // never reported at all
  })

  test("🔴 a digest that is not a sha256 is refused", () => {
    const out = parseProMaxImageProvenance(["a-1\ttag\tnot-a-digest"].join("\n"), ["a-1"])
    expect(out.ok).toBe(false)
  })

  test("unparseable output yields faults, never an empty PASS", () => {
    const out = parseProMaxImageProvenance("total garbage", ["a-1"])
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.faults.length).toBeGreaterThan(0)
  })
})
