import { test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { __resetRuntimeConfig } from "@/shared"
import { discoverSkills } from "@/skill/discover"

const arm = () => { process.env.QUANTA_MANIFEST_COMPAT = "1"; __resetRuntimeConfig() }
const disarm = () => { delete process.env.QUANTA_MANIFEST_COMPAT; __resetRuntimeConfig() }
beforeEach(disarm); afterEach(disarm)

function mkSkill(dir: string, name: string, md: string) {
  mkdirSync(join(dir, name), { recursive: true })
  writeFileSync(join(dir, name, "SKILL.md"), md)
}

// PROBE G: discovery — broad kebab block-list AND narrow native allowedTools.
// Does the runtime tool-scoping read narrow native (safe) or broad kebab (UNSAFE)?
test("PROBE G: discovery collision broad-kebab vs narrow-native", async () => {
  const root = mkdtempSync(join(tmpdir(), "probe-"))
  try {
    mkSkill(root, "collide", ["---","name: collide","description: d",
      'allowedTools: ["Read"]',          // narrow native
      "allowed-tools:","  - Read","  - Write","  - Bash",  // broad kebab
      "---","b"].join("\n"))
    arm()
    const skills = await discoverSkills(root)
    const c = skills.find(s => s.name === "collide")
    console.log("PROBE G tools:", JSON.stringify(c?.tools))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// PROBE H: discovery — ONLY broad kebab, native absent.
test("PROBE H: discovery kebab-only block list captured", async () => {
  const root = mkdtempSync(join(tmpdir(), "probe-"))
  try {
    mkSkill(root, "konly", ["---","name: konly","description: d",
      "allowed-tools:","  - Read","  - Bash","---","b"].join("\n"))
    arm()
    const skills = await discoverSkills(root)
    const c = skills.find(s => s.name === "konly")
    console.log("PROBE H tools:", JSON.stringify(c?.tools))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// PROBE I: discovery — kebab user-invocable, does it map? (affects slash exposure)
test("PROBE I: discovery default-OFF byte identity with kebab present", async () => {
  const root = mkdtempSync(join(tmpdir(), "probe-"))
  try {
    mkSkill(root, "konly2", ["---","name: konly2","description: d",
      "allowed-tools:","  - Read","---","b"].join("\n"))
    disarm()
    const off = await discoverSkills(root)
    const c = off.find(s => s.name === "konly2")
    console.log("PROBE I default-OFF tools:", JSON.stringify(c?.tools))
  } finally { rmSync(root, { recursive: true, force: true }) }
})
