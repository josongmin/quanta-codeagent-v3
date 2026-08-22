/**
 * `code-parser` sub-slice barrel (RFC jun-6-syntax-aware-chunking).
 *
 * One `CodeParserPort` (WASM tree-sitter) powers BOTH the syntax-aware
 * indexer chunker and the read-time outline. Default-OFF: nothing here is
 * constructed unless an operator opts in via the `QUANTA_SYNTAX_CHUNK` /
 * `QUANTA_READ_OUTLINE` knobs and a composition root wires the parser.
 */

export { isContainer, kindForNodeType, langForPath, wasmBasename } from "./lang-table"
export type { FakeParser } from "./tree-sitter"
export { createTreeSitterParser, fakeParser } from "./tree-sitter"
export type {
  CodeParserPort,
  DeclNode,
  ParsedFile,
  ParseLang,
  ParseOutcome,
} from "./types"
