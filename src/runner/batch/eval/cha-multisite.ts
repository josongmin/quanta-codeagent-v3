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
  /** TELEMETRY ONLY (jun-25 magic-number removal): Jaccard overlap [0,1] of this
   *  sibling's method-body structural token set against the target override. Was
   *  formerly a `>= 0.45` admission gate; now surfaced purely so a sweep can see
   *  how divergent a surfaced sibling is. NEVER filtered on downstream. */
  readonly structurallySimilar?: number
}

export interface ChaRepairTarget {
  readonly file: string
  readonly method: string
  readonly sites: readonly SiblingOverrideSite[]
}

/**
 * Python CHA analyzer (stdin program). Args: <repoRoot> <targetRelFile> <method>.
 * Emits JSON `{"sites":[{file,line,cls}], "targetClass": "...", "bases":[...]}` on
 * stdout (sites EXCLUDES the target class itself). Robustness: unparseable files
 * are skipped; no target class (method not found in targetRelFile) ⇒ empty sites.
 *
 * Sibling rule (parameter-free CHA invariant): a class C is a sibling iff C
 * defines a method named `method` AND C's transitive ancestor set intersects the
 * target class's ancestor set. Shared-ancestor + same-method-name IS the
 * override-family membership signal; EVERY such sibling is surfaced as evidence
 * (no similarity threshold admits/rejects). The steer text then asks the LLM to
 * confirm which siblings exhibit the bug — the model filters, not a frozen
 * constant. A `structurallySimilar` Jaccard value is computed per site for
 * telemetry/sweep visibility only and never gates the set.
 *
 * Contract-fallback (siblings that do NOT define the method — the structural gate
 * cannot see them): selected by the `siblingMode` argv. "path-hardcoded" (default)
 * is the legacy django/db/backends path match (byte-identical). "general" is a
 * structural parallel-sibling rule (same dir-root + same leaf filename, different
 * variant dir, shared ancestor) — the django case is a strict subset, so "general"
 * is byte-identical for django targets and merely additive elsewhere. The target
 * class itself is excluded from its own sibling list.
 */
// Wall-clock ceilings for the one-shot Python analyzers spawned per call.
// Generous because a cold large repo's `python3 -` startup + AST parse is slow;
// callers may override via `args.timeoutMs`.
const CHA_ANALYZER_TIMEOUT_MS = 60_000
const METHOD_AT_LINE_TIMEOUT_MS = 30_000

export const CHA_ANALYZER_PY = `
import ast, json, os, sys

repo, target_rel, method = sys.argv[1], sys.argv[2], sys.argv[3]
# Sibling-mode for the contract fallback (siblings that DON'T define the method):
#   "path-hardcoded" (default) — legacy django/db/backends path match (byte-identical).
#   "general"        — structural parallel-sibling rule: same dir-root + same leaf
#                      filename, different variant dir, sharing an ancestor. For the
#                      canonical 5-segment django layout (django/db/backends/<backend>/
#                      <file> — the only shape django backends use) the match set is
#                      EXACTLY the path-hardcode's, so "general" is byte-identical on
#                      real django and merely ADDITIVE for other parallel-impl layouts.
#                      (For hypothetical deeper django-prefixed paths "general" is
#                      strictly more precise, not a superset — irrelevant in practice.)
sibling_mode = sys.argv[4] if len(sys.argv) > 4 else "path-hardcoded"

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

# Jaccard overlap of the two method bodies' structural token sets. TELEMETRY
# ONLY: emitted as the per-site \`structurallySimilar\` score so a sweep can SEE
# how divergent a surfaced sibling is, but it MUST NOT gate admission — the
# parameter-free CHA invariant (shared transitive ancestor + same method name =
# override-family member) is the admission signal, and the steer text already
# tells the LLM to confirm which siblings exhibit the bug. (A frozen threshold
# here silently dropped TRUE override-family members whose body shape differed.)
def structural_overlap(target_qid, sibling_qid):
    target_sig = method_signature(method_nodes.get(target_qid))
    sibling_sig = method_signature(method_nodes.get(sibling_qid))
    if not target_sig or not sibling_sig:
        return 0.0
    union = len(target_sig | sibling_sig)
    if union == 0:
        return 0.0
    return len(target_sig & sibling_sig) / union

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
        # sibling overrides the SAME method name. That pair (shared ancestor +
        # same method name) IS the parameter-free override-family invariant; ALL
        # such siblings are surfaced as evidence (no similarity threshold gates
        # admission). The Jaccard overlap rides along as telemetry only.
        if tanc and (ancestors(qid) & tanc):
            site_keys.add((c["file"], c["line"]))
            sites.append({"file": c["file"], "line": c["method_line"], "cls": c["cls"], "method": method, "role": "override", "structurallySimilar": structural_overlap(target, qid)})

    # Backend-contract fallback: sibling classes that participate in the same
    # contract family but do NOT define the localized method themselves (e.g. a
    # sqlite helper file) — the same-method-name override pass above cannot see
    # them (no def of the method to match). A "contract sibling" is another file in a
    # PARALLEL implementation directory: same dir-root + same leaf filename, a
    # different variant dir, sharing a transitive ancestor with the target class.
    parts = target_rel.split("/")
    backend_contract = False
    root = leaf = None
    if sibling_mode == "general":
        # Structural parallel-sibling rule (no repo/path hardcode). Requires a
        # non-empty root (>=3 segments: <root...>/<variant>/<leaf>) so it cannot
        # collapse to "every same-named file in the repo".
        if len(parts) >= 3:
            backend_contract = True
            root = parts[:-2]
            leaf = parts[-1]
    else:
        # Legacy path-hardcoded django rule (byte-identical default). The general
        # rule above subsumes this exact match set for django targets.
        if len(parts) >= 5 and parts[0:3] == ["django", "db", "backends"]:
            backend_contract = True
            root = ["django", "db", "backends"]
            leaf = parts[-1]
    if backend_contract:
        for qid, c in classes.items():
            cparts = c["file"].split("/")
            if qid == target or len(cparts) != len(parts):
                continue
            # same dir-root + same leaf filename (a different variant directory).
            if cparts[:-2] != root or cparts[-1] != leaf:
                continue
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
  /** Contract-fallback sibling mode. Default "path-hardcoded" = legacy django
   *  path match (byte-identical). "general" = structural parallel-sibling rule. */
  siblingMode?: "path-hardcoded" | "general"
  timeoutMs?: number
}): Promise<readonly SiblingOverrideSite[]> => {
  const { exec, repoRoot, targetRelFile, method } = args
  const siblingMode = args.siblingMode ?? "path-hardcoded"
  if (method.trim() === "" || targetRelFile.trim() === "") return []
  // Pass args via argv to a stdin program so paths/method never need shell-quoting
  // inside the program body. The heredoc carries the program; "$@" forwards argv.
  const sh = `python3 - ${shArg(repoRoot)} ${shArg(targetRelFile)} ${shArg(method)} ${shArg(siblingMode)} <<'QUANTA_CHA_PY'\n${CHA_ANALYZER_PY}\nQUANTA_CHA_PY`
  let r: { code: number; stdout: string; stderr: string }
  try {
    r = await exec(sh, repoRoot, args.timeoutMs ?? CHA_ANALYZER_TIMEOUT_MS)
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
    r = await exec(sh, repoRoot, args.timeoutMs ?? METHOD_AT_LINE_TIMEOUT_MS)
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

const siteSimilarityOf = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined

const siblingSiteOf = (value: unknown): SiblingOverrideSite | undefined => {
  if (!isRecord(value)) return undefined
  const { file, line, cls, method, role, structurallySimilar } = value
  if (typeof file !== "string" || typeof line !== "number" || typeof cls !== "string") {
    return undefined
  }
  const parsedMethod = siteMethodOf(method)
  const parsedRole = siteRoleOf(role)
  const parsedSimilarity = siteSimilarityOf(structurallySimilar)
  return {
    file,
    line,
    cls,
    ...(parsedMethod !== undefined ? { method: parsedMethod } : {}),
    ...(parsedRole !== undefined ? { role: parsedRole } : {}),
    ...(parsedSimilarity !== undefined ? { structurallySimilar: parsedSimilarity } : {}),
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
