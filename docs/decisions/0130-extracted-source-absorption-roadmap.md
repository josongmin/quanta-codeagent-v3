# ADR-0130 — Extracted-source absorption roadmap (R1–R6 → ADR 후보 catalog)

- **Status**: Proposed (2026-05-24, roadmap only — individual ADRs are 0131+)
- **Related**: [[extracted-source-novel-findings-2026-05-24]] (memory, 30-병렬 누적 결과), [[agent-analysis-corpus]] (코퍼스 위치), [[no-heuristics-only-validated]] (모든 흡수는 검증된 신호 기반)
- **References**: `/.extracted_source/` 100MB+ corpus (Claude Desktop / Codex Desktop / Cursor / Claude Code CLI / Codex CLI / userdata) — all source paths anchor under this prefix

## Problem

R1–R6 6-round, 30-병렬 agent 탐색으로 `.extracted_source/` (Cursor 3.2.16 187MB + Codex Desktop build 2867 160MB + Claude Desktop 1.7196.3 18MB + Claude Code CLI Mach-O strings 23MB + Codex CLI 5.7MB + userdata 105MB)에서 **43건 Tier-S + 50+ Tier-A + 60+ Tier-B + 29건 메모리 정정** 발견. 모두 [[extracted-source-novel-findings-2026-05-24]]에 keyword·usecase·why·source-path로 색인됨.

이제 흡수 결정이 필요. 43건을 모두 ADR로 만들면 noise이고, 우선순위 없이 두면 잊혀짐. 따라서 (a) 전체 catalog를 ADR 후보로 한 단위 정리 + (b) 가장 즉시 가치 있는 Top 5를 별도 ADR proposal로 분리.

## Decision

`.extracted_source/` 흡수를 **3 tier × 4 theme = 12 wave**로 패키징.

### Wave priority matrix (post-2026-05-24 verification)

| Wave | Theme | ADR # | 흡수 형태 | 우선순위 | 코드 검증 결과 |
|---|---|---|---|---|---|
| **W1** | Memory hygiene seam | **0131** | 4-state outcome enum + preference phrase grammar + stage1→phase2 pipeline | P0 (즉시) | PARTIALLY-NEEDED (ADR-0068 Wave A foundation HIT, outcome enum + 10% gate 추가) |
| **W2** | Autonomous reactor | **0132** | SIMULATED_MSG_REASON + cloud-agent branch snapshot 사다리 | P0 (paradigm shift) | **FULLY-NEEDED** (0%, `src/reactor/` 미존재) |
| **W3** | Hook bidirectional RPC | **0133** | 6-hook Request/Response paired + prompt_hook injection | P0 (기존 hook 자연스러운 superset) | **FULLY-NEEDED** (현 5-event 단방향) |
| **W4** | Skill 7-scope tiering | **0134** | builtIn/system/admin/team/repo/user/personal + 10% phase2 promotion | P1 (enterprise 진출) | **FULLY-NEEDED** (현 implicit 2-tier) |
| **W5** | Permission + sandbox 2-layer | **0135** | permission_profile + file_system_sandbox_policy + 4-pillar permission | P1 (security primitive) | PARTIALLY-NEEDED (PermissionStack ADR-0046 HIT, layer/pillar/scope 추가) |
| W6 | Retrieval SOTA stack | (TBD) | reranker + 4 token bucket re-chunk + commit embedding + 8-vendor LLM (BM25 + hybrid 이미 있음) | P2 (downgrade) | PARTIALLY-NEEDED (BM25 + hybrid HIT, reranker/chunk/commit MISS) |
| W7 | Connectors REST API | (TBD) | `/aip/connectors` dynamic registry + OAuth discovery + per-host availability | P2 | **FULLY-NEEDED** (현 MCP는 static stdio) |
| W8 | Scheduled agent | (TBD) | RRULE + Weekday nth-occurrence + thread destination + model reroute | P2 | **FULLY-NEEDED** (현 one-shot background only) |
| ~~W9~~ | ~~Composer UX completeness~~ | — | — | **REDUNDANT for CLI surface** | CLI surface가 attachment/dropdown/card UI 차단. wire layer만 의미 있음 — 그건 W3 (hook RPC) 안에서 자연 해결. **Drop from active backlog** |
| ~~W10~~ | ~~Typed proto RPC migration~~ | — | — | **REDUNDANT** | 우리 typed-envelope (`quanta.ipc.v1` + discriminated union + zod + deterministic encoding)이 이미 protobuf 동등 superset. **Drop from active backlog**, ADR-0023 + R7 ADR-0072 ([[may-21-codex-r7-sota-plus-plus]])으로 cover됨 |
| W11 | Plugin process isolation | (TBD) | DXT UtilityProcess.fork + MessageChannelMain (Claude pattern) | P3 (desktop 진출 시) | PARTIALLY-NEEDED (escalatingKill 2s grace HIT, UtilityProcess/MessageChannel 0%) |
| W12 | Misc multi-cloud + OAuth lock | (TBD) | Bedrock/Vertex/Foundry/Mantle + Redis OAuth refresh lock + mid-session GitHub token rotate | P3 (enterprise 후) | unverified (별도 round) |

**검증 후 갱신 (2026-05-24)**:
- W6 retrieval downgrade P1 → P2 (BM25 foundation 이미 우수, marginal stack)
- W9 / W10 모두 **REDUNDANT** — drop from active backlog (이유는 위 표)
- 활성 backlog: W6 W7 W8 W11 W12 = 5 (was 7)
- ADR 0131 / 0135 PARTIALLY-NEEDED — scope 축소 가능 (foundation 안 다시 짤 필요 없음)

### 즉시 ADR proposal (이 roadmap과 함께)

- **[0131-memory-outcome-and-preference-grammar.md](0131-memory-outcome-and-preference-grammar.md)** — W1
- **[0132-autonomous-proactive-reactor.md](0132-autonomous-proactive-reactor.md)** — W2
- **[0133-hook-bidirectional-rpc.md](0133-hook-bidirectional-rpc.md)** — W3
- **[0134-skill-scope-tiering.md](0134-skill-scope-tiering.md)** — W4
- **[0135-permission-sandbox-two-layer.md](0135-permission-sandbox-two-layer.md)** — W5

### 의식적으로 흡수 안 함 (Negative invariants)

다음은 Tier-S에 있어도 우리 surface model([[surface-model]])과 맞지 않거나 ROI 낮아 흡수 안 함:

1. **Cursor Popcorn-style 발표/spreadsheet/document 4 채널** — Codex는 Notion+Figma 하이브리드로 진화 중. quanta는 "code agent" 정의 유지 (코드 + 도구 호출 + verify). 4 채널은 product surface 폭증, ROI 낮음.
2. **Codex Chronicle (화면 캡처 컨텍스트)** — 메모리 [[no-heuristics-only-validated]]와 충돌 (검증 어려운 신호로 추측 강화). 데스크톱 진출 후에도 보류.
3. **Cursor BugBot AUTOFIX_MODE 자동 머지** — auto-merge는 우리 verify discipline와 충돌. PR 자동 생성까지는 W7과 W2 시너지로 가능하지만 머지까지는 ban.
4. **Codex 8 user role onboarding** — quanta는 single-user 가정. Enterprise 진출 후에도 segmentation 직접 흡수는 보류.
5. **Codex Popcorn shared protobuf codec** — 우리 IPC는 typed-envelope ([[may-21-codex-r7-sota-plus-plus]]) 자체로 충분. Codex Popcorn codec 흡수 시 schema 폭증.
6. **Claude DXT extension blocklist 메커니즘** — plugin allowlist는 [[codex-plugin-manifest-pattern]]와 우리 system으로 충분. blocklist는 over-engineering.
7. **Cursor 22 proposed VSCode API** — quanta는 VSCode fork 아님. multi-surface ([[surface-model]]) 시각으로 우회.

## Invariants preserved (전체 wave)

모든 ADR 0131–0135 (그리고 후속 W6–W12)은 다음을 보존:

1. **[[no-heuristics-only-validated]]**: 모든 흡수는 .extracted_source의 검증된 신호 (file:line anchor)에 기반. 메모리 추측 금지.
2. **[[surface-model]]**: ROI를 surface-가용성으로 게이팅하지 않음 — 데스크톱-only 기능도 CLI에 우선 wire 후 후속 surface 확장.
3. **byte-identical invariant** ([[codex-absorption-complete]]): 흡수 후에도 기존 byte-identical replay 보장. 새 기능은 default-OFF seam으로.
4. **closed-port discipline** ([[branch-search-adr0083]]): 모든 신규 wire는 closed-port → unit → integration 순서.
5. **smoke battery 회귀 0** ([[smoke-fixture-system]]): 흡수 후 `tests/smoke/` 전체 pass 필수.

## Tradeoffs

- **5 ADR 동시 proposal은 큰 양** — 한꺼번에 다 implement 의도 아님. P0 3개 (0131/0132/0133) 우선, P1 2개 (0134/0135)는 next sprint, P2/P3는 backlog.
- **흡수 후 우리 surface 변화**: W2 (autonomous reactor)는 가장 큰 paradigm shift — CI/PR 외부 trigger로 self-wake. 검증 어려움(시간 의존). W2는 careful staging 필요.
- **typed-envelope vs protobuf** (W10): 우리 typed-envelope는 TypeScript-native, Cursor는 protobuf. W10은 큰 작업이고 backward compat 신중. P3로 deferred.
- **컴파일/번들 도구**: 흡수 코드 일부는 Rust (Codex CLI), Swift (ChatGPT Atlas), Electron native (Claude DXT). 우리는 Bun + TypeScript. 일부 패턴 직접 차용 불가 — 개념만 흡수.

## Out of scope (deferred)

- **R7+ deeper探索**: R6에서 saturation 신호 부분적. 더 캐도 marginal ROI. 흡수 사이클 한 번 돌고 (0131–0135 implement) 다음 라운드 결정.
- **Anthropic SDK 진입 path 추가 분석**: [[anthropic-sdk-in-codex]] 메모리에 이미 정리 (Codex 본체 호출 안 함, Sentry hook). 추가 캐기 ROI 없음.
- **Codex Popcorn proto codec import** — 위 negative invariant 5에 따라 의도적 배제.
- **R6 memory 정정 29건의 개별 ADR화**: 정정은 [[extracted-source-novel-findings-2026-05-24]] 메모리에 이미 반영. 별도 ADR 불필요.

## References

- Memory: [[extracted-source-novel-findings-2026-05-24]] 전체 — 43 Tier-S + 50+ Tier-A + 60+ Tier-B 색인
- 코퍼스 진입점: `/.extracted_source/{claude,codex,cursor,claude-code-cli,codex-cli,userdata}/INVENTORY.md`
- 6 라운드 30-병렬 agent log: 이 conversation의 R1–R6 boundary
