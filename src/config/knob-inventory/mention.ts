import type { KnobDeclaration } from "./types"

/**
 * `@`-mention resolver knob inventory (ADR-0418 file/symbol caps + §10.3
 * folder/git + RFC-12-2 mcp/subagent/thread). Extracted from `extra.ts` so that
 * flat inventory module stays under the god-MODULE ratchet while this cohesive
 * mention cluster lives in one place. Spread back into `EXTRA` at the call site.
 *
 * Every gate here is default-ON (a per-kind kill-switch); numeric caps are
 * optional. Graceful-omit: a kind whose injected owner is absent resolves to
 * null even with the gate ON — byte-identical to the pre-feature path. The
 * app/plugin opt-in gate (`QUANTA_MENTION_APP_PLUGIN`, default-OFF) stays in
 * `extra.ts` next to the other opt-in bench/box gates.
 */
export const MENTION: readonly KnobDeclaration[] = [
  // @-mention resolver caps — all default-ON; numeric caps optional
  {
    envKey: "QUANTA_MENTION_FILE_MAX_BYTES",
    kind: "int",
    default: undefined,
    group: "host-gate",
    home: "runtime-config",
    describe: "@file mention byte cap.",
    readSite: "agent/mention-runner/default-resolver.ts",
  },
  {
    envKey: "QUANTA_MENTION_FILE_TAIL_RATIO",
    kind: "float",
    default: undefined,
    group: "host-gate",
    home: "runtime-config",
    describe: "@file mention head/tail ratio.",
    readSite: "agent/mention-runner/default-resolver.ts",
  },
  {
    envKey: "QUANTA_MENTION_SYMBOL_RESOLVER",
    kind: "enum",
    default: undefined,
    group: "host-gate",
    home: "runtime-config",
    describe: "@symbol mention resolver backend.",
    readSite: "agent/mention-runner/default-resolver.ts",
  },
  {
    envKey: "QUANTA_MENTION_SYMBOL_TIMEOUT_MS",
    kind: "int",
    default: undefined,
    group: "host-gate",
    home: "runtime-config",
    describe: "@symbol resolver timeout (ms).",
    readSite: "agent/mention-runner/default-resolver.ts",
  },
  // §10.3 — @folder + @git mention kinds (Cursor parity). Gates default-ON
  // (=off opts out per kind); numeric caps optional. Graceful-omit semantics:
  // a kind whose dep (cwd / git provider) is absent resolves to null even when
  // the gate is on — byte-identical to the pre-§10.3 path.
  {
    envKey: "QUANTA_MENTION_FOLDER",
    kind: "bool",
    default: true,
    group: "host-gate",
    home: "runtime-config",
    describe: "@folder mention directory-listing resolver (default ON; =off to disable).",
    readSite: "agent/mention-runner/default-resolver.ts",
  },
  {
    envKey: "QUANTA_MENTION_FOLDER_MAX_ENTRIES",
    kind: "int",
    default: undefined,
    group: "host-gate",
    home: "runtime-config",
    describe: "@folder mention listing entry cap.",
    readSite: "agent/mention-runner/default-resolver.ts",
  },
  {
    envKey: "QUANTA_MENTION_GIT",
    kind: "bool",
    default: true,
    group: "host-gate",
    home: "runtime-config",
    describe: "@git mention git-context resolver (default ON; =off to disable).",
    readSite: "agent/mention-runner/default-resolver.ts",
  },
  {
    envKey: "QUANTA_MENTION_GIT_MAX_BYTES",
    kind: "int",
    default: undefined,
    group: "host-gate",
    home: "runtime-config",
    describe: "@git mention body byte cap.",
    readSite: "agent/mention-runner/default-resolver.ts",
  },
  // RFC-12-2 — richer @-mention sources (mcp / subagent / thread). Each is a
  // default-ON kill-switch (=off opts out per kind); numeric caps optional.
  // Graceful-omit semantics: a kind whose injected owner (mcp listing port /
  // named-agent registry / thread summary port) is absent resolves to null even
  // when the gate is on — byte-identical to the pre-RFC-12-2 path.
  {
    envKey: "QUANTA_MENTION_MCP",
    kind: "bool",
    default: true,
    group: "host-gate",
    home: "runtime-config",
    describe: "@mcp: mention MCP-server tool-list resolver (default ON; =off to disable).",
    readSite: "agent/mention-runner/default-resolver.ts",
  },
  {
    envKey: "QUANTA_MENTION_MCP_MAX_TOOLS",
    kind: "int",
    default: undefined,
    group: "host-gate",
    home: "runtime-config",
    describe: "@mcp: mention per-server tool-line cap.",
    readSite: "agent/mention-runner/default-resolver.ts",
  },
  {
    envKey: "QUANTA_MENTION_SUBAGENT",
    kind: "bool",
    default: true,
    group: "host-gate",
    home: "runtime-config",
    describe: "@subagent: mention named-agent role resolver (default ON; =off to disable).",
    readSite: "agent/mention-runner/default-resolver.ts",
  },
  {
    envKey: "QUANTA_MENTION_THREAD",
    kind: "bool",
    default: true,
    group: "host-gate",
    home: "runtime-config",
    describe: "@thread: mention prior-session summary resolver (default ON; =off to disable).",
    readSite: "agent/mention-runner/default-resolver.ts",
  },
  // The two GATES that decide whether the caps above are ever consulted. They sat
  // undeclared beside their own byte/ratio caps: read as `isOn(opts.env, "KEY")`,
  // a key-as-argument form the scanner could not see.
  {
    envKey: "QUANTA_MENTION_FILE",
    kind: "bool",
    default: false,
    group: "host-gate",
    describe:
      "Resolve `@file` mentions. Unset ⇒ the resolver returns undefined and the mention is left literal.",
    home: "runtime-config",
    readSite: "agent/mention-runner/default-resolver.ts",
  },
  {
    envKey: "QUANTA_MENTION_SKILL",
    kind: "bool",
    default: false,
    group: "host-gate",
    describe: "Resolve `@skill` mentions. Unset ⇒ the resolver returns undefined.",
    home: "runtime-config",
    readSite: "agent/mention-runner/default-resolver.ts",
  },
]
