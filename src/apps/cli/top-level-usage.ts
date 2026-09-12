/** Top-level usage block, isolated from the REPL/agent composition graph.
 *
 *  The `Common flags:` rows are RENDERED from `TOP_LEVEL_FLAGS`, not typed here.
 *  Hand-written, this block advertised `--lsp-tools`, `--git-tools` and
 *  `--metrics` — none of which any top-level parser consumes — while omitting six
 *  flags the parser does accept. A prose block cannot drift-check either
 *  direction; a table can, and `top-level-flag-parity-hellgate` does. */
import { renderTopLevelFlagRows } from "./top-level-flags"

export const topLevelUsage = (): string =>
  [
    "quanta — coding agent CLI",
    "",
    "Usage:",
    "  quanta [PROMPT]                      Run a one-shot prompt",
    "  quanta                               Start interactive REPL",
    "  quanta /<command> [args]             Run a slash command directly (`quanta /version`, `quanta /doctor`)",
    "  quanta -- [PROMPT]                   Everything after `--` is prompt text, even if it starts with `-`",
    "  quanta session <subcommand> ...      Session management (see `quanta session --help`)",
    "  quanta remote <subcommand> ...       Remote execution plane (see `quanta remote --help`)",
    "  quanta attach [ws-url]               Join a running daemon's shared session over WS",
    "  quanta mcp-server                    Expose quanta AS an MCP server over stdio (needs QUANTA_MCP_SERVER=1)",
    "",
    "Common flags:",
    ...renderTopLevelFlagRows(),
    "",
  ].join("\n")
