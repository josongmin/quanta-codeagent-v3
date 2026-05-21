/**
 * Plugin loader unit tests (Cluster E / F13, ADR-0039).
 *
 * Real tmpdir fixtures (no virtual FS dep). ≥ 10 scenarios covering: missing
 * manifest, malformed JSON, bad Capability, valid load with/without
 * `.mcp.json`, skills enumeration, and discoverPlugins on nested layouts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  discoverPlugins,
  loadPluginManifest,
  PluginManifestError,
} from "../../src/skill/plugin-loader"

const baseInterface = {
  displayName: "Demo",
  shortDescription: "Demo plugin",
  longDescription: "Long form description.",
  developerName: "Quanta",
  category: "dev",
  capabilities: ["Read"],
  websiteURL: "https://example.com",
  privacyPolicyURL: "https://example.com/p",
  termsOfServiceURL: "https://example.com/t",
  logo: "logo.png",
  defaultPrompt: ["help"],
  brandColor: "#000000",
  screenshots: [],
}

const baseManifest = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: "demo",
  version: "0.0.1",
  description: "Demo",
  author: { name: "Quanta" },
  license: "MIT",
  keywords: [],
  interface: baseInterface,
  ...overrides,
})

let ROOT = ""
beforeAll(async () => {
  ROOT = await mkdtemp(join(tmpdir(), "qcav3-plugin-loader-"))
})
afterAll(async () => {
  if (ROOT) await rm(ROOT, { recursive: true, force: true })
})

const writePlugin = async (
  name: string,
  manifest: Record<string, unknown>,
  opts: { mcp?: string; skills?: string[] } = {},
): Promise<string> => {
  const dir = join(ROOT, name)
  await mkdir(join(dir, ".quanta-plugin"), { recursive: true })
  await writeFile(join(dir, ".quanta-plugin", "plugin.json"), JSON.stringify(manifest), "utf8")
  if (opts.mcp !== undefined) {
    await writeFile(join(dir, ".mcp.json"), opts.mcp, "utf8")
  }
  if (opts.skills !== undefined) {
    for (const s of opts.skills) {
      await mkdir(join(dir, "skills", s), { recursive: true })
      await writeFile(join(dir, "skills", s, "SKILL.md"), `---\nname: ${s}\n---\n`, "utf8")
    }
  }
  return dir
}

describe("loadPluginManifest", () => {
  test("loads a valid minimal plugin", async () => {
    const dir = await writePlugin("ok-minimal", baseManifest())
    const loaded = await loadPluginManifest(dir)
    expect(loaded.manifest.name).toBe("demo")
    expect(loaded.skillEntries).toEqual([])
    expect(loaded.mcpServers).toBeUndefined()
  })

  test("loads with valid .mcp.json", async () => {
    const dir = await writePlugin("ok-mcp", baseManifest(), {
      mcp: JSON.stringify({ mcpServers: { git: { command: "uvx", args: ["mcp-server-git"] } } }),
    })
    const loaded = await loadPluginManifest(dir)
    expect(loaded.mcpServers?.git?.command).toBe("uvx")
  })

  test("loads with multiple skills, sorted by name", async () => {
    const dir = await writePlugin("ok-skills", baseManifest(), {
      skills: ["zeta", "alpha", "mid"],
    })
    const loaded = await loadPluginManifest(dir)
    expect(loaded.skillEntries.map((s) => s.name)).toEqual(["alpha", "mid", "zeta"])
  })

  test("fails when the manifest file is missing", async () => {
    const dir = join(ROOT, "missing-manifest")
    await mkdir(dir, { recursive: true })
    let caught: unknown
    try {
      await loadPluginManifest(dir)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(PluginManifestError)
    expect((caught as PluginManifestError).cause).toBe("missing")
  })

  test("fails when the manifest JSON is malformed", async () => {
    const dir = join(ROOT, "bad-json")
    await mkdir(join(dir, ".quanta-plugin"), { recursive: true })
    await writeFile(join(dir, ".quanta-plugin", "plugin.json"), "{ not valid json", "utf8")
    let caught: unknown
    try {
      await loadPluginManifest(dir)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(PluginManifestError)
    expect((caught as PluginManifestError).cause).toBe("json")
  })

  test("fails when Capability value is invalid", async () => {
    const dir = await writePlugin(
      "bad-cap",
      baseManifest({ interface: { ...baseInterface, capabilities: ["Execute"] } }),
    )
    let caught: unknown
    try {
      await loadPluginManifest(dir)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(PluginManifestError)
    expect((caught as PluginManifestError).cause).toBe("schema")
  })

  test("fails when manifest has unknown top-level key (strict)", async () => {
    const dir = await writePlugin("strict-extra", baseManifest({ unknownTopKey: 1 }))
    let caught: unknown
    try {
      await loadPluginManifest(dir)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(PluginManifestError)
    expect((caught as PluginManifestError).cause).toBe("schema")
  })

  test("fails when .mcp.json present but malformed", async () => {
    const dir = await writePlugin("bad-mcp", baseManifest(), {
      mcp: JSON.stringify({ wrongRoot: 1 }),
    })
    let caught: unknown
    try {
      await loadPluginManifest(dir)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(PluginManifestError)
    expect((caught as PluginManifestError).cause).toBe("schema")
  })

  test(".mcp.json json-malformed surfaces as json cause", async () => {
    const dir = await writePlugin("bad-mcp-json", baseManifest(), { mcp: "{nope" })
    let caught: unknown
    try {
      await loadPluginManifest(dir)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(PluginManifestError)
    expect((caught as PluginManifestError).cause).toBe("json")
  })

  test("ignores plugin-name dirs without SKILL.md inside skills/", async () => {
    const dir = await writePlugin("partial-skills", baseManifest())
    await mkdir(join(dir, "skills", "no-skillmd"), { recursive: true })
    await mkdir(join(dir, "skills", "with-skillmd"), { recursive: true })
    await writeFile(join(dir, "skills", "with-skillmd", "SKILL.md"), "---\nname: x\n---\n", "utf8")
    const loaded = await loadPluginManifest(dir)
    expect(loaded.skillEntries.map((s) => s.name)).toEqual(["with-skillmd"])
  })
})

describe("discoverPlugins", () => {
  test("returns empty for a non-existent root", async () => {
    const got = await discoverPlugins(join(ROOT, "does-not-exist"))
    expect(got).toEqual([])
  })

  test("discovers nested plugins, ignores junk dirs", async () => {
    const root = await mkdtemp(join(tmpdir(), "qcav3-plugin-discover-"))
    try {
      // Three plugins at depths 1, 2, 3
      await mkdir(join(root, "a", ".quanta-plugin"), { recursive: true })
      await writeFile(
        join(root, "a", ".quanta-plugin", "plugin.json"),
        JSON.stringify(baseManifest({ name: "a" })),
        "utf8",
      )
      await mkdir(join(root, "nested", "b", ".quanta-plugin"), { recursive: true })
      await writeFile(
        join(root, "nested", "b", ".quanta-plugin", "plugin.json"),
        JSON.stringify(baseManifest({ name: "b" })),
        "utf8",
      )
      await mkdir(join(root, "nested", "deeper", "c", ".quanta-plugin"), { recursive: true })
      await writeFile(
        join(root, "nested", "deeper", "c", ".quanta-plugin", "plugin.json"),
        JSON.stringify(baseManifest({ name: "c" })),
        "utf8",
      )
      // Junk that must be skipped:
      await mkdir(join(root, "node_modules", "pkg", ".quanta-plugin"), { recursive: true })
      await writeFile(
        join(root, "node_modules", "pkg", ".quanta-plugin", "plugin.json"),
        "should-never-be-loaded",
        "utf8",
      )
      await mkdir(join(root, ".hidden", ".quanta-plugin"), { recursive: true })
      await writeFile(
        join(root, ".hidden", ".quanta-plugin", "plugin.json"),
        "should-never-be-loaded",
        "utf8",
      )

      const got = await discoverPlugins(root)
      const names = got.map((d) => d.dir.replace(`${root}/`, ""))
      expect(names).toContain("a")
      expect(names).toContain("nested/b")
      expect(names).toContain("nested/deeper/c")
      expect(names).not.toContain("node_modules/pkg")
      expect(names).not.toContain(".hidden")
      // Sorted output for determinism
      const sorted = [...names].sort()
      expect(names).toEqual(sorted)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("caps recursion depth (no plugin beyond depth 4 is found)", async () => {
    const root = await mkdtemp(join(tmpdir(), "qcav3-plugin-deep-"))
    try {
      // Bury a plugin at depth 6 (l1/l2/l3/l4/l5/plug)
      const deep = join(root, "l1", "l2", "l3", "l4", "l5", "plug")
      await mkdir(join(deep, ".quanta-plugin"), { recursive: true })
      await writeFile(
        join(deep, ".quanta-plugin", "plugin.json"),
        JSON.stringify(baseManifest()),
        "utf8",
      )
      const got = await discoverPlugins(root)
      expect(got).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
