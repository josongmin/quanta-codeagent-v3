/**
 * DXT loader — hellgate (ADR-0162 Phase C).
 *
 * Seals the validate / launch surface across 4 sections — 12 cases total.
 * No real spawn: a stub spawner records `spawn(opts)` for cross-checking the
 * env / args / cwd plumbing without touching processes.
 *
 * Sections:
 *   A. validateDxt input errors (5)  — missing / oversize / malformed JSON /
 *                                       schema-extra-key / bad serviceName
 *                                       regex.
 *   B. Entry resolution (3)          — relative escape (`..`), absolute path,
 *                                       missing entry file.
 *   C. Launch wiring (3)             — args/env/allowUnsigned propagation.
 *   D. Field bounds (1)              — unicode in serviceName rejected.
 */

import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { IsolatedProcess, IsolatedProcessSpawnerPort, SpawnOpts } from "@/plugin-isolation"
import { type DxtError, launchDxt, MAX_DXT_MANIFEST_BYTES, validateDxt } from "@/plugin-isolation"

const tmp = async (): Promise<{ dir: string; cleanup: () => Promise<void> }> => {
  const dir = await mkdtemp(join(tmpdir(), "dxt-hellgate-"))
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

interface StubSpawner {
  readonly port: IsolatedProcessSpawnerPort
  readonly calls: SpawnOpts[]
}

const stubSpawner = (): StubSpawner => {
  const calls: SpawnOpts[] = []
  const port: IsolatedProcessSpawnerPort = {
    spawn: async (opts) => {
      calls.push(opts)
      const exitPromise = new Promise<{ code: number | null; signal: string | null }>(() => {
        // never settles
      })
      const proc: IsolatedProcess = {
        pid: 1,
        serviceName: opts.serviceName,
        send: () => {
          // no-op
        },
        onMessage: () => () => {
          // no-op
        },
        kill: async () => {
          // no-op
        },
        exitPromise,
      }
      return proc
    },
  }
  return { port, calls }
}

const validManifest = (): Record<string, unknown> => ({
  name: "echo-plugin",
  version: "0.1.0",
  entry: "child.mjs",
  serviceName: "echo-svc",
})

describe("ADR-0162 DXT hellgate — A. validateDxt input errors", () => {
  test("missing manifest → kind=missing", async () => {
    const t = await tmp()
    try {
      let caught: DxtError | null = null
      try {
        await validateDxt(join(t.dir, "nope.json"))
      } catch (e) {
        caught = e as DxtError
      }
      expect(caught?.kind).toBe("missing")
    } finally {
      await t.cleanup()
    }
  })

  test("oversize manifest → kind=manifest-too-large", async () => {
    const t = await tmp()
    try {
      const path = join(t.dir, "big.json")
      const huge = "x".repeat(MAX_DXT_MANIFEST_BYTES + 1024)
      await writeFile(path, `{"name":"${huge}"}`, "utf8")
      let caught: DxtError | null = null
      try {
        await validateDxt(path)
      } catch (e) {
        caught = e as DxtError
      }
      expect(caught?.kind).toBe("manifest-too-large")
    } finally {
      await t.cleanup()
    }
  })

  test("malformed JSON → kind=malformed-json", async () => {
    const t = await tmp()
    try {
      const path = join(t.dir, "bad.json")
      await writeFile(path, "{not json", "utf8")
      let caught: DxtError | null = null
      try {
        await validateDxt(path)
      } catch (e) {
        caught = e as DxtError
      }
      expect(caught?.kind).toBe("malformed-json")
    } finally {
      await t.cleanup()
    }
  })

  test("extra key in manifest → kind=schema-mismatch (strict)", async () => {
    const t = await tmp()
    try {
      const path = join(t.dir, "extra.json")
      await writeFile(path, JSON.stringify({ ...validManifest(), surprise: "field" }), "utf8")
      let caught: DxtError | null = null
      try {
        await validateDxt(path)
      } catch (e) {
        caught = e as DxtError
      }
      expect(caught?.kind).toBe("schema-mismatch")
    } finally {
      await t.cleanup()
    }
  })

  test("missing required field → kind=schema-mismatch", async () => {
    const t = await tmp()
    try {
      const path = join(t.dir, "no-name.json")
      await writeFile(
        path,
        JSON.stringify({ version: "1", entry: "x.mjs", serviceName: "x" }),
        "utf8",
      )
      let caught: DxtError | null = null
      try {
        await validateDxt(path)
      } catch (e) {
        caught = e as DxtError
      }
      expect(caught?.kind).toBe("schema-mismatch")
    } finally {
      await t.cleanup()
    }
  })
})

describe("ADR-0162 DXT hellgate — B. Entry resolution", () => {
  test("relative entry with `..` escape → kind=entry-escape", async () => {
    const t = await tmp()
    try {
      const path = join(t.dir, "manifest.json")
      await writeFile(path, JSON.stringify({ ...validManifest(), entry: "../etc/passwd" }), "utf8")
      let caught: DxtError | null = null
      try {
        await launchDxt(path, stubSpawner().port)
      } catch (e) {
        caught = e as DxtError
      }
      expect(caught?.kind).toBe("entry-escape")
    } finally {
      await t.cleanup()
    }
  })

  test("absolute entry → kind=entry-escape", async () => {
    const t = await tmp()
    try {
      const path = join(t.dir, "manifest.json")
      await writeFile(path, JSON.stringify({ ...validManifest(), entry: "/bin/echo" }), "utf8")
      let caught: DxtError | null = null
      try {
        await launchDxt(path, stubSpawner().port)
      } catch (e) {
        caught = e as DxtError
      }
      expect(caught?.kind).toBe("entry-escape")
    } finally {
      await t.cleanup()
    }
  })

  test("entry file missing → kind=entry-missing", async () => {
    const t = await tmp()
    try {
      const path = join(t.dir, "manifest.json")
      await writeFile(
        path,
        JSON.stringify({ ...validManifest(), entry: "nonexistent.mjs" }),
        "utf8",
      )
      let caught: DxtError | null = null
      try {
        await launchDxt(path, stubSpawner().port)
      } catch (e) {
        caught = e as DxtError
      }
      expect(caught?.kind).toBe("entry-missing")
    } finally {
      await t.cleanup()
    }
  })
})

describe("ADR-0162 DXT hellgate — C. Launch wiring", () => {
  test("args / env / allowLoadingUnsignedLibraries propagate to spawner", async () => {
    const t = await tmp()
    try {
      const entry = join(t.dir, "child.mjs")
      await writeFile(entry, "//noop", "utf8")
      const path = join(t.dir, "manifest.json")
      await writeFile(
        path,
        JSON.stringify({
          ...validManifest(),
          args: ["--flag", "value"],
          env: { CUSTOM_KEY: "v" },
          allowLoadingUnsignedLibraries: true,
        }),
        "utf8",
      )
      const s = stubSpawner()
      await launchDxt(path, s.port)
      expect(s.calls.length).toBe(1)
      const call = s.calls[0]
      if (!call) throw new Error("expected exactly one spawn call")
      expect(call.serviceName).toBe("echo-svc")
      expect(call.args).toEqual(["--flag", "value"])
      expect(call.env).toEqual({ CUSTOM_KEY: "v" })
      expect(call.allowLoadingUnsignedLibraries).toBe(true)
      expect(call.cwd).toBe(t.dir)
      expect(call.entry).toBe(entry)
    } finally {
      await t.cleanup()
    }
  })

  test("optional fields omitted when manifest omits them", async () => {
    const t = await tmp()
    try {
      const entry = join(t.dir, "child.mjs")
      await writeFile(entry, "//noop", "utf8")
      const path = join(t.dir, "manifest.json")
      await writeFile(path, JSON.stringify(validManifest()), "utf8")
      const s = stubSpawner()
      await launchDxt(path, s.port)
      const call = s.calls[0]
      if (!call) throw new Error("expected exactly one spawn call")
      expect(call.args).toBeUndefined()
      expect(call.env).toBeUndefined()
      expect(call.allowLoadingUnsignedLibraries).toBeUndefined()
    } finally {
      await t.cleanup()
    }
  })

  test("launchDxt returns a PluginHost instance", async () => {
    const t = await tmp()
    try {
      const entry = join(t.dir, "child.mjs")
      await writeFile(entry, "//noop", "utf8")
      const path = join(t.dir, "manifest.json")
      await writeFile(path, JSON.stringify(validManifest()), "utf8")
      const s = stubSpawner()
      const host = await launchDxt(path, s.port)
      // PluginHost surface methods exist.
      expect(typeof host.call).toBe("function")
      expect(typeof host.notify).toBe("function")
      expect(typeof host.stop).toBe("function")
    } finally {
      await t.cleanup()
    }
  })
})

describe("ADR-0162 DXT hellgate — D. Field bounds", () => {
  test("unicode in serviceName → kind=schema-mismatch", async () => {
    const t = await tmp()
    try {
      const path = join(t.dir, "manifest.json")
      await writeFile(path, JSON.stringify({ ...validManifest(), serviceName: "héllo" }), "utf8")
      let caught: DxtError | null = null
      try {
        await validateDxt(path)
      } catch (e) {
        caught = e as DxtError
      }
      expect(caught?.kind).toBe("schema-mismatch")
    } finally {
      await t.cleanup()
    }
  })
})
