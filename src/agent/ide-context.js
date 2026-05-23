import { readFileSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { errMessage } from "@/shared";
import { escapeBoundary } from "./untrusted";
/**
 * Defang BOTH boundary tag families a user-controlled fragment could forge:
 * the outer `<system-reminder>` wrapper (the rendered block is ultimately
 * prepended to a user message that may itself be inside a reminder downstream)
 * AND this block's own `<ide-context>` wrapper. A selection text or diagnostic
 * message carrying a literal `</ide-context>` would otherwise terminate THIS
 * block's wrapper and let the trailing payload read as out-of-band context —
 * the exact trust-boundary break the renderer's docstring promises against.
 *
 * This is now a thin alias over the canonical {@link escapeBoundary} helper
 * (`src/agent/untrusted.ts`) bound to the `ide-context` tag — the SINGLE
 * enforced path all untrusted fragments funnel through. `escapeBoundary`
 * always also defangs `system-reminder`, so the behavior is byte-identical to
 * the prior local form (`escapeReminderBoundary(s).replace(/<(\/?ide-context>)/gi,
 * "<\\$1")`): same backslash defang form (`<\/ide-context>` / `<\ide-context>`),
 * case-insensitive, casing preserved. */
const escapeContextBoundary = (s) => escapeBoundary("ide-context", s);
/** True when the snapshot has no presentable content (every field absent or
 *  an empty array). Used by {@link renderIdeContext} to short-circuit to an
 *  empty string instead of rendering an empty `<ide-context>` wrapper. */
const isEmptySnapshot = (snapshot) => {
    if (snapshot.activeFile !== undefined)
        return false;
    if (snapshot.openTabs && snapshot.openTabs.length > 0)
        return false;
    if (snapshot.selection !== undefined)
        return false;
    if (snapshot.diagnostics && snapshot.diagnostics.length > 0)
        return false;
    return true;
};
/** Render the `## Active file:` heading. Returns `undefined` when the field is
 *  absent so the renderer can skip the section without emitting a blank line.
 *  PR-4 self-audit fix: every interpolated field — including numeric `line`,
 *  union `severity`, tuple `range` — goes through `String(...)` +
 *  `escapeReminderBoundary` so a provider returning the wrong runtime shape
 *  (untyped JS host, `as any` cast) cannot forge `<system-reminder>` tags. */
const renderActiveFile = (file) => {
    if (file === undefined)
        return undefined;
    const path = escapeContextBoundary(file.path);
    return file.line !== undefined
        ? `## Active file: ${path}:${escapeContextBoundary(String(file.line))}`
        : `## Active file: ${path}`;
};
/** Render the `## Open tabs:` block (heading + one bullet per tab). Returns
 *  `undefined` when the list is absent or empty. */
const renderOpenTabs = (tabs) => {
    if (!tabs || tabs.length === 0)
        return undefined;
    const lines = ["## Open tabs:"];
    for (const tab of tabs) {
        const path = escapeContextBoundary(tab.path);
        lines.push(tab.dirty === true ? `- ${path} [dirty]` : `- ${path}`);
    }
    return lines;
};
/** Render the `## Selection in ...` block (heading + escaped body). Returns
 *  `undefined` when no selection is present. */
const renderSelection = (selection) => {
    if (selection === undefined)
        return undefined;
    const path = escapeContextBoundary(selection.path);
    const [start, end] = selection.range;
    const startStr = escapeContextBoundary(String(start));
    const endStr = escapeContextBoundary(String(end));
    const text = escapeContextBoundary(selection.text);
    return [`## Selection in ${path} [${startStr}:${endStr}]:`, text];
};
/** Render the `## Diagnostics:` block (heading + one bullet per item). Returns
 *  `undefined` when the list is absent or empty. */
const renderDiagnostics = (diagnostics) => {
    if (!diagnostics || diagnostics.length === 0)
        return undefined;
    const lines = ["## Diagnostics:"];
    for (const d of diagnostics) {
        const path = escapeContextBoundary(d.path);
        const message = escapeContextBoundary(d.message);
        const severity = escapeContextBoundary(String(d.severity));
        const line = escapeContextBoundary(String(d.line));
        lines.push(`- ${severity} ${path}:${line} — ${message}`);
    }
    return lines;
};
/**
 * Deterministic renderer. Produces the closed `<ide-context>` block format:
 *
 * ```
 * <ide-context>
 * ## Active file: <path>:<line?>
 * ## Open tabs:
 * - <path> [dirty]
 * - <path>
 * ## Selection in <path> [start:end]:
 * <escaped text>
 * ## Diagnostics:
 * - error <path>:<line> — <message>
 * - warning <path>:<line> — <message>
 * </ide-context>
 * ```
 *
 * Sections are present ONLY when their field is present (and arrays non-
 * empty). `escapeReminderBoundary` is applied to every user-supplied text
 * fragment (paths, selection text, diagnostic messages) so a file's content
 * cannot forge `<system-reminder>` tags.
 *
 * `null` snapshot ⇒ empty string (caller prepends nothing).
 * Empty snapshot (every field absent/empty) ⇒ empty string.
 */
export const renderIdeContext = (snapshot) => {
    if (snapshot === null)
        return "";
    if (isEmptySnapshot(snapshot))
        return "";
    const lines = ["<ide-context>"];
    const activeFile = renderActiveFile(snapshot.activeFile);
    if (activeFile !== undefined)
        lines.push(activeFile);
    const tabs = renderOpenTabs(snapshot.openTabs);
    if (tabs !== undefined)
        lines.push(...tabs);
    const selection = renderSelection(snapshot.selection);
    if (selection !== undefined)
        lines.push(...selection);
    const diagnostics = renderDiagnostics(snapshot.diagnostics);
    if (diagnostics !== undefined)
        lines.push(...diagnostics);
    lines.push("</ide-context>");
    return lines.join("\n");
};
/**
 * Normalise an arbitrary file path against a cwd. Absolute paths are made
 * relative; relative paths are returned unchanged. Path-traversal sequences
 * (`..`) are preserved on input but the result NEVER starts with `/` so a
 * downstream renderer doesn't accidentally leak a host-absolute prefix.
 */
export const toRelativePath = (cwd, path) => {
    if (path === "")
        return "";
    if (!isAbsolute(path))
        return path;
    const rel = relative(cwd, path);
    // `relative('/a','/a')` returns ''; preserve the original basename in that
    // edge case so the rendered block still shows SOMETHING (the empty string
    // would silently drop the field downstream).
    return rel === "" ? "." : rel;
};
/** Strip a snapshot's paths to relative + return a fresh snapshot. */
const toRelativeSnapshot = (cwd, snap) => ({
    ...(snap.activeFile !== undefined
        ? {
            activeFile: {
                path: toRelativePath(cwd, snap.activeFile.path),
                ...(snap.activeFile.line !== undefined ? { line: snap.activeFile.line } : {}),
            },
        }
        : {}),
    ...(snap.openTabs !== undefined
        ? {
            openTabs: snap.openTabs.map((t) => ({
                path: toRelativePath(cwd, t.path),
                ...(t.dirty !== undefined ? { dirty: t.dirty } : {}),
            })),
        }
        : {}),
    ...(snap.selection !== undefined
        ? {
            selection: {
                path: toRelativePath(cwd, snap.selection.path),
                range: snap.selection.range,
                text: snap.selection.text,
            },
        }
        : {}),
    ...(snap.diagnostics !== undefined
        ? {
            diagnostics: snap.diagnostics.map((d) => ({
                path: toRelativePath(cwd, d.path),
                severity: d.severity,
                line: d.line,
                message: d.message,
            })),
        }
        : {}),
});
/**
 * Strip a snapshot down to its metadata projection — absolute paths normalised
 * to relative, selection text replaced with `textLength`, diagnostic messages
 * replaced with `messageLength`. Used by the persistence path so the
 * trajectory never carries raw editor contents.
 *
 * `tier` and `capturedAtMs` are injected by the caller (the provider knows
 * which tier the data is from + when it was captured). This function is pure
 * + safe to call without a provider.
 */
export const toMetadataSnapshot = (cwd, snap, tier, capturedAtMs) => ({
    tier,
    capturedAtMs,
    ...(snap.activeFile !== undefined
        ? {
            activeFile: {
                relativeFilePath: toRelativePath(cwd, snap.activeFile.path),
                ...(snap.activeFile.line !== undefined ? { line: snap.activeFile.line } : {}),
            },
        }
        : {}),
    ...(snap.openTabs !== undefined
        ? {
            openTabs: snap.openTabs.map((t) => ({
                relativeFilePath: toRelativePath(cwd, t.path),
                ...(t.dirty !== undefined ? { dirty: t.dirty } : {}),
            })),
        }
        : {}),
    ...(snap.selection !== undefined
        ? {
            selection: {
                relativeFilePath: toRelativePath(cwd, snap.selection.path),
                range: snap.selection.range,
                textLength: snap.selection.text.length,
            },
        }
        : {}),
    ...(snap.diagnostics !== undefined
        ? {
            diagnostics: snap.diagnostics.map((d) => ({
                relativeFilePath: toRelativePath(cwd, d.path),
                severity: d.severity,
                line: d.line,
                messageLength: d.message.length,
            })),
        }
        : {}),
});
/** Per-field parsers extracted from {@link parseIdeContextJson} so the root
 *  parser stays under the cognitive-complexity budget. Each helper validates
 *  shape + throws with a descriptive message on the first violation. */
const parseActiveFile = (raw) => {
    if (typeof raw !== "object" || raw === null) {
        throw new Error("ide-context.activeFile: must be an object");
    }
    const a = raw;
    if (typeof a.path !== "string")
        throw new Error("ide-context.activeFile.path: must be a string");
    return { path: a.path, ...(typeof a.line === "number" ? { line: a.line } : {}) };
};
const parseOpenTabs = (raw) => {
    if (!Array.isArray(raw))
        throw new Error("ide-context.openTabs: must be an array");
    return raw.map((t, i) => {
        if (typeof t !== "object" || t === null) {
            throw new Error(`ide-context.openTabs[${i}]: must be an object`);
        }
        const x = t;
        if (typeof x.path !== "string") {
            throw new Error(`ide-context.openTabs[${i}].path: must be a string`);
        }
        return { path: x.path, ...(typeof x.dirty === "boolean" ? { dirty: x.dirty } : {}) };
    });
};
const parseSelection = (raw) => {
    if (typeof raw !== "object" || raw === null) {
        throw new Error("ide-context.selection: must be an object");
    }
    const x = raw;
    if (typeof x.path !== "string") {
        throw new Error("ide-context.selection.path: must be a string");
    }
    if (!Array.isArray(x.range) || x.range.length !== 2) {
        throw new Error("ide-context.selection.range: must be a 2-element [start, end] array");
    }
    const [start, end] = x.range;
    if (typeof start !== "number" || typeof end !== "number") {
        throw new Error("ide-context.selection.range: both endpoints must be numbers");
    }
    if (typeof x.text !== "string") {
        throw new Error("ide-context.selection.text: must be a string");
    }
    return { path: x.path, range: [start, end], text: x.text };
};
const parseDiagnosticItem = (raw, i) => {
    if (typeof raw !== "object" || raw === null) {
        throw new Error(`ide-context.diagnostics[${i}]: must be an object`);
    }
    const x = raw;
    if (typeof x.path !== "string") {
        throw new Error(`ide-context.diagnostics[${i}].path: must be a string`);
    }
    if (x.severity !== "error" && x.severity !== "warning") {
        throw new Error(`ide-context.diagnostics[${i}].severity: must be "error" or "warning"`);
    }
    if (typeof x.line !== "number") {
        throw new Error(`ide-context.diagnostics[${i}].line: must be a number`);
    }
    if (typeof x.message !== "string") {
        throw new Error(`ide-context.diagnostics[${i}].message: must be a string`);
    }
    return { path: x.path, severity: x.severity, line: x.line, message: x.message };
};
const parseDiagnostics = (raw) => {
    if (!Array.isArray(raw)) {
        throw new Error("ide-context.diagnostics: must be an array");
    }
    return raw.map((d, i) => parseDiagnosticItem(d, i));
};
/** Validate + coerce a raw JSON object into an {@link IdeSnapshot}. Throws
 *  with a descriptive message on shape error so a typo in the JSON file is
 *  surfaced loudly (not silently rendered as an empty snapshot). */
const parseIdeContextJson = (raw) => {
    if (typeof raw !== "object" || raw === null) {
        throw new Error("ide-context: root must be a JSON object");
    }
    const r = raw;
    const out = {};
    if (r.activeFile !== undefined)
        out.activeFile = parseActiveFile(r.activeFile);
    if (r.openTabs !== undefined)
        out.openTabs = parseOpenTabs(r.openTabs);
    if (r.selection !== undefined)
        out.selection = parseSelection(r.selection);
    if (r.diagnostics !== undefined)
        out.diagnostics = parseDiagnostics(r.diagnostics);
    return out;
};
/**
 * Concrete in-repo IDE context provider — reads `.quanta/ide-context.json`
 * per turn (or a host-overridden path). Absent file ⇒ `null` snapshot (no
 * IDE attached signal). Malformed JSON ⇒ throw (the loop catches at the
 * boundary, emits an `error` event, and proceeds with no block).
 *
 * Why a JSON file (not a socket / pipe / env var)?
 *   - The file is hand-editable for ad-hoc debugging.
 *   - It survives process restarts (daemon mode benefit).
 *   - A host can atomically swap it (write-then-rename) without coupling
 *     to a runtime IPC channel.
 *   - The agent loop already reads files for skills + AGENTS.md — no new
 *     I/O primitive.
 *
 * Concurrency: `snapshot()` does ONE `readFileSync`. If the host writes
 * concurrently using rename-after-write the read either sees the old
 * complete file or the new complete file — never a torn read.
 *
 * Negative invariants (mirror the seam's own — preserved here):
 *   - The provider does NOT cache across turns. Each `snapshot()` reads the
 *     file fresh — the host is the source of truth.
 *   - The provider does NOT widen `IdeSnapshot` (closed shape). Dual-tier
 *     provenance is recorded in the METADATA only.
 */
export class FileSystemIdeContextProvider {
    cwd;
    contextFile;
    metadataSink;
    now;
    read;
    /** Visible to tests — count of `snapshot()` invocations. */
    calls = 0;
    constructor(opts) {
        this.cwd = opts.cwd;
        this.contextFile = opts.contextFile ?? `${opts.cwd}/.quanta/ide-context.json`;
        this.metadataSink = opts.metadataSink;
        this.now = opts.now ?? (() => Date.now());
        this.read =
            opts.read ??
                ((p) => {
                    try {
                        return readFileSync(p, "utf8");
                    }
                    catch (e) {
                        if (e instanceof Error && "code" in e && e.code === "ENOENT") {
                            return null;
                        }
                        throw e;
                    }
                });
    }
    async snapshot(signal) {
        this.calls += 1;
        if (signal.aborted)
            return null;
        const raw = this.read(this.contextFile);
        if (raw === null)
            return null;
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch (e) {
            throw new Error(`ide-context: JSON parse failed at ${this.contextFile}: ${errMessage(e)}`);
        }
        const snap = parseIdeContextJson(parsed);
        const relative = toRelativeSnapshot(this.cwd, snap);
        // Persist metadata-only BEFORE returning so the recorder sees the
        // capture for THIS turn even if the loop later aborts. Sink failures
        // are absorbed (boundary contract) — a broken sink must not crash the
        // turn.
        if (this.metadataSink !== undefined) {
            try {
                this.metadataSink(toMetadataSnapshot(this.cwd, snap, "injected", this.now()));
            }
            catch {
                // sink bug ⇒ swallow (boundary)
            }
        }
        return relative;
    }
}
