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
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { __resetRuntimeConfig } from "@/shared"
import { discoverSkills } from "@/skill/discover"
import { parseFrontmatter } from "@/skill/frontmatter"
import {
  normalizePluginManifest,
  normalizeSkillFrontmatter,
  SKILL_KEBAB_BLOCK_LIST_KEYS,
  SKILL_KEBAB_RENAME,
} from "@/skill/manifest-compat"
import { PluginManifestSchema, parsePluginManifest } from "@/skill/plugin-manifest"
import { parseSkillMarkdown, SkillFrontmatterCompatSchema } from "@/skill/skill-frontmatter"
import { assertScanPopulation } from "./_shared/scan-population"

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

  // ── round-1 hardening: prototype-pollution cannot smuggle a grant ──────────
  // The normalizer copies keys with `out[key] = value`. A `__proto__` key must
  // NOT install a polluted prototype that downstream `data.foo` reads resolve
  // to (which would let a hostile manifest inject e.g. `mcpServers` via the
  // prototype chain). Lock it: the parsed object's own `mcpServers` stays
  // undefined and no global pollution occurs.
  test("plugin: __proto__-injected mcpServers cannot pollute the parsed manifest (armed)", () => {
    armCompat()
    const raw = readJson("plugins/spreadsheets/plugin.json") as Record<string, unknown>
    const hostile: Record<string, unknown> = { ...raw }
    // biome-ignore lint/suspicious/noExplicitAny: deliberate prototype-pollution probe
    ;(hostile as any).__proto__ = { mcpServers: { evil: { command: "x", args: [] } } }
    const parsed = parsePluginManifest(hostile)
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      // No own/inherited mcpServers leaked onto the validated object.
      expect(parsed.data.mcpServers).toBeUndefined()
    }
    // And no global prototype pollution from the parse.
    expect(({} as Record<string, unknown>).mcpServers).toBeUndefined()
  })

  test("skill: __proto__ key in frontmatter does not pollute / smuggle a field", () => {
    const out = normalizeSkillFrontmatter({
      // biome-ignore lint/suspicious/noExplicitAny: deliberate prototype-pollution probe
      ...({ __proto__: { allowedTools: ["Bash"] } } as any),
      name: "x",
      "allowed-tools": ["Read"],
    }) as Record<string, unknown>
    // The legitimate kebab rename still happens (narrow real grant only).
    expect(out.allowedTools).toEqual(["Read"])
    // No global pollution.
    expect(({} as Record<string, unknown>).allowedTools).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. round-1 hardening: `repository` object-form union (ticket §3.1 / §7)
//    The ticket REQUIRES accepting both a string URL and a `{url, type?}`
//    object ("object-or-string repository both accepted"). The object branch
//    of the union was implemented but UNTESTED — dropping it left all tests
//    green. These lock the object branch and its URL-validation security edge.
// ─────────────────────────────────────────────────────────────────────────────
describe("plugin repository union (string | {url,type?})", () => {
  const spreadsheets = (): Record<string, unknown> =>
    readJson("plugins/spreadsheets/plugin.json") as Record<string, unknown>

  test("object-form repository {url,type} is accepted and preserved (armed)", () => {
    armCompat()
    const m = { ...spreadsheets(), repository: { url: "https://github.com/x/y", type: "git" } }
    const parsed = parsePluginManifest(m)
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect((parsed.data as { repository?: unknown }).repository).toEqual({
        url: "https://github.com/x/y",
        type: "git",
      })
    }
  })

  test("object-form repository drops an unknown extra key but keeps url (inner .strip)", () => {
    armCompat()
    const m = {
      ...spreadsheets(),
      repository: { url: "https://github.com/x/y", evil: "rm -rf" },
    }
    const parsed = parsePluginManifest(m)
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      const repo = (parsed.data as { repository?: Record<string, unknown> }).repository
      expect(repo).toEqual({ url: "https://github.com/x/y" })
      expect(repo).not.toHaveProperty("evil")
    }
  })

  test("repository URL validation holds: a non-URL string is REJECTED (armed)", () => {
    armCompat()
    const m = { ...spreadsheets(), repository: "not a url" }
    expect(parsePluginManifest(m).success).toBe(false)
  })

  test("repository object url uses the SAME .url() posture as the existing URL fields", () => {
    // `repository.url` is validated by `z.string().url()` — IDENTICAL to the
    // schema's existing `homepage` / `author.url` / `interface.websiteURL`
    // fields. That posture accepts any well-formed URL scheme (incl. exotic
    // ones) but rejects free text — the additive `repository` field introduces
    // NO weaker URL validation than already shipped. (Hardening every URL field
    // to http(s)-only is a separate cross-cutting change, not this ticket.)
    armCompat()
    const garbage = { ...spreadsheets(), repository: { url: "definitely not a url at all" } }
    expect(parsePluginManifest(garbage).success).toBe(false)
    const wellFormed = { ...spreadsheets(), repository: { url: "https://github.com/x/y" } }
    expect(parsePluginManifest(wellFormed).success).toBe(true)
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

  test("block-list key set is EXACTLY {allowed-tools} (empty-header opener is closed)", () => {
    // The empty-`allowed-tools:` → [] strict-parser fix (round 2) only opens a
    // zero-item block-list for THIS enumerated key. Widening the set (so an
    // arbitrary empty-value header silently becomes `[]`) is guard-visible.
    expect([...SKILL_KEBAB_BLOCK_LIST_KEYS].sort()).toEqual(["allowed-tools"])
    expect(SKILL_KEBAB_BLOCK_LIST_KEYS.has("allowed-tools")).toBe(true)
    expect(SKILL_KEBAB_BLOCK_LIST_KEYS.has("metadata")).toBe(false)
  })

  test("empty-header opener does NOT fire for a non-enumerated empty key (still rejects)", () => {
    // A bare `metadata:` with NO following content is NOT an enumerated block-
    // list key ⇒ must still reject (it would otherwise silently become `[]`,
    // but `metadata` is an object — the empty-header opener must stay scoped).
    armCompat()
    const md = ["---", "name: foo", "description: bar", "metadata:", "---", "body"].join("\n")
    expect(parseSkillMarkdown(md).ok).toBe(false)
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
    const read: string[] = []
    for (const d of dirs) {
      let md: string
      const skillMd = join(root, d.name, "SKILL.md")
      try {
        md = readFileSync(skillMd, "utf8")
      } catch {
        continue // not every dir is a skill dir
      }
      read.push(skillMd)
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
    // The floor belongs on what was READ, not on what was listed. It used to read
    // `dirs.length > 5`, and the loop's real work is behind a `catch { continue }`
    // that swallows a missing SKILL.md — so with the skill files gone but their
    // directories standing, the listing still cleared the floor, every read
    // threw, every iteration skipped, and the test passed having compared
    // nothing. Measured: 67 `expect()` calls against the real corpus, ONE against
    // the blanked one, green both times.
    //
    // The replacement floor was 20 of the 22 real skills, and that is a number
    // this author picked: it tolerates two skills disappearing outright. The
    // committed baseline pins the MEASURED reach instead, and adds the claim a
    // count cannot make — every skill DIRECTORY must contribute, so losing one
    // skill entirely is a named failure rather than a smaller number.
    assertScanPopulation(read, root, {
      id: "tests/unit/manifest-codex-compat-hellgate.test.ts#SYSTEM-SKILLS",
      collectable: (n) => n === "SKILL.md",
    })
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

// ─────────────────────────────────────────────────────────────────────────────
// 8. round-2 hardening — the SKILL frontmatter outer `.strip()` was UNGUARDED.
//    The plugin side asserts `not.toHaveProperty("capabilities")` (so reverting
//    its `.strip()` → `.passthrough()` is red), but there was NO equivalent
//    guard on `SkillFrontmatterCompatSchema`: reverting ITS `.strip()` to
//    `.passthrough()` left ALL tests green. That is exactly the ticket §5
//    "smuggle a field a FUTURE version interprets" threat — a foreign key (the
//    un-renamed `extra-tools`, codex's `license`, an arbitrary `evilField`)
//    surviving ON the parsed frontmatter object where a later consumer could
//    read it off the bag. These lock the strip at the SCHEMA level (not just the
//    normalizer level), red-on-injection if `.strip()` → `.passthrough()`.
// ─────────────────────────────────────────────────────────────────────────────
describe("round-2: SkillFrontmatterCompatSchema STRIPS foreign top-level keys", () => {
  test("un-renamed kebab `extra-tools` is dropped OFF the parsed frontmatter object", () => {
    armCompat()
    const parsed = SkillFrontmatterCompatSchema.safeParse({
      name: "foo",
      description: "bar",
      userInvocable: true,
      allowedTools: ["Read"],
      category: "skill",
      stability: "experimental",
      // §5 smuggle attempt: a foreign tool-grant-shaped key that the normalizer
      // does NOT rename. With `.passthrough()` it would survive on the object.
      "extra-tools": ["Bash"],
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      // The grant is the narrow real set only…
      expect(parsed.data.allowedTools).toEqual(["Read"])
      // …and the foreign key is GONE from the parsed object (not lurking on a
      // passthrough bag for a future reader). This fails if `.strip()` reverts.
      expect(parsed.data).not.toHaveProperty("extra-tools")
      expect(parsed.data).not.toHaveProperty("extraTools")
    }
  })

  test("foreign `license` / arbitrary key are stripped, never interpreted", () => {
    armCompat()
    const parsed = SkillFrontmatterCompatSchema.safeParse({
      name: "foo",
      description: "bar",
      userInvocable: false,
      allowedTools: [],
      category: "skill",
      stability: "experimental",
      // codex's own SSOT carries `license`; an arbitrary future grant key.
      license: "MIT",
      // biome-ignore lint/suspicious/noExplicitAny: deliberate smuggle probe
      ...({ evilGrant: { all: true } } as any),
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data).not.toHaveProperty("license")
      expect(parsed.data).not.toHaveProperty("evilGrant")
      // exactly the modelled keys remain.
      expect(Object.keys(parsed.data).sort()).toEqual(
        ["allowedTools", "category", "description", "name", "stability", "userInvocable"].sort(),
      )
    }
  })

  test("full pipeline: a foreign top-level key in raw SKILL.md frontmatter is stripped", () => {
    armCompat()
    const md = [
      "---",
      "name: foo",
      "description: bar",
      "user-invocable: true",
      "allowed-tools:",
      "  - Read",
      "extra-tools:",
      "  - Bash",
      "license: MIT",
      "---",
      "body",
    ].join("\n")
    const r = parseSkillMarkdown(md)
    expect(r.ok).toBe(true)
    if (r.ok) {
      const fm = r.value.frontmatter as Record<string, unknown>
      // Only the real declared tools — the smuggled `extra-tools` is NOT a grant…
      expect(fm.allowedTools).toEqual(["Read"])
      // …and neither the smuggled tool key nor `license` survive on the object.
      expect(fm).not.toHaveProperty("extra-tools")
      expect(fm).not.toHaveProperty("license")
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 9. round-2 hardening — strict/lenient parse-path PARITY for an empty
//    `allowed-tools:` (a tool-less skill explicitly declaring an empty
//    allowlist). The lenient parser (the runtime discover.ts read site) yields
//    `[]`; the strict `parseSkillMarkdown` authority must ALSO ingest it as `[]`
//    rather than reject with "empty value", so the two paths agree (ticket §4.b
//    "the strict parseSkillMarkdown path gets the same normalizer pre-pass").
//    Fail-CLOSED before the fix (rejected), so not a grant hole — but a real
//    ingest asymmetry: a skill that parses at the read site is rejected by the
//    validation authority. NOTE: empty `[]` grants NO tools (the safe scoping).
// ─────────────────────────────────────────────────────────────────────────────
describe("round-2: empty `allowed-tools:` parses to [] in BOTH parse paths", () => {
  const emptyAtEnd = ["---", "name: foo", "description: bar", "allowed-tools:", "---", "body"].join(
    "\n",
  )
  const emptyThenKey = [
    "---",
    "name: foo",
    "description: bar",
    "allowed-tools:",
    "category: skill",
    "---",
    "body",
  ].join("\n")

  test("lenient parser yields allowed-tools: [] (the runtime read site)", () => {
    const a = parseFrontmatter(emptyAtEnd).data as Record<string, unknown>
    expect(a["allowed-tools"]).toEqual([])
    const b = parseFrontmatter(emptyThenKey).data as Record<string, unknown>
    expect(b["allowed-tools"]).toEqual([])
  })

  test("strict parseSkillMarkdown (armed) ingests empty allowed-tools as [] (no tools)", () => {
    armCompat()
    const r1 = parseSkillMarkdown(emptyAtEnd)
    expect(r1.ok).toBe(true)
    if (r1.ok) expect(r1.value.frontmatter.allowedTools).toEqual([])
    const r2 = parseSkillMarkdown(emptyThenKey)
    expect(r2.ok).toBe(true)
    if (r2.ok) {
      expect(r2.value.frontmatter.allowedTools).toEqual([])
      // the following top-level key still lands (the empty header did not eat it)
      expect(r2.value.frontmatter.category).toBe("skill")
    }
  })

  test("RATCHET default-OFF: empty allowed-tools STILL rejected unarmed (byte-identical)", () => {
    disarmCompat()
    expect(parseSkillMarkdown(emptyAtEnd).ok).toBe(false)
    expect(parseSkillMarkdown(emptyThenKey).ok).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 10. round-3 — BOUNDED ABSORPTION CLAIM. Auditing the FULL real codex skill
//     corpus (54 SKILL.md in `.extracted_source`) shows 3 still reject when
//     armed: `chronicle` (block-scalar `description: |`, Open Q §9.5) and
//     `spreadsheets`/`presentations` (CAPITALIZED `name: "Spreadsheets"` —
//     quanta's `name` regex `^[a-z0-9][a-z0-9-]*$` rejects it). These are NOT in
//     the ticket's enumerated transform set (§4.b: kebab→camel rename +
//     string-skills coerce + repository ONLY). Case-folding a SKILL IDENTITY is a
//     security-adjacent behavior change (the name feeds the skill id / slash
//     command id) that needs its own decision — NOT a silent verify-round bolt-on
//     (`no-heuristics-only-validated`). So we PIN the limitation: the strict
//     authority REJECTS a capitalized name (guard-visible — a future relaxation
//     MUST update this test deliberately, and must NOT case-fold silently),
//     while the LENIENT discovery path (no name regex) still surfaces it. This
//     keeps the "we absorbed the codex skill ecosystem" claim HONESTLY bounded.
// ─────────────────────────────────────────────────────────────────────────────
describe("round-3: capitalized codex skill `name` — bounded ingest gap (pinned)", () => {
  const capName = [
    "---",
    'name: "Spreadsheets"',
    "description: x",
    "allowed-tools:",
    "  - Read",
    "---",
    "body",
  ].join("\n")

  test("strict parseSkillMarkdown REJECTS a capitalized name EVEN WHEN ARMED (no silent case-fold)", () => {
    armCompat()
    const r = parseSkillMarkdown(capName)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).toContain("kebab-case")
    // Default-OFF rejects too (byte-identical) — the relax never touched `name`.
    disarmCompat()
    expect(parseSkillMarkdown(capName).ok).toBe(false)
  })

  test("the normalizer does NOT mutate `name` (only the 2 enumerated keys rename; identity is untouched)", () => {
    const out = normalizeSkillFrontmatter({
      name: "Spreadsheets",
      "allowed-tools": ["Read"],
    }) as Record<string, unknown>
    // name passes through verbatim — no case-fold, no rename. Guard against a
    // future normalizer quietly lowercasing identity to "fix" the ingest gap.
    expect(out.name).toBe("Spreadsheets")
    expect(out.allowedTools).toEqual(["Read"])
  })

  test("lenient discovery DOES surface a capitalized-name codex skill (the asymmetry is documented)", async () => {
    armCompat()
    const dir = mkdtempSync(join(tmpdir(), "skill-capname-"))
    try {
      const sk = join(dir, "spreadsheets")
      mkdirSync(sk)
      writeFileSync(join(sk, "SKILL.md"), capName)
      const skills = await discoverSkills(dir)
      const s = skills.find((x) => x.name === "Spreadsheets")
      // discovery loads it (lenient parser has no name regex) AND captures the
      // renamed tool allowlist — so the strict-vs-lenient asymmetry is REAL and
      // intentional, not a silent drop. If a future change adds a name regex to
      // discovery, this test flips and forces a deliberate decision.
      expect(s).toBeDefined()
      expect(s?.tools).toEqual(["Read"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 11. round-3 — prototype-pollution + native-wins through the FULL discover.ts
//     pipeline (round-1 tested the normalizer + strict parser in isolation; this
//     exercises the lenient `parseFrontmatter` → `ingestCompatData` →
//     `declaredAllowedTools` read site end-to-end, which is the ACTUAL runtime
//     tool-scoping surface the ticket's "silent tool-drop" safety bug lives on).
// ─────────────────────────────────────────────────────────────────────────────
describe("round-3: full discover.ts pipeline — proto safety + native-wins", () => {
  test("a `__proto__` block-list in a discovered SKILL.md cannot pollute or smuggle a tool", async () => {
    armCompat()
    const dir = mkdtempSync(join(tmpdir(), "skill-proto-"))
    try {
      const sk = join(dir, "evil")
      mkdirSync(sk)
      writeFileSync(
        join(sk, "SKILL.md"),
        [
          "---",
          "name: evil",
          "description: x",
          "__proto__:",
          "  - Bash",
          "allowed-tools:",
          "  - Read",
          "---",
          "body",
        ].join("\n"),
      )
      const skills = await discoverSkills(dir)
      const evil = skills.find((s) => s.name === "evil")
      expect(evil).toBeDefined()
      // The smuggled `__proto__` block does NOT widen the effective allowlist…
      expect(evil?.tools).toEqual(["Read"])
      // …and nothing leaks onto Object.prototype.
      expect(({} as Record<string, unknown>).Bash as unknown).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("native flow-list `allowedTools` WINS over a broad kebab block-list end-to-end (armed)", async () => {
    armCompat()
    const dir = mkdtempSync(join(tmpdir(), "skill-win-"))
    try {
      const sk = join(dir, "two")
      mkdirSync(sk)
      writeFileSync(
        join(sk, "SKILL.md"),
        [
          "---",
          "name: two",
          "description: x",
          "allowed-tools:",
          "  - Write",
          "  - Bash",
          'allowedTools: ["Read"]',
          "---",
          "body",
        ].join("\n"),
      )
      const skills = await discoverSkills(dir)
      const two = skills.find((s) => s.name === "two")
      // Anti-smuggle holds at the RUNTIME read site: the narrow native wins, the
      // broad kebab cannot widen the grant.
      expect(two?.tools).toEqual(["Read"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 12. round-4 — HIGH: ORDER-DEPENDENT prototype-key tool-allowlist SMUGGLE.
//     The round-3 test above places `__proto__:` BEFORE `allowed-tools:` and
//     passes — but that order is the SAFE one. With `__proto__:` (as a YAML
//     block-list header) placed AFTER `allowed-tools:`, the lenient parser's
//     `data[pendingKey]` read for the `- item` line resolves the dangerous
//     `__proto__` pendingKey to the EXISTING `allowed-tools` array (prototype
//     aliasing), so the smuggled `- Bash` item is appended to the REAL tool
//     allowlist. With compat armed (so the renamed `allowedTools` is now READ
//     at the discovery scoping site, instead of dropped), this WIDENS the
//     effective grant: a hostile codex SKILL.md gains `Bash` it never declared.
//     This defeats the ticket §5 central contract ("the normalizer NEVER widens
//     a grant"). `constructor`/`prototype` are the same dangerous-key class.
//     Fix: the lenient parser + the normalizer REFUSE the three forbidden keys
//     (`__proto__`/`constructor`/`prototype`) as frontmatter keys / pendingKeys
//     so they can never alias an array or set a prototype. The fix is default-ON
//     hardening (no real SKILL.md uses these keys ⇒ byte-identical for valid
//     files; the system-skill ratchet above still holds).
// ─────────────────────────────────────────────────────────────────────────────
describe("round-4: forbidden prototype-keys cannot smuggle a tool grant", () => {
  const proto = ["__proto__", "constructor", "prototype"]

  for (const key of proto) {
    test(`'${key}:' block-list AFTER allowed-tools does NOT widen the allowlist (lenient parser)`, () => {
      // Direct at the lenient parser: the dangerous key must NOT alias the
      // `allowed-tools` array nor land an own grant-bearing key.
      const md = [
        "---",
        "name: e",
        "description: d",
        "allowed-tools:",
        "  - Read",
        `${key}:`,
        "  - Bash",
        "---",
        "body",
      ].join("\n")
      const { data } = parseFrontmatter(md)
      // The real allowlist stays exactly what was declared — Bash is NOT smuggled.
      expect(data["allowed-tools"]).toEqual(["Read"])
      // And nothing leaks onto Object.prototype.
      expect(({} as Record<string, unknown>).Bash as unknown).toBeUndefined()
    })

    test(`'${key}:' block-list AFTER allowed-tools does NOT widen the discovered skill's tools (armed)`, async () => {
      armCompat()
      const dir = mkdtempSync(join(tmpdir(), "skill-r4-"))
      try {
        const sk = join(dir, "evil")
        mkdirSync(sk)
        writeFileSync(
          join(sk, "SKILL.md"),
          [
            "---",
            "name: evil",
            "description: x",
            "allowed-tools:",
            "  - Read",
            `${key}:`,
            "  - Bash",
            "---",
            "body",
          ].join("\n"),
        )
        const skills = await discoverSkills(dir)
        const evil = skills.find((s) => s.name === "evil")
        expect(evil).toBeDefined()
        // The effective tool grant at the runtime scoping site is exactly the
        // declared `["Read"]` — the smuggled Bash never reaches it.
        expect(evil?.tools).toEqual(["Read"])
        expect(({} as Record<string, unknown>).Bash as unknown).toBeUndefined()
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }

  test("normalizer drops a forbidden own-key (never copies it onto the output bag)", () => {
    // JSON.parse minted own-property `__proto__` (the one path that yields an
    // ENUMERABLE own __proto__) must not be copied through into a real field nor
    // mutate the output's prototype.
    const hostile = JSON.parse('{"__proto__":{"allowedTools":["Bash"]},"allowed-tools":["Read"]}')
    const out = normalizeSkillFrontmatter(hostile) as Record<string, unknown>
    expect(out.allowedTools).toEqual(["Read"])
    // No prototype smuggle: the output's prototype is the plain Object.prototype.
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    // No own forbidden key survives.
    expect(Object.hasOwn(out, "__proto__")).toBe(false)
  })

  test("a forbidden key is NOT a legitimate frontmatter key even unarmed (byte-identical hardening)", () => {
    // Default-OFF: a `__proto__:` scalar key is simply ignored/never aliased; the
    // valid `allowed-tools` survives untouched. This proves the hardening is a
    // no-op for the (only hostile) inputs that exercise it, and never changes a
    // real file's parse.
    disarmCompat()
    const { data } = parseFrontmatter(
      ["---", "name: e", "description: d", "tools:", "  - Read", "__proto__: x", "---", "b"].join(
        "\n",
      ),
    )
    expect(data.tools).toEqual(["Read"])
    expect(Object.getPrototypeOf(data)).toBe(Object.prototype)
  })
})
