import { test, expect, beforeEach, afterEach } from "bun:test"
import { __resetRuntimeConfig } from "@/shared"
import { parseSkillMarkdown } from "@/skill/skill-frontmatter"
import { normalizeSkillFrontmatter, normalizePluginManifest } from "@/skill/manifest-compat"

const arm = () => { process.env.QUANTA_MANIFEST_COMPAT = "1"; __resetRuntimeConfig() }
const disarm = () => { delete process.env.QUANTA_MANIFEST_COMPAT; __resetRuntimeConfig() }
beforeEach(disarm); afterEach(disarm)

// PROBE A: a block-list under a DUPLICATE camel allowedTools flow list AFTER the kebab.
// Order: kebab block list FIRST, then native flow list. Does native still win?
test("PROBE A: kebab block-list BEFORE native flow — native must still win", () => {
  arm()
  const md = ["---","name:c","description:d",
    "allowed-tools:","  - Read","  - Write","  - Bash",
    'allowedTools: ["Read"]',
    "category: skill","stability: stable","---","b"].join("\n")
  const res = parseSkillMarkdown(md)
  console.log("PROBE A result:", JSON.stringify(res))
})

// PROBE B: __proto__ pollution via frontmatter key
test("PROBE B: __proto__ key in normalizer", () => {
  const out = normalizeSkillFrontmatter({ "__proto__": { polluted: true }, name: "x" }) as Record<string, unknown>
  console.log("PROBE B keys:", Object.keys(out), "polluted global?", ({} as any).polluted)
})

// PROBE C: prototype pollution via plugin manifest
test("PROBE C: constructor/__proto__ in plugin normalizer", () => {
  const out = normalizePluginManifest({ skills: "./s/", "__proto__": {x:1} }) as any
  console.log("PROBE C out keys:", Object.keys(out))
})

// PROBE D: block-list tool value with shell metachar / injection
test("PROBE D: block-list element Bash(rm -rf)", () => {
  arm()
  const md = ["---","name:d","description:d","user-invocable: true",
    "allowed-tools:","  - Bash(rm -rf /)","category: skill","stability: stable","---","b"].join("\n")
  const res = parseSkillMarkdown(md)
  console.log("PROBE D:", JSON.stringify(res))
})

// PROBE E: empty block-list (header but no items) — does it default to []?
test("PROBE E: empty allowed-tools block list", () => {
  arm()
  const md = ["---","name:e","description:d","user-invocable: true",
    "allowed-tools:","category: skill","stability: stable","---","b"].join("\n")
  const res = parseSkillMarkdown(md)
  console.log("PROBE E:", JSON.stringify(res))
})

// PROBE F: hostile mcpServers as a top-level block list (compat block list parser generic?)
test("PROBE F: mcpServers as block list (should NOT be interpreted as a grant)", () => {
  arm()
  const md = ["---","name:f","description:d","user-invocable: true",
    "mcpServers:","  - evil","category: skill","stability: stable","---","b"].join("\n")
  const res = parseSkillMarkdown(md)
  console.log("PROBE F:", JSON.stringify(res))
})
