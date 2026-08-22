/**
 * jun-7-misc 02 — manifest codex-compat END-TO-END hellgate.
 *
 * Ticket: docs/tickets/misc-jun-7/02-manifest-codex-compat.md
 *
 * The sibling `manifest-codex-compat-hellgate.test.ts` exercises the SCHEMA
 * entry (`parsePluginManifest`), the normalizer in isolation, and the skill
 * `discoverSkills` read site. This file closes the gap CONCLUSIVELY by driving
 * the REAL plugin-load seam end-to-end — `loadPluginManifest(pluginDir)` — the
 * actual disk-reading loader the host calls. It reads a real codex `plugin.json`
 * laid out on disk in the canonical `.quanta-plugin/` layout, routes it through
 * the gated `parsePluginManifest` inside the loader, and asserts a fully-
 * resolved `LoadedPlugin`. No schema is invoked directly here — only the
 * production loader function — so a regression in the wiring (loader bypassing
 * the gated entry, the knob not threaded, the coercion not reaching the loader)
 * fails LOUDLY.
 *
 * Three proofs (the e2e hellgate contract):
 *   1. REAL-PATH gap-closed: with the knob ON, `loadPluginManifest` on a real
 *      codex plugin root (string `skills`, top-level `repository`) SUCCEEDS and
 *      returns the coerced `skills: ["./skills/"]` + captured `repository` —
 *      AND the same root drives `discoverSkills` so the codex skill's kebab
 *      `allowed-tools` block-list reaches the runtime tool-scoping site.
 *   2. DEFAULT-OFF BYTE-IDENTITY: with the knob unset, `loadPluginManifest` on
 *      the identical disk layout THROWS the same `PluginManifestError("schema")`
 *      it throws today — the codex artifact is rejected exactly as before, and a
 *      quanta-native plugin loads to a byte-identical `manifest` object across
 *      armed/unarmed. No new field/coercion appears on the legacy path.
 *   3. RED-ON-INJECTION: the loader still hard-fails a hostile inner block (a
 *      typo'd `mcpServers` descriptor key, an unknown `interface.capabilities`
 *      enum member) EVEN WHEN ARMED — the outer relax never loosens the inner
 *      strict security boundary; and a broad kebab `allowed-tools` block-list
 *      cannot widen a narrow native `allowedTools` at the live discovery site.
 *
 * If the gated seam is removed (loader stops routing through `parsePluginManifest`,
 * the knob is ignored, inner `.strict()` reverts, or native-wins is broken) a
 * test here MUST fail.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { __resetRuntimeConfig } from "@/shared"
import { discoverSkills } from "@/skill/discover"
import { loadPluginManifest, PluginManifestError } from "@/skill/plugin-loader"
import { PLUGIN_DIR_NAME, PLUGIN_MANIFEST_FILE } from "@/skill/plugin-manifest"

const FIX = join(import.meta.dir, "..", "fixtures", "manifest-compat")
const readFixJson = (rel: string): unknown =>
  JSON.parse(readFileSync(join(FIX, rel), "utf8")) as unknown

const armCompat = (): void => {
  process.env.QUANTA_MANIFEST_COMPAT = "1"
  __resetRuntimeConfig()
}
const disarmCompat = (): void => {
  delete process.env.QUANTA_MANIFEST_COMPAT
  __resetRuntimeConfig()
}

beforeEach(disarmCompat)
afterEach(disarmCompat)

/** Lay a `plugin.json` object (and optional skills) out on disk in the canonical
 *  `<root>/.quanta-plugin/plugin.json` layout that `loadPluginManifest` expects,
 *  returning the plugin ROOT dir. Caller cleans up. */
const writePluginRoot = (
  manifest: unknown,
  skills?: Record<string, string>,
): { root: string; cleanup: () => void } => {
  const root = mkdtempSync(join(tmpdir(), "manifest-e2e-"))
  mkdirSync(join(root, PLUGIN_DIR_NAME), { recursive: true })
  writeFileSync(join(root, PLUGIN_DIR_NAME, PLUGIN_MANIFEST_FILE), JSON.stringify(manifest))
  if (skills) {
    for (const [name, md] of Object.entries(skills)) {
      mkdirSync(join(root, "skills", name), { recursive: true })
      writeFileSync(join(root, "skills", name, "SKILL.md"), md)
    }
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

const NATIVE_MANIFEST = {
  name: "native-demo",
  version: "1.0.0",
  description: "a quanta-native plugin",
  author: { name: "me" },
  license: "MIT",
  keywords: ["a", "b"],
  skills: ["./skills/x"],
  interface: {
    displayName: "Demo",
    shortDescription: "d",
    longDescription: "dd",
    developerName: "me",
    category: "x",
    capabilities: ["Read"],
    websiteURL: "https://e.com/",
    privacyPolicyURL: "https://e.com/p",
    termsOfServiceURL: "https://e.com/t",
    logo: "l",
    defaultPrompt: [],
    brandColor: "#000",
    screenshots: [],
  },
}

// ───────────────────────────────────────────────────────────────────────────
// 1. REAL-PATH: loadPluginManifest ingests a real codex plugin when armed
// ───────────────────────────────────────────────────────────────────────────
describe("e2e: loadPluginManifest drives the real codex plugin seam (armed)", () => {
  test("real codex spreadsheets plugin.json loads from disk; skills coerced + repository captured", async () => {
    armCompat()
    const { root, cleanup } = writePluginRoot(readFixJson("plugins/spreadsheets/plugin.json"))
    try {
      const loaded = await loadPluginManifest(root)
      // The string `skills: "./skills/"` was coerced to a 1-element array by the
      // gated normalizer INSIDE the loader — proving the seam is wired end-to-end.
      expect(loaded.manifest.skills).toEqual(["./skills/"])
      // top-level `repository` (rejected today) is now captured on the manifest.
      expect((loaded.manifest as { repository?: unknown }).repository).toBe(
        "https://github.com/openai/openai",
      )
      // inner strict interface enum survived untouched.
      expect(loaded.manifest.interface.capabilities).toEqual(["Interactive", "Write"])
      expect(loaded.manifest.name).toBe("spreadsheets")
    } finally {
      cleanup()
    }
  })

  test("real codex browser plugin.json loads from disk when armed", async () => {
    armCompat()
    const { root, cleanup } = writePluginRoot(readFixJson("plugins/browser/plugin.json"))
    try {
      const loaded = await loadPluginManifest(root)
      expect(loaded.manifest.skills).toEqual(["./skills/"])
    } finally {
      cleanup()
    }
  })

  test("the SAME codex plugin root drives discoverSkills: rr2 kebab allow-list reaches tool-scoping", async () => {
    // End-to-end across BOTH seams the ticket fixes: the plugin manifest loads
    // (string skills) AND the codex skill's kebab `allowed-tools` block-list is
    // captured at the runtime scoping site (the latent silent-drop safety bug).
    armCompat()
    const { root, cleanup } = writePluginRoot(readFixJson("plugins/spreadsheets/plugin.json"), {
      rr2: readFileSync(join(FIX, "skills", "rr2", "SKILL.md"), "utf8"),
      briefing: readFileSync(join(FIX, "skills", "briefing", "SKILL.md"), "utf8"),
    })
    try {
      const loaded = await loadPluginManifest(root)
      // The loader enumerates the on-disk skill dirs…
      expect(loaded.skillEntries.map((s) => s.name).sort()).toEqual(["briefing", "rr2"])
      // …and the SAME skills dir, read by discovery, scopes rr2's tools (no drop).
      const skills = await discoverSkills(join(root, "skills"))
      const rr2 = skills.find((s) => s.name === "rr2")
      expect(rr2?.tools).toEqual(["Read", "Grep", "Bash", "Edit"])
      const briefing = skills.find((s) => s.name === "briefing")
      expect(briefing).toBeDefined()
      expect(briefing?.tools).toBeUndefined() // name+description only ⇒ no tools
    } finally {
      cleanup()
    }
  })
})

// ───────────────────────────────────────────────────────────────────────────
// 2. DEFAULT-OFF BYTE-IDENTITY: the real loader rejects/loads exactly as today
// ───────────────────────────────────────────────────────────────────────────
describe("e2e: DEFAULT-OFF byte-identity through the real loader", () => {
  test("RATCHET: codex plugin.json on disk is REJECTED by loadPluginManifest with a schema error (unarmed)", async () => {
    // knob unset (beforeEach). The loader must throw the SAME PluginManifestError
    // it throws today — the string `skills` / top-level `repository` are hard
    // schema failures on the strict path. This is the no-regression invariant.
    const { root, cleanup } = writePluginRoot(readFixJson("plugins/spreadsheets/plugin.json"))
    try {
      let thrown: unknown
      try {
        await loadPluginManifest(root)
      } catch (e) {
        thrown = e
      }
      expect(thrown).toBeInstanceOf(PluginManifestError)
      expect((thrown as PluginManifestError).cause).toBe("schema")
    } finally {
      cleanup()
    }
  })

  test("RATCHET: quanta-native plugin loads to a BYTE-IDENTICAL manifest armed vs unarmed", async () => {
    const { root, cleanup } = writePluginRoot(NATIVE_MANIFEST)
    try {
      disarmCompat()
      const off = await loadPluginManifest(root)
      armCompat()
      const on = await loadPluginManifest(root)
      // The parsed manifest object is identical across the knob — no new field,
      // no coercion, no `repository` materialising on a file that omits it.
      expect(on.manifest).toEqual(off.manifest)
      expect(off.manifest.skills).toEqual(["./skills/x"]) // array untouched
      expect((on.manifest as { repository?: unknown }).repository).toBeUndefined()
      expect((off.manifest as { repository?: unknown }).repository).toBeUndefined()
      // No phantom keys appear on the armed parse vs the unarmed one.
      expect(Object.keys(on.manifest).sort()).toEqual(Object.keys(off.manifest).sort())
    } finally {
      cleanup()
    }
  })
})

// ───────────────────────────────────────────────────────────────────────────
// 3. RED-ON-INJECTION: inner strict boundary + anti-smuggle hold through the
//    real loader even when armed
// ───────────────────────────────────────────────────────────────────────────
describe("e2e: red-on-injection through the real loader (armed)", () => {
  test("a typo'd inner mcpServers descriptor key STILL hard-fails the loader (armed)", async () => {
    armCompat()
    const raw = readFixJson("plugins/spreadsheets/plugin.json") as Record<string, unknown>
    const hostile = { ...raw, mcpServers: { evil: { command: "x", args: [], sneak: "rm -rf /" } } }
    const { root, cleanup } = writePluginRoot(hostile)
    try {
      let thrown: unknown
      try {
        await loadPluginManifest(root)
      } catch (e) {
        thrown = e
      }
      // The outer relax did NOT loosen the inner MCP-server `.strict()`: an
      // unknown descriptor key (a server-spawn injection surface) is still a
      // loud schema error. If inner `.strict()` reverts, this goes green ⇒ red.
      expect(thrown).toBeInstanceOf(PluginManifestError)
      expect((thrown as PluginManifestError).cause).toBe("schema")
    } finally {
      cleanup()
    }
  })

  test("an unknown interface.capabilities enum member STILL hard-fails the loader (armed)", async () => {
    armCompat()
    const raw = readFixJson("plugins/spreadsheets/plugin.json") as {
      interface: Record<string, unknown>
    }
    const hostile = {
      ...raw,
      interface: { ...raw.interface, capabilities: ["Interactive", "Root"] },
    }
    const { root, cleanup } = writePluginRoot(hostile)
    try {
      let thrown: unknown
      try {
        await loadPluginManifest(root)
      } catch (e) {
        thrown = e
      }
      expect(thrown).toBeInstanceOf(PluginManifestError)
      expect((thrown as PluginManifestError).cause).toBe("schema")
    } finally {
      cleanup()
    }
  })

  test("a top-level `capabilities` cannot be surfaced off the loaded manifest (stripped, armed)", async () => {
    armCompat()
    const raw = readFixJson("plugins/spreadsheets/plugin.json") as Record<string, unknown>
    const hostile = { ...raw, capabilities: ["Admin", "Root"] }
    const { root, cleanup } = writePluginRoot(hostile)
    try {
      const loaded = await loadPluginManifest(root)
      // The unknown top-level `capabilities` is stripped — NOT readable on the
      // loaded manifest. The only capability surface is the inner strict enum.
      expect(loaded.manifest).not.toHaveProperty("capabilities")
      expect(loaded.manifest.interface.capabilities).toEqual(["Interactive", "Write"])
    } finally {
      cleanup()
    }
  })

  test("a broad kebab `allowed-tools` CANNOT widen a narrow native allowedTools at the live discovery site (armed)", async () => {
    armCompat()
    const md = [
      "---",
      "name: collide",
      "description: d",
      'allowedTools: ["Read"]', // narrow native
      "user-invocable: true",
      "allowed-tools:", // broad kebab block-list
      "  - Read",
      "  - Write",
      "  - Bash",
      "---",
      "body",
    ].join("\n")
    const { root, cleanup } = writePluginRoot(NATIVE_MANIFEST, { collide: md })
    try {
      const skills = await discoverSkills(join(root, "skills"))
      const collide = skills.find((s) => s.name === "collide")
      // Native-wins anti-smuggle holds at the runtime tool-scoping read site:
      // the broad kebab block-list does NOT widen the grant. If native-wins is
      // broken, `tools` becomes the broad set ⇒ this fails.
      expect(collide?.tools).toEqual(["Read"])
    } finally {
      cleanup()
    }
  })
})
