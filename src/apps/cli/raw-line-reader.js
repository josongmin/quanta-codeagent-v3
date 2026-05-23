/** Bun-compatible line reader with Codex-style input box + below-prompt
 *  slash command palette.
 *
 *  Bun's `node:readline` polyfill (probe-verified 2026-05) does NOT invoke
 *  the `completer` option, so this module reads keys at the raw-mode
 *  `keypress` event level and renders the completion UX itself.
 *
 *  Layout (matches the Codex CLI reference):
 *
 *      ▏› {buf}{ghost}                                          ◀ BG-filled input row
 *      ▏  {meta}                                                ◀ BG-filled meta row
 *
 *      /name1      description for /name1                       ◀ candidate rows
 *      /name2      description for /name2                          (cyan name + dim desc)
 *      …
 *
 *  - The two top rows form a subtle gray "box" (terminal BG colour 236)
 *    that spans the full terminal width — visually distinguishes the
 *    composer from regular log output.
 *  - The candidate list appears BELOW the box, in a separate region.
 *    It's a plain two-column list (no border) with the command name in
 *    cyan and the description in dim gray, column-aligned to the widest
 *    visible name.
 *  - The list auto-opens as soon as the buffer starts with `/` and at
 *    least one candidate matches. Typing filters it in place; `↑`/`↓`
 *    navigate; `Tab`/`Enter` commit; `Esc` collapses it.
 *  - Ghost-text inline completion is still painted on the prompt row
 *    when the list is closed (a single match's tail in dim).
 *
 *  Scroll-stability invariant: every redraw paints inside the reserved
 *  band that the last expansion claimed; the band only ever grows (with
 *  a single terminal-scroll moment when it does), never shrinks
 *  mid-read. On read exit the band is fully erased and the prompt
 *  line is echoed normally so subsequent stdout starts on a fresh row.
 */
import * as readline from "node:readline";
export class AbortError extends Error {
    constructor() {
        super("aborted");
        this.name = "AbortError";
    }
}
const ESC = "\x1b[";
const ERASE_LINE = `${ESC}2K`;
const ERASE_LINE_RIGHT = `${ESC}0K`;
const CR = "\r";
const moveUp = (n) => (n > 0 ? `${ESC}${n}A` : "");
const moveDown = (n) => (n > 0 ? `${ESC}${n}B` : "");
const moveRight = (n) => (n > 0 ? `${ESC}${n}C` : "");
const DIM = `${ESC}2m`;
const RESET = `${ESC}0m`;
const CYAN = `${ESC}36m`;
const GRAY = `${ESC}90m`;
const BG = `${ESC}48;5;236m`;
const BG_END = `${ESC}49m`;
const REVERSE = `${ESC}7m`;
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s) => s.replace(ANSI_RE, "");
const charColumns = (ch) => {
    const code = ch.codePointAt(0);
    if (code === undefined)
        return 1;
    if (code < 0x80)
        return 1;
    if ((code >= 0x1100 && code <= 0x115f) ||
        (code >= 0x2e80 && code <= 0x303e) ||
        (code >= 0x3041 && code <= 0x33ff) ||
        (code >= 0x3400 && code <= 0x4dbf) ||
        (code >= 0x4e00 && code <= 0x9fff) ||
        (code >= 0xa000 && code <= 0xa4cf) ||
        (code >= 0xac00 && code <= 0xd7a3) ||
        (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0xfe30 && code <= 0xfe4f) ||
        (code >= 0xff00 && code <= 0xff60) ||
        (code >= 0xffe0 && code <= 0xffe6)) {
        return 2;
    }
    return 1;
};
const stringColumns = (s) => {
    let cols = 0;
    for (const ch of s)
        cols += charColumns(ch);
    return cols;
};
const MAX_VISIBLE_CANDIDATES = 8;
const termWidth = () => {
    const w = process.stderr.columns;
    return typeof w === "number" && w > 0 ? w : 80;
};
/** Fill an ANSI-coloured "row" out to the full terminal width.
 *
 *  IMPORTANT: `\x1b[0m` (full RESET) clears the background colour too —
 *  if a caller embeds `${RESET}` inside `content` the BG box visibly
 *  ends there (observed: short BG strip behind `›` + cursor, rest of
 *  the line plain black). We pre-process `content` to rewrite every
 *  full-RESET into a foreground-only reset (`\x1b[39;22m` — default fg
 *  + bold/dim off, BG untouched) so the band stays contiguous all the
 *  way to the terminal edge. */
const RESET_KEEP_BG = `${ESC}39;22m`;
const FULL_RESET_RE = /\x1b\[0m/g;
const fillBgRow = (content) => {
    const safe = content.replace(FULL_RESET_RE, RESET_KEEP_BG);
    const cols = stringColumns(stripAnsi(safe));
    const pad = Math.max(0, termWidth() - cols);
    return `${BG}${safe}${" ".repeat(pad)}${BG_END}`;
};
const ghostSuffix = (buf, candidates) => {
    if (candidates.length === 0)
        return "";
    const top = candidates[0] ?? "";
    if (!top.startsWith(buf))
        return "";
    return top.slice(buf.length);
};
export const readLine = (opts) => {
    return new Promise((resolve, reject) => {
        const stdin = process.stdin;
        const stdout = process.stderr;
        const promptCols = stringColumns(stripAnsi(opts.prompt));
        const META_ROWS = opts.meta !== undefined && opts.meta !== "" ? 1 : 0;
        const state = {
            buf: "",
            cursor: 0,
            candidates: [],
            selectedIdx: -1,
            listOpen: false,
            reserved: 0,
        };
        let settled = false;
        readline.emitKeypressEvents(stdin);
        const wasRaw = stdin.isTTY === true ? (stdin.isRaw ?? false) : false;
        if (stdin.isTTY === true)
            stdin.setRawMode(true);
        stdin.resume();
        const refreshCandidates = () => {
            if (opts.completer === undefined) {
                state.candidates = [];
                return;
            }
            state.candidates = state.buf.startsWith("/") ? opts.completer(state.buf) : [];
            // Auto-open the list whenever there's at least one match for a
            // slash-prefix buffer — Codex parity. The user never has to press
            // anything special to see the candidates.
            state.listOpen = state.candidates.length > 0;
            if (state.listOpen && state.selectedIdx < 0)
                state.selectedIdx = 0;
            if (!state.listOpen)
                state.selectedIdx = -1;
            if (state.selectedIdx >= state.candidates.length) {
                state.selectedIdx = state.candidates.length - 1;
            }
        };
        const targetReserved = () => {
            // meta row (if any) + blank row + list rows (if list open)
            const listRows = state.listOpen
                ? Math.min(state.candidates.length, MAX_VISIBLE_CANDIDATES) +
                    (state.candidates.length > MAX_VISIBLE_CANDIDATES ? 1 : 0)
                : 0;
            const blankRow = listRows > 0 ? 1 : 0;
            return META_ROWS + blankRow + listRows;
        };
        const growBandTo = (rows) => {
            if (rows <= state.reserved)
                return;
            const extra = rows - state.reserved;
            // Move past the current band, emit `extra` newlines (this is where
            // a one-time scroll happens if the prompt is near the bottom), then
            // walk back to the prompt line.
            let out = "";
            out += moveDown(state.reserved);
            out += "\n".repeat(extra);
            out += moveUp(state.reserved + extra);
            stdout.write(out);
            state.reserved = rows;
        };
        const renderListRows = () => {
            if (!state.listOpen || state.candidates.length === 0)
                return [];
            const visible = state.candidates.slice(0, MAX_VISIBLE_CANDIDATES);
            const extra = state.candidates.length - visible.length;
            const nameW = Math.max(...visible.map((c) => stringColumns(c)));
            const rows = visible.map((c, i) => {
                const namePadded = c + " ".repeat(Math.max(0, nameW - stringColumns(c)));
                const desc = opts.describe?.(c) ?? "";
                const sel = i === state.selectedIdx;
                const nameStyled = sel ? `${REVERSE}${CYAN}${namePadded}${RESET}` : `${CYAN}${namePadded}${RESET}`;
                const descStyled = desc !== "" ? `  ${GRAY}${desc}${RESET}` : "";
                return `${nameStyled}${descStyled}`;
            });
            if (extra > 0)
                rows.push(`${GRAY}  … +${extra} more${RESET}`);
            return rows;
        };
        const redraw = () => {
            const target = targetReserved();
            growBandTo(Math.max(target, state.reserved));
            let out = "";
            // Cursor is at prompt line, buf cursor col. Walk down through the
            // band, painting each row (or erasing it). Use moveDown — it does
            // NOT scroll the terminal even at the bottom of the screen, so the
            // band is stable once reserved.
            const listRows = renderListRows();
            for (let i = 0; i < state.reserved; i += 1) {
                out += moveDown(1) + CR + ERASE_LINE;
                if (i === 0 && META_ROWS === 1) {
                    out += fillBgRow(`  ${DIM}${opts.meta}${RESET}`);
                    continue;
                }
                const listOffset = META_ROWS === 1 ? 2 : 1;
                if (i >= listOffset && i - listOffset < listRows.length) {
                    out += listRows[i - listOffset] ?? "";
                }
                // Rows that are within `reserved` but past the actual content
                // remain blank (we already wrote ERASE_LINE above).
            }
            // Walk back up to the prompt line.
            out += moveUp(state.reserved);
            // Repaint the prompt line.
            out += CR + ERASE_LINE;
            out += fillBgRow(`${CYAN}${opts.prompt}${RESET}${state.buf}`);
            // Ghost text (only when list is closed AND cursor at end).
            if (!state.listOpen && state.cursor === state.buf.length) {
                const ghost = ghostSuffix(state.buf, state.candidates);
                if (ghost !== "") {
                    // Repaint with ghost embedded inside the BG row.
                    out += CR + ERASE_LINE;
                    out += fillBgRow(`${CYAN}${opts.prompt}${RESET}${state.buf}${DIM}${ghost}${RESET}`);
                }
            }
            // Cursor back to prompt line, buf cursor col.
            out += CR + moveRight(promptCols + stringColumns(state.buf.slice(0, state.cursor)));
            stdout.write(out);
        };
        const releaseBand = () => {
            if (state.reserved === 0)
                return;
            // Walk through the reserved band erasing every row, then come back
            // to the prompt line so the final echo + newline lands cleanly.
            let out = "";
            for (let i = 0; i < state.reserved; i += 1) {
                out += moveDown(1) + CR + ERASE_LINE;
            }
            out += moveUp(state.reserved);
            stdout.write(out);
            state.reserved = 0;
        };
        const cleanup = () => {
            stdin.removeListener("keypress", onKey);
            if (signalListener !== null)
                opts.signal?.removeEventListener("abort", signalListener);
            if (stdin.isTTY === true)
                stdin.setRawMode(wasRaw);
            stdin.pause();
        };
        const finalRenderForExit = () => {
            releaseBand();
            // Cursor is on the prompt line at the buffer cursor column. Wipe the
            // BG-styled prompt and echo it as plain text so subsequent stdout
            // doesn't bleed into the composer's background colour.
            stdout.write(CR + ERASE_LINE + opts.prompt + state.buf + "\n");
        };
        const settleResolve = (value) => {
            if (settled)
                return;
            settled = true;
            finalRenderForExit();
            cleanup();
            resolve(value);
        };
        const settleReject = (err) => {
            if (settled)
                return;
            settled = true;
            finalRenderForExit();
            cleanup();
            reject(err);
        };
        const signalListener = opts.signal
            ? () => settleReject(new AbortError())
            : null;
        if (opts.signal && signalListener !== null) {
            if (opts.signal.aborted) {
                queueMicrotask(() => settleReject(new AbortError()));
            }
            else {
                opts.signal.addEventListener("abort", signalListener, { once: true });
            }
        }
        const acceptGhost = () => {
            const ghost = ghostSuffix(state.buf, state.candidates);
            if (ghost === "")
                return false;
            state.buf += ghost;
            state.cursor = state.buf.length;
            refreshCandidates();
            return true;
        };
        const commitSelected = () => {
            if (!state.listOpen || state.selectedIdx < 0)
                return false;
            const pick = state.candidates[state.selectedIdx] ?? "";
            if (pick === "")
                return false;
            state.buf = pick;
            state.cursor = state.buf.length;
            refreshCandidates();
            return true;
        };
        const onKey = (str, key) => {
            if (settled)
                return;
            const k = key ?? {};
            if (k.ctrl === true && k.name === "c") {
                settleReject(new AbortError());
                return;
            }
            if (k.name === "return") {
                if (state.listOpen && state.selectedIdx >= 0)
                    commitSelected();
                settleResolve(state.buf);
                return;
            }
            if (k.name === "escape") {
                if (state.listOpen) {
                    state.listOpen = false;
                    state.selectedIdx = -1;
                    redraw();
                }
                return;
            }
            if (k.name === "tab") {
                if (state.listOpen && state.selectedIdx >= 0) {
                    commitSelected();
                }
                else if (!acceptGhost() && state.candidates.length > 0) {
                    state.listOpen = true;
                    state.selectedIdx = 0;
                }
                redraw();
                return;
            }
            if (k.name === "down") {
                if (state.listOpen && state.candidates.length > 0) {
                    const visible = Math.min(state.candidates.length, MAX_VISIBLE_CANDIDATES);
                    state.selectedIdx = (state.selectedIdx + 1) % visible;
                    redraw();
                }
                return;
            }
            if (k.name === "up") {
                if (state.listOpen && state.candidates.length > 0) {
                    const visible = Math.min(state.candidates.length, MAX_VISIBLE_CANDIDATES);
                    state.selectedIdx = state.selectedIdx <= 0 ? visible - 1 : state.selectedIdx - 1;
                    redraw();
                }
                return;
            }
            if (k.name === "right") {
                if (state.cursor === state.buf.length && ghostSuffix(state.buf, state.candidates) !== "") {
                    acceptGhost();
                }
                else if (state.cursor < state.buf.length) {
                    state.cursor += 1;
                }
                redraw();
                return;
            }
            if (k.name === "left") {
                if (state.cursor > 0) {
                    state.cursor -= 1;
                    redraw();
                }
                return;
            }
            if (k.name === "home") {
                state.cursor = 0;
                redraw();
                return;
            }
            if (k.name === "end") {
                state.cursor = state.buf.length;
                redraw();
                return;
            }
            if (k.name === "backspace") {
                if (state.cursor > 0) {
                    state.buf = state.buf.slice(0, state.cursor - 1) + state.buf.slice(state.cursor);
                    state.cursor -= 1;
                    refreshCandidates();
                    redraw();
                }
                return;
            }
            if (k.name === "delete") {
                if (state.cursor < state.buf.length) {
                    state.buf = state.buf.slice(0, state.cursor) + state.buf.slice(state.cursor + 1);
                    refreshCandidates();
                    redraw();
                }
                return;
            }
            if (typeof str === "string" && str.length > 0) {
                if (str === "\t" || str === "\r" || str === "\n")
                    return;
                if (str.length === 1 && str < " ")
                    return;
                state.buf = state.buf.slice(0, state.cursor) + str + state.buf.slice(state.cursor);
                state.cursor += str.length;
                refreshCandidates();
                redraw();
            }
        };
        stdin.on("keypress", onKey);
        // Initial paint: BG-styled prompt + (optional) meta row.
        growBandTo(targetReserved());
        redraw();
    });
};
const longestCommonPrefix = (candidates) => {
    if (candidates.length === 0)
        return "";
    let prefix = candidates[0] ?? "";
    for (let i = 1; i < candidates.length; i += 1) {
        const cur = candidates[i] ?? "";
        let j = 0;
        while (j < prefix.length && j < cur.length && prefix[j] === cur[j])
            j += 1;
        prefix = prefix.slice(0, j);
        if (prefix === "")
            return "";
    }
    return prefix;
};
export const __longestCommonPrefixForTest = longestCommonPrefix;
export const __stringColumnsForTest = stringColumns;
export const __ghostSuffixForTest = ghostSuffix;
