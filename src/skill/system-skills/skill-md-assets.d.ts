/**
 * Type declarations for the EMBEDDED `SKILL.md` assets.
 *
 * `import x from "./<name>/SKILL.md" with { type: "file" }` is a bun bundler
 * feature: it embeds the bytes and yields the path to read them from.
 * TypeScript has no notion of the attribute, so every `SKILL.md` under this
 * directory is declared here as `string` (the path).
 *
 * Embedding rather than walking the directory is what makes the bundled system
 * skills exist in a COMPILED binary at all — see `index.ts` for the measured
 * failure this prevents (22 skills from source, zero in the shipped CLI).
 */

declare module "*/SKILL.md" {
  const path: string
  export default path
}
