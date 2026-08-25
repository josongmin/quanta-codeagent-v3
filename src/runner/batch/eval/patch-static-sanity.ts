import { readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { execArgv } from "./exec"

/**
 * Differential undefined-name (F821) analyzer — the sole static-sanity probe.
 *
 * A naive single-pass "undefined name" scan false-positives catastrophically on
 * real, dirty SWE-bench repos (forward refs, star-imports, conditional defs,
 * dynamic globals, scoping our stdlib heuristic does not fully model). The fix —
 * mirroring agentless `postprocess_data.py` — is to run the SAME deterministic
 * analyzer over the BEFORE (pre-patch) and AFTER (post-patch) version of each
 * edited file and veto ONLY net-new undefined names (after-minus-before). Any
 * name the analyzer would mis-flag also gets mis-flagged on the before image, so
 * it cancels in the subtraction. Consistency therefore matters more than
 * completeness: the analyzer just has to be DETERMINISTIC and IDENTICAL on both
 * images. This is why the heuristic below is allowed to be deliberately simple.
 *
 * Scope model (stdlib `ast` only — no pyflakes/flake8, not installable here):
 * a `Name` node in Load context is "undefined" iff it resolves to NONE of
 *   - python builtins,
 *   - module-level assignments / imports / def+class names,
 *   - an enclosing function's params + any name bound anywhere in that scope,
 *   - comprehension / lambda targets,
 *   - `global`/`nonlocal`-declared names,
 *   - class-scope names,
 *   - names bound by `with as` / `except as` / `for` targets / walrus.
 * Bindings are collected scope-wide (collect-then-resolve), so the result is
 * order-insensitive and identical before vs after for unchanged code.
 *
 * Payload: a JSON file `[{"rel","before","after"}, ...]` (before = "" for a
 * brand-new file ⇒ its undefined names are all net-new and eligible). One python
 * invocation diffs both images and prints the net-new reasons, staying inside a
 * single timeout. A file whose BEFORE or AFTER is unparseable contributes
 * nothing for that file (ambiguous ⇒ advisory, never a hard veto).
 */
export const PYTHON_UNDEFINED_NAME_DIFF_SCRIPT = `
import ast
import builtins
import json
import sys

BUILTINS = set(dir(builtins)) | {
    "__file__", "__name__", "__doc__", "__builtins__", "__spec__",
    "__loader__", "__package__", "__path__", "__dict__", "__class__",
    "__module__", "__qualname__", "self", "cls",
}


def target_names(node, out):
    if isinstance(node, ast.Name):
        out.add(node.id)
    elif isinstance(node, (ast.Tuple, ast.List)):
        for e in node.elts:
            target_names(e, out)
    elif isinstance(node, ast.Starred):
        target_names(node.value, out)


class Scope(object):
    def __init__(self, kind, parent):
        self.kind = kind
        self.parent = parent
        self.bound = set()


def bind_node(node, scope):
    if isinstance(node, ast.Import):
        for a in node.names:
            scope.bound.add((a.asname or a.name).split(".")[0])
        return
    if isinstance(node, ast.ImportFrom):
        for a in node.names:
            scope.bound.add(a.asname or a.name)
        return
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        scope.bound.add(node.name)
        return
    if isinstance(node, (ast.Lambda, ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)):
        return
    if isinstance(node, ast.Assign):
        for t in node.targets:
            target_names(t, scope.bound)
        bind_node(node.value, scope)
        return
    if isinstance(node, (ast.AnnAssign, ast.AugAssign)):
        target_names(node.target, scope.bound)
        if node.value is not None:
            bind_node(node.value, scope)
        return
    if hasattr(ast, "NamedExpr") and isinstance(node, ast.NamedExpr):
        target_names(node.target, scope.bound)
        bind_node(node.value, scope)
        return
    if isinstance(node, (ast.For, ast.AsyncFor)):
        target_names(node.target, scope.bound)
        bind_node(node.iter, scope)
        for s in node.body:
            bind_node(s, scope)
        for s in node.orelse:
            bind_node(s, scope)
        return
    if isinstance(node, (ast.With, ast.AsyncWith)):
        for item in node.items:
            if item.optional_vars is not None:
                target_names(item.optional_vars, scope.bound)
            bind_node(item.context_expr, scope)
        for s in node.body:
            bind_node(s, scope)
        return
    if isinstance(node, ast.ExceptHandler):
        if node.name:
            scope.bound.add(node.name)
        for s in node.body:
            bind_node(s, scope)
        return
    if isinstance(node, ast.Global):
        scope.bound.update(node.names)
        return
    if isinstance(node, ast.Nonlocal):
        scope.bound.update(node.names)
        return
    for child in ast.iter_child_nodes(node):
        bind_node(child, scope)


def func_params(fn):
    names = set()
    a = fn.args
    for grp in (list(a.posonlyargs), list(a.args), list(a.kwonlyargs)):
        for arg in grp:
            names.add(arg.arg)
    if a.vararg:
        names.add(a.vararg.arg)
    if a.kwarg:
        names.add(a.kwarg.arg)
    return names


def build_function_scope(fn, parent):
    s = Scope("function", parent)
    s.bound |= func_params(fn)
    for stmt in fn.body:
        bind_node(stmt, s)
    return s


def resolve(name, scope):
    if name in BUILTINS:
        return True
    cur = scope
    while cur is not None:
        if name in cur.bound:
            return True
        cur = cur.parent
    return False


class UndefVisitor(object):
    def __init__(self):
        self.found = []

    def visit_scope(self, body_nodes, scope):
        for n in body_nodes:
            self.visit(n, scope)

    def visit(self, node, scope):
        if isinstance(node, ast.Name):
            if isinstance(node.ctx, ast.Load) and not resolve(node.id, scope):
                self.found.append(node.id)
            return
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            for d in node.decorator_list:
                self.visit(d, scope)
            for df in node.args.defaults:
                self.visit(df, scope)
            for df in node.args.kw_defaults:
                if df is not None:
                    self.visit(df, scope)
            allargs = list(node.args.posonlyargs) + list(node.args.args) + list(node.args.kwonlyargs)
            for arg in allargs:
                if arg.annotation is not None:
                    self.visit(arg.annotation, scope)
            if node.returns is not None:
                self.visit(node.returns, scope)
            fscope = build_function_scope(node, scope)
            self.visit_scope(node.body, fscope)
            return
        if isinstance(node, ast.Lambda):
            for df in node.args.defaults:
                self.visit(df, scope)
            for df in node.args.kw_defaults:
                if df is not None:
                    self.visit(df, scope)
            lscope = Scope("lambda", scope)
            lscope.bound |= func_params(node)
            self.visit(node.body, lscope)
            return
        if isinstance(node, ast.ClassDef):
            for d in node.decorator_list:
                self.visit(d, scope)
            for b in node.bases:
                self.visit(b, scope)
            for kw in node.keywords:
                self.visit(kw.value, scope)
            cscope = Scope("class", scope)
            for stmt in node.body:
                bind_node(stmt, cscope)
            self.visit_scope(node.body, cscope)
            return
        if isinstance(node, (ast.ListComp, ast.SetComp, ast.GeneratorExp, ast.DictComp)):
            compscope = Scope("comp", scope)
            for gen in node.generators:
                target_names(gen.target, compscope.bound)
            for i, gen in enumerate(node.generators):
                if i == 0:
                    self.visit(gen.iter, scope)
                else:
                    self.visit(gen.iter, compscope)
                for cond in gen.ifs:
                    self.visit(cond, compscope)
            if isinstance(node, ast.DictComp):
                self.visit(node.key, compscope)
                self.visit(node.value, compscope)
            else:
                self.visit(node.elt, compscope)
            return
        for child in ast.iter_child_nodes(node):
            self.visit(child, scope)


def undefined_names(text):
    try:
        tree = ast.parse(text)
    except Exception:
        return None
    module_scope = Scope("module", None)
    for stmt in tree.body:
        bind_node(stmt, module_scope)
    v = UndefVisitor()
    v.visit_scope(tree.body, module_scope)
    return set(v.found)


def main():
    payload_path = sys.argv[1]
    try:
        with open(payload_path, "r", encoding="utf-8") as fh:
            entries = json.load(fh)
    except Exception:
        print("[]")
        return
    out = []
    seen = set()
    for entry in entries:
        rel = entry.get("rel", "")
        if not rel.endswith(".py"):
            continue
        after = undefined_names(entry.get("after", ""))
        if after is None:
            # AFTER unparseable ⇒ ambiguous ⇒ contribute nothing for this file.
            continue
        before_text = entry.get("before", "")
        before = undefined_names(before_text)
        if before is None:
            # BEFORE unparseable ⇒ cannot trust the subtraction for this file;
            # advisory ⇒ contribute nothing (never a false hard veto).
            continue
        for name in sorted(after - before):
            reason = "hard:staticSanity=pythonUndefinedNameIntroduced(" + name + "@" + rel + ")"
            if reason not in seen:
                seen.add(reason)
                out.append(reason)
    print(json.dumps(out))


main()
`.trim()

export const parsePatchStaticSanityStdout = (stdout: string): string[] | null => {
  try {
    const parsed = JSON.parse(stdout.trim()) as unknown
    if (!Array.isArray(parsed)) return null
    const out: string[] = []
    for (const item of parsed) {
      if (typeof item !== "string") return null
      out.push(item)
    }
    return out
  } catch {
    return null
  }
}

/** Pre-patch (BEFORE) content of a sandbox file via `git show HEAD:<rel>`.
 *
 * The probe runs in a git worktree reset to `baseCommit` (= HEAD) with the
 * candidate patch applied to the WORKING TREE but NOT committed (see
 * rematerialize.ts `withCandidatePatch` / `resetToBase`). So the committed HEAD
 * tree is exactly the pre-patch image, and `git show HEAD:<rel>` yields BEFORE.
 *
 * Returns the file's pre-patch text, or `undefined` when git-show fails — which
 * legitimately happens for a brand-new file the patch ADDS (path absent at HEAD,
 * rc 128). A new file's undefined names ARE net-new, so the caller treats a
 * `undefined` here as an EMPTY before-image (eligible), not as an error. Genuine
 * git unavailability (no repo at all) is detected separately by the caller via a
 * `git rev-parse` probe so it can fail-open instead of vetoing everything. */
const gitShowBefore = async (
  cwd: string,
  rel: string,
  timeoutMs: number,
): Promise<string | undefined> => {
  const r = await execArgv(["git", "show", `HEAD:${rel}`], cwd, timeoutMs).catch(() => null)
  if (r === null || r.code !== 0) return undefined
  return r.stdout
}

type DiffEntry = { readonly rel: string; readonly before: string; readonly after: string }

/** Per-target-file metadata parsed from the candidate's unified diff. Used to get
 *  the CORRECT before-image: a rename target's pre-image lives at its OLD path, and
 *  a genuinely-new file legitimately has an empty before. Without this, a renamed
 *  file's `git show HEAD:<new-path>` fails (rc 128) and the whole file is treated
 *  as net-new ⇒ a legitimate rename+fix is FALSE-VETOED (the F821 gate's worst
 *  failure mode). */
interface DiffFileMeta {
  readonly renamedFrom?: string
  readonly isNew: boolean
}

/** Parse `diff --git` sections for each target (b-side) path: whether it is a new
 *  file (`new file mode` / `--- /dev/null`) and its rename source (`rename from`).
 *  Best-effort + conservative: anything it cannot classify stays `{isNew:false}`,
 *  which routes an unresolved missing before-image to FAIL-OPEN (never net-new). */
export const parseDiffFileMeta = (patch: string): ReadonlyMap<string, DiffFileMeta> => {
  const out = new Map<string, DiffFileMeta>()
  let bPath: string | undefined
  let isNew = false
  let renamedFrom: string | undefined
  const flush = (): void => {
    if (bPath !== undefined) out.set(bPath, { isNew, ...(renamedFrom ? { renamedFrom } : {}) })
  }
  for (const line of patch.split("\n")) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
    if (header !== null) {
      flush()
      bPath = header[2]
      isNew = false
      renamedFrom = undefined
      continue
    }
    if (bPath === undefined) continue
    if (line.startsWith("new file mode") || line === "--- /dev/null") isNew = true
    else if (line.startsWith("rename from ")) renamedFrom = line.slice("rename from ".length).trim()
    // A `copy from` source exists at HEAD too — resolve the before-image from it so
    // copied names cancel in the subtraction (NOT a false net-new veto).
    else if (line.startsWith("copy from ")) renamedFrom = line.slice("copy from ".length).trim()
  }
  flush()
  return out
}

/** Temp payload file for the differential analyzer. Untracked, so the
 *  surrounding `withCandidatePatch` finally-reset (`git clean -fdx`) sweeps it
 *  even if the explicit unlink below fails; it is never part of any captured
 *  diff. */
const UNDEFINED_DIFF_PAYLOAD_FILE = ".quanta-undefined-diff.json"

/**
 * Differential undefined-name probe (the static-sanity gate). Builds a
 * `[{rel, before, after}]` payload (before via {@link gitShowBefore}, after via
 * the working-tree file) and runs {@link PYTHON_UNDEFINED_NAME_DIFF_SCRIPT} ONCE
 * so before+after stay inside a single timeout.
 *
 * FAIL-OPEN (returns `null`, never a hard veto) when:
 *   - the sandbox is not a git repo (cannot obtain any before-image reliably),
 *   - EVERY edited file's git-show failed (whole-set git failure ⇒ ambiguous),
 *   - the python backend is unavailable / errored / emitted unparseable output.
 * A `null` here is treated by {@link probePatchStaticSanity} as "no contribution"
 * (advisory), so it can never erase a real veto from the other probes nor invent
 * one. A new file (git-show fails for SOME but not all files) is handled by an
 * empty before-image, which is correct (its names are net-new). */
/** What one collection pass over the edited .py files produced. `anyBefore`
 *  records whether ANY git before-image was readable — the signal that separates
 *  "all-new files" from "the git baseline is broken". */
type DiffEntryScan = { readonly entries: DiffEntry[]; readonly anyBefore: boolean }

/**
 * Read the (before, after) pair for every edited `.py` file.
 *
 * Its own unit because each of its three skip conditions is a FAIL-OPEN
 * decision with its own justification, and inline every one of them sat inside
 * the file loop and paid its nesting surcharge.
 */
const collectDiffEntries = async (
  cwd: string,
  pyFiles: readonly string[],
  fileMeta: ReadonlyMap<string, DiffFileMeta> | undefined,
  timeoutMs: number,
): Promise<DiffEntryScan> => {
  const entries: DiffEntry[] = []
  let anyBefore = false
  for (const rel of pyFiles) {
    const meta = fileMeta?.get(rel)
    // Rename target ⇒ its pre-image lives at the OLD path.
    const beforePath = meta?.renamedFrom ?? rel
    const before = await gitShowBefore(cwd, beforePath, timeoutMs)
    if (before !== undefined) anyBefore = true
    // Missing before-image: only treat as net-new-eligible (empty before) when the
    // diff CONFIRMS this is a genuinely new file. For a rename/modify whose before
    // we could not read, FAIL-OPEN (skip the file) rather than false-veto every
    // name in it. When no patch was supplied we keep the legacy empty-before
    // behavior (callers without rename context).
    if (before === undefined && fileMeta !== undefined && meta?.isNew !== true) {
      continue
    }
    let after: string
    try {
      after = await readFile(join(cwd, rel), "utf8")
    } catch {
      // After-file unreadable (deleted by the patch / path error) ⇒ nothing to
      // analyze for this file.
      continue
    }
    entries.push({ rel, before: before ?? "", after })
  }
  return { entries, anyBefore }
}

/**
 * Hand the collected (before, after) pairs to the python F821 backend through a
 * temp payload file, and always remove the payload afterwards.
 *
 * A unit of its own because it owns the payload file's LIFETIME: every exit
 * path — write failure, spawn failure, non-zero exit, success — must leave the
 * sandbox clean, which is only checkable when the write and the `finally` sit
 * in one function. Returns `null` (fail-open) for every backend problem.
 */
const runUndefinedNameBackend = async (
  cwd: string,
  entries: readonly DiffEntry[],
  timeoutMs: number,
): Promise<string[] | null> => {
  const payloadPath = join(cwd, UNDEFINED_DIFF_PAYLOAD_FILE)
  try {
    await writeFile(payloadPath, JSON.stringify(entries), "utf8")
  } catch {
    return null
  }
  try {
    const result = await execArgv(
      ["python3", "-c", PYTHON_UNDEFINED_NAME_DIFF_SCRIPT, UNDEFINED_DIFF_PAYLOAD_FILE],
      cwd,
      timeoutMs,
    ).catch(() => null)
    if (result === null || result.code !== 0) return null
    return parsePatchStaticSanityStdout(result.stdout)
  } finally {
    await rm(payloadPath, { force: true }).catch(() => {})
  }
}

export const probeUndefinedNameDiff = async (args: {
  readonly cwd: string
  readonly files: readonly string[]
  readonly timeoutMs: number
  /** The candidate's unified diff. Used to resolve rename pre-images and to tell a
   *  genuinely-new file (empty before is correct) from a rename/modify whose
   *  before-image we simply failed to read (must FAIL-OPEN, never net-new).
   *  Absent ⇒ legacy behavior (missing before ⇒ empty before). */
  readonly patch?: string
}): Promise<string[] | null> => {
  const pyFiles = args.files.filter((file) => file.endsWith(".py"))
  if (pyFiles.length === 0) return []
  // Whole-set git availability gate: a non-git sandbox cannot yield trustworthy
  // before-images ⇒ advisory (fail-open) rather than treating every file as new
  // and hard-vetoing pre-existing repo noise.
  const isGit = await execArgv(["git", "rev-parse", "--git-dir"], args.cwd, args.timeoutMs).catch(
    () => null,
  )
  if (isGit === null || isGit.code !== 0) return null

  const fileMeta = args.patch !== undefined ? parseDiffFileMeta(args.patch) : undefined
  const { entries, anyBefore } = await collectDiffEntries(
    args.cwd,
    pyFiles,
    fileMeta,
    args.timeoutMs,
  )
  // If NO file yielded a before-image, the git tree is unusable as a baseline
  // (every show failed) — but only treat that as ambiguous when there is more
  // than the new-file case. We cannot distinguish "all brand-new files" from
  // "git baseline broken" cheaply; the conservative, fail-open choice is to NOT
  // veto when nothing baselined. New-file-only edits are rare for source fixes
  // (they edit existing modules), and a false hard veto is the worse failure.
  if (entries.length === 0) return []
  if (!anyBefore) return null

  return await runUndefinedNameBackend(args.cwd, entries, args.timeoutMs)
}

/**
 * Static-sanity probe. The ONLY remaining static-sanity gate is the differential
 * undefined-name (F821) analyzer — the bespoke AST pattern probes (callback-arity
 * mismatch, None-subscript mutation) were removed as overfit deterministic
 * heuristics. The differential analyzer is FAIL-OPEN (returns `null`, never a
 * false hard veto) on any ambiguity, and only flags NET-NEW undefined names a
 * patch literally introduces — a definite, execution-free defect rather than a
 * patch-shape guess.
 */
export const probePatchStaticSanity = async (args: {
  readonly cwd: string
  readonly files: readonly string[]
  readonly timeoutMs: number
  /** Candidate unified diff — forwarded to the differential probe for rename
   *  pre-image resolution + new-file discrimination. Absent ⇒ legacy behavior. */
  readonly patch?: string
}): Promise<string[] | null> => {
  const pyFiles = args.files.filter((file) => file.endsWith(".py"))
  if (pyFiles.length === 0) return []
  return probeUndefinedNameDiff({
    cwd: args.cwd,
    files: args.files,
    timeoutMs: args.timeoutMs,
    ...(args.patch !== undefined ? { patch: args.patch } : {}),
  }).catch(() => null)
}
