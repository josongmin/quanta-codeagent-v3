/**
 * `@/permission/shell/ir` — lower a parsed bash tree into the typed IR the
 * effect assessment reads.
 *
 * The IR answers exactly the questions a security decision needs and nothing
 * more:
 *
 *   - what COMMANDS run, in execution order, across `;`, `&&`, `||`, `|`, `&`,
 *     newlines, subshells and groups (so `cd /` can be seen to precede the
 *     delete that follows it);
 *   - for each command, the head word and its arguments as RESOLVED text —
 *     with quoting removed, because `r""m` and `rm` are the same program;
 *   - which words could NOT be resolved statically, because they contain a
 *     parameter expansion, a command substitution, an arithmetic expansion or
 *     a process substitution.
 *
 * THAT LAST POINT IS THE LOAD-BEARING ONE. `rm${IFS}-rf${IFS}/` is a single
 * `command_name` in the grammar whose text happens to spell a delete; a lowering
 * that concatenated the literal fragments and dropped the expansions would hand
 * the assessment a confident, WRONG answer. Every word therefore carries
 * `resolved`, and an unresolved word in a security-relevant position forces
 * `unknown` rather than a guess about what the shell would have produced.
 *
 * Pure: no IO, no clock, no randomness. Same tree ⇒ same IR.
 */

import type { ShellNode } from "./parser"

/** One word of a command, after quote removal. `resolved:false` means the word
 *  contains something only the running shell can evaluate, so its TEXT must
 *  never be pattern-matched as if it were the final argument. */
export interface ShellWord {
  readonly text: string
  readonly resolved: boolean
}

/** A single simple command in execution order. */
export interface ShellCommandIr {
  /** The head word (program name), or `null` for an assignment-only command. */
  readonly head: ShellWord | null
  readonly args: readonly ShellWord[]
  /** Redirect targets, e.g. the `X` of `> X`. Carried because a write can be
   *  expressed purely as a redirect (`: > /etc/passwd`). */
  readonly redirects: readonly ShellWord[]
  /** Which pipeline this command belongs to, or `null` when it stands alone.
   *
   *  A flattened command list would lose the ONE fact that makes
   *  `curl x | sh` different from `curl x` followed by `sh`: the first
   *  command's OUTPUT becomes the second's program text. Pipe-to-shell is the
   *  canonical remote-code-execution shape, so co-pipeline membership is part
   *  of the IR rather than something the assessment has to guess. */
  readonly pipeline: number | null
  /** True when this command is the body of a function whose body invokes the
   *  function again — the fork-bomb shape. Recorded here because the recursion
   *  is visible in the TREE and invisible in any single command's argv. */
  readonly selfRecursiveFunction: boolean
}

export interface ShellScriptIr {
  readonly commands: readonly ShellCommandIr[]
  /** The grammar reported an ERROR or a MISSING node anywhere. */
  readonly hasParseError: boolean
  /** A function whose body calls itself and backgrounds the call — the fork
   *  bomb. Detected on the tree because no individual command looks unusual. */
  readonly hasForkBomb: boolean
}

/** Node types whose presence means "only the running shell knows the value". */
const UNRESOLVABLE_NODE_TYPES = new Set([
  "expansion",
  "simple_expansion",
  "command_substitution",
  "arithmetic_expansion",
  "process_substitution",
])

/** Node types that introduce a NEW command in execution order. */
const COMMAND_NODE_TYPES = new Set(["command", "declaration_command", "unset_command"])

/** The container node types this slice expects the grammar to produce around a
 *  command. The walker descends into EVERY node with children — a shape it did
 *  not anticipate must never make a command vanish from the IR — so this set is
 *  not a filter. It is the DRIFT GUARD's inventory: a test parses a corpus of
 *  real command shapes and fails if the grammar emits a container that is not
 *  listed here, which is how a grammar bump that renames or adds a construct
 *  gets noticed instead of silently changing what the authority can see. */
export const EXPECTED_CONTAINER_NODE_TYPES: ReadonlySet<string> = new Set([
  "program",
  "list",
  "pipeline",
  "subshell",
  "compound_statement",
  "if_statement",
  "elif_clause",
  "else_clause",
  "while_statement",
  "until_statement",
  "for_statement",
  "c_style_for_statement",
  "case_statement",
  "case_item",
  "function_definition",
  "do_group",
  "negated_command",
  "redirected_statement",
  "variable_assignment",
  // `[ -f x ]` / `[[ … ]]` — found by the B-11 drift guard on its first run.
  "test_command",
])

const children = (node: ShellNode): ShellNode[] => {
  const out: ShellNode[] = []
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i)
    if (c !== null) out.push(c)
  }
  return out
}

/** Does this subtree contain anything only the shell can evaluate? */
const hasUnresolvable = (node: ShellNode): boolean => {
  if (UNRESOLVABLE_NODE_TYPES.has(node.type)) return true
  return children(node).some(hasUnresolvable)
}

/** Strip one layer of shell quoting from a word's source text.
 *
 *  Deliberately literal: it removes `'`, `"` and a backslash before a character,
 *  which is what makes `r""m`, `'rm'` and `r\m` read as the programs they are.
 *  It does NOT attempt to evaluate anything — a word containing an expansion is
 *  marked unresolved by the caller and its text is never trusted. */
const stripQuoting = (raw: string): string => {
  let out = ""
  let quote: '"' | "'" | null = null
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i] as string
    if (ch === "\\" && quote !== "'" && i + 1 < raw.length) {
      out += raw[i + 1] as string
      i++
      continue
    }
    if (quote === null && (ch === '"' || ch === "'")) {
      quote = ch
      continue
    }
    if (quote !== null && ch === quote) {
      quote = null
      continue
    }
    out += ch
  }
  return out
}

const toWord = (node: ShellNode): ShellWord =>
  hasUnresolvable(node)
    ? { text: node.text, resolved: false }
    : { text: stripQuoting(node.text), resolved: true }

/** Node types that appear inside a `command` but are not argument words. */
const NON_ARG_CHILD_TYPES = new Set(["command_name", "file_redirect", "heredoc_redirect"])

const REDIRECT_TYPES = new Set(["file_redirect", "heredoc_redirect"])

/** Redirect operand node types that can name a FILE. A positive ALLOWLIST, not
 *  an operator denylist: an fd-dup (`2>&1`) lowers to
 *  `file_descriptor "2" / >& / number "1"`, and a denylist that forgot `number`
 *  let the descriptor `1` through as if it were a path — a fabricated write
 *  effect in a deny authority, which is exactly the false positive the
 *  false-negatives-over-false-positives posture forbids. */
const REDIRECT_TARGET_TYPES: ReadonlySet<string> = new Set([
  "word",
  "string",
  "raw_string",
  "concatenation",
  "expansion",
  "simple_expansion",
  "command_substitution",
])

const lowerCommand = (node: ShellNode, pipeline: number | null): ShellCommandIr => {
  let head: ShellWord | null = null
  const args: ShellWord[] = []
  const redirects: ShellWord[] = []
  for (const child of children(node)) {
    if (child.type === "command_name") {
      head = toWord(child)
      continue
    }
    if (REDIRECT_TYPES.has(child.type)) {
      for (const target of children(child)) {
        if (target.type === ">" || target.type === ">>" || target.type === "<") continue
        redirects.push(toWord(target))
      }
      continue
    }
    if (NON_ARG_CHILD_TYPES.has(child.type)) continue
    // `variable_assignment` prefixes (`FOO=1 cmd`) are arguments to the effect
    // reader only insofar as they are not the head; the assessment ignores them
    // unless the head is a vehicle like `env`.
    args.push(toWord(child))
  }
  return { head, args, redirects, pipeline, selfRecursiveFunction: false }
}

/** Walk the tree in execution order, collecting simple commands.
 *
 *  `pipeline` threads the enclosing pipeline's id so co-piped commands can be
 *  recognized as one data path. `fnName` threads the enclosing function's name
 *  so a body that calls its own function is visible as recursion. */
interface WalkState {
  error: boolean
  forkBomb: boolean
  nextPipeline: number
}

/** Redirect targets declared on a `redirected_statement`, as words.
 *
 *  Whether a redirect names a FILE or a DESCRIPTOR is decided by the OPERAND,
 *  not the operator: `>&1` dups (operand is a `number`) while `>&out.log` sends
 *  BOTH streams to a file (operand is a `word`). An operator-level skip
 *  therefore silently dropped the second — a real write, missed by the old
 *  regexes too — so the target-type allowlist is the only check, and it gets
 *  both right. */
const redirectTargetWords = (kids: readonly ShellNode[]): ShellWord[] => {
  const targets: ShellWord[] = []
  for (const c of kids) {
    if (!REDIRECT_TYPES.has(c.type)) continue
    for (const t of children(c)) {
      if (!REDIRECT_TARGET_TYPES.has(t.type)) continue
      targets.push(toWord(t))
    }
  }
  return targets
}

/** `file_redirect` is a SIBLING of the command, not a child, so lowering the
 *  `command` node alone left `redirects` structurally EMPTY for every command in
 *  the tree — the field looked wired and never carried anything. Collect the
 *  targets here and attach them to the LAST command the wrapped subtree emits,
 *  which is where bash binds them (`cd /etc && echo x > motd` redirects `echo`,
 *  not `cd`). */
const walkRedirected = (
  node: ShellNode,
  out: ShellCommandIr[],
  st: WalkState,
  pipeline: number | null,
  fnName: string | null,
): void => {
  const kids = children(node)
  const before = out.length
  for (const c of kids) {
    if (REDIRECT_TYPES.has(c.type)) continue
    walk(c, out, st, pipeline, fnName)
  }
  const targets = redirectTargetWords(kids)
  const lastIdx = out.length - 1
  if (targets.length === 0 || lastIdx < before) return
  const last = out[lastIdx] as ShellCommandIr
  out[lastIdx] = { ...last, redirects: [...last.redirects, ...targets] }
}

/** Node types this walker handles specially, in the order it checks them. */
const walkSpecial = (
  node: ShellNode,
  out: ShellCommandIr[],
  st: WalkState,
  pipeline: number | null,
  fnName: string | null,
): boolean => {
  if (node.type === "pipeline") {
    const id = st.nextPipeline
    st.nextPipeline++
    for (const c of children(node)) walk(c, out, st, id, fnName)
    return true
  }
  if (node.type === "redirected_statement") {
    walkRedirected(node, out, st, pipeline, fnName)
    return true
  }
  if (node.type === "function_definition") {
    const kids = children(node)
    const nameNode = kids[0]
    const name =
      nameNode !== undefined && !hasUnresolvable(nameNode) ? stripQuoting(nameNode.text) : null
    for (const c of kids) walk(c, out, st, pipeline, name)
    return true
  }
  return false
}

const walk = (
  node: ShellNode,
  out: ShellCommandIr[],
  st: WalkState,
  pipeline: number | null,
  fnName: string | null,
): void => {
  if (node.isMissing) st.error = true
  if (node.type === "ERROR") {
    st.error = true
    return
  }
  if (COMMAND_NODE_TYPES.has(node.type)) {
    const cmd = lowerCommand(node, pipeline)
    if (fnName !== null && cmd.head?.resolved === true && cmd.head.text === fnName) {
      st.forkBomb = true
    }
    out.push(cmd)
    return
  }
  if (walkSpecial(node, out, st, pipeline, fnName)) return
  // An unmodelled node that itself contains a command would otherwise vanish
  // from the IR, which would read as "nothing dangerous here". Descend either
  // way; CONTAINER_NODE_TYPES documents the shapes we expect to see.
  for (const c of children(node)) walk(c, out, st, pipeline, fnName)
}

export const lowerShellTree = (root: ShellNode): ShellScriptIr => {
  const commands: ShellCommandIr[] = []
  const st: WalkState = { error: root.hasError, forkBomb: false, nextPipeline: 0 }
  walk(root, commands, st, null, null)
  return { commands, hasParseError: st.error, hasForkBomb: st.forkBomb }
}
