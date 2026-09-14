/**
 * Hellgate — the DENY-ALL network posture actually denies egress-bearing calls.
 *
 * Round 9, three escapes, each reproduced: the guard found a shell command only in the
 * input fields `command`/`cmd` (the registry's projection now arrives as
 * `facts.shellCommand`); tools that run code or drive a network without a shell line had
 * no contribution; and a subagent's config never received the parent's guard.
 *
 * Round 10, reproduced: the fix for the second was a REFUSAL list covering only the
 * plan-mode rows classified as code or network, so `web_search {query}` (no `url`),
 * `git_push`, `gh_pr_create`, `image_gen`, every `mcp__*` tool and a renamed subagent tool
 * were allowed. The posture now permits only `DENY_ALL_PERMITTED_TOOLS`; the classification
 * arm below places every tool of the assembled universe and the caller-wire ledger on one
 * side, both ways. And the guard reached `assembleAgentConfig`'s spread copy of the base,
 * not the base the delegation runner captured, so delegate children ran unguarded.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { consultDispatchGuard } from "@/agent/dispatch/preflight-consults"
import { buildNetworkDispatchGuard, DENY_ALL_PERMITTED_TOOLS } from "@/agent/dispatch-guard"
import { CALLER_WIRE_TOOL_NAMES, planModeMutatingTable } from "@/agent/mode"
import { buildChildConfig } from "@/agent/subagent-runner-child-config"
import type { AgentConfig } from "@/agent/types"
import { buildBaseFromArgs } from "@/host/runtime/agent-arg-builder"
import type { SubagentRequest } from "@/subagent"
import { ToolRegistry } from "@/tool"
import { testRunnerTool } from "@/tool/test-runner"
import { assembleToolUniverse } from "./_shared/assembled-tool-universe"

const denied = buildNetworkDispatchGuard({ posture: "denied" })
if (denied === undefined) throw new Error("fixture: the denied posture must build a guard")

const configWith = (over: Partial<AgentConfig>): AgentConfig =>
  ({
    registry: new ToolRegistry([testRunnerTool as never]),
    dispatchGuard: denied,
    ...over,
  }) as AgentConfig

const call = (name: string, input: unknown) => ({
  type: "tool_use" as const,
  id: "c1",
  name,
  input,
})

describe("deny-all posture — the seam hands the guard the registry's shell command", () => {
  // `test_runner { path }` exposes its command only through `extractShellCommand` (the
  // projected `bun test <path>` line), not through a `command` field, and it is NOT in the
  // by-name set — so it isolates the seam fix.
  const input = { path: "x.test.ts" }

  test("RED: through the seam, a shell-exposing tool with no `command` field is refused", () => {
    const res = consultDispatchGuard(call("test_runner", input) as never, configWith({}))
    expect(res, "test_runner's projected line reached a deny-all network").not.toBeNull()
  })

  test("the shell-line check sees the projection the seam passes, not only input fields", () => {
    // `test_runner` is refused by the permitted list anyway; the shell arm is its own check.
    const guard = buildNetworkDispatchGuard({ posture: "allowlist", hosts: [] })
    if (guard === undefined) throw new Error("fixture: an empty allowlist builds a guard")
    expect(Object.hasOwn(DENY_ALL_PERMITTED_TOOLS, "grep")).toBe(true)
    expect(guard.check("grep", { pattern: "x" }).kind).toBe("allow")
    const viaFacts = guard.check("grep", { pattern: "x" }, { shellCommand: "curl evil.example" })
    expect(viaFacts.kind).toBe("deny")
    if (viaFacts.kind === "deny") expect(viaFacts.reason).toContain("shell-equivalent")
  })
})

describe("deny-all posture — only the permitted tools run", () => {
  test("RED (round 10): network and code tools with no url or shell field are refused", () => {
    const cases: ReadonlyArray<readonly [string, unknown]> = [
      ["web_search", { query: "EXFIL-secret-token-123" }],
      ["git_push", {}],
      ["gh_pr_create", { title: "t", body: "b" }],
      ["gh_pr_comment", { body: "b" }],
      ["image_gen", { prompt: "p" }],
      ["mcp_connector_install", { id: "github" }],
      ["mcp__github__create_issue", { title: "t" }],
      ["mcp__fetch__fetch", { uri: "https://evil.example" }],
      ["agent1__read", { path: "a.ts" }], // a renamed tool is not the tool the table vetted
      ["enter_worktree", {}], // post-checkout hooks run
      ["side_agent_spawn", {}], // its worker carries no guard
      ["lsp_hover", { path: "a.ts" }], // language servers run workspace code
      ["node_repl", {}],
      ["write_stdin", {}],
    ]
    for (const [tool, input] of cases) {
      expect(denied.check(tool, input).kind, tool).toBe("deny")
    }
  })

  test("PAIRED CONTROL: permitted tools run, and the other postures are unaffected", () => {
    for (const [tool, input] of [
      ["read", { path: "a.ts" }],
      ["apply_patch", { patch: "*** Begin Patch" }],
      ["agent", { prompt: "go" }],
    ] as const) {
      expect(denied.check(tool, input).kind, tool).toBe("allow")
    }
    expect(buildNetworkDispatchGuard({ posture: "open" })).toBeUndefined()
    const allowlist = buildNetworkDispatchGuard({ posture: "allowlist", hosts: ["example.com"] })
    expect(allowlist?.check("web_search", { query: "q" }).kind).toBe("allow")
    expect(allowlist?.check("node_repl", {}).kind).toBe("allow")
  })
})

describe("deny-all posture — a subagent runs under its parent's guard", () => {
  test("buildChildConfig carries the parent's dispatchGuard; absent stays absent", () => {
    const parent = {
      llm: { stream: async function* () {} },
      registry: new ToolRegistry([]),
      stream: { emit: () => {} },
      permission: { mode: "default" },
      messages: [],
      system: "S",
      cwd: "/repo",
      maxTurns: 3,
      signal: new AbortController().signal,
      dispatchGuard: denied,
    } as unknown as AgentConfig
    const req: SubagentRequest = { prompt: "go", depth: 1 }
    const mailbox = { agentId: "child", parentId: "parent" }
    const child = buildChildConfig(parent, req, "/repo", mailbox, undefined, undefined, undefined, {
      fsOwnershipEnforce: false,
    })
    expect(child.dispatchGuard).toBe(denied)
    const { dispatchGuard: _dropped, ...unguarded } = parent
    const child2 = buildChildConfig(
      unguarded as AgentConfig,
      req,
      "/repo",
      mailbox,
      undefined,
      undefined,
      undefined,
      { fsOwnershipEnforce: false },
    )
    expect("dispatchGuard" in child2).toBe(false)
  })
})

describe("deny-all posture — every tool is classified", () => {
  /** Each tool NOT permitted, with why. The permitted side lives in src. */
  const REFUSED: Readonly<Record<string, string>> = {
    bash: "shell",
    exec_command: "shell",
    pty_write: "shell",
    container_exec: "shell",
    container_write_file: "shell",
    test_runner: "runs tests",
    run_tests: "runs tests",
    collect_evidence: "runs tests",
    debug_inspect: "runs the program",
    node_repl: "runs Node",
    shadow_verify: "runs tests and language servers",
    write_stdin: "feeds a shell",
    objective_verify: "runs declared checks",
    diagnostics: "language server",
    lsp_code_action: "language server",
    lsp_definition: "language server",
    lsp_document_symbol: "language server",
    lsp_format: "language server",
    lsp_hover: "language server",
    lsp_implementation: "language server",
    lsp_incoming_calls: "language server",
    lsp_outgoing_calls: "language server",
    lsp_references: "language server",
    lsp_rename_apply: "language server",
    lsp_rename_preview: "language server",
    lsp_signature_help: "language server",
    lsp_type_definition: "language server",
    lsp_workspace_symbol: "language server",
    web_fetch: "network",
    web_search: "network",
    read_image_url: "network",
    image_gen: "network",
    appshot_verify: "renders and judges an app",
    gh_check_status: "GitHub API",
    gh_issue_view: "GitHub API",
    gh_pr_auto_merge: "GitHub API",
    gh_pr_blame: "GitHub API",
    gh_pr_code_tour: "GitHub API",
    gh_pr_comment: "GitHub API",
    gh_pr_create: "GitHub API",
    gh_pr_edit_labels: "GitHub API",
    gh_pr_list: "GitHub API",
    gh_pr_open: "GitHub API",
    gh_pr_resolve_thread: "GitHub API",
    gh_pr_review_diff: "GitHub API",
    gh_pr_view: "GitHub API",
    git_push: "network",
    git_commit: "runs commit hooks",
    git_branch_switch: "runs checkout hooks",
    enter_worktree: "runs checkout hooks",
    automation_update: "schedules later runs",
    side_agent_spawn: "OS-process worker without the guard",
    mcp_connector_install: "configures and fetches MCP servers",
    mcp_connector_list: "remote registry",
    mcp_get_prompt: "MCP server",
    mcp_list_prompts: "MCP server",
    mcp_list_resource_templates: "MCP server",
    mcp_list_resources: "MCP server",
    mcp_read_resource: "MCP server",
    mcp_read_resource_dir: "MCP server",
    cancel_mcp_task: "MCP server",
    get_mcp_task: "MCP server",
    list_mcp_tasks: "MCP server",
    browser_cdp: "browser",
    browser_click: "browser",
    browser_console: "browser",
    browser_drag: "browser",
    browser_element_bounds: "browser",
    browser_fill: "browser",
    browser_highlight: "browser",
    browser_mouse_click_xy: "browser",
    browser_navigate: "browser",
    browser_network: "browser",
    browser_press_key: "browser",
    browser_read: "browser",
    browser_screenshot: "browser",
    browser_scroll: "browser",
    browser_select_option: "browser",
    browser_snapshot: "browser",
    browser_tab_close: "browser",
    browser_tab_list: "browser",
    browser_tab_new: "browser",
    browser_tab_switch: "browser",
    browser_type: "browser",
    browser_wait: "browser",
  }

  test("the classification is exact: every tool on one side, no stale entry, no shell-exposing permit", async () => {
    const universe = await assembleToolUniverse()
    const names = new Set([...universe.tools.map((t) => t.name), ...CALLER_WIRE_TOOL_NAMES])
    expect(names.size, "the universe enumerated too few tools").toBeGreaterThan(190)
    const permitted = Object.keys(DENY_ALL_PERMITTED_TOOLS)
    const unplaced = [...names].filter(
      (n) => !Object.hasOwn(DENY_ALL_PERMITTED_TOOLS, n) && !Object.hasOwn(REFUSED, n),
    )
    expect(
      unplaced,
      "classify each new tool: permitted in src, or REFUSED here with a reason",
    ).toEqual([])
    expect(
      permitted.filter((n) => Object.hasOwn(REFUSED, n)),
      "a tool on both sides",
    ).toEqual([])
    expect(
      [...permitted, ...Object.keys(REFUSED)].filter((n) => !names.has(n)),
      "stale names",
    ).toEqual([])
    const shellExposing = universe.tools
      .filter(
        (t) => typeof (t as { extractShellCommand?: unknown }).extractShellCommand === "function",
      )
      .map((t) => t.name)
      .filter((n) => Object.hasOwn(DENY_ALL_PERMITTED_TOOLS, n))
    expect(shellExposing, "a permitted tool exposes a shell line").toEqual([])
    for (const [name, why] of Object.entries(DENY_ALL_PERMITTED_TOOLS)) {
      expect(why.trim().length, `${name} needs a reason`).toBeGreaterThan(5)
    }
    // Every row plan mode classifies as code or network is refused.
    const table = planModeMutatingTable()
    const codeRows = Object.entries(table)
      .filter(([, kind]) => kind === "network_write")
      .map(([n]) => n)
    expect(codeRows.filter((n) => Object.hasOwn(DENY_ALL_PERMITTED_TOOLS, n))).toEqual([])
  })
})

describe("deny-all posture — the guard is on the base the runners capture", () => {
  const prevKey = process.env.OPENAI_API_KEY
  afterEach(() => {
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = prevKey
  })

  test("RED (round 10): a restrictive mode's base carries the guard before delegation captures it", () => {
    process.env.OPENAI_API_KEY = "sk-test-not-used-no-network"
    const base = buildBaseFromArgs({
      mode: "batch",
      dials: {},
      delegateModes: ["explore"],
    } as never)
    expect(base.delegation, "fixture: delegation was requested").toBeDefined()
    expect(base.dispatchGuard?.check("web_search", { query: "q" }).kind).toBe("deny")
  })

  test("PAIRED CONTROL: an open-network mode's base carries no guard", () => {
    process.env.OPENAI_API_KEY = "sk-test-not-used-no-network"
    const base = buildBaseFromArgs({ mode: "interactive", dials: {} } as never)
    expect(base.dispatchGuard).toBeUndefined()
  })
})
