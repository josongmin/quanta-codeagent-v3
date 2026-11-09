# Documentation

[Project overview](../README.md) · [Quick start](../README.md#quick-start) · [Source tree](../src/)

Find the right entry point for running, extending, and understanding Quanta CodeAgent v3. Operational guides, design contracts, and verification references are listed separately from historical research and implementation plans.

## Getting started

| Goal | Reference |
| :--- | :--- |
| Install and run the CLI | [Quick start](../README.md#quick-start) |
| Configure credentials and environment | [Environment example](../.env.example) |
| Understand the system | [Architecture guide](ARCHITECTURE.md) · [Design RFC](../rfc/0001-architecture.md) |
| Trace execution and recovery | [Agent-loop operational reference](runbooks/agent-loop-reference.md) |
| Check feature maturity and evidence | [Feature catalog](10.feature-catalog.md) |

## Surfaces & integrations

| Area | Documentation or source |
| :--- | :--- |
| Terminal | [CLI entry point](../src/apps/cli/index.ts) — `bun run start --help`, or `/help` inside a session |
| Web | [Daemon](../src/apps/web-daemon/README.md) · [Frontend](../apps/web-frontend/README.md) |
| macOS desktop | [Tauri shell](../apps/tauri-shell/README.md) · [Sidecar builds](../apps/tauri-shell/binaries/README.md) |
| SDK | [Usage guide](plans/jul-4-sdk-embed-dx/USAGE.md) · [Public exports](../src/sdk/index.ts) |
| VS Code | [Editor surface](../surfaces/vscode/README.md) |
| GitHub | [Integration guide](integrations/github/README.md) |
| Custom tools | [Tool authoring](tool-authoring.md) |

## Architecture & contracts

| Question | Start here |
| :--- | :--- |
| How are dependencies between slices constrained? | [Architecture and ports & adapters](ARCHITECTURE.md) |
| Why was a design chosen? | [Architecture decision records](decisions/README.md) |
| Where are the session and event contracts? | [Protocol](../src/protocol/) · [SDK](../src/sdk/) |
| Where are permissions and approvals enforced? | [Permission policy](../src/permission/) · [Execution runtime](../src/runtime/) |
| How are memory and sessions stored? | [Memory](../src/memory/) · [Sessions](../src/session/) |
| How is feature documentation maintained? | [Catalog workflow](../tools/feature-catalog/README.md) · [Reading the catalog](feature-catalog-explained.md) |

## Testing & evaluation

| Goal | Reference |
| :--- | :--- |
| Understand test organization and execution | [Test guide](../tests/README.md) · [Naming conventions](test-naming.md) |
| Inspect verification tiers and gates | [Gate manifest](../tools/dev/gate-manifest.ts) — `bun run gates:list` |
| Run SWE-bench smoke scenarios | [Pinned data and reproduction guide](../tests/smoke/swebench/README.md) |
| Run remote SWE-bench evaluations | [EC2 runbook](swebench-ec2-runbook.md) |
| Use Terminal-Bench | [Adapter guide](../adapters/terminal-bench/README.md) |
| Inspect trajectories | [Viewer source](../tools/trajectory-viewer/) |

Interpret results with their commit, configuration, toolchain, dataset, and execution conditions. Focused test results, full product verification, patch generation, and official harness grading establish different kinds of evidence.

## Contributing

1. Read the [repository rules](../AGENTS.md) and inspect the current worktree.
2. Read the owning source, its consumers, and its tests before editing.
3. For feature changes, update the [catalog YAML](../tools/feature-catalog/features/), then run `bun fc validate` and `bun fc build`.
4. Do not edit the generated `10.feature-catalog.md` directly.

## Research & planning archive

These directories contain historical designs, experiments, investigations, and unfinished plans. Confirm current behavior against the source and its verification evidence.

| Material | Location |
| :--- | :--- |
| Design proposals | [Original RFCs](../rfc/) · [Documentation RFCs](rfc/) · [Additional RFCs](rfcs/) |
| Implementation plans and tickets | [Plans](plans/) · [Tickets](tickets/) |
| Evaluation and analysis | [Analysis](analysis/) · [Evidence](evidence/) |
| Claude-related research | [Research notes](reviews-claude-agent/) |
| Codex-related research | [Research notes](reviews-codex-agent/README.md) |
| Work records | [Journal](journal/) · [Handoff](handoff/) |

This index is a navigation guide. Catalog YAML remains the source of truth for feature maturity; individual documents retain their own dates and completion status. Linked historical documents may be written in Korean.
