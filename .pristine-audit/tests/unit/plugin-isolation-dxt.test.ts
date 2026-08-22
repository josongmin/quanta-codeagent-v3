/**
 * DXT loader — happy-path unit (ADR-0162 Phase C).
 *
 * Pure-schema assertions that don't need a tmp dir, plus a couple of
 * smoke-level positive validates.
 */

import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DxtManifestSchema, validateDxt } from "@/plugin-isolation"

describe("ADR-0162 DXT manifest schema — pure", () => {
  test("minimal valid manifest parses", () => {
    const r = DxtManifestSchema.safeParse({
      name: "n",
      version: "0.0.1",
      entry: "e.mjs",
      serviceName: "svc",
    })
    expect(r.success).toBe(true)
  })

  test("name must be kebab/snake-case", () => {
    const r = DxtManifestSchema.safeParse({
      name: "Bad Name",
      version: "0.0.1",
      entry: "e.mjs",
      serviceName: "svc",
    })
    expect(r.success).toBe(false)
  })

  test("args must be ≤ 64 items", () => {
    const r = DxtManifestSchema.safeParse({
      name: "n",
      version: "0.0.1",
      entry: "e.mjs",
      serviceName: "svc",
      args: Array.from({ length: 65 }, () => "x"),
    })
    expect(r.success).toBe(false)
  })

  test("env value cannot exceed 4096 chars", () => {
    const r = DxtManifestSchema.safeParse({
      name: "n",
      version: "0.0.1",
      entry: "e.mjs",
      serviceName: "svc",
      env: { K: "y".repeat(4097) },
    })
    expect(r.success).toBe(false)
  })

  test("allowLoadingUnsignedLibraries is optional boolean", () => {
    const r1 = DxtManifestSchema.safeParse({
      name: "n",
      version: "0.0.1",
      entry: "e.mjs",
      serviceName: "svc",
      allowLoadingUnsignedLibraries: true,
    })
    const r2 = DxtManifestSchema.safeParse({
      name: "n",
      version: "0.0.1",
      entry: "e.mjs",
      serviceName: "svc",
      allowLoadingUnsignedLibraries: "yes",
    })
    expect(r1.success).toBe(true)
    expect(r2.success).toBe(false)
  })
})

describe("ADR-0162 DXT validate — happy path", () => {
  test("validateDxt returns { manifest, dir } on a clean file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dxt-unit-"))
    try {
      const path = join(dir, "manifest.json")
      await writeFile(
        path,
        JSON.stringify({
          name: "p",
          version: "0.0.1",
          entry: "e.mjs",
          serviceName: "svc",
        }),
        "utf8",
      )
      const { manifest, dir: parsedDir } = await validateDxt(path)
      expect(manifest.name).toBe("p")
      expect(parsedDir).toBe(dir)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("validateDxt preserves optional fields when present", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dxt-unit-2-"))
    try {
      const path = join(dir, "manifest.json")
      await writeFile(
        path,
        JSON.stringify({
          name: "p",
          version: "0.0.1",
          entry: "e.mjs",
          serviceName: "svc",
          args: ["--x"],
          env: { K: "V" },
          allowLoadingUnsignedLibraries: true,
        }),
        "utf8",
      )
      const { manifest } = await validateDxt(path)
      expect(manifest.args).toEqual(["--x"])
      expect(manifest.env).toEqual({ K: "V" })
      expect(manifest.allowLoadingUnsignedLibraries).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("MAX_DXT_MANIFEST_BYTES is exactly 1MB", async () => {
    const { MAX_DXT_MANIFEST_BYTES } = await import("@/plugin-isolation")
    expect(MAX_DXT_MANIFEST_BYTES).toBe(1024 * 1024)
  })
})
