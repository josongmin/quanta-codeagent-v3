const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const RED = "\x1b[31m";
const detectColor = () => {
    if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "")
        return false;
    // Only paint when stderr is a TTY — pipes get plain text.
    return Boolean(process.stderr.isTTY);
};
/** Build the painter observer. The shared `TextDecoder` per observer
 *  preserves split-multibyte semantics across chunks; one decoder per painter
 *  instance (stateful). Returns a closure satisfying {@link ShellExecObserver}. */
export const buildShellStreamPainter = (opts = {}) => {
    const write = opts.write ?? ((s) => process.stderr.write(s));
    const color = opts.color ?? detectColor();
    const dim = (s) => (color ? `${DIM}${s}${RESET}` : s);
    const redDim = (s) => (color ? `${RED}${DIM}${s}${RESET}` : s);
    const labelTag = opts.label !== undefined ? `[${opts.label}] ` : "";
    // `stream: true` so a UTF-8 multibyte sequence split across chunks decodes
    // correctly on subsequent calls. One decoder per painter instance.
    const decStdout = new TextDecoder("utf-8");
    const decStderr = new TextDecoder("utf-8");
    return (event) => {
        switch (event.kind) {
            case "start":
                write(dim(`${labelTag}[shell] $ ${event.command}\n`));
                return;
            case "stdout":
                write(decStdout.decode(event.chunk, { stream: true }));
                return;
            case "stderr":
                write(redDim(decStderr.decode(event.chunk, { stream: true })));
                return;
            case "exit": {
                // Final flush — pass an empty buffer with `stream: false` so any
                // trailing partial gets emitted; the decoders are not reused after.
                const tailOut = decStdout.decode();
                const tailErr = decStderr.decode();
                if (tailOut.length > 0)
                    write(tailOut);
                if (tailErr.length > 0)
                    write(redDim(tailErr));
                const sig = event.signal !== null ? ` signal=${event.signal}` : "";
                write(dim(`${labelTag}[shell] exit code=${event.code ?? "null"}${sig}\n`));
                return;
            }
            case "aborted":
                write(dim(`${labelTag}[shell] aborted (${event.reason})\n`));
                return;
            default: {
                // Exhaustive switch — a new ShellExecEvent variant becomes a compile
                // error at the `never` assignment per ADR-0081. We do NOT `return` the
                // value (biome `useExhaustiveDependencies` style: a void function must
                // not return a value).
                const _exhaustive = event;
                void _exhaustive;
            }
        }
    };
};
