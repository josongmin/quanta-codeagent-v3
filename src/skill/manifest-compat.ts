/**
 * jun-7-misc 02 — codex-shape manifest INGEST normalizer (pure, closed-port).
 *
 * quanta's strict Zod schemas (`./plugin-manifest.ts`, `./skill-frontmatter.ts`)
 * empirically REJECT the real Codex 0.135 plugin/skill artifacts shipped in
 * `.extracted_source` (three concrete rejections — see ticket §1):
 *   1. `plugin.json` `"skills": "./skills/"` is a STRING, quanta wants `string[]`.
 *   2. `plugin.json` top-level `"repository"` is rejected by `.strict()`.
 *   3. `SKILL.md` uses kebab `allowed-tools` / `user-invocable`; quanta wants
 *      camel `allowedTools` / `userInvocable`, and the read site at
 *      `discover.ts` only reads the camel key ⇒ the kebab tool whitelist is
 *      SILENTLY DROPPED (a tool-scoping safety field vanishing without error).
 *
 * This module is the read-only interop layer: a pure `(raw) → normalized`
 * mapper run BEFORE `safeParse`, with a FROZEN, enumerated transform set.
 * Anything outside the closed set is left untouched (the relaxed schema's
 * `.strip()` drops genuinely-unknown keys).
 *
 * SECURITY CONTRACT (ticket §5): the normalizer NEVER widens a grant.
 *   - It renames ONLY the two enumerated kebab keys (`allowed-tools`,
 *     `user-invocable`). A hostile `extra-tools` / `allow-tools` is NOT renamed
 *     — it stays unknown and is stripped. No generic kebab→camel auto-caser.
 *   - On a kebab/camel DUPLICATE the native CAMEL key wins; the kebab is
 *     dropped (a quanta-native file is authoritative over an injected dup), so
 *     a broad kebab `allowed-tools` can NEVER override a narrow native
 *     `allowedTools`.
 *   - It only renames/coerces SHAPE; every grant-bearing VALUE is still
 *     validated by the UNCHANGED strict inner schemas (`allowedTools` element
 *     shape, `interface.capabilities` enum, `mcpServers` descriptors).
 *
 * Slice-pure: NO IO, NO `process.env`, NO clock, NO RNG. The knob that arms
 * this layer (`QUANTA_MANIFEST_COMPAT`, default-OFF, strict `=== "1"`) is read
 * at the call sites (`./plugin-manifest.ts` / `./skill-frontmatter.ts` /
 * `./discover.ts`) via `runtimeConfig().manifestCompat`; this module itself is
 * a pure function so the hellgate can exercise it deterministically.
 */

/**
 * FROZEN kebab→camel rename map for skill frontmatter. Exported for the
 * hellgate so the test asserts the map is EXACTLY these two keys (a future
 * widening of the map is a guard-visible change).
 *
 * This is deliberately NOT a generic kebab→camel auto-caser: a generic caser
 * would silently rename a future hostile `evil-grant` → `evilGrant` into a real
 * field. Only the two known interop keys are renamed.
 */
export const SKILL_KEBAB_RENAME: Readonly<Record<string, string>> = Object.freeze({
  "allowed-tools": "allowedTools",
  "user-invocable": "userInvocable",
})

/** Observability hook for dropped/normalized keys (ticket §5: keep drift
 *  visible). The default is a no-op; `discover.ts` / parsers may pass a debug
 *  sink. NEVER throws. */
export type CompatLog = (message: string) => void

const NOOP_LOG: CompatLog = () => {}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

/**
 * Normalize a raw plugin manifest object for codex-shape ingest. Closed set:
 *   - string `skills` → one-element array (`"./skills/"` → `["./skills/"]`).
 *     An array `skills` (quanta-native) is untouched (no-regression).
 * `repository` is left as-is on the object and captured by the (relaxed)
 * schema's additive optional `repository` field — it is NOT coerced here.
 *
 * Returns a NEW object (never mutates `raw`). A non-object input is returned
 * untouched so the schema produces the normal "expected object" error.
 */
export const normalizePluginManifest = (raw: unknown, log: CompatLog = NOOP_LOG): unknown => {
  if (!isPlainObject(raw)) return raw
  const out: Record<string, unknown> = { ...raw }
  if (typeof out.skills === "string") {
    const dir = out.skills
    out.skills = [dir]
    log(`[manifest-compat] coerced string skills "${dir}" → ["${dir}"]`)
  }
  return out
}

/**
 * Normalize raw skill frontmatter `data` for codex-shape ingest. Closed set:
 *   - rename ONLY the two enumerated kebab keys (`SKILL_KEBAB_RENAME`); on a
 *     kebab/camel collision the native CAMEL key WINS and the kebab is dropped
 *     (logged). All other keys (incl. already-accepted kebab keys like
 *     `argument-hint` / `metadata`) pass through UNTOUCHED.
 *
 * Returns a NEW object (never mutates `data`). A non-object input is returned
 * untouched. The relaxed `SkillFrontmatterSchema.strip()` drops anything not in
 * the schema, so an un-renamed hostile kebab key (e.g. `extra-tools`) is
 * IGNORED, never interpreted.
 */
export const normalizeSkillFrontmatter = (data: unknown, log: CompatLog = NOOP_LOG): unknown => {
  if (!isPlainObject(data)) return data
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    const camel = SKILL_KEBAB_RENAME[key]
    if (camel === undefined) {
      // Not an enumerated interop key — pass through verbatim.
      out[key] = value
      continue
    }
    // Enumerated kebab key. Native camel wins on conflict: if the camel key is
    // ALREADY present (native file authoritative, or already-renamed earlier),
    // drop the kebab. This is the load-bearing anti-smuggle rule — a broad
    // kebab `allowed-tools` cannot override a narrow native `allowedTools`.
    const camelPresentNative = Object.hasOwn(data, camel)
    const camelAlreadyWritten = Object.hasOwn(out, camel)
    if (camelPresentNative || camelAlreadyWritten) {
      log(`[manifest-compat] dropped kebab '${key}' — native '${camel}' is authoritative`)
      continue
    }
    out[camel] = value
    log(`[manifest-compat] renamed kebab '${key}' → '${camel}'`)
  }
  return out
}
