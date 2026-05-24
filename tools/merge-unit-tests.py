#!/usr/bin/env python3
"""Merge a unit test file into a target (typically *-hellgate.test.ts)."""
from __future__ import annotations

import re
import sys
from pathlib import Path


def skip_header(lines: list[str], i: int) -> int:
    while i < len(lines) and (
        lines[i].startswith("/**")
        or lines[i].strip().startswith("*")
        or lines[i].strip() in ("*/", "")
    ):
        if lines[i].startswith("/**"):
            i += 1
            while i < len(lines) and "*/" not in lines[i]:
                i += 1
            i += 1
            continue
        i += 1
    return i


def consume_imports(lines: list[str], i: int) -> tuple[list[str], int]:
    imports: list[str] = []
    while i < len(lines) and lines[i].startswith("import "):
        block = [lines[i]]
        i += 1
        while i < len(lines) and not re.search(r'\bfrom\s+["\']', block[-1]):
            block.append(lines[i])
            i += 1
        imports.append("\n".join(block))
    return imports, i


def import_module(imp: str) -> str | None:
    m = re.search(r'\bfrom\s+["\']([^"\']+)["\']', imp)
    return m.group(1) if m else None


def split_file(text: str) -> tuple[list[str], str]:
    lines = text.splitlines()
    i = skip_header(lines, 0)
    imports, i = consume_imports(lines, i)
    while i < len(lines) and lines[i].strip() == "":
        i += 1
    body = "\n".join(lines[i:]).lstrip("\n")
    return imports, body


def merge_imports(target_imports: list[str], source_imports: list[str]) -> list[str]:
    modules = {import_module(i) for i in target_imports}
    out = list(target_imports)
    for imp in source_imports:
        mod = import_module(imp)
        if mod and mod in modules:
            continue
        if imp not in out:
            out.append(imp)
            if mod:
                modules.add(mod)
    return out


DECL_RE = re.compile(
    r"^(?:export\s+)?(?:(?:const|function|class|type|interface)\s+(\w+))",
    re.MULTILINE,
)


def declared_names(body: str) -> set[str]:
    return set(DECL_RE.findall(body))


def _skip_decl_block(lines: list[str], i: int) -> int:
    """Advance past the top-level declaration starting at lines[i]."""
    line = lines[i]
    i += 1
    if line.startswith("class ") or line.startswith("export class "):
        depth = 0
        started = False
        while i < len(lines):
            depth += lines[i].count("{") - lines[i].count("}")
            if "{" in lines[i]:
                started = True
            i += 1
            if started and depth <= 0:
                break
        return i
    if line.startswith("type ") or line.startswith("export type ") or line.startswith("interface "):
        while i < len(lines):
            nxt = lines[i]
            if DECL_RE.match(nxt):
                break
            if nxt.strip() == "" and i + 1 < len(lines) and DECL_RE.match(lines[i + 1]):
                break
            i += 1
        return i
    # const / function — balance braces or end at ;
    depth = 0
    while i < len(lines):
        depth += lines[i].count("{") - lines[i].count("}")
        i += 1
        if depth <= 0 and (lines[i - 1].rstrip().endswith(";") or lines[i - 1].rstrip() == "}"):
            if "{" not in line and "=>" not in line:
                break
            if depth <= 0 and "}" in lines[i - 1]:
                break
    return i


def strip_duplicate_decls(target_body: str, source_body: str) -> str:
    """Drop top-level decl blocks in source that re-use names from target."""
    existing = declared_names(target_body)
    if not existing:
        return source_body

    lines = source_body.splitlines()
    out: list[str] = []
    i = 0
    while i < len(lines):
        m = DECL_RE.match(lines[i])
        if m and m.group(1) in existing:
            i = _skip_decl_block(lines, i)
            continue
        out.append(lines[i])
        i += 1
    return "\n".join(out).strip("\n")


def render_file(header: str, imports: list[str], bodies: list[str]) -> str:
    parts: list[str] = []
    if header.strip():
        parts.append(header.rstrip())
        parts.append("")
    parts.extend(imports)
    if imports:
        parts.append("")
    for body in bodies:
        parts.append(body.rstrip())
        parts.append("")
    return "\n".join(parts).rstrip() + "\n"


def merge_files(target_path: Path, source_path: Path) -> None:
    target_text = target_path.read_text()
    source_text = source_path.read_text()

    t_lines = target_text.splitlines()
    hi = skip_header(t_lines, 0)
    header = "\n".join(t_lines[:hi])

    t_imports, t_body = split_file(target_text)
    s_imports, s_body = split_file(source_text)
    s_body = strip_duplicate_decls(t_body, s_body)
    merged_imports = merge_imports(t_imports, s_imports)

    marker = (
        f"/* ------------------------------------------------------------------ */\n"
        f"/* merged from {source_path.name} */\n"
        f"/* ------------------------------------------------------------------ */\n\n"
    )
    new_body = t_body.rstrip() + "\n\n" + marker + s_body
    target_path.write_text(render_file(header, merged_imports, [new_body]))
    print(f"merged {source_path.name} -> {target_path.name}")


def discover_pairs(root: Path) -> list[tuple[str, str]]:
    pairs: list[tuple[str, str]] = []
    for hell in sorted(root.glob("tests/unit/**/*-hellgate.test.ts")):
        base = hell.with_name(hell.name.replace("-hellgate.test.ts", ".test.ts"))
        if base.is_file():
            pairs.append(
                (
                    str(hell.relative_to(root)),
                    str(base.relative_to(root)),
                )
            )
    return pairs


SKIP_SOURCES = {
    "tests/unit/hooks-updated-input.test.ts",
    "tests/unit/plugin-isolation-lifecycle.test.ts",
    "tests/unit/plugin-isolation-dxt.test.ts",
    "tests/unit/plugin-isolation-host.test.ts",
    "tests/unit/plugin-isolation-mcp-integration.test.ts",
}


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    pairs = discover_pairs(root)
    if len(sys.argv) > 1 and sys.argv[1] == "--all":
        todo = [(t, s) for t, s in pairs if s not in SKIP_SOURCES]
    else:
        todo = pairs  # legacy: run explicit list below only when no --all
        todo = [
            (t, s)
            for t, s in [
                ("tests/unit/memory-hellgate.test.ts", "tests/unit/memory.test.ts"),
                ("tests/unit/fallback-hellgate.test.ts", "tests/unit/fallback.test.ts"),
                ("tests/unit/recovery-hellgate.test.ts", "tests/unit/recovery.test.ts"),
                ("tests/unit/verify-guard-hellgate.test.ts", "tests/unit/verify-guard.test.ts"),
                ("tests/unit/verify-guard-must-pass-hellgate.test.ts", "tests/unit/verify-guard-must-pass.test.ts"),
                ("tests/unit/streaming-dispatch-hellgate.test.ts", "tests/unit/streaming-dispatch.test.ts"),
                ("tests/unit/fs-jail-hellgate.test.ts", "tests/unit/fs-jail.test.ts"),
                ("tests/unit/git-tools-hellgate.test.ts", "tests/unit/git-tools.test.ts"),
                ("tests/unit/pricing-hellgate.test.ts", "tests/unit/pricing.test.ts"),
                ("tests/unit/compaction-breaker-hellgate.test.ts", "tests/unit/compaction-breaker.test.ts"),
                ("tests/unit/localize-phase-guard-hellgate.test.ts", "tests/unit/localize-phase-guard.test.ts"),
                ("tests/unit/scheduler-next-fire-hellgate.test.ts", "tests/unit/scheduler-next-fire.test.ts"),
                ("tests/unit/scheduler-rrule-parser-hellgate.test.ts", "tests/unit/scheduler-rrule-parser.test.ts"),
                (
                    "tests/unit/bench-branch-search-wiring-hellgate.test.ts",
                    "tests/unit/bench-branch-search-wiring.test.ts",
                ),
                (
                    "tests/unit/plugin-isolation-spawner-hellgate.test.ts",
                    "tests/unit/plugin-isolation-spawner.test.ts",
                ),
            ]
            if (root / t).is_file() and (root / s).is_file()
        ]

    if len(sys.argv) > 1 and sys.argv[1] == "--all":
        pass  # todo already set

    for target_rel, source_rel in todo:
        if source_rel in SKIP_SOURCES:
            print(f"skip {source_rel}")
            continue
        merge_files(root / target_rel, root / source_rel)
        (root / source_rel).unlink()


if __name__ == "__main__":
    main()
