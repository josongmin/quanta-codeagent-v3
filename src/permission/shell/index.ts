/**
 * `@/permission/shell` — the single shell syntax/effect authority (§17 packet B).
 *
 * One parse per command, one typed IR, one assessment that hard-deny,
 * circumvention, ownership and grant all read. `unknown` is a first-class
 * verdict and never means "safe".
 */
export {
  assessShellCommand,
  assessShellCommandWith,
  type ShellAssessment,
  type ShellAssessmentKind,
} from "./assess"
export type { ShellCommandIr, ShellScriptIr, ShellWord } from "./ir"
export { EXPECTED_CONTAINER_NODE_TYPES, lowerShellTree } from "./ir"
export {
  __resetShellEffectParserForTest,
  initShellEffectParser,
  parseShell,
  shellEffectParserReady,
} from "./parser"
