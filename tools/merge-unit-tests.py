#!/usr/bin/env python3
"""Merge a unit test file into a target (typically *-hellgate.test.ts)."""
from __future__ import annotations

import re
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
        # Multiline import until a line contains `from "..."` or `from '...'`
        while i < len(lines) and not re.search(r'\bfrom\s+["\']', block[-1]):
            block.append(lines[i])
            i += 1
        imports.append("\n".join(block))
    return imports, i


def split_file(text: str) -> tuple[list[str], str]:
    lines = text.splitlines()
    i = skip_header(lines, 0)
    imports, i = consume_imports(lines, i)
    while i < len(lines) and lines[i].strip() == "":
        i += 1
    body = "\n".join(lines[i:]).lstrip("\n")
    return imports, body


def merge_imports(target_imports: list[str], source_imports: list[str]) -> list[str]:
    seen = set(target_imports)
    out = list(target_imports)
    for imp in source_imports:
        if imp not in seen:
            out.append(imp)
            seen.add(imp)
    return out


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

    # Preserve target file header comment block only.
    t_lines = target_text.splitlines()
    hi = skip_header(t_lines, 0)
    header = "\n".join(t_lines[:hi])

    t_imports, t_body = split_file(target_text)
    s_imports, s_body = split_file(source_text)
    merged_imports = merge_imports(t_imports, s_imports)

    marker = (
        f"/* ------------------------------------------------------------------ */\n"
        f"/* merged from {source_path.name} */\n"
        f"/* ------------------------------------------------------------------ */\n\n"
    )
    new_body = t_body.rstrip() + "\n\n" + marker + s_body
    target_path.write_text(render_file(header, merged_imports, [new_body]))
    print(f"merged {source_path.name} -> {target_path.name}")


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    pairs = [
        ("tests/unit/retrieval-chunk-bucket-hellgate.test.ts", "tests/unit/retrieval-chunk-bucket.test.ts"),
        ("tests/unit/retrieval-commit-embedder-hellgate.test.ts", "tests/unit/retrieval-commit-embedder.test.ts"),
        ("tests/unit/retrieval-hybrid-query-hellgate.test.ts", "tests/unit/retrieval-hybrid-query.test.ts"),
        ("tests/unit/retrieval-rerank-registry.test.ts", "tests/unit/retrieval-rerank-hellgate.test.ts"),
        ("tests/unit/glob-rules-hellgate.test.ts", "tests/unit/glob-rules.test.ts"),
        ("tests/unit/hooks-updated-input-hellgate.test.ts", "tests/unit/hooks-updated-input.test.ts"),
        ("tests/unit/plugin-isolation-lifecycle-hellgate.test.ts", "tests/unit/plugin-isolation-lifecycle.test.ts"),
        ("tests/unit/plugin-isolation-dxt-hellgate.test.ts", "tests/unit/plugin-isolation-dxt.test.ts"),
        ("tests/unit/plugin-isolation-host-hellgate.test.ts", "tests/unit/plugin-isolation-host.test.ts"),
        ("tests/unit/plugin-isolation-mcp-integration-hellgate.test.ts", "tests/unit/plugin-isolation-mcp-integration.test.ts"),
        ("tests/unit/observability-metrics-instrument-tool-dedup-hellgate.test.ts", "tests/unit/observability-metrics-tool-dedup-ttl-hellgate.test.ts"),
        ("tests/unit/observability-metrics-instrument-tool-dedup-hellgate.test.ts", "tests/unit/observability-tool-dedup-drift-hellgate.test.ts"),
    ]
    for target_rel, source_rel in pairs:
        merge_files(root / target_rel, root / source_rel)
        (root / source_rel).unlink()


if __name__ == "__main__":
    main()
