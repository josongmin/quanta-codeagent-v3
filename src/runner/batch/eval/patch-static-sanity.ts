import { execArgv } from "./exec"

export const PYTHON_AST_STATIC_SANITY_SCRIPT = `
import ast
import json
import pathlib
import sys


def simple_name(node):
    return node.id if isinstance(node, ast.Name) else None


def parameter_acceptance(fn):
    args = fn.args
    if args.vararg is not None or args.kwarg is not None:
        return None
    positional = list(args.posonlyargs) + list(args.args)
    required = len(positional) - len(args.defaults)
    if any(default is None for default in args.kw_defaults):
        return None
    return (required, len(positional))


def collect_function_arities(tree):
    arities = {}
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            arities[node.name] = parameter_acceptance(node)
    return arities


class StaticSanityAnalyzer(ast.NodeVisitor):
    def __init__(self, tree):
        self.reasons = []
        self.seen = set()
        self.arities = collect_function_arities(tree)

    def add(self, reason):
        if reason in self.seen:
            return
        self.seen.add(reason)
        self.reasons.append(reason)

    def visit_Call(self, node):
        func = node.func
        if (
            isinstance(func, ast.Attribute)
            and func.attr == "create_function"
            and len(node.args) >= 3
            and isinstance(node.args[1], ast.Constant)
            and isinstance(node.args[1].value, int)
            and isinstance(node.args[2], ast.Name)
        ):
            expected = node.args[1].value
            callback = node.args[2].id
            arity = self.arities.get(callback)
            if arity is not None:
                lower, upper = arity
                if not (lower <= expected <= upper):
                    actual = upper if expected > upper else lower
                    self.add(
                        f"hard:staticSanity=pythonCallbackArityMismatch({callback}:{actual}->{expected})"
                    )
        self.generic_visit(node)

    def visit_Module(self, node):
        self.scan_statements(node.body, {})
        for stmt in node.body:
            self.visit(stmt)

    def visit_FunctionDef(self, node):
        self.scan_statements(node.body, {})
        for stmt in node.body:
            self.visit(stmt)

    visit_AsyncFunctionDef = visit_FunctionDef

    def scan_statements(self, statements, none_names):
        state = dict(none_names)
        for stmt in statements:
            self.scan_statement(stmt, state)

    def scan_statement(self, stmt, state):
        if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            return
        if isinstance(stmt, ast.Assign):
            self.scan_targets(stmt.targets, stmt.value, state)
        elif isinstance(stmt, ast.AnnAssign):
            self.scan_targets([stmt.target], stmt.value, state)
        elif isinstance(stmt, ast.AugAssign):
            name = simple_name(stmt.target)
            if name is not None:
                state.pop(name, None)
        elif isinstance(stmt, ast.If):
            self.scan_statements(stmt.body, dict(state))
            self.scan_statements(stmt.orelse, dict(state))
            return
        elif isinstance(stmt, (ast.For, ast.AsyncFor, ast.While, ast.With, ast.AsyncWith, ast.Try)):
            for child in ast.iter_child_nodes(stmt):
                if isinstance(child, ast.stmt):
                    self.scan_statement(child, dict(state))
            return
        self.scan_subscript_mutation(stmt, state)

    def scan_targets(self, targets, value, state):
        for target in targets:
            name = simple_name(target)
            if name is None:
                self.scan_subscript_target(target, state)
                continue
            if isinstance(value, ast.Constant) and value.value is None:
                state[name] = True
            else:
                state.pop(name, None)

    def scan_subscript_target(self, target, state):
        if isinstance(target, ast.Subscript):
            name = simple_name(target.value)
            if name is not None and state.get(name) is True:
                self.add(f"hard:staticSanity=pythonNoneSubscriptMutation({name})")

    def scan_subscript_mutation(self, stmt, state):
        for node in ast.walk(stmt):
            if isinstance(node, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
                targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                for target in targets:
                    self.scan_subscript_target(target, state)


def analyze_file(rel):
    if not rel.endswith(".py"):
        return []
    try:
        text = pathlib.Path(rel).read_text(encoding="utf-8")
        tree = ast.parse(text, filename=rel)
    except Exception:
        return []
    analyzer = StaticSanityAnalyzer(tree)
    analyzer.visit(tree)
    return analyzer.reasons


out = []
seen = set()
for rel in sys.argv[1:]:
    for reason in analyze_file(rel):
        if reason not in seen:
            seen.add(reason)
            out.append(reason)
print(json.dumps(out))
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

export const probePatchStaticSanity = async (args: {
  readonly cwd: string
  readonly files: readonly string[]
  readonly timeoutMs: number
}): Promise<string[] | null> => {
  const pyFiles = args.files.filter((file) => file.endsWith(".py"))
  if (pyFiles.length === 0) return []
  const result = await execArgv(
    ["python3", "-c", PYTHON_AST_STATIC_SANITY_SCRIPT, ...pyFiles],
    args.cwd,
    args.timeoutMs,
  ).catch(() => null)
  if (result === null || result.code !== 0) return null
  return parsePatchStaticSanityStdout(result.stdout)
}
