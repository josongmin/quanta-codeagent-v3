/**
 * §17 packet I — type declarations for the EMBEDDED wasm assets.
 *
 * `import x from "…/y.wasm" with { type: "file" }` is a bun bundler feature: it
 * embeds the bytes and yields the path to read them from. TypeScript has no
 * notion of it, so the modules are declared here as `string` (the path).
 *
 * Embedding rather than resolving from `node_modules` is what makes the shell
 * effect authority work in the COMPILED binary — see `parser.ts` for the
 * measured failure this prevents.
 */

declare module "web-tree-sitter/web-tree-sitter.wasm" {
  const path: string
  export default path
}

declare module "@vscode/tree-sitter-wasm/wasm/tree-sitter-bash.wasm" {
  const path: string
  export default path
}
