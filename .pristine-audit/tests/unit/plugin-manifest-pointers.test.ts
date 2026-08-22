/**
 * §2.4 — plugin manifest `hooks`/`apps` pointer fields + loader resolution.
 *
 * SOTA mechanism (Claude Code `.claude-plugin/plugin.json`): a plugin manifest
 * may declare pointer fields — `hooks` (a path to a hooks config, or an inline
 * hooks config) and `apps` (folder pointers the harness auto-loads). The loader
 * resolves the pointers (relative to the plugin dir) so the host can auto-load
 * the referenced config without hand-editing `settings.json`.
 *
 * Discipline:
 *  - additive optional fields ⇒ a manifest WITHOUT them parses identically
 *    (byte-identity);
 *  - pointer RESOLUTION (path-join + escape guard) is gated by
 *    `QUANTA_PLUGIN_POINTERS` (default-OFF ⇒ loader output byte-identical).
 */
import { describe, expect, test } from "bun:test"
import { resolvePluginPointers } from "../../src/skill/plugin-loader"
import { PluginManifestSchema, PluginPointerHooksSchema } from "../../src/skill/plugin-manifest"

const VALID_INTERFACE = {
  displayName: "Quanta Demo",
  shortDescription: "Demo plugin",
  longDescription: "A longer description of the demo plugin.",
  developerName: "Quanta",
  category: "developer-tools",
  capabilities: ["Interactive", "Read"],
  websiteURL: "https://example.com",
  privacyPolicyURL: "https://example.com/privacy",
  termsOfServiceURL: "https://example.com/tos",
  logo: "assets/logo.png",
  defaultPrompt: ["help"],
  brandColor: "#FF8800",
  screenshots: [],
}

const VALID_MANIFEST = {
  name: "quanta-demo",
  version: "1.0.0",
  description: "Demo plugin manifest.",
  author: { name: "Quanta", email: "team@example.com" },
  license: "MIT",
  keywords: ["demo", "plugin"],
  interface: VALID_INTERFACE,
}

describe("§2.4 plugin manifest schema — hooks/apps fields", () => {
  test("byte-identity: a manifest WITHOUT hooks/apps still parses (no field added)", () => {
    const r = PluginManifestSchema.safeParse(VALID_MANIFEST)
    expect(r.success).toBe(true)
    if (r.success) {
      expect("hooks" in r.data).toBe(false)
      expect("apps" in r.data).toBe(false)
    }
  })

  test("accepts hooks as a string path pointer", () => {
    const r = PluginManifestSchema.safeParse({ ...VALID_MANIFEST, hooks: "./hooks/hooks.json" })
    expect(r.success).toBe(true)
  })

  test("accepts hooks as an inline event→matcher config object", () => {
    const r = PluginManifestSchema.safeParse({
      ...VALID_MANIFEST,
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }],
      },
    })
    expect(r.success).toBe(true)
  })

  test("accepts apps as an array of folder pointers", () => {
    const r = PluginManifestSchema.safeParse({
      ...VALID_MANIFEST,
      apps: ["./apps/foo", "./apps/bar"],
    })
    expect(r.success).toBe(true)
  })

  test("accepts apps as a single string pointer", () => {
    const r = PluginManifestSchema.safeParse({ ...VALID_MANIFEST, apps: "./apps" })
    expect(r.success).toBe(true)
  })

  test("rejects hooks of wrong type (number)", () => {
    const r = PluginManifestSchema.safeParse({ ...VALID_MANIFEST, hooks: 7 })
    expect(r.success).toBe(false)
  })

  test("rejects apps of wrong type (number)", () => {
    const r = PluginManifestSchema.safeParse({ ...VALID_MANIFEST, apps: 7 })
    expect(r.success).toBe(false)
  })

  test("inline hooks schema rejects an unknown hook action type (strict)", () => {
    const r = PluginPointerHooksSchema.safeParse({
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "rce", command: "rm -rf /" }] }],
    })
    expect(r.success).toBe(false)
  })
})

describe("§2.4 resolvePluginPointers — escape guard + default-OFF", () => {
  const PLUGIN_DIR = "/tmp/plug"
  const OFF = {} as Record<string, string | undefined>
  const ON = { QUANTA_PLUGIN_POINTERS: "1" }

  test("default-OFF: gate absent ⇒ returns undefined (no resolution)", () => {
    const out = resolvePluginPointers(PLUGIN_DIR, { hooks: "./hooks.json", apps: "./apps" }, OFF)
    expect(out).toBeUndefined()
  })

  test("gate ON: resolves string hooks path + apps array under the plugin dir", () => {
    const out = resolvePluginPointers(
      PLUGIN_DIR,
      { hooks: "./hooks/hooks.json", apps: ["./apps/a", "./apps/b"] },
      ON,
    )
    expect(out).toBeDefined()
    expect(out?.hooksPath).toBe("/tmp/plug/hooks/hooks.json")
    expect(out?.appPaths).toEqual(["/tmp/plug/apps/a", "/tmp/plug/apps/b"])
    expect(out?.hooksInline).toBeUndefined()
  })

  test("gate ON: inline hooks config is surfaced as hooksInline (no path)", () => {
    const inline = {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command" as const, command: "x" }] }],
    }
    const out = resolvePluginPointers(PLUGIN_DIR, { hooks: inline }, ON)
    expect(out?.hooksInline).toEqual(inline)
    expect(out?.hooksPath).toBeUndefined()
  })

  test("RED-ON-INJECTION: a `../` escape pointer is dropped, never resolved outside the dir", () => {
    const out = resolvePluginPointers(
      PLUGIN_DIR,
      { hooks: "../../etc/evil.json", apps: ["./ok", "../../../escape"] },
      ON,
    )
    // escape hooks path must be dropped (never points outside /tmp/plug)
    expect(out?.hooksPath).toBeUndefined()
    // only the in-dir app survives
    expect(out?.appPaths).toEqual(["/tmp/plug/ok"])
  })

  test("NO-THROW: nothing declared ⇒ empty resolution object (gate ON)", () => {
    expect(resolvePluginPointers(PLUGIN_DIR, {}, ON)).toEqual({})
  })
})
