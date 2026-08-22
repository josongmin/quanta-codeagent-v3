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

/**
 * FROZEN closed set of frontmatter keys that the strict `parseSkillMarkdown`
 * block-list lookahead may open as a YAML block-list parent EVEN WHEN ZERO
 * items follow (an explicit tool-less skill declaring `allowed-tools:` with an
 * empty list ⇒ `[]`, the safe "no tools" scoping). Without this the strict
 * authority rejects a bare `allowed-tools:` header with "empty value" while the
 * LENIENT discover.ts read path yields `[]` — a real parse-path asymmetry
 * (ticket §4.b parity). Exported so the hellgate asserts the set is exactly the
 * one enumerated block-list interop key (widening it is guard-visible).
 *
 * Compat-only / default-OFF: the strict parser ONLY consults this when the
 * `QUANTA_MANIFEST_COMPAT` knob is armed, so unarmed parsing is byte-identical.
 */
export const SKILL_KEBAB_BLOCK_LIST_KEYS: ReadonlySet<string> = Object.freeze(
  new Set(["allowed-tools"]),
) as ReadonlySet<string>

/** Observability hook for dropped/normalized keys (ticket §5: keep drift
 *  visible). The default is a no-op; `discover.ts` / parsers may pass a debug
 *  sink. NEVER throws. */
export type CompatLog = (message: string) => void

const NOOP_LOG: CompatLog = () => {}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

/**
 * Keys the normalizer NEVER copies onto the output object. `out["__proto__"] =
 * v` mutates the prototype rather than creating an own key; the `.strip()`
 * schemas absorb that today, but skipping these keys is the load-bearing
 * defense-in-depth so the normalizer can never alias a prototype or carry a
 * forbidden own-key through (matches the lenient parser's `FORBIDDEN_KEYS`).
 */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"])

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
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    // Never copy a forbidden prototype key (spread `{...raw}` would mutate the
    // prototype for an own-enumerable `__proto__`); drop it.
    if (FORBIDDEN_KEYS.has(key)) {
      log(`[manifest-compat] dropped forbidden prototype key '${key}'`)
      continue
    }
    out[key] = value
  }
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
    // Never copy a forbidden prototype key (defense-in-depth — assigning
    // `out["__proto__"]` mutates the prototype, not an own slot).
    if (FORBIDDEN_KEYS.has(key)) {
      log(`[manifest-compat] dropped forbidden prototype key '${key}'`)
      continue
    }
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
