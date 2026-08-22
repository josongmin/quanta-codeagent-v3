/**
 * §2.4 e2e HELLGATE — a real plugin manifest declaring `hooks`/`apps` pointers
 * loads from disk through `loadPluginManifest`, and the gated loader resolves
 * the pointers under the plugin dir (escape pointers dropped).
 *
 * Drives the REAL seam: real tmpdir, real `.quanta-plugin/plugin.json`, the
 * actual `loadPluginManifest` → `resolvePluginPointers` path, both with the
 * `QUANTA_PLUGIN_POINTERS` gate OFF (byte-identical: no `pointers`) and ON.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadPluginManifest } from "../../src/skill/plugin-loader"

const baseInterface = {
  displayName: "Demo",
  shortDescription: "Demo plugin",
  longDescription: "Long description.",
  developerName: "Quanta",
  category: "dev",
  capabilities: ["Read", "Interactive"],
  websiteURL: "https://example.com",
  privacyPolicyURL: "https://example.com/p",
  termsOfServiceURL: "https://example.com/t",
  logo: "logo.png",
  defaultPrompt: [],
  brandColor: "#abcdef",
  screenshots: [],
}

let ROOT = ""
let PLUGIN_DIR = ""

beforeAll(async () => {
  ROOT = await mkdtemp(join(tmpdir(), "qcav3-plugin-pointers-e2e-"))
  PLUGIN_DIR = join(ROOT, "withhooks")
  await mkdir(join(PLUGIN_DIR, ".quanta-plugin"), { recursive: true })
  // a manifest declaring a STRING hooks pointer, an apps array, AND an
  // escaping app pointer that must be dropped.
  const manifest = {
    name: "withhooks",
    version: "0.0.1",
    description: "plugin with hooks/apps pointers",
    author: { name: "Quanta" },
    license: "MIT",
    keywords: [],
    hooks: "./hooks/hooks.json",
    apps: ["./apps/dashboard", "../../../escape-outside"],
    interface: baseInterface,
  }
  await writeFile(
    join(PLUGIN_DIR, ".quanta-plugin", "plugin.json"),
    JSON.stringify(manifest),
    "utf8",
  )
})

afterAll(async () => {
  if (ROOT) await rm(ROOT, { recursive: true, force: true })
})

const ON = { QUANTA_PLUGIN_POINTERS: "1" }

describe("§2.4 plugin hooks/apps pointers — e2e load", () => {
  test("BYTE-IDENTITY: no env passed ⇒ manifest still loads, NO pointers attached", async () => {
    // the host opts in by passing env; the default call resolves nothing.
    const loaded = await loadPluginManifest(PLUGIN_DIR)
    expect(loaded.manifest.name).toBe("withhooks")
    // the fields are PARSED onto the manifest (additive schema) ...
    expect(loaded.manifest.hooks).toBe("./hooks/hooks.json")
    // ... but the loader resolves NOTHING (no auto-load surface) when OFF.
    expect(loaded.pointers).toBeUndefined()
  })

  test("BYTE-IDENTITY: env passed but gate OFF ⇒ still no pointers", async () => {
    const loaded = await loadPluginManifest(PLUGIN_DIR, {})
    expect(loaded.pointers).toBeUndefined()
  })

  test("gate ON ⇒ loader resolves the hooks path + in-dir app, DROPS the escape", async () => {
    const loaded = await loadPluginManifest(PLUGIN_DIR, ON)
    expect(loaded.pointers).toBeDefined()
    expect(loaded.pointers?.hooksPath).toBe(join(PLUGIN_DIR, "hooks", "hooks.json"))
    // the `../../../escape-outside` app pointer escapes the plugin dir ⇒ dropped;
    // only the in-dir dashboard survives (RED-ON-INJECTION: path traversal guard).
    expect(loaded.pointers?.appPaths).toEqual([join(PLUGIN_DIR, "apps", "dashboard")])
  })

  test("gate ON, a manifest WITHOUT pointer fields ⇒ empty resolution object", async () => {
    const dir = join(ROOT, "nohooks")
    await mkdir(join(dir, ".quanta-plugin"), { recursive: true })
    await writeFile(
      join(dir, ".quanta-plugin", "plugin.json"),
      JSON.stringify({
        name: "nohooks",
        version: "0.0.1",
        description: "no pointers",
        author: { name: "Quanta" },
        license: "MIT",
        keywords: [],
        interface: baseInterface,
      }),
      "utf8",
    )
    const loaded = await loadPluginManifest(dir, ON)
    // gate ON but nothing declared ⇒ resolvePluginPointers returns {} ⇒ attached
    // as an empty object (no hooksPath / appPaths).
    expect(loaded.pointers).toEqual({})
  })
})
