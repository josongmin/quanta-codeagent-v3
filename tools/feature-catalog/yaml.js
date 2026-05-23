// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: YAML parse/emit dispatchers are inherently branchy; structure follows the YAML 1.2 production rules and is covered by 30+ round-trip tests.
/**
 * In-house mini-YAML parser/serializer for the feature-catalog schema.
 *
 * Supported subset (intentional — see README §"YAML subset"):
 *   - Scalars: string (quoted/unquoted), number, boolean, null
 *   - Block scalar (literal):  key: |        (preserves newlines, dedents)
 *   - Block sequence:          - item
 *   - Block mapping:           key: value
 *   - Flow sequence:           [a, b, c]    (scalar elements only)
 *   - Indentation: 2 spaces (tabs FORBIDDEN — explicit error)
 *   - Comments: `# ...` to end of line (outside strings)
 *
 * NOT supported (will throw or be treated as string):
 *   - Anchors / aliases / tags
 *   - Flow mappings `{a: b}`
 *   - Folded block scalars `>`
 *   - Multi-document `---`
 *
 * Round-trip invariant: parseYaml(stringifyYaml(x)) deep-equals x for any
 * value whose shape matches the FeatureSchema (tests assert).
 */
// --- Public API ------------------------------------------------------------
export function parseYaml(text) {
    const lines = preprocess(text);
    if (lines.length === 0)
        return {};
    const parser = new Parser(lines);
    const value = parser.parseBlockNode(0);
    parser.expectEnd();
    return value;
}
export function stringifyYaml(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("stringifyYaml: top-level must be a mapping (object)");
    }
    const out = [];
    emitMapping(value, 0, out);
    let result = out.join("\n");
    if (!result.endsWith("\n"))
        result += "\n";
    return result;
}
function preprocess(text) {
    const out = [];
    const src = text.split("\n");
    for (let i = 0; i < src.length; i++) {
        const raw = src[i] ?? "";
        const lineno = i + 1;
        const leadMatch = raw.match(/^[ \t]*/);
        const lead = leadMatch ? leadMatch[0] : "";
        if (lead.includes("\t")) {
            throw new Error(`line ${lineno}: tabs are forbidden in indentation`);
        }
        const indent = lead.length;
        let rest = raw.slice(indent);
        if (rest.length === 0 || rest.startsWith("#"))
            continue;
        rest = stripTrailingComment(rest, lineno);
        rest = rest.replace(/[ \t]+$/, "");
        if (rest.length === 0)
            continue;
        out.push({ lineno, indent, content: rest });
    }
    return out;
}
function stripTrailingComment(s, lineno) {
    // Fast path: no `#` ⇒ no comment to strip, no quote tracking needed. This
    // also keeps mid-string `"` / `'` characters from being mis-interpreted as
    // YAML string delimiters in unquoted scalars (a quote-delimited string
    // would always start a value position; if `#` is absent the distinction
    // doesn't matter and the literal characters pass through verbatim).
    if (!s.includes("#"))
        return s;
    let inSingle = false;
    let inDouble = false;
    // Track whether we are currently inside a YAML-syntactic quoted scalar.
    // The quote characters only act as delimiters when they appear at the
    // start of a value position (line start after trim, or right after `: `).
    // Anywhere else they are literal characters of an unquoted scalar.
    const isValueStartPos = (i) => {
        // value position = i is the first non-whitespace char (line-start case),
        // OR the two chars to the left are `: ` / `:\t`.
        if (i === 0)
            return true;
        const left = s.slice(0, i);
        if (/^[ \t]*$/.test(left))
            return true;
        if (i >= 2 && s[i - 1] === " " && s[i - 2] === ":")
            return true;
        if (i >= 2 && s[i - 1] === "\t" && s[i - 2] === ":")
            return true;
        return false;
    };
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (inSingle) {
            if (ch === "'")
                inSingle = false;
        }
        else if (inDouble) {
            if (ch === "\\") {
                i++;
            }
            else if (ch === '"') {
                inDouble = false;
            }
        }
        else {
            if (ch === "'" && isValueStartPos(i))
                inSingle = true;
            else if (ch === '"' && isValueStartPos(i))
                inDouble = true;
            else if (ch === "#") {
                if (i === 0 || s[i - 1] === " " || s[i - 1] === "\t") {
                    return s.slice(0, i).replace(/[ \t]+$/, "");
                }
            }
        }
    }
    if (inSingle || inDouble) {
        throw new Error(`line ${lineno}: unterminated string literal`);
    }
    return s;
}
// --- Parser ----------------------------------------------------------------
class Parser {
    lines;
    idx = 0;
    constructor(lines) {
        this.lines = lines;
    }
    expectEnd() {
        if (this.idx !== this.lines.length) {
            const line = this.lines[this.idx];
            const lineno = line ? line.lineno : "?";
            throw new Error(`line ${lineno}: unexpected trailing content`);
        }
    }
    parseBlockNode(indent) {
        if (this.idx >= this.lines.length)
            return null;
        const first = this.lines[this.idx];
        if (!first)
            return null;
        if (first.indent < indent)
            return null;
        if (first.indent > indent) {
            throw new Error(`line ${first.lineno}: unexpected indent ${first.indent} (expected ${indent})`);
        }
        if (first.content.startsWith("- ") || first.content === "-") {
            return this.parseSequence(indent);
        }
        return this.parseMapping(indent);
    }
    parseMapping(indent) {
        const obj = {};
        while (this.idx < this.lines.length) {
            const line = this.lines[this.idx];
            if (!line || line.indent !== indent)
                break;
            const { content, lineno } = line;
            if (content.startsWith("- ") || content === "-") {
                throw new Error(`line ${lineno}: sequence item where mapping key expected`);
            }
            const m = matchKey(content, lineno);
            const key = m.key;
            const after = m.rest;
            this.idx++;
            if (after === "" || after === undefined) {
                const next = this.lines[this.idx];
                if (next && next.indent > indent) {
                    const value = this.parseBlockNode(next.indent);
                    obj[key] = value;
                }
                else {
                    obj[key] = null;
                }
            }
            else if (after === "|") {
                obj[key] = this.parseBlockScalar(indent);
            }
            else {
                obj[key] = parseScalar(after, lineno);
            }
        }
        return obj;
    }
    parseSequence(indent) {
        const arr = [];
        while (this.idx < this.lines.length) {
            const line = this.lines[this.idx];
            if (!line || line.indent !== indent)
                break;
            const { content, lineno } = line;
            if (!(content.startsWith("- ") || content === "-"))
                break;
            const after = content === "-" ? "" : content.slice(2);
            this.idx++;
            if (after === "") {
                const next = this.lines[this.idx];
                if (next && next.indent > indent) {
                    arr.push(this.parseBlockNode(next.indent));
                }
                else {
                    arr.push(null);
                }
            }
            else if (looksLikeKey(after)) {
                const innerIndent = indent + 2;
                const firstKey = matchKey(after, lineno);
                const mapping = {};
                if (firstKey.rest === "" || firstKey.rest === undefined) {
                    const next = this.lines[this.idx];
                    if (next && next.indent > innerIndent) {
                        mapping[firstKey.key] = this.parseBlockNode(next.indent);
                    }
                    else {
                        mapping[firstKey.key] = null;
                    }
                }
                else if (firstKey.rest === "|") {
                    mapping[firstKey.key] = this.parseBlockScalar(innerIndent);
                }
                else {
                    mapping[firstKey.key] = parseScalar(firstKey.rest, lineno);
                }
                while (this.idx < this.lines.length) {
                    const nxt = this.lines[this.idx];
                    if (!nxt || nxt.indent !== innerIndent)
                        break;
                    if (nxt.content.startsWith("- ") || nxt.content === "-")
                        break;
                    const km = matchKey(nxt.content, nxt.lineno);
                    this.idx++;
                    if (km.rest === "" || km.rest === undefined) {
                        const nn = this.lines[this.idx];
                        if (nn && nn.indent > innerIndent) {
                            mapping[km.key] = this.parseBlockNode(nn.indent);
                        }
                        else {
                            mapping[km.key] = null;
                        }
                    }
                    else if (km.rest === "|") {
                        mapping[km.key] = this.parseBlockScalar(innerIndent);
                    }
                    else {
                        mapping[km.key] = parseScalar(km.rest, nxt.lineno);
                    }
                }
                arr.push(mapping);
            }
            else {
                arr.push(parseScalar(after, lineno));
            }
        }
        return arr;
    }
    parseBlockScalar(parentIndent) {
        const collected = [];
        let blockIndent = null;
        while (this.idx < this.lines.length) {
            const line = this.lines[this.idx];
            if (!line)
                break;
            if (line.indent <= parentIndent)
                break;
            if (blockIndent === null)
                blockIndent = line.indent;
            if (line.indent < blockIndent)
                break;
            const extra = line.indent - blockIndent;
            collected.push(" ".repeat(extra) + line.content);
            this.idx++;
        }
        return collected.join("\n");
    }
}
function matchKey(content, lineno) {
    const m = content.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:(?:\s+(.*))?$/);
    if (!m)
        throw new Error(`line ${lineno}: malformed mapping key in "${content}"`);
    const key = m[1] ?? "";
    const rest = m[2] !== undefined ? m[2] : "";
    return { key, rest };
}
function looksLikeKey(s) {
    return /^[A-Za-z_][A-Za-z0-9_-]*\s*:(\s|$)/.test(s);
}
// --- Scalar parsing --------------------------------------------------------
function parseScalar(raw, lineno) {
    const s = raw.trim();
    if (s === "")
        return null;
    if (s === "null" || s === "~")
        return null;
    if (s === "true")
        return true;
    if (s === "false")
        return false;
    if (/^-?\d+$/.test(s)) {
        const n = Number(s);
        if (Number.isSafeInteger(n))
            return n;
    }
    if (/^-?\d+\.\d+$/.test(s))
        return Number(s);
    if (s.startsWith('"')) {
        return parseDoubleQuoted(s, lineno);
    }
    if (s.startsWith("'")) {
        return parseSingleQuoted(s, lineno);
    }
    if (s.startsWith("[")) {
        return parseFlowSequence(s, lineno);
    }
    return s;
}
function parseDoubleQuoted(s, lineno) {
    if (!s.endsWith('"') || s.length < 2) {
        throw new Error(`line ${lineno}: unterminated double-quoted string`);
    }
    const body = s.slice(1, -1);
    let out = "";
    for (let i = 0; i < body.length; i++) {
        const ch = body[i];
        if (ch === "\\") {
            const next = body[i + 1];
            if (next === undefined) {
                throw new Error(`line ${lineno}: dangling escape in double-quoted string`);
            }
            switch (next) {
                case "n":
                    out += "\n";
                    break;
                case "t":
                    out += "\t";
                    break;
                case "r":
                    out += "\r";
                    break;
                case '"':
                    out += '"';
                    break;
                case "\\":
                    out += "\\";
                    break;
                case "/":
                    out += "/";
                    break;
                default:
                    out += next;
            }
            i++;
        }
        else {
            out += ch;
        }
    }
    return out;
}
function parseSingleQuoted(s, lineno) {
    if (!s.endsWith("'") || s.length < 2) {
        throw new Error(`line ${lineno}: unterminated single-quoted string`);
    }
    const body = s.slice(1, -1);
    return body.replace(/''/g, "'");
}
function parseFlowSequence(s, lineno) {
    if (!s.endsWith("]")) {
        throw new Error(`line ${lineno}: unterminated flow sequence`);
    }
    const inner = s.slice(1, -1).trim();
    if (inner === "")
        return [];
    const parts = [];
    let depth = 0;
    let inSingle = false;
    let inDouble = false;
    let buf = "";
    for (let i = 0; i < inner.length; i++) {
        const ch = inner[i] ?? "";
        if (inSingle) {
            buf += ch;
            if (ch === "'")
                inSingle = false;
        }
        else if (inDouble) {
            buf += ch;
            if (ch === "\\" && i + 1 < inner.length) {
                const nx = inner[i + 1] ?? "";
                buf += nx;
                i++;
            }
            else if (ch === '"') {
                inDouble = false;
            }
        }
        else if (ch === "'") {
            buf += ch;
            inSingle = true;
        }
        else if (ch === '"') {
            buf += ch;
            inDouble = true;
        }
        else if (ch === "[") {
            depth++;
            buf += ch;
        }
        else if (ch === "]") {
            depth--;
            buf += ch;
        }
        else if (ch === "," && depth === 0) {
            parts.push(buf);
            buf = "";
        }
        else {
            buf += ch;
        }
    }
    if (buf.trim() !== "")
        parts.push(buf);
    return parts.map((p) => parseScalar(p, lineno));
}
// --- Serializer ------------------------------------------------------------
function emitMapping(obj, indent, out) {
    for (const key of Object.keys(obj)) {
        emitKeyValue(key, obj[key], indent, out);
    }
}
function emitKeyValue(key, value, indent, out) {
    const pad = " ".repeat(indent);
    if (value === null || value === undefined) {
        out.push(`${pad}${key}: null`);
        return;
    }
    if (typeof value === "boolean") {
        out.push(`${pad}${key}: ${value ? "true" : "false"}`);
        return;
    }
    if (typeof value === "number") {
        if (!Number.isFinite(value)) {
            throw new Error(`stringifyYaml: non-finite number for key "${key}"`);
        }
        out.push(`${pad}${key}: ${String(value)}`);
        return;
    }
    if (typeof value === "string") {
        if (value.includes("\n")) {
            out.push(`${pad}${key}: |`);
            const inner = " ".repeat(indent + 2);
            for (const ln of value.split("\n")) {
                out.push(ln === "" ? "" : `${inner}${ln}`);
            }
            return;
        }
        out.push(`${pad}${key}: ${formatInlineString(value)}`);
        return;
    }
    if (Array.isArray(value)) {
        if (value.length === 0) {
            out.push(`${pad}${key}: []`);
            return;
        }
        const allScalar = value.every((v) => v === null ||
            typeof v === "boolean" ||
            typeof v === "number" ||
            (typeof v === "string" && !v.includes("\n")));
        if (allScalar) {
            const rendered = value.map((v) => formatInlineForFlow(v)).join(", ");
            out.push(`${pad}${key}: [${rendered}]`);
            return;
        }
        out.push(`${pad}${key}:`);
        for (const elem of value) {
            emitSequenceItem(elem, indent + 2, out);
        }
        return;
    }
    if (typeof value === "object") {
        const inner = value;
        if (Object.keys(inner).length === 0) {
            out.push(`${pad}${key}: null`);
            return;
        }
        out.push(`${pad}${key}:`);
        emitMapping(inner, indent + 2, out);
        return;
    }
    throw new Error(`stringifyYaml: unsupported value for key "${key}"`);
}
function emitSequenceItem(value, indent, out) {
    const pad = " ".repeat(indent);
    if (value === null || typeof value === "boolean" || typeof value === "number") {
        out.push(`${pad}- ${formatScalarForBlock(value)}`);
        return;
    }
    if (typeof value === "string") {
        if (value.includes("\n")) {
            throw new Error("stringifyYaml: multiline strings inside sequences are not supported");
        }
        out.push(`${pad}- ${formatInlineString(value)}`);
        return;
    }
    if (Array.isArray(value)) {
        throw new Error("stringifyYaml: nested sequences are not supported");
    }
    if (typeof value === "object") {
        const obj = value;
        if (Object.keys(obj).length === 0) {
            out.push(`${pad}- null`);
            return;
        }
        out.push(`${pad}-`);
        emitMapping(obj, indent + 2, out);
        return;
    }
    throw new Error("stringifyYaml: unsupported sequence element");
}
function formatScalarForBlock(value) {
    if (value === null)
        return "null";
    if (typeof value === "boolean")
        return value ? "true" : "false";
    if (typeof value === "number")
        return String(value);
    if (typeof value === "string")
        return formatInlineString(value);
    throw new Error("stringifyYaml: unsupported scalar");
}
function formatInlineString(s) {
    if (s === "")
        return "''";
    if (needsQuoting(s)) {
        if (s.includes("'") || s.includes("\\") || s.includes('"')) {
            return JSON.stringify(s);
        }
        return `'${s}'`;
    }
    return s;
}
function formatInlineForFlow(value) {
    if (value === null)
        return "null";
    if (typeof value === "boolean")
        return value ? "true" : "false";
    if (typeof value === "number")
        return String(value);
    if (typeof value === "string") {
        if (value === "" || /[,[\]]/.test(value) || needsQuoting(value)) {
            if (value.includes("'") || value.includes("\\") || value.includes('"')) {
                return JSON.stringify(value);
            }
            return `'${value}'`;
        }
        return value;
    }
    throw new Error("stringifyYaml: unsupported flow element");
}
function needsQuoting(s) {
    if (s !== s.trim())
        return true;
    if (s === "true" || s === "false" || s === "null" || s === "~")
        return true;
    if (/^-?\d+$/.test(s))
        return true;
    if (/^-?\d+\.\d+$/.test(s))
        return true;
    if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(s))
        return true;
    if (s.includes(": ") || s.includes(" #"))
        return true;
    for (let i = 0; i < s.length; i++) {
        const code = s.charCodeAt(i);
        if (code < 0x20)
            return true;
    }
    return false;
}
