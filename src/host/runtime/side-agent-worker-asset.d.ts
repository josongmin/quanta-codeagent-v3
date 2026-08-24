/**
 * Type declaration for the EMBEDDED side-agent worker asset.
 *
 * `import x from "@/side-agent/worker-entry.mjs" with { type: "file" }` is a bun
 * bundler feature: it embeds the bytes and yields the path to read them from.
 * TypeScript has no notion of the attribute (it reports TS7016 for the `.mjs`),
 * so the module is declared here as `string` (the path) — the same shape the
 * sibling `permission/shell/wasm-assets.d.ts` and
 * `skill/system-skills/skill-md-assets.d.ts` use for their embedded assets.
 *
 * Embedding is what stops `sideAgentWorkerModulePath()` from escaping to the
 * FILESYSTEM ROOT in a compiled binary. It does NOT make the fork work — see
 * `side-agent-fork-port.ts` for the measured reason it cannot.
 */

declare module "@/side-agent/worker-entry.mjs" {
  const path: string
  export default path
}
