/**
 * CHA multi-site fix-site resolver (jun-23).
 *
 * MEASURED motivation: on `agentless-v4-proof-clean`, the repro oracle is now
 * reliable (reproduces the bug 20/20), but multi-backend bugs still fail because
 * the model writes the CORRECT per-site fix yet MISSES sibling override sites.
 * django-11138 (proven): the model's `mysql/operations.py._convert_field_to_tz`
 * hunk is byte-identical to gold, but oracle + sqlite3 backends — which override
 * the SAME base method with the same bug — were left unfixed, so the (perfect)
 * repro correctly stays RED → empty_patch.
 *
 * LSP `references` does not surface "every override of an abstract method across
 * subclasses". This module does: a whole-repo class-hierarchy analysis (CHA) that,
 * given a method the agent localized, returns the SIBLING override sites — classes
 * that share a base with the target's class AND define the same method. A steer
 * then tells the agent to apply the same fix to each.
 *
 * NOT answer-key: this reads ONLY the candidate repo's own class structure. The
 * gold patch / its file list is never consulted. Pure static analysis.
 *
 * Slice posture: the heavy parse runs as a one-shot `python3 -` (Python analysing
 * Python — faithful + dependency-free) via the INJECTED exec port; this module
 * has no `node:*` import. The Python AST walk is deterministic; a fake exec makes
 * the parse/format hermetically testable, and a real-python hellgate proves the
 * sibling resolution end-to-end.
 */

/** Injected exec port — same shape as the bench's `Exec` (dataset.ts). */
export type ChaExec = (
  cmd: string,
  cwd: string,
  timeoutMs: number,
) => Promise<{ code: number; stdout: string; stderr: string }>

/** One sibling override site of the target method. */
export interface SiblingOverrideSite {
  /** Repo-relative path of the file defining the sibling override. */
  readonly file: string
  /** 1-based line of the `def <method>`. */
  readonly line: number
  /** Class that owns the sibling override. */
  readonly cls: string
}

/**
 * Python CHA analyzer (stdin program). Args: <repoRoot> <targetRelFile> <method>.
 * Emits JSON `{"sites":[{file,line,cls}], "targetClass": "...", "bases":[...]}` on
 * stdout (sites EXCLUDES the target class itself). Robustness: unparseable files
 * are skipped; no target class (method not found in targetRelFile) ⇒ empty sites.
 *
 * Sibling rule (deliberately conservative — shared BASE, not name-match): a class
 * C is a sibling iff C defines a method named `method` AND C's base-name set
 * intersects the target class's base-name set. So mysql/oracle/sqlite3
 * `DatabaseOperations` (all `(BaseDatabaseOperations)`) are siblings, but an
 * unrelated `Foo._convert_field_to_tz` with no shared base is NOT. The target
 * class itself is excluded from its own sibling list.
 */
export const CHA_ANALYZER_PY = String.raw`
import ast, json, os, sys

repo, target_rel, method = sys.argv[1], sys.argv[2], sys.argv[3]

# registry: list of {file, cls, line(def of method or class), bases:set, has_method:bool}
classes = []
for root, dirs, files in os.walk(repo):
    # skip vendored / VCS / cache dirs to keep the walk bounded
    dirs[:] = [d for d in dirs if d not in (".git", "node_modules", "__pycache__", ".tox", ".venv", "build", "dist")]
    for fn in files:
        if not fn.endswith(".py"):
            continue
        path = os.path.join(root, fn)
        try:
            with open(path, "r", encoding="utf-8") as fh:
                tree = ast.parse(fh.read())
        except Exception:
            continue
        rel = os.path.relpath(path, repo)
        for node in ast.walk(tree):
            if not isinstance(node, ast.ClassDef):
                continue
            base_names = set()
            for b in node.bases:
                # last attribute/name component (e.g. db.X -> X), import-agnostic
                cur = b
                while isinstance(cur, ast.Attribute):
                    cur = cur.attr
                    break
                if isinstance(b, ast.Name):
                    base_names.add(b.id)
                elif isinstance(b, ast.Attribute):
                    base_names.add(b.attr)
            method_line = None
            for item in node.body:
                if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)) and item.name == method:
                    method_line = item.lineno
                    break
            classes.append({
                "file": rel, "cls": node.name, "bases": base_names,
                "class_line": node.lineno,
                "method_line": method_line,
            })

# target = the class in target_rel that defines the method
target = None
for c in classes:
    if c["file"] == target_rel and c["method_line"] is not None:
        target = c
        break
# fallback: any class in target_rel (method may be inherited, still anchor on the file)
if target is None:
    for c in classes:
        if c["file"] == target_rel:
            target = c
            break

sites = []
if target is not None:
    tbases = target["bases"]
    for c in classes:
        if c["method_line"] is None:
            continue
        if c["file"] == target["file"] and c["cls"] == target["cls"]:
            continue  # exclude the target itself
        # sibling iff shares >=1 base name with the target class
        if tbases and (c["bases"] & tbases):
            sites.append({"file": c["file"], "line": c["method_line"], "cls": c["cls"]})

# stable order: by file then line
sites.sort(key=lambda s: (s["file"], s["line"]))
print(json.dumps({
    "sites": sites,
    "targetClass": None if target is None else target["cls"],
    "bases": [] if target is None else sorted(target["bases"]),
}))
`

/**
 * Python method-at-line resolver. Args: <repoRoot> <targetRelFile> <line>.
 * Emits JSON `{"method":"name"}` or `{"method":null}` when the line is not
 * inside a function/method body (or the file failed to parse). The smallest
 * enclosing span wins so nested defs/lambdas do not mask the true owner.
 */
export const METHOD_AT_LINE_PY = String.raw`
import ast, json, os, sys

repo, target_rel, raw_line = sys.argv[1], sys.argv[2], sys.argv[3]
path = os.path.join(repo, target_rel)
try:
    line = int(raw_line)
except Exception:
    print(json.dumps({"method": None}))
    raise SystemExit(0)

try:
    with open(path, "r", encoding="utf-8") as fh:
        tree = ast.parse(fh.read())
except Exception:
    print(json.dumps({"method": None}))
    raise SystemExit(0)

best = None
for node in ast.walk(tree):
    if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        continue
    start = getattr(node, "lineno", None)
    end = getattr(node, "end_lineno", start)
    if start is None or end is None:
        continue
    if start <= line <= end:
        span = end - start
        if best is None or span < best[0]:
            best = (span, node.name)

print(json.dumps({"method": None if best is None else best[1]}))
`

/**
 * Run the CHA analyzer on `repoRoot` for `targetRelFile`'s `method`, returning the
 * sibling override sites (empty on any failure — never throws). `targetRelFile`
 * is repo-relative (e.g. `django/db/backends/mysql/operations.py`).
 */
export const findSiblingOverrideSites = async (args: {
  exec: ChaExec
  repoRoot: string
  targetRelFile: string
  method: string
  timeoutMs?: number
}): Promise<readonly SiblingOverrideSite[]> => {
  const { exec, repoRoot, targetRelFile, method } = args
  if (method.trim() === "" || targetRelFile.trim() === "") return []
  // Pass args via argv to a stdin program so paths/method never need shell-quoting
  // inside the program body. The heredoc carries the program; "$@" forwards argv.
  const sh = `python3 - ${shArg(repoRoot)} ${shArg(targetRelFile)} ${shArg(method)} <<'QUANTA_CHA_PY'\n${CHA_ANALYZER_PY}\nQUANTA_CHA_PY`
  let r: { code: number; stdout: string; stderr: string }
  try {
    r = await exec(sh, repoRoot, args.timeoutMs ?? 60_000)
  } catch {
    return []
  }
  if (r.code !== 0) return []
  return parseChaStdout(r.stdout)
}

/**
 * Resolve the innermost Python function/method that encloses `line` inside
 * `targetRelFile`. Empty/invalid inputs, parse failures, or non-function lines
 * all fail closed to `undefined`.
 */
export const findEnclosingPythonMethod = async (args: {
  exec: ChaExec
  repoRoot: string
  targetRelFile: string
  line: number
  timeoutMs?: number
}): Promise<string | undefined> => {
  const { exec, repoRoot, targetRelFile, line } = args
  if (targetRelFile.trim() === "" || !Number.isInteger(line) || line < 1) return undefined
  const sh = `python3 - ${shArg(repoRoot)} ${shArg(targetRelFile)} ${shArg(String(line))} <<'QUANTA_METHOD_AT_LINE_PY'\n${METHOD_AT_LINE_PY}\nQUANTA_METHOD_AT_LINE_PY`
  let r: { code: number; stdout: string; stderr: string }
  try {
    r = await exec(sh, repoRoot, args.timeoutMs ?? 30_000)
  } catch {
    return undefined
  }
  if (r.code !== 0) return undefined
  return parseMethodAtLineStdout(r.stdout)
}

/** Single-quote a shell arg (safe for paths/identifiers). */
const shArg = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`

/** Parse the analyzer's JSON stdout into sibling sites. Tolerant: malformed ⇒ []. */
export const parseChaStdout = (stdout: string): readonly SiblingOverrideSite[] => {
  try {
    const obj = JSON.parse(stdout.trim()) as unknown
    if (typeof obj !== "object" || obj === null) return []
    const sites = (obj as { sites?: unknown }).sites
    if (!Array.isArray(sites)) return []
    const out: SiblingOverrideSite[] = []
    for (const s of sites) {
      if (typeof s !== "object" || s === null) continue
      const file = (s as { file?: unknown }).file
      const line = (s as { line?: unknown }).line
      const cls = (s as { cls?: unknown }).cls
      if (typeof file === "string" && typeof line === "number" && typeof cls === "string") {
        out.push({ file, line, cls })
      }
    }
    return out
  } catch {
    return []
  }
}

/** Parse the method-at-line helper's JSON stdout. Malformed / null ⇒ undefined. */
export const parseMethodAtLineStdout = (stdout: string): string | undefined => {
  try {
    const obj = JSON.parse(stdout.trim()) as unknown
    if (typeof obj !== "object" || obj === null) return undefined
    const method = (obj as { method?: unknown }).method
    return typeof method === "string" && method.trim() !== "" ? method : undefined
  } catch {
    return undefined
  }
}

/**
 * Format the multi-site steer. Empty sites ⇒ `undefined` (no steer — byte-identical
 * to the un-steered prompt). The steer names every sibling override site so the
 * agent inspects each sibling override explicitly instead of silently stopping at a
 * single backend.
 */
export const buildMultisiteSteer = (
  method: string,
  sites: readonly SiblingOverrideSite[],
): string | undefined => {
  if (sites.length === 0) return undefined
  const lines = sites.map((s) => `  - ${s.file}:${s.line}  (${s.cls}.${method})`)
  return [
    `MULTI-SITE FIX: \`${method}\` is overridden by sibling classes that share a base.`,
    `Inspect every sibling override below before stopping at one backend.`,
    `If the shared contract is broken, confirm which sibling overrides exhibit the`,
    `same bug and apply the equivalent change only to those proven sites:`,
    ...lines,
  ].join("\n")
}
