/** Top-level usage block, isolated from the REPL/agent composition graph. */
export const topLevelUsage = (): string =>
  [
    "quanta — coding agent CLI",
    "",
    "Usage:",
    "  quanta [PROMPT]                      Run a one-shot prompt",
    "  quanta                               Start interactive REPL",
    "  quanta --new-session [--title T]     Start a new id-mode session",
    "  quanta --resume <id|path>            Resume by id (id-mode) or path (path-mode)",
    "  quanta --state <path>                Save path-mode transcript",
    "  quanta session <subcommand> ...      Session management (see `quanta session --help`)",
    "  quanta remote <subcommand> ...       Remote execution plane (see `quanta remote --help`)",
    "  quanta attach [ws-url]               Join a running daemon's shared session over WS",
    "  quanta mcp-server        Expose quanta AS an MCP server over stdio (needs QUANTA_MCP_SERVER=1)",
    "",
    "Common flags:",
    "  --plan, --lsp, --lsp-tools, --git-tools, --observe-dir <d>, --metrics",
    "  -h, --help                           Show this help",
    "",
  ].join("\n")
