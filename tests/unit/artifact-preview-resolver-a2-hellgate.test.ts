/**
 * A2 Hellgate — the READ-ONLY `quanta-artifact://` preview resolver stays JAILED.
 *
 * The resolver maps an id / `quanta-artifact://<id>` locator → registry bytes.
 * The load-bearing invariant: it NEVER reads an arbitrary path — only a path a
 * registered artifact wrote, and only when that path is inside the jail root.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createArtifactRegistry, monotonicIdFactory } from "@/artifact"
import { createArtifactPreviewResolver } from "@/host/runtime/artifact-preview-resolver"

let jailRoot = ""
let outsideFile = ""

beforeAll(async () => {
  jailRoot = await mkdtemp(join(tmpdir(), "a2-jail-"))
  await writeFile(join(jailRoot, "a.png"), new Uint8Array([1, 2, 3]))
  // A secret OUTSIDE the jail the resolver must never serve.
  outsideFile = join(tmpdir(), `a2-secret-${Date.now()}.txt`)
  await writeFile(outsideFile, "TOP SECRET")
})

afterAll(async () => {
  await rm(jailRoot, { recursive: true, force: true })
  await rm(outsideFile, { force: true })
})

const reg = () => createArtifactRegistry({ now: () => 1, idFactory: monotonicIdFactory("art") })

describe("A2 preview resolver — jailed read-only", () => {
  test("resolves a registered in-jail artifact to its bytes + recorded mediaType", async () => {
    const registry = reg()
    registry.register({ kind: "image", path: join(jailRoot, "a.png"), mediaType: "image/png" })
    const resolver = createArtifactPreviewResolver({ registry, jailRoot })

    // Accept both the bare id and the quanta-artifact:// locator.
    for (const key of ["art-1", "quanta-artifact://art-1"]) {
      const out = await resolver.resolve(key)
      expect(out.ok).toBe(true)
      if (out.ok) {
        expect(out.preview.mediaType).toBe("image/png")
        expect([...out.preview.bytes]).toEqual([1, 2, 3])
        expect(out.preview.artifactId).toBe("art-1")
      }
    }
  })

  test("an unknown id ⇒ not_found (never a crash)", async () => {
    const resolver = createArtifactPreviewResolver({ registry: reg(), jailRoot })
    const out = await resolver.resolve("art-999")
    expect(out).toEqual({ ok: false, reason: "not_found" })
  })

  test("JAIL: a forged registry entry pointing OUTSIDE the jail is rejected, not read", async () => {
    const registry = reg()
    // A malicious/forged artifact whose path escapes the jail. The resolver must
    // NOT serve it (defense-in-depth jail assertion), even though it is a valid
    // registry entry.
    registry.register({ kind: "other", path: outsideFile, mediaType: "text/plain" })
    const resolver = createArtifactPreviewResolver({ registry, jailRoot })
    const out = await resolver.resolve("art-1")
    expect(out).toEqual({ ok: false, reason: "escaped" })
  })

  test("JAIL: an arbitrary fs path / traversal passed as the 'id' can never read a file", async () => {
    const registry = reg()
    registry.register({ kind: "image", path: join(jailRoot, "a.png"), mediaType: "image/png" })
    let reads = 0
    const resolver = createArtifactPreviewResolver({
      registry,
      jailRoot,
      readBytes: async (p) => {
        reads += 1
        const { readFile } = await import("node:fs/promises")
        return new Uint8Array(await readFile(p))
      },
    })
    for (const bad of [
      outsideFile,
      "../../../../etc/passwd",
      "file:///etc/passwd",
      "/etc/passwd",
      "quanta-artifact://../a.png",
    ]) {
      const out = await resolver.resolve(bad)
      expect(out.ok).toBe(false)
      if (!out.ok) expect(out.reason).toBe("bad_locator")
    }
    // The read port was NEVER invoked for any hostile input.
    expect(reads).toBe(0)
  })
})
