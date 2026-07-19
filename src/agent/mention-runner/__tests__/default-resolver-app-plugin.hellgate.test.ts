/**
 * ADR-0422 follow-up — `@@app` / `plugin://` deps-pass hellgate.
 *
 * The gap this pins: `buildDefaultMentionResolver` composed only
 * file/symbol/skill/folder/git deps and NEVER passed the injected
 * `plugins` / `apps` ports into `createCompositeMentionResolver`, so
 * `resolvePlugin` / `resolveApp` always resolved `null` (the composite
 * ran `createPluginResolver(undefined)` / `createAppResolver(undefined)`).
 *
 * This wires the injected ports THROUGH, gated behind the default-OFF
 * `QUANTA_MENTION_APP_PLUGIN` knob:
 *
 *   - Gate OFF (unset / `off`) ⇒ `plugins` / `apps` deps are NOT passed to
 *     the composite ⇒ `resolvePlugin` / `resolveApp` resolve `null`
 *     regardless of the injected ports ⇒ byte-identical to the pre-fix path.
 *   - Gate ON  ⇒ the injected ports flow to the composite ⇒ a hit resolves
 *     to real bodyText; a miss resolves `null` (typed not-found, never a
 *     fabricated stub).
 *
 * NO real fs — the `PluginRegistryPort` / `AppCatalogPort` are in-memory
 * ports built from the REAL adapters (`createInMemoryPluginRegistry` /
 * `createInMemoryAppCatalog`), the same ports the host composition root
 * hands over after `discoverPlugins` / `loadWorkspaceAppCatalog`. This
 * proves the deps-pass seam WITHOUT re-implementing discovery.
 *
 *   A. gate ON + plugin hit  ⇒ real bodyText                              (1)
 *   B. gate ON + plugin miss ⇒ null (typed not-found)                     (1)
 *   C. gate ON + app hit     ⇒ real bodyText (surface prefix)             (1)
 *   D. gate ON + app miss    ⇒ null                                       (1)
 *   E. gate OFF (unset) + ports present ⇒ plugin/app resolve null         (2)
 *   F. gate =off (explicit) + ports present ⇒ plugin/app resolve null     (2)
 *   G. gate ON but ports absent ⇒ plugin/app resolve null (graceful omit) (2)
 *   H. gate ON does NOT disturb the legacy skill/file wiring              (1)
 *
 * Total = 11 cases.
 *
 * RED-on-injection: revert the deps-pass in `default-resolver.ts` (drop the
 * `...(plugins ...)` / `...(apps ...)` spread) ⇒ A/C go RED (hit → null).
 */

import { describe, expect, test } from "bun:test"
import { createInMemoryAppCatalog } from "@/agent/app-catalog"
import { createInMemoryPluginRegistry } from "@/agent/plugin-discovery"
import { buildDefaultMentionResolver, type MentionEnv } from "../default-resolver"

const env = (over: Record<string, string | undefined> = {}): MentionEnv => over

/** Gate-ON env (the knob is default-OFF, so ON must be explicit). */
const ON: Record<string, string> = { QUANTA_MENTION_APP_PLUGIN: "on" }

const pluginRegistry = () =>
  createInMemoryPluginRegistry([
    {
      id: "codex-r2-mention-injection-pipeline",
      name: "Mention Injection Pipeline",
      description: "Resolves @@app / plugin:// mentions to workspace context\nsecond line",
      capabilities: ["Read"],
    },
  ])

const appCatalog = () =>
  createInMemoryAppCatalog([
    { id: "browser", surface: "cli-browser", description: "the CLI-embedded browser surface" },
  ])

describe("buildDefaultMentionResolver — @@app/plugin:// deps-pass hellgate", () => {
  // -------- A/B. plugin hit / miss (gate ON) -------------------------
  test("A — gate ON + plugin hit ⇒ real first-line bodyText", async () => {
    const r = buildDefaultMentionResolver({
      cwd: "/repo",
      env: env(ON),
      plugins: pluginRegistry(),
    })
    const res = await r.resolvePlugin("codex-r2-mention-injection-pipeline")
    expect(res?.bodyText).toBe("Resolves @@app / plugin:// mentions to workspace context")
  })

  test("B — gate ON + plugin miss ⇒ null (typed not-found, never stub)", async () => {
    const r = buildDefaultMentionResolver({
      cwd: "/repo",
      env: env(ON),
      plugins: pluginRegistry(),
    })
    expect(await r.resolvePlugin("does-not-exist")).toBeNull()
  })

  // -------- C/D. app hit / miss (gate ON) ----------------------------
  test("C — gate ON + app hit ⇒ real bodyText with surface prefix", async () => {
    const r = buildDefaultMentionResolver({
      cwd: "/repo",
      env: env(ON),
      apps: appCatalog(),
    })
    const res = await r.resolveApp("browser")
    expect(res?.bodyText).toBe("surface: cli-browser — the CLI-embedded browser surface")
  })

  test("D — gate ON + app miss ⇒ null", async () => {
    const r = buildDefaultMentionResolver({
      cwd: "/repo",
      env: env(ON),
      apps: appCatalog(),
    })
    expect(await r.resolveApp("nope")).toBeNull()
  })

  // -------- E. gate OFF (unset) ⇒ byte-identical null -----------------
  test("E1 — gate UNSET + plugin port present ⇒ plugin resolves null", async () => {
    const r = buildDefaultMentionResolver({
      cwd: "/repo",
      env: env(),
      plugins: pluginRegistry(),
    })
    expect(await r.resolvePlugin("codex-r2-mention-injection-pipeline")).toBeNull()
  })

  test("E2 — gate UNSET + app port present ⇒ app resolves null", async () => {
    const r = buildDefaultMentionResolver({
      cwd: "/repo",
      env: env(),
      apps: appCatalog(),
    })
    expect(await r.resolveApp("browser")).toBeNull()
  })

  // -------- F. gate explicitly =off ⇒ byte-identical null ------------
  test("F1 — gate =off + plugin port present ⇒ plugin resolves null", async () => {
    const r = buildDefaultMentionResolver({
      cwd: "/repo",
      env: env({ QUANTA_MENTION_APP_PLUGIN: "off" }),
      plugins: pluginRegistry(),
    })
    expect(await r.resolvePlugin("codex-r2-mention-injection-pipeline")).toBeNull()
  })

  test("F2 — gate =off + app port present ⇒ app resolves null", async () => {
    const r = buildDefaultMentionResolver({
      cwd: "/repo",
      env: env({ QUANTA_MENTION_APP_PLUGIN: "off" }),
      apps: appCatalog(),
    })
    expect(await r.resolveApp("browser")).toBeNull()
  })

  // -------- F3. gate = empty string ⇒ NOT armed (opt-in SSOT) --------
  // `QUANTA_MENTION_APP_PLUGIN=` (empty) is NOT an opt-in: the canonical
  // `gateOn` reader treats empty/unrecognized as OFF (the byte-identical
  // guarantee). A regression to `parseEnvFlag(..., false)` would arm the gate
  // on empty string (its legacy `""`→true quirk) and turn this RED.
  test("F3 — gate = '' (empty) + plugin port present ⇒ plugin resolves null", async () => {
    const r = buildDefaultMentionResolver({
      cwd: "/repo",
      env: env({ QUANTA_MENTION_APP_PLUGIN: "" }),
      plugins: pluginRegistry(),
    })
    expect(await r.resolvePlugin("codex-r2-mention-injection-pipeline")).toBeNull()
  })

  // -------- G. gate ON but ports absent ⇒ graceful omit --------------
  test("G1 — gate ON + no plugin port ⇒ plugin resolves null", async () => {
    const r = buildDefaultMentionResolver({ cwd: "/repo", env: env(ON) })
    expect(await r.resolvePlugin("anything")).toBeNull()
  })

  test("G2 — gate ON + no app port ⇒ app resolves null", async () => {
    const r = buildDefaultMentionResolver({ cwd: "/repo", env: env(ON) })
    expect(await r.resolveApp("anything")).toBeNull()
  })

  // -------- H. gate ON leaves the legacy skill/file wiring intact -----
  test("H — gate ON does not disturb @file/@skill (file still attached)", async () => {
    const r = buildDefaultMentionResolver({ cwd: "/repo", env: env(ON) })
    expect(typeof r.resolveFile).toBe("function")
    // @skill with no registry still resolves null (unchanged legacy shape).
    expect(await r.resolveSkill("code-review")).toBeNull()
  })
})
