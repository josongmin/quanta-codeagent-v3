/**
 * Plugin manifest schema unit tests (Cluster E / F13, ADR-0039).
 *
 * Direct Zod-level assertions: feed candidate JSON into `PluginManifestSchema`
 * and assert valid/invalid outcomes. ≥ 20 cases total (positive + negative).
 */
import { describe, expect, test } from "bun:test"
import {
  CapabilitySchema,
  MCPRootSchema,
  MCPServerSpecSchema,
  PluginAuthorSchema,
  PluginInterfaceSchema,
  PluginManifestSchema,
} from "../../src/skill/plugin-manifest"

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

describe("CapabilitySchema (closed enum)", () => {
  test("accepts 'Interactive'", () => {
    expect(CapabilitySchema.safeParse("Interactive").success).toBe(true)
  })
  test("accepts 'Read'", () => {
    expect(CapabilitySchema.safeParse("Read").success).toBe(true)
  })
  test("accepts 'Write'", () => {
    expect(CapabilitySchema.safeParse("Write").success).toBe(true)
  })
  test("rejects 'Execute' (not in closed set)", () => {
    expect(CapabilitySchema.safeParse("Execute").success).toBe(false)
  })
  test("rejects lowercased 'read'", () => {
    expect(CapabilitySchema.safeParse("read").success).toBe(false)
  })
})

describe("MCPServerSpecSchema", () => {
  test("accepts minimal valid (command + args)", () => {
    const r = MCPServerSpecSchema.safeParse({ command: "node", args: [] })
    expect(r.success).toBe(true)
  })
  test("accepts with env", () => {
    const r = MCPServerSpecSchema.safeParse({
      command: "uvx",
      args: ["mcp-server-git"],
      env: { GIT_HOME: "/tmp" },
    })
    expect(r.success).toBe(true)
  })
  test("rejects empty command", () => {
    const r = MCPServerSpecSchema.safeParse({ command: "", args: [] })
    expect(r.success).toBe(false)
  })
  test("rejects args as string (must be array)", () => {
    const r = MCPServerSpecSchema.safeParse({ command: "node", args: "x" })
    expect(r.success).toBe(false)
  })
  test("rejects unknown extra key (strict)", () => {
    const r = MCPServerSpecSchema.safeParse({ command: "node", args: [], extra: 1 })
    expect(r.success).toBe(false)
  })
})

describe("PluginAuthorSchema", () => {
  test("accepts minimal (name only)", () => {
    const r = PluginAuthorSchema.safeParse({ name: "Alice" })
    expect(r.success).toBe(true)
  })
  test("accepts with email + url", () => {
    const r = PluginAuthorSchema.safeParse({
      name: "Alice",
      email: "a@b.com",
      url: "https://b.com",
    })
    expect(r.success).toBe(true)
  })
  test("rejects empty name", () => {
    expect(PluginAuthorSchema.safeParse({ name: "" }).success).toBe(false)
  })
  test("rejects malformed email", () => {
    expect(PluginAuthorSchema.safeParse({ name: "x", email: "not-an-email" }).success).toBe(false)
  })
  test("rejects malformed url", () => {
    expect(PluginAuthorSchema.safeParse({ name: "x", url: "not a url" }).success).toBe(false)
  })
})

describe("PluginInterfaceSchema", () => {
  test("accepts a valid interface block", () => {
    expect(PluginInterfaceSchema.safeParse(VALID_INTERFACE).success).toBe(true)
  })
  test("rejects empty displayName", () => {
    const bad = { ...VALID_INTERFACE, displayName: "" }
    expect(PluginInterfaceSchema.safeParse(bad).success).toBe(false)
  })
  test("rejects missing capabilities array", () => {
    const { capabilities: _omit, ...rest } = VALID_INTERFACE
    expect(PluginInterfaceSchema.safeParse(rest).success).toBe(false)
  })
  test("rejects capability value 'Execute'", () => {
    const bad = { ...VALID_INTERFACE, capabilities: ["Execute"] }
    expect(PluginInterfaceSchema.safeParse(bad).success).toBe(false)
  })
  test("rejects malformed websiteURL", () => {
    const bad = { ...VALID_INTERFACE, websiteURL: "not a url" }
    expect(PluginInterfaceSchema.safeParse(bad).success).toBe(false)
  })
  test("accepts optional composerIcon", () => {
    const ok = { ...VALID_INTERFACE, composerIcon: "icon.png" }
    expect(PluginInterfaceSchema.safeParse(ok).success).toBe(true)
  })
})

describe("PluginManifestSchema", () => {
  test("accepts a minimal valid manifest", () => {
    const r = PluginManifestSchema.safeParse(VALID_MANIFEST)
    expect(r.success).toBe(true)
  })

  test("accepts with mcpServers and skills lists", () => {
    const r = PluginManifestSchema.safeParse({
      ...VALID_MANIFEST,
      mcpServers: { git: { command: "uvx", args: ["mcp-server-git"] } },
      skills: ["foo", "bar"],
    })
    expect(r.success).toBe(true)
  })

  test("rejects bad name casing", () => {
    const bad = { ...VALID_MANIFEST, name: "BadCaseName" }
    expect(PluginManifestSchema.safeParse(bad).success).toBe(false)
  })

  test("rejects unknown extra top-level key (strict mode)", () => {
    const bad = { ...VALID_MANIFEST, extraneous: "no" }
    expect(PluginManifestSchema.safeParse(bad).success).toBe(false)
  })

  test("rejects missing license", () => {
    const { license: _omit, ...rest } = VALID_MANIFEST
    expect(PluginManifestSchema.safeParse(rest).success).toBe(false)
  })

  test("rejects missing interface", () => {
    const { interface: _omit, ...rest } = VALID_MANIFEST
    expect(PluginManifestSchema.safeParse(rest).success).toBe(false)
  })

  test("rejects empty version", () => {
    const bad = { ...VALID_MANIFEST, version: "" }
    expect(PluginManifestSchema.safeParse(bad).success).toBe(false)
  })

  test("rejects keywords as non-array", () => {
    const bad = { ...VALID_MANIFEST, keywords: "demo" }
    expect(PluginManifestSchema.safeParse(bad).success).toBe(false)
  })

  test("accepts optional homepage url", () => {
    const ok = { ...VALID_MANIFEST, homepage: "https://example.com/p" }
    expect(PluginManifestSchema.safeParse(ok).success).toBe(true)
  })

  test("rejects bad homepage url", () => {
    const bad = { ...VALID_MANIFEST, homepage: "not a url" }
    expect(PluginManifestSchema.safeParse(bad).success).toBe(false)
  })
})

describe("MCPRootSchema", () => {
  test("accepts a single-server map", () => {
    const r = MCPRootSchema.safeParse({
      mcpServers: { git: { command: "uvx", args: ["mcp-server-git"] } },
    })
    expect(r.success).toBe(true)
  })

  test("rejects unknown top-level key (strict)", () => {
    const r = MCPRootSchema.safeParse({
      mcpServers: {},
      garbage: 1,
    })
    expect(r.success).toBe(false)
  })

  test("rejects server with missing command", () => {
    const r = MCPRootSchema.safeParse({
      mcpServers: { bad: { args: [] } as unknown as { command: string; args: string[] } },
    })
    expect(r.success).toBe(false)
  })
})
