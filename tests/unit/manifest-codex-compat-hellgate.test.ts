/**
 * jun-7-misc 02 — manifest codex-compat hellgate.
 *
 * Ticket: docs/tickets/misc-jun-7/02-manifest-codex-compat.md (§7 test plan).
 *
 * Asserts the codex-shape INGEST compat layer, gated by the strict
 * `QUANTA_MANIFEST_COMPAT` (`=== "1"`) knob:
 *   1. Real codex `plugin.json` (string `skills`, top-level `repository`) parses
 *      ONLY when armed; coerces `skills → ["./skills/"]`, captures `repository`.
 *   2. Real codex `SKILL.md` (kebab `allowed-tools` BLOCK-LIST, kebab
 *      `user-invocable`) parses ONLY when armed; the tool allowlist is CAPTURED,
 *      not silently dropped.
 *   3. DEFAULT-OFF BYTE-IDENTITY: with the knob unset every input behaves
 *      exactly as before the ticket (real codex artifacts REJECT; quanta-native
 *      files parse identically).
 *   4. RED-ON-INJECTION security: an unknown/renamed kebab key cannot smuggle a
 *      tool/permission grant; native camel always wins; inner strict blocks
 *      still hard-fail.
 *
 * Red-on-injection standard: if the compat seam is removed (knob ignored, or
 * the rename map widened, or `.strip()` reverted to `.passthrough()`), a test
 * here MUST fail.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { __resetRuntimeConfig } from "@/shared"
import { discoverSkills } from "@/skill/discover"
import { parseFrontmatter } from "@/skill/frontmatter"
import {
  normalizePluginManifest,
  normalizeSkillFrontmatter,
  SKILL_KEBAB_RENAME,
} from "@/skill/manifest-compat"
import { PluginManifestSchema, parsePluginManifest } from "@/skill/plugin-manifest"
import { parseSkillMarkdown } from "@/skill/skill-frontmatter"

const FIX = join(import.meta.dir, "..", "fixtures", "manifest-compat")
const readFix = (rel: string): string => readFileSync(join(FIX, rel), "utf8")
const readJson = (rel: string): unknown => JSON.parse(readFix(rel))

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

// ─────────────────────────────────────────────────────────────────────────────
// 1. Real codex plugin.json — parses ONLY when armed
// ─────────────────────────────────────────────────────────────────────────────
describe("plugin.json codex-compat", () => {
  test("spreadsheets plugin.json parses when armed; skills coerced, repository captured", () => {
    armCompat()
    const raw = readJson("plugins/spreadsheets/plugin.json")
    const parsed = parsePluginManifest(raw)
    expect(parsed.success).toBe(true)
    if (!parsed.success) throw new Error("unreachable")
    expect(parsed.data.skills).toEqual(["./skills/"])
    expect((parsed.data as { repository?: unknown }).repository).toBe(
      "https://github.com/openai/openai",
    )
  })

  test("browser plugin.json (string skills + repository) parses when armed", () => {
    armCompat()
    const parsed = parsePluginManifest(readJson("plugins/browser/plugin.json"))
    expect(parsed.success).toBe(true)
    if (!parsed.success) throw new Error("unreachable")
    expect(parsed.data.skills).toEqual(["./skills/"])
  })

  // DEFAULT-OFF BYTE-IDENTITY: real codex plugin.json REJECTS exactly as today.
  test("RATCHET default-OFF: codex plugin.json REJECTED (string skills + repository)", () => {
    // knob unset (beforeEach). parsePluginManifest === strict schema path.
    const raw = readJson("plugins/spreadsheets/plugin.json")
    const viaEntry = parsePluginManifest(raw)
    const viaStrict = PluginManifestSchema.safeParse(raw)
    expect(viaEntry.success).toBe(false)
    expect(viaStrict.success).toBe(false)
    // The default-OFF entry MUST be byte-identical to the strict schema result:
    // same success flag (the load-bearing no-regression invariant).
    expect(viaEntry.success).toBe(viaStrict.success)
  })

  test("RATCHET default-OFF: quanta-native plugin (array skills, no repository) parses identically", () => {
    const native = {
      name: "demo",
      version: "1.0.0",
      description: "demo",
      author: { name: "me" },
      license: "MIT",
      keywords: [],
      skills: ["./skills/a", "./skills/b"],
      interface: {
        displayName: "Demo",
        shortDescription: "d",
        longDescription: "d",
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
    const off = parsePluginManifest(native)
    const strict = PluginManifestSchema.safeParse(native)
    expect(off.success).toBe(true)
    expect(strict.success).toBe(true)
    if (off.success && strict.success) {
      expect(off.data).toEqual(strict.data) // byte-identical parsed object
      expect(off.data.skills).toEqual(["./skills/a", "./skills/b"]) // not coerced
    }
    // And armed: still parses, still no repository on a file that omits it.
    armCompat()
    const on = parsePluginManifest(native)
    expect(on.success).toBe(true)
    if (on.success) expect((on.data as { repository?: unknown }).repository).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. Real codex SKILL.md — parses ONLY when armed; tool allowlist captured
// ─────────────────────────────────────────────────────────────────────────────
describe("SKILL.md codex-compat (strict parseSkillMarkdown)", () => {
  test("rr2 SKILL.md parses when armed; allowed-tools BLOCK-LIST captured, user-invocable mapped", () => {
    armCompat()
    const res = parseSkillMarkdown(readFix("skills/rr2/SKILL.md"))
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error(`expected ok, got: ${res.error.message}`)
    expect(res.value.frontmatter.allowedTools).toEqual(["Read", "Grep", "Bash", "Edit"])
    expect(res.value.frontmatter.userInvocable).toBe(true)
    // already-accepted kebab key (ADR-0457) is NOT clobbered
    expect(res.value.frontmatter["argument-hint"]).toBe("[scope]")
  })

  // DEFAULT-OFF BYTE-IDENTITY: codex SKILL.md (block-list + kebab) REJECTS.
  test("RATCHET default-OFF: rr2 SKILL.md REJECTED (block-list trips strict parser)", () => {
    const res = parseSkillMarkdown(readFix("skills/rr2/SKILL.md"))
    expect(res.ok).toBe(false)
  })

  test("RATCHET default-OFF: quanta-native SKILL.md parses identically armed vs unarmed", () => {
    const native = [
      "---",
      "name: demo-skill",
      "description: a demo",
      "userInvocable: true",
      'allowedTools: ["Read", "Edit"]',
      "category: skill",
      "stability: stable",
      "---",
      "# body",
    ].join("\n")
    const off = parseSkillMarkdown(native)
    armCompat()
    const on = parseSkillMarkdown(native)
    expect(off.ok).toBe(true)
    expect(on.ok).toBe(true)
    if (off.ok && on.ok) {
      expect(on.value.frontmatter).toEqual(off.value.frontmatter) // identical
      expect(off.value.frontmatter.allowedTools).toEqual(["Read", "Edit"])
    }
  })

  test("user-invocable defaults to false when absent (armed)", () => {
    armCompat()
    const md = [
      "---",
      "name: noinvoke",
      "description: d",
      'allowedTools: ["Read"]',
      "category: skill",
      "stability: stable",
      "---",
      "body",
    ].join("\n")
    const res = parseSkillMarkdown(md)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.value.frontmatter.userInvocable).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. RED-ON-INJECTION — grant smuggling is REJECTED / IGNORED
// ─────────────────────────────────────────────────────────────────────────────
describe("security: grant smuggling is ignored, never interpreted", () => {
  test("unknown kebab `extra-tools` is NOT renamed/granted (only the 2 enumerated keys rename)", () => {
    const out = normalizeSkillFrontmatter({
      name: "x",
      "allowed-tools": ["Read"],
      "extra-tools": ["Bash"],
    }) as Record<string, unknown>
    expect(out.allowedTools).toEqual(["Read"])
    // smuggled key NOT renamed to a real field; left verbatim for `.strip()`.
    expect(out).not.toHaveProperty("extraTools")
    expect(out).not.toHaveProperty("extra_tools")
    expect(out["extra-tools"]).toEqual(["Bash"]) // untouched, will be stripped
  })

  test("kebab/camel collision: native camel WINS, broad kebab cannot widen narrow native", () => {
    const out = normalizeSkillFrontmatter({
      allowedTools: ["Read"], // narrow native
      "allowed-tools": ["Read", "Grep", "Bash", "Edit", "Write"], // broad kebab
    }) as Record<string, unknown>
    expect(out.allowedTools).toEqual(["Read"]) // native authoritative
  })

  test("full pipeline: broad kebab block-list CANNOT override narrow native allowedTools (armed)", () => {
    armCompat()
    const md = [
      "---",
      "name: collide",
      "description: d",
      'allowedTools: ["Read"]', // narrow native (flow list)
      "user-invocable: true",
      "allowed-tools:", // broad kebab block-list
      "  - Read",
      "  - Write",
      "  - Bash",
      "category: skill",
      "stability: stable",
      "---",
      "body",
    ].join("\n")
    const res = parseSkillMarkdown(md)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.value.frontmatter.allowedTools).toEqual(["Read"]) // narrow wins
  })

  test("plugin: unknown top-level `capabilities` is STRIPPED (cannot bypass interface enum)", () => {
    armCompat()
    const raw = readJson("plugins/spreadsheets/plugin.json") as Record<string, unknown>
    const hostile = { ...raw, capabilities: ["Admin", "Root"] }
    const parsed = parsePluginManifest(hostile)
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      // top-level `capabilities` stripped — NOT a field on the parsed object.
      expect(parsed.data).not.toHaveProperty("capabilities")
      // the ONLY capability surface is the inner strict interface enum.
      expect(parsed.data.interface.capabilities).toEqual(["Interactive", "Write"])
    }
  })

  test("plugin: unknown enum member in inner interface.capabilities STILL hard-fails (armed)", () => {
    armCompat()
    const raw = readJson("plugins/spreadsheets/plugin.json") as {
      interface: Record<string, unknown>
    }
    const hostile = {
      ...raw,
      interface: { ...raw.interface, capabilities: ["Interactive", "Root"] },
    }
    expect(parsePluginManifest(hostile).success).toBe(false)
  })

  test("plugin: unknown key in inner mcpServers descriptor STILL hard-fails (armed)", () => {
    armCompat()
    const raw = readJson("plugins/spreadsheets/plugin.json") as Record<string, unknown>
    const hostile = {
      ...raw,
      mcpServers: { evil: { command: "x", args: [], sneak: "rm -rf" } },
    }
    expect(parsePluginManifest(hostile).success).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. Normalizer transform-set is EXACTLY frozen / closed
// ─────────────────────────────────────────────────────────────────────────────
describe("normalizer closed transform set", () => {
  test("rename map is EXACTLY the two enumerated interop keys (widening is guard-visible)", () => {
    expect(Object.keys(SKILL_KEBAB_RENAME).sort()).toEqual(["allowed-tools", "user-invocable"])
    expect(SKILL_KEBAB_RENAME["allowed-tools"]).toBe("allowedTools")
    expect(SKILL_KEBAB_RENAME["user-invocable"]).toBe("userInvocable")
  })

  test("rename map is frozen (cannot be mutated to widen at runtime)", () => {
    expect(Object.isFrozen(SKILL_KEBAB_RENAME)).toBe(true)
  })

  test("an unrelated kebab key (`some-other-kebab`) is left untouched", () => {
    const out = normalizeSkillFrontmatter({ "some-other-kebab": "v" }) as Record<string, unknown>
    expect(out["some-other-kebab"]).toBe("v")
    expect(Object.keys(out)).toEqual(["some-other-kebab"])
  })

  test("string skills coerce; array skills untouched; non-object passthrough", () => {
    expect(
      (normalizePluginManifest({ skills: "./skills/" }) as { skills: unknown }).skills,
    ).toEqual(["./skills/"])
    const arr = { skills: ["./a", "./b"] }
    expect((normalizePluginManifest(arr) as { skills: unknown }).skills).toEqual(["./a", "./b"])
    expect(normalizePluginManifest(null)).toBe(null)
    expect(normalizePluginManifest("nope")).toBe("nope")
  })

  test("dropped-key observability: a coerced/renamed key emits a debug log", () => {
    const logs: string[] = []
    normalizePluginManifest({ skills: "./skills/" }, (m) => logs.push(m))
    expect(logs.some((l) => l.includes("skills"))).toBe(true)
    const logs2: string[] = []
    normalizeSkillFrontmatter({ "allowed-tools": ["Read"] }, (m) => logs2.push(m))
    expect(logs2.some((l) => l.includes("allowed-tools"))).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. Lenient discovery parser produces a kebab block-list (the silent-drop bug)
// ─────────────────────────────────────────────────────────────────────────────
describe("lenient parser + normalizer fix the discover.ts silent tool-drop", () => {
  test("RATCHET no-regression: EVERY real system-skill parses IDENTICALLY armed vs unarmed", () => {
    // Load-bearing byte-identity invariant: a quanta-native SKILL.md (camel
    // `allowedTools` flow-list) must produce the EXACT same SkillFrontmatter
    // whether or not the compat knob is armed. If the relaxed schema / defaults
    // / normalizer ever altered a native parse, this fails.
    const root = join(import.meta.dir, "..", "..", "src", "skill", "system-skills")
    const dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())
    expect(dirs.length).toBeGreaterThan(5) // guard: the corpus is real
    for (const d of dirs) {
      let md: string
      try {
        md = readFileSync(join(root, d.name, "SKILL.md"), "utf8")
      } catch {
        continue // not every dir is a skill dir
      }
      disarmCompat()
      const off = parseSkillMarkdown(md)
      armCompat()
      const on = parseSkillMarkdown(md)
      expect(on.ok).toBe(off.ok)
      if (off.ok && on.ok) {
        expect(on.value.frontmatter).toEqual(off.value.frontmatter)
        expect(on.value.body).toBe(off.value.body)
      }
    }
  })

  test("rr2 lenient parse yields kebab `allowed-tools` block-list; normalizer renames it", () => {
    const { data } = parseFrontmatter(readFix("skills/rr2/SKILL.md"))
    // The lenient parser keeps the kebab key — proving the drop at the camel
    // read site is real without normalization.
    expect(data["allowed-tools"]).toEqual(["Read", "Grep", "Bash", "Edit"])
    expect(data.allowedTools).toBeUndefined()
    // After the normalizer the camel read site sees the tools (no silent drop).
    const norm = normalizeSkillFrontmatter(data) as Record<string, unknown>
    expect(norm.allowedTools).toEqual(["Read", "Grep", "Bash", "Edit"])
  })

  test("discoverSkills: rr2 tool allowlist is DROPPED default-OFF, CAPTURED when armed", async () => {
    const skillsDir = join(FIX, "skills")
    // Default-OFF (the latent safety bug the ticket fixes): the kebab block-list
    // `allowed-tools` is read via the camel key only ⇒ tools silently absent.
    const off = await discoverSkills(skillsDir)
    const rr2Off = off.find((s) => s.name === "rr2")
    expect(rr2Off).toBeDefined()
    expect(rr2Off?.tools).toBeUndefined() // SILENTLY DROPPED today

    // Armed: the normalizer renames the kebab key so discovery scopes the tools.
    armCompat()
    const on = await discoverSkills(skillsDir)
    const rr2On = on.find((s) => s.name === "rr2")
    expect(rr2On?.tools).toEqual(["Read", "Grep", "Bash", "Edit"]) // captured
    // briefing (name+description only) still discovers, with no tools.
    const briefing = on.find((s) => s.name === "briefing")
    expect(briefing).toBeDefined()
    expect(briefing?.tools).toBeUndefined()
  })
})
