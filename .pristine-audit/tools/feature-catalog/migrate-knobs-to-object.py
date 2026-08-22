#!/usr/bin/env python3
"""
P2-D catalog cleanup: migrate string-form knobs to object form.

Scans tools/feature-catalog/features/**/*.yaml, finds yamls whose `knobs:`
block is string-form, parses each entry, and rewrites to object form.
Preserves every other yaml field byte-identical via line-range replacement.
"""
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
FEATURES = ROOT / "tools" / "feature-catalog" / "features"

NAME_RE = re.compile(r"^[A-Z_][A-Z0-9_]*$")
# permit dotted/typescript paths too
PATH_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_.?]*$")


def _strip_outer_quotes(s: str) -> str:
    s = s.strip()
    if len(s) >= 2 and s[0] == s[-1] and s[0] in ("'", '"'):
        return s[1:-1].strip()
    return s


def _normalize_default(v: str) -> str:
    v = _strip_outer_quotes(v).strip()
    # strip trailing punctuation like commas, semicolons, periods
    v = v.rstrip(",;.").strip()
    if not v:
        return "undefined"
    low = v.lower()
    if low in ("off", "0", "false", "no", "disabled"):
        return "off"
    if low in ("on", "1", "true", "yes", "enabled"):
        return "on"
    return v


def _yaml_quote(s: str) -> str:
    """Quote a string for YAML single-quoted scalar."""
    return "'" + s.replace("'", "''") + "'"


def _extract_default(text: str):
    """Look for 'default X' or '(default X)' in text. Returns (default_or_None, text_without_default_phrase).

    Conservative — only takes a SHORT atomic value (single token, optionally with units),
    not a clause. Multi-word/complex defaults are left in purpose.
    """
    # Pattern A: standalone '(default VALUE)' or '(defaults to VALUE)' — short value only
    m = re.search(
        r"\(\s*defaults?\s+(?:to\s+)?([^,;()]+?)\s*\)",
        text,
        re.IGNORECASE,
    )
    if m:
        val = m.group(1).strip()
        if 1 <= len(val.split()) <= 3:
            new_text = (text[: m.start()] + text[m.end() :]).strip()
            return val, new_text

    # Pattern B: ', default VALUE)' or '; default VALUE)' inside parens
    m = re.search(
        r"[,;]\s*defaults?\s+(?:to\s+)?([^,;()]+?)\s*\)",
        text,
        re.IGNORECASE,
    )
    if m:
        val = m.group(1).strip()
        if 1 <= len(val.split()) <= 3:
            # remove just the ', default VALUE' segment, keep surrounding parens
            new_text = text[: m.start()] + ")" + text[m.end() :]
            return val, new_text

    # Pattern C: ' — default VALUE' (em-dash) at end-of-text
    m = re.search(
        r"\s+[—–]\s+defaults?\s+(?:to\s+)?(.+?)$",
        text,
        re.IGNORECASE,
    )
    if m:
        val = m.group(1).strip().rstrip(".;,")
        if 1 <= len(val.split()) <= 3:
            new_text = text[: m.start()].rstrip()
            return val, new_text

    # Pattern D: '; default VALUE' or ', default VALUE' standalone clause
    m = re.search(
        r"[;,]\s+defaults?\s+(?:to\s+)?([^,;.()]+?)(?=[.;,]|$)",
        text,
        re.IGNORECASE,
    )
    if m:
        val = m.group(1).strip()
        if 1 <= len(val.split()) <= 3:
            new_text = (text[: m.start()] + text[m.end() :]).strip()
            return val, new_text

    return None, text


def _parse_entry(raw: str):
    """Parse a single '- ...' knob line.

    Returns dict with keys 'name', 'default', 'purpose' OR None if unparseable.
    """
    s = raw.lstrip()
    if not s.startswith("- "):
        return None
    body = s[2:].strip()
    # strip surrounding quotes around the whole entry
    body = _strip_outer_quotes(body)
    if not body:
        return None

    # Strip inline yaml comment trailing  '#  comment' but only if hash preceded by whitespace
    # Note: # can appear in URLs/text so only split if line-end style
    hash_m = re.search(r"\s+#\s+(.+)$", body)
    inline_comment = None
    if hash_m:
        inline_comment = hash_m.group(1).strip()
        body = body[: hash_m.start()].rstrip()

    # find separator between name and description
    # Priority: em-dash, en-dash, ': ', ' - '
    sep_m = re.search(r"(\s+—\s+|\s+–\s+|\s+-\s+|:\s+|\(\s*default)", body)
    if sep_m:
        sep_text = sep_m.group(1)
        if sep_text.startswith("("):
            # name is everything before, description is the '(default ...)' part
            name_raw = body[: sep_m.start()].strip()
            rest = body[sep_m.start() :].strip()
        else:
            name_raw = body[: sep_m.start()].strip()
            rest = body[sep_m.end() :].strip()
    else:
        name_raw = body.strip()
        rest = ""

    if not name_raw:
        return None

    # Validate name. If multi-word or has spaces, try to keep ENV-style if possible.
    name_clean = name_raw.rstrip(":").strip()
    # Strip ='value' or ="value" or =value suffix (it leaks into name when written like QUANTA_X="1")
    name_clean = re.sub(r"=.*$", "", name_clean).strip()
    if " " in name_clean:
        # take first word
        first = name_clean.split()[0]
        name_clean = first.rstrip(":,;").strip()
    if not name_clean:
        return None

    # Strip a trailing '(...)' annotation from the name itself (e.g. 'FOO(constant, 5 rows)')
    # but keep it as part of the description.
    paren_strip = re.match(r"^([A-Za-z_][A-Za-z0-9_.?]*)\s*\((.+)\)\s*$", name_clean)
    if paren_strip:
        name_clean = paren_strip.group(1)
        if rest:
            rest = "(" + paren_strip.group(2) + ") " + rest
        else:
            rest = "(" + paren_strip.group(2) + ")"

    # validate: name must match ENV pattern or TS path; otherwise fall back to first word
    if not (NAME_RE.match(name_clean) or PATH_RE.match(name_clean)):
        # take first word; strip parens and trailing punctuation
        tokens = re.split(r"[\s(,]", name_clean)
        if tokens:
            name_clean = tokens[0].rstrip(":,;").strip()
    if not name_clean:
        return None

    # purpose: rest (and inline comment if present)
    purpose = rest.strip()

    # Extract default from purpose
    default_val = None
    if purpose:
        d, purpose_stripped = _extract_default(purpose)
        if d:
            default_val = d
            purpose = purpose_stripped

    # If purpose is entirely parenthesized, strip outer parens
    purpose = purpose.strip()
    if purpose.startswith("(") and purpose.endswith(")") and purpose.count("(") == 1:
        purpose = purpose[1:-1].strip()

    # Strip leading punctuation
    purpose = re.sub(r"^[—–\-:,;\s]+", "", purpose).strip()

    # If inline comment present, prepend to purpose
    if inline_comment:
        if purpose:
            purpose = inline_comment + " — " + purpose
        else:
            purpose = inline_comment
        # Recheck default in combined purpose
        d, p2 = _extract_default(purpose)
        if d and not default_val:
            default_val = d
            purpose = p2

    if not purpose:
        purpose = "(no description)"

    if default_val is None:
        default_str = "undefined"
    else:
        default_str = _normalize_default(default_val)

    return {"name": name_clean, "default": default_str, "purpose": purpose}


def _find_knobs_block(lines):
    """Return (knobs_line_idx, block_end_idx, items) or None.

    block_end_idx is exclusive (idx of first line AFTER the knobs block).
    items is a list of raw lines (with original indentation) belonging to knobs.

    Handles BOTH block-style (knobs:\\n  - X) and flow-style (knobs: [A, B, C]).
    For flow-style, items contains synthetic '  - NAME' lines.
    """
    for i, l in enumerate(lines):
        if l.startswith("knobs:"):
            rest = l[len("knobs:") :].strip()
            if rest == "[]":
                return None
            # flow-style: knobs: [A, B, C]
            flow_m = re.match(r"^\[(.+)\]\s*$", rest)
            if flow_m:
                payload = flow_m.group(1).strip()
                names = [
                    n.strip().strip('"').strip("'")
                    for n in payload.split(",")
                    if n.strip()
                ]
                if not names:
                    return None
                synth = [f"  - {n}" for n in names]
                return (i, i + 1, synth)
            if rest:
                # inline scalar — skip
                return None
            j = i + 1
            items = []
            while j < len(lines):
                cur = lines[j]
                if cur.strip() == "":
                    k = j + 1
                    while k < len(lines) and lines[k].strip() == "":
                        k += 1
                    if k < len(lines) and lines[k].startswith("  "):
                        j += 1
                        continue
                    else:
                        break
                if cur.startswith("  "):
                    items.append(cur)
                    j += 1
                else:
                    break
            if not items:
                return None
            return (i, j, items)
    return None


def _is_object_form(items):
    """If first item starts with '- name:', it's object form."""
    for it in items:
        s = it.lstrip()
        if s.startswith("- "):
            return s.startswith("- name:")
    return False


def _has_multi_line(items):
    """Detect multi-line items: any non-blank item line that doesn't start with '- '
    and isn't part of an already-recognized object-form continuation.

    For string-form: each item should be a single '- ...' line.
    If we see continuation lines (indented further), flag as multi-line skip.
    """
    for it in items:
        s = it.lstrip()
        if not s:
            continue
        if not s.startswith("- "):
            # could be continuation
            return True
    return False


def migrate_file(path: Path):
    """Returns one of: ('migrated', count), ('skip', reason), ('object', 0), ('empty', 0)."""
    with open(path) as fh:
        txt = fh.read()
    lines = txt.split("\n")
    found = _find_knobs_block(lines)
    if not found:
        return ("empty", 0)
    i, j, items = found
    if _is_object_form(items):
        return ("object", 0)
    if _has_multi_line(items):
        return ("skip", "multi-line")

    # Parse each item
    parsed = []
    for it in items:
        p = _parse_entry(it)
        if p is None:
            return ("skip", f"unparseable: {it.strip()[:80]}")
        parsed.append(p)

    # Build object-form replacement
    new_lines = ["knobs:"]
    for p in parsed:
        new_lines.append(f"  - name: {p['name']}")
        new_lines.append(f"    default: {_yaml_quote(p['default'])}")
        new_lines.append(f"    purpose: {_yaml_quote(p['purpose'])}")

    # Splice
    out = lines[:i] + new_lines + lines[j:]
    new_txt = "\n".join(out)

    with open(path, "w") as fh:
        fh.write(new_txt)
    return ("migrated", len(parsed))


def main():
    yamls = sorted(FEATURES.rglob("*.yaml"))
    total = len(yamls)
    migrated = 0
    entries_total = 0
    skipped = []
    object_form = 0
    empty_form = 0
    examples = []

    for path in yamls:
        result, payload = migrate_file(path)
        if result == "migrated":
            migrated += 1
            entries_total += payload
            if len(examples) < 8:
                examples.append((path, payload))
        elif result == "skip":
            skipped.append((path, payload))
        elif result == "object":
            object_form += 1
        elif result == "empty":
            empty_form += 1

    print(f"Total scanned: {total}")
    print(f"Migrated: {migrated} ({entries_total} entries)")
    print(f"Already object form: {object_form}")
    print(f"Empty knobs: {empty_form}")
    print(f"Skipped: {len(skipped)}")
    if skipped:
        print("--- skip reasons ---")
        for p, r in skipped[:20]:
            print(f"  {p.relative_to(ROOT)}: {r}")


if __name__ == "__main__":
    main()
