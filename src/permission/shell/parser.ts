/**
 * `@/permission/shell/parser` — the ONE shell parse the effect authority runs.
 *
 * The vendored `tree-sitter-bash` grammar (`@vscode/tree-sitter-wasm`, the same
 * package the retrieval code-parser already pins) is loaded ONCE, eagerly, by
 * {@link initShellEffectParser}. After that {@link parseShell} is SYNCHRONOUS —
 * which is what lets the permission gate stay a synchronous function.
 *
 * NOT-READY IS NOT SAFE. Before init completes (or if it fails), `parseShell`
 * returns `null` and the assessment answers `unknown`. It never degrades to
 * "assume harmless": a gate that guessed while blind would be worse than one
 * that admits it cannot read the command.
 *
 * NO-THROW: every failure path — missing package, wasm load error, grammar
 * mismatch, parse crash — resolves to "not ready", never an exception into a
 * permission decision.
 *
 * Determinism: a pinned grammar + a pure tree walk ⇒ same input, same tree. No
 * clock, no randomness, no env read beyond the grammar-dir override the
 * retrieval parser already honors.
 */

import { readFile } from "node:fs/promises"
import bashGrammarPath from "@vscode/tree-sitter-wasm/wasm/tree-sitter-bash.wasm" with {
  type: "file",
}
// EMBEDDED, not resolved from disk. `bun build --compile` produces a single-file
// binary with no `node_modules` beside it, so a `createRequire` lookup resolves
// nothing and `web-tree-sitter` falls back to loading its runtime wasm from
// `/$bunfs/root/web-tree-sitter.wasm` — which is not there either.
//
// Measured: in `dist/agent` the load failed with
// `ENOENT '/$bunfs/root/web-tree-sitter.wasm'`, so the structural hard-deny
// authority answered `unknown` for EVERY command and the SHIPPING binary
// silently ran on the regex-only gate this lane was built to replace. Dev runs
// were fine, which is exactly what made it invisible until the integration pass.
//
// `with { type: "file" }` makes bun embed the bytes and hand back a path that
// resolves in BOTH modes (a real path in dev, `/$bunfs/root/…` when compiled).
import runtimeWasmPath from "web-tree-sitter/web-tree-sitter.wasm" with { type: "file" }
import { errMessage, logger } from "@/shared"

/** The subset of a tree-sitter node this slice reads. Declared structurally so
 *  a missing/odd `web-tree-sitter` build cannot break type-checking of the
 *  permission slice (the runtime import is dynamic). */
export interface ShellNode {
  readonly type: string
  readonly text: string
  readonly childCount: number
  readonly hasError: boolean
  readonly isMissing: boolean
  child(i: number): ShellNode | null
}

interface ShellParser {
  parse(source: string): { readonly rootNode: ShellNode } | null
}

let parser: ShellParser | null = null
let initPromise: Promise<void> | null = null

/** Load the grammar once. Idempotent and concurrency-safe: repeated calls await
 *  the SAME promise, so N sessions in one process load one grammar. */
export const initShellEffectParser = async (): Promise<void> => {
  if (parser !== null) return
  if (initPromise !== null) return initPromise
  initPromise = (async () => {
    try {
      const mod = (await import("web-tree-sitter")) as unknown as {
        Parser?: { init(opts?: unknown): Promise<void>; new (): unknown }
        Language?: { load(bytes: Uint8Array): Promise<unknown> }
        default?: {
          Parser?: { init(opts?: unknown): Promise<void>; new (): unknown }
          Language?: { load(bytes: Uint8Array): Promise<unknown> }
        }
      }
      const ParserCtor = mod.Parser ?? mod.default?.Parser
      const Language = mod.Language ?? mod.default?.Language
      if (ParserCtor === undefined || Language === undefined) return
      // `locateFile` is how emscripten asks where its runtime wasm lives; without
      // it the module guesses a sibling path that does not exist in a compiled
      // binary.
      await ParserCtor.init({ locateFile: () => runtimeWasmPath })
      const wasm = await readFile(bashGrammarPath)
      const language = await Language.load(wasm)
      const p = new ParserCtor() as { setLanguage(l: unknown): void } & ShellParser
      p.setLanguage(language)
      parser = p
    } catch (e) {
      // Stay not-ready. Every caller reads this as `unknown`, which routes to
      // the existing ask/deny boundary — never to an allow. ATTRIBUTED, not
      // swallowed: a security authority that silently failed to arm is exactly
      // the failure an operator must be able to see.
      logger.warn(`shell effect parser: grammar load failed; ${errMessage(e)}`)
      parser = null
    }
  })()
  return initPromise
}

/** Is the grammar loaded? Exposed for diagnostics and for the wiring proof that
 *  the composition root actually initializes it. */
export const shellEffectParserReady = (): boolean => parser !== null

/** Parse one command. `null` means "could not read it" — not "it is fine". */
export const parseShell = (command: string): ShellNode | null => {
  if (parser === null) return null
  try {
    return parser.parse(command)?.rootNode ?? null
  } catch (e) {
    // tree-sitter reports a malformed command as an ERROR *tree*, so reaching
    // here means the parser itself failed — rare and worth surfacing, not a
    // per-command log flood. The caller degrades to `unknown` either way.
    logger.warn(`shell effect parser: parse failed; ${errMessage(e)}`)
    return null
  }
}

/** Test seam: drop the loaded grammar so a suite can exercise the not-ready
 *  path deliberately. NOT for production callers. */
export const __resetShellEffectParserForTest = (): void => {
  parser = null
  initPromise = null
}
