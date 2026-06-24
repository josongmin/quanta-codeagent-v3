/**
 * CHA multi-site fix-site resolver (jun-23).
 *
 * MEASURED motivation: on `agentless-v4-proof-clean`, the repro oracle is now
 * reliable (reproduces the bug 20/20), but multi-backend bugs still fail because
 * the model writes the CORRECT per-site fix yet MISSES sibling override sites.
 * django-11138 (proven): the model's `mysql/operations.py._convert_field_to_tz`
 * hunk is byte-identical to gold, but sibling backend contract surfaces were
 * left unfixed, so the (perfect) repro correctly stays RED → empty_patch.
 *
 * LSP `references` does not surface "every override of an abstract method across
 * subclasses". This module does: a whole-repo class-hierarchy analysis (CHA) that,
 * given a method the agent localized, returns SIBLING override sites plus narrow
 * Django backend contract sibling files that share the same base class. A steer
 * then tells the agent to inspect each sibling surface.
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
  /** 1-based line of the `def <method>` or the owning backend contract class. */
  readonly line: number
  /** Class that owns the sibling override. */
  readonly cls: string
  /** Method at the site when it differs from or is more specific than the target method. */
  readonly method?: string
  /** Why this site was selected. */
  readonly role?: "override" | "backend-contract"
}

/**
 * Python CHA analyzer (stdin program). Args: <repoRoot> <targetRelFile> <method>.
 * Emits JSON `{"sites":[{file,line,cls}], "targetClass": "...", "bases":[...]}` on
 * stdout (sites EXCLUDES the target class itself). Robustness: unparseable files
 * are skipped; no target class (method not found in targetRelFile) ⇒ empty sites.
 *
 * Sibling rule (symptom-coupled, not "all overrides"): a class C is a sibling iff
 * C defines a method named `method`, C's ancestor set intersects the target
 * class's ancestor set, AND the sibling method body is structurally similar to
 * the localized target override. This keeps real co-change siblings while
 * rejecting divergent overrides that share the base but not the bug shape
 * (e.g. a backend with a fundamentally different timezone implementation).
 * Django backend files also get a narrow same-file-family fallback so equivalent
 * contract surfaces with different helper names are still inspected. The target
 * class itself is excluded from its own sibling list.
 */
export const CHA_ANALYZER_PY = `
import ast, json, os, sys

repo, target_rel, method = sys.argv[1], sys.argv[2], sys.argv[3]

# ---------------------------------------------------------------------------
# Real CHA (NOT a base-NAME heuristic): resolve each base to the CLASS IDENTITY
# it refers to (via the file's imports + same-file defs), build a qualified
# class graph, and compute the TRANSITIVE ancestor set per class. Two classes
# are siblings iff their ancestor sets SHARE A CLASS IDENTITY — this catches
# intermediate-base hierarchies (oracle.DatabaseOperations(_OracleBase) where
# _OracleBase(BaseDatabaseOperations)) AND rejects same-NAMED-but-different
# bases (two unrelated 'BaseOps' in different modules resolve to different ids).
# ---------------------------------------------------------------------------

def mod_to_rel(mod):
    # 'a.b.c' -> candidate rel files 'a/b/c.py' / 'a/b/c/__init__.py'
    p = mod.replace(".", "/")
    for cand in (p + ".py", p + "/__init__.py"):
        if os.path.exists(os.path.join(repo, cand)):
            return cand
    return None

def rel_import_to_rel(cur_rel, mod, level):
    # Resolve absolute or relative ImportFrom targets to repo-relative files.
    if level <= 0:
        return mod_to_rel(mod) if mod else None
    if cur_rel.endswith("/__init__.py"):
        pkg_parts = cur_rel[:-12].split("/") if cur_rel[:-12] else []
    else:
        pkg_parts = cur_rel[:-3].split("/")[:-1]
    up = max(0, level - 1)
    base_parts = pkg_parts[: max(0, len(pkg_parts) - up)]
    mod_parts = [] if not mod else mod.split(".")
    parts = [p for p in (base_parts + mod_parts) if p]
    if not parts:
        return None
    return mod_to_rel(".".join(parts))

# Per-file: import map (local name -> "relfile::Name") + class list.
# classes registry keyed by qualified id "relfile::Name".
classes = {}       # qid -> {file, cls, line, method_line, raw_bases:[node]}
method_nodes = {}  # qid -> ast.FunctionDef/AsyncFunctionDef for the target method
file_imports = {}  # relfile -> { localname -> qid_or_namefallback }
file_classes = {}  # relfile -> set(class names defined here)

trees = {}
for root, dirs, files in os.walk(repo):
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
        trees[rel] = tree
        imap = {}
        cset = set()
        for node in tree.body:
            if isinstance(node, ast.ImportFrom):
                tgt = rel_import_to_rel(rel, node.module, node.level)
                for a in node.names:
                    local = a.asname or a.name
                    imap[local] = (tgt + "::" + a.name) if tgt else ("::" + a.name)
            if isinstance(node, ast.ClassDef):
                cset.add(node.name)
        file_imports[rel] = imap
        file_classes[rel] = cset

def base_to_qid(rel, b):
    # last identifier component of the base expression
    if isinstance(b, ast.Name):
        name = b.id
    elif isinstance(b, ast.Attribute):
        name = b.attr
    else:
        return None
    imap = file_imports.get(rel, {})
    if name in imap:
        return imap[name]            # imported -> resolved identity
    if name in file_classes.get(rel, set()):
        return rel + "::" + name      # same-file class
    return "::" + name                # unresolved -> name-only id (degrade, never miss)

for rel, tree in trees.items():
    for node in ast.walk(tree):
        if not isinstance(node, ast.ClassDef):
            continue
        qid = rel + "::" + node.name
        method_line = None
        method_node = None
        for item in node.body:
            if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)) and item.name == method:
                method_line = item.lineno
                method_node = item
                break
        bqids = set()
        for b in node.bases:
            r = base_to_qid(rel, b)
            if r:
                bqids.add(r)
        classes[qid] = {"file": rel, "cls": node.name, "line": node.lineno,
                        "method_line": method_line, "bases": bqids}
        if method_node is not None:
            method_nodes[qid] = method_node

def ancestors(qid):
    seen = set()
    stack = list(classes.get(qid, {}).get("bases", set()))
    while stack:
        a = stack.pop()
        if a in seen:
            continue
        seen.add(a)
        stack.extend(classes.get(a, {}).get("bases", set()))
    return seen

def call_name(func):
    if isinstance(func, ast.Name):
        return func.id
    if isinstance(func, ast.Attribute):
        return func.attr
    return type(func).__name__

def method_signature(node):
    toks = set()
    if node is None:
        return toks
    for child in ast.walk(node):
        if child is node:
            continue
        if isinstance(child, ast.stmt):
            toks.add("stmt:" + type(child).__name__)
        if isinstance(child, ast.Call):
            toks.add("call:" + call_name(child.func))
        if isinstance(child, ast.Attribute):
            toks.add("attr:" + child.attr)
        if isinstance(child, ast.BinOp):
            toks.add("binop:" + type(child.op).__name__)
        if isinstance(child, ast.BoolOp):
            toks.add("boolop:" + type(child.op).__name__)
        if isinstance(child, ast.Compare):
            toks.add("cmp")
    return toks

def structurally_similar(target_qid, sibling_qid):
    target_sig = method_signature(method_nodes.get(target_qid))
    sibling_sig = method_signature(method_nodes.get(sibling_qid))
    if not target_sig or not sibling_sig:
        return False
    union = len(target_sig | sibling_sig)
    if union == 0:
        return False
    return (len(target_sig & sibling_sig) / union) >= 0.45

# target = the class in target_rel that defines the method (fallback: any in file)
target = None
for qid, c in classes.items():
    if c["file"] == target_rel and c["method_line"] is not None:
        target = qid; break
if target is None:
    for qid, c in classes.items():
        if c["file"] == target_rel:
            target = qid; break

sites = []
site_keys = set()
if target is not None:
    tanc = ancestors(target)
    for qid, c in classes.items():
        if qid == target or c["method_line"] is None:
            continue
        # sibling iff ancestor sets share a class IDENTITY (transitive) AND the
        # override body is structurally similar to the localized buggy override.
        if tanc and (ancestors(qid) & tanc) and structurally_similar(target, qid):
            site_keys.add((c["file"], c["line"]))
            sites.append({"file": c["file"], "line": c["method_line"], "cls": c["cls"], "method": method, "role": "override"})

    parts = target_rel.split("/")
    if len(parts) >= 5 and parts[0:3] == ["django", "db", "backends"]:
        backend_file = parts[-1]
        for qid, c in classes.items():
            cparts = c["file"].split("/")
            if qid == target or len(cparts) != len(parts):
                continue
            if cparts[0:3] != ["django", "db", "backends"] or cparts[-1] != backend_file:
                continue
            # Backend-contract fallback is ONLY for sibling backend classes that
            # do NOT define the localized method themselves (e.g. sqlite helper
            # files). Divergent real overrides are handled by the structural
            # similarity gate above and must not be re-added here.
            if c["file"] == target_rel or c["method_line"] is not None or not tanc or not (ancestors(qid) & tanc):
                continue
            key = (c["file"], c["line"])
            if key in site_keys:
                continue
            site_keys.add(key)
            sites.append({"file": c["file"], "line": c["line"], "cls": c["cls"], "role": "backend-contract"})

sites.sort(key=lambda s: (s["file"], s["line"]))
print(json.dumps({
    "sites": sites,
    "targetClass": None if target is None else classes[target]["cls"],
    "bases": [] if target is None else sorted(classes[target]["bases"]),
}))
`

/**
 * Python method-at-line resolver. Args: <repoRoot> <targetRelFile> <line>.
 * Emits JSON `{"method":"name"}` or `{"method":null}` when the line is not
 * inside a function/method body (or the file failed to parse). The smallest
 * enclosing span wins so nested defs/lambdas do not mask the true owner.
 */
export const METHOD_AT_LINE_PY = `
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const siteRoleOf = (role: unknown): SiblingOverrideSite["role"] | undefined =>
  role === "override" || role === "backend-contract" ? role : undefined

const siteMethodOf = (method: unknown): string | undefined =>
  typeof method === "string" && method.trim() !== "" ? method : undefined

const siblingSiteOf = (value: unknown): SiblingOverrideSite | undefined => {
  if (!isRecord(value)) return undefined
  const { file, line, cls, method, role } = value
  if (typeof file !== "string" || typeof line !== "number" || typeof cls !== "string") {
    return undefined
  }
  const parsedMethod = siteMethodOf(method)
  const parsedRole = siteRoleOf(role)
  return {
    file,
    line,
    cls,
    ...(parsedMethod !== undefined ? { method: parsedMethod } : {}),
    ...(parsedRole !== undefined ? { role: parsedRole } : {}),
  }
}

const parseChaSites = (value: unknown): readonly SiblingOverrideSite[] => {
  if (!isRecord(value)) return []
  const sites = value.sites
  if (!Array.isArray(sites)) return []
  return sites.flatMap((site) => {
    const parsed = siblingSiteOf(site)
    return parsed === undefined ? [] : [parsed]
  })
}

/** Parse the analyzer's JSON stdout into sibling sites. Tolerant: malformed ⇒ []. */
export const parseChaStdout = (stdout: string): readonly SiblingOverrideSite[] => {
  try {
    return parseChaSites(JSON.parse(stdout.trim()) as unknown)
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
  const lines = sites.map((s) => {
    const owner = s.method === undefined ? `${s.cls} backend contract` : `${s.cls}.${s.method}`
    return `  - ${s.file}:${s.line}  (${owner})`
  })
  return [
    `MULTI-SITE FIX: \`${method}\` participates in a sibling override/backend contract family.`,
    `Inspect every sibling override below before stopping at one backend.`,
    `If the shared contract is broken, confirm which sibling overrides exhibit the`,
    `same bug and apply the equivalent change only to those proven sites:`,
    ...lines,
  ].join("\n")
}
