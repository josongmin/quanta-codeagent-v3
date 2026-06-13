# jun-13 — Codex IDE + Desktop 3808 재흡수 백로그 (master board)

**Date:** 2026-06-13
**Goal:** 최신 설치 빌드(Codex Desktop 3808, **신규 Codex IDE 확장**, Claude Code IDE 2.1.170)를 코퍼스로 재추출하고, 5-에이전트 병렬 적대어딧으로 신규 기능·메커니즘을 전수 인벤토리화 → quanta 대비 코드검증된 갭만 추려 우선순위 백로그로 묶는다.
**Corpus:** `.extracted_source/` — `codex/`(3808), **`codex-ide/`(NET-NEW)**, `claude-code-ide-2.1.170/`, 디프베이스 `codex_3390_prev/`. 상세 [REFRESH-DIFF-2026-06-13.md](../../.extracted_source/REFRESH-DIFF-2026-06-13.md), [codex-ide/INVENTORY.md](../../.extracted_source/codex-ide/INVENTORY.md).
**Discipline (모든 티켓):**
- default-OFF byte-identical: 신규 기능은 `QUANTA_*` 게이트(@/shared `gateOn`/`gateDisabled` SSOT), 게이트 off면 기존과 바이트동일.
- TDD red-first + hellgate red-on-injection. e2e는 실 seam 관통.
- knob home 분기: host-gate는 `knob-inventory.ts`, runtime-config 소비는 `runtime-config-knobs.ts` (혼동 시 [[knob-config-systems-inventory]] 먼저 grep).
- claim-100 ⇒ ≥3R 적대어딧. **이 백로그 자체가 그 교훈의 산물**(아래 §정정 참조).
- false-gap 방지: 갭 주장 전 broad-grep(synonym 포함), narrow-symbol 1건으로 부재 단정 금지.

---

## 0. 🔴 1차 결론 정정 (왜 이 백로그가 신뢰 가능한가)

1차 패스에서 두 가지를 **틀리게** 단정했고, 병렬 적대어딧이 잡았다. 기록으로 남긴다.

| 1차 (틀림) | 검증 후 (정정) | 적발 방법 |
|---|---|---|
| "Codex Desktop 3390→3808은 점진뿐, 새 능력 없음" | **신규 기능 패밀리 15개+** (토큰레벨 diff: 신규 dotted key ~874 / camelCase ~1429) | 키워드 **파일-카운트** diff가 너무 뭉툭 → **토큰레벨** diff로 전환 |
| external-agent import / per-thread heartbeat = quanta 갭 | **둘 다 FALSE-GAP** (이미 LIVE) | quanta src broad-grep 적대검증 |

교훈: ① 콘텐츠-해시 빌드는 파일-리스트/카운트 diff 금지, **심볼/토큰 diff 필수**(REFRESH-DIFF-2026-06-01이 이미 경고했던 함정 재발). ② 흡수 후보는 반드시 quanta src에서 synonym broad-grep으로 false-gap 거른 뒤 올린다.

---

## 1. 버전 델타 (설치 vs 코퍼스)

| 항목 | 코퍼스 | 설치/추출 | 조치 |
|---|---|---|---|
| Codex Desktop | 3390 / 26.527 | **3808 / 26.609.30741** | 재추출(`codex/`), +`.vite/build` 메인프로세스(이전엔 누락) |
| Codex IDE ext (`openai.chatgpt`) | *없음* | **26.5609.30741** (codex-rs 0.140.0-alpha.2) | **NET-NEW** `codex-ide/` |
| Claude Code IDE ext | 2.1.167 | 2.1.170 | refresh; manifest 동일하나 코드 변경(§7) |
| Cursor / Claude Desktop / Codex CLI | 3.5.33 / 1.0.734 / 0.133 | 동일 | skip |

추출 메서드: asar는 npm 설치 막혀서 `node` 직접 파서(`/tmp/asar-extract.js`); js-beautify 없어 **biome format** 사용. node_modules 제외, 네이티브 바이너리는 `strings` 덤프만.

---

## 2. 신규 기능 전수 인벤토리 (테마별)

현황: ❌갭 · 🟡부분 · ✅이미있음. ROI 높은 순으로 §3에서 티켓화.

### 2.1 에이전트 제어·관측
| 기능 | 설명·증거 | quanta 현황 | 흡수 포인트 |
|---|---|---|---|
| `item/*` fine-grained 스트리밍 | `item/started→completed` + typed delta(reasoning text/summary, command output, file patch, plan, mcpToolCall progress) — codex-ide app-server | 🟡 SessionEvent 거침 | **T01** |
| `thread-follower` co-control | 보조 클라이언트가 스레드 공동조종: steer/interrupt-turn, edit-last-user-turn, load-history, approval relay — 전부 request/response/**timeout** | 🟡 thin-client 있으나 follower 없음 | **T02** |
| follow-up queue modes `queue\|steer\|interrupt` | in-flight 턴 큐잉/조종/인터럽트, per-msg invert 핫키 | 🟡 inbound 3-mode 유사 | T02 포함 |
| `collab_*` subagent lifecycle 이벤트 | spawn/interaction/waiting/resume begin·end | 🟡 multi-agent 있으나 vocab 미정 | T01 연계 |

### 2.2 권한·승인·샌드박스
| 기능 | 설명·증거 | quanta 현황 | 흡수 포인트 |
|---|---|---|---|
| `guardian_subagent` 자동승인 reviewer | 승인을 LLM 서브에이전트에 위임(`approvalsReviewer`=user\|agent), `item/autoApprovalReview/*` 스트림 | ❌ 없음 | **T03** |
| approval ladder (명명 6단) | read-only→auto→granular→guardian-approvals→full-access→custom | 🟡 모드 있으나 사다리 아님 | T03 포함 |
| hooks `needsReview` 신뢰게이트 | imported/project hook 활성 전 review, `source∈{user,admin,project,sessionFlags}` | ❌ 없음 | **T04** |
| per-site 브라우저 권한 + full-CDP 게이팅 | site별 allow/deny, allowedFullCdpOrigins, multi-tab | 🟡 browser-use 있으나 게이팅 약함 | 후순위 |

### 2.3 자동화·스케줄
| 기능 | 설명·증거 | quanta 현황 | 흡수 포인트 |
|---|---|---|---|
| per-thread heartbeat automation | targetThreadId 바인딩 반복 프롬프트, thread당 1개 | ✅ `src/scheduler/heartbeat.ts` | — false-gap |
| rrule cron automations | iCalendar RRULE + 자체 model/effort/cwd + per-automation 권한, SQLite 영속 | 🟡 cron 변형 있음 | 후순위(posture 보강) |

### 2.4 도구 surface
| 기능 | 설명·증거 | quanta 현황 | 흡수 포인트 |
|---|---|---|---|
| LSP-as-MCP 브릿지 | `vscodeDiagnostics/References/WorkspaceSymbols`를 MCP 툴로 CLI 에이전트에 노출 | 🟡 MCP서버 O, LSP는 client 전용 | **T06** |
| MCP form elicitation | MCP 서버가 대화 중 구조화 폼 입력 요청 | 🟡 elicitation 일부 | 후순위 |
| skill recording + marketplace | 스킬 녹화(`recordSkill` 0→88)+마켓 | 🟡 skill 강함, 녹화/마켓 없음 | 후순위(녹화만 ROI) |
| raw CDP 브라우저 툴 | `cdp/tab_cdp_call/events`, 로컬 IPC 소켓, per-origin allow | 🟡 browser-use 있음 | 후순위(보안게이트 필수) |
| MCP-Apps 위젯 샌드박스 (Apps SDK) | MCP 툴이 격리 iframe에 인터랙티브 위젯, MessagePort 전송 | ❌ 없음 | 후순위(Tauri면 ROI↑) |

### 2.5 worktree·원격 실행
| 기능 | 설명·증거 | quanta 현황 | 흡수 포인트 |
|---|---|---|---|
| pending-worktree 상태머신 + snapshot | create/retry/continue/cancel/dismiss + prepare/upload-snapshot, move-thread-to-{worktree,host,local} | 🟡 dispatch 강함, 상태머신 없음 | 후순위 |
| SSH-remote app-server | unix소켓 + `codex app-server proxy`로 원격 호스트 구동 | ❌ 로컬 전용 | 후순위 |
| WSL 실행 / cloud remote-control / worktree worker-thread | Windows WSL, device-key 클라우드 환경, 워커스레드 분리 | ❌/🟡 | 낮음 |

### 2.6 마이그레이션·통합·IDE
| 기능 | 설명·증거 | quanta 현황 | 흡수 포인트 |
|---|---|---|---|
| VS Code `chatSessions` provider | 네이티브 Agent Sessions API 등록, thread→ChatSessionItem(status), Copilot inference 백엔드 | ❌ **확정갭**(contributes/chatSessions repo에 0) | **T07**(전략) |
| external-agent import 분류체계 | claude-code/cowork서 CONFIG/AGENTS_MD/SKILLS/COMMANDS/SUBAGENTS/HOOKS/PLUGINS/MCP import | ✅ `src/migration/`(transcript+config) | — false-gap |
| per-hunk diff accept/reject | 에디터서 hunk 단위 수락/거부(`acceptProposedDiff`/`rejectProposedDiff`) | 🟡 diff 렌더+whole-call approve/deny만 | **T05** |
| hooks 10 이벤트 + per-hook model | preToolUse/permissionRequest/.../stop; per-hook model override | 🟡 command-hooks O, model·신뢰게이트 ❌ | **T04** |
| conversationEditor / code lens / addToThread | task=에디터 탭, TODO 렌즈, 선택영역 컨텍스트 주입 | 🟡 mention-injection 있음 | T07 의존 |

### 2.7 codex-rs 0.140 코어 (대체로 점진)
| 기능 | 설명·증거 | quanta 현황 | 흡수 |
|---|---|---|---|
| `ext/{goal,image,skills,mcp}` 확장크레이트 | 기존 기능을 플러그블 크레이트로 분리(리팩터) | 🟡 슬라이스 구조 | 낮음(참고) |
| `cloud_config` 엔터프라이즈 거버넌스 | 서명+JWKS검증 config 번들, enterprise_requirements | ❌ | 낮음 |
| `SpendControl` 한도 / `responses_lite` 전송 / code_mode delegation | 지출한도, 경량 Responses API, code-mode 서브에이전트 위임 | 🟡 budget/code-mode 있음 | 낮음~중(delegation) |

### 2.8 상용·코스메틱 (참고용, 낮은 ROI — surface 가용성 게이팅 금지)
문서/PPT/시트/사이트 authoring(이미 Office 슬라이스 O), appgen 공유모델, realtime voice/avatar overlay, Codex Mobile(+MFA), 대화내 PR/git-checks fix(🟡 PR bot O), rate-limit/pricing, unified search/archived chats, background subagents(🟡 side-agent O).

---

## 3. 우선순위 백로그 (티켓)

확정갭 + 고ROI만. 각 티켓은 코드검증된 quanta 앵커 + default-OFF 게이트 + TDD/hellgate 규율.

> **구현 프롬프트:** [`prompts/T01~T08-prompt.md`](prompts/) — 각 티켓을 **헬게이트 프로토콜**(메모리 `hellgate-implementation-protocol`: 헬게이트 RED e2e셋업 → TDD+구조구현 → 적대어딧≥3R → 셀프어딧 → 구조적TDD보완)로 수행하도록 작성. 핵심 유즈케이스를 RED e2e로 명시.

| # | 티켓 | 현황 | ROI | 근거 |
|---|---|---|---|---|
| [T01](01-item-level-streaming.md) | `item/*` fine-grained 스트리밍 프로토콜 | 🟡 | ★★★ | 북극성 agent-state 가시성 직결 |
| [T02](02-thread-follower-cocontrol.md) | `thread-follower` co-control + queue modes | 🟡 | ★★★ | CLI↔web parity·mid-turn-channel SOTA 답 |
| [T03](03-guardian-auto-approval-reviewer.md) | `guardian_subagent` 자동승인 reviewer + approval ladder | ❌ | ★★ | 무인-but-안전 실행, HITL 4-verb 확장 |
| [T04](04-hooks-trust-gate-and-model.md) | hooks 신뢰게이트(`needsReview`) + per-hook model | ❌ | ★★ | 보안갭 + 기능갭 |
| [T05](05-per-hunk-diff-accept-reject.md) | per-hunk diff accept/reject | 🟡 | ★★ | 입자도 갭, diff-ops 위 |
| [T06](06-lsp-as-mcp-bridge.md) | LSP-as-MCP 브릿지 | 🟡 | ★★ | IDE 없이 코드 인텔리전스 |
| [T07](07-chatsessions-editor-extension.md) | VS Code `chatSessions` 에디터 확장 | ❌ | ★(전략) | 에디터 surface 자체 부재 |
| [T08](08-model-refusal-recovery.md) | model-refusal 복구(fork+re-prompt) | ❌ | ★★ | CC IDE 2.1.170 신규; quanta는 terminal error만 |

### 티켓 안 만든 후순위 꼬리 (의식적 defer — silent cap 아님)
(기능)+(왜 defer)+(ROI). 승격 필요하면 별 티켓화.

| 기능 | 왜 defer | ROI |
|---|---|---|
| per-site 브라우저 권한 + full-CDP 게이팅 | browser-use 기반 있음, 보강 성격; raw CDP 도입과 묶어야 효율 | 중 |
| raw CDP 브라우저 툴 | 보안 게이트(per-origin) 선결 + browser-use surface 의존 | 중 |
| rrule cron posture 보강 | cron 변형 이미 LIVE, per-automation posture만 갭(증분) | 중 |
| MCP form elicitation | elicitation 일부 있음, 폼 입력은 증분 | 중 |
| skill recording | skill 시스템 강함; 녹화 UX만 신규(마켓은 인프라 과투자) | 중 |
| MCP-Apps 위젯 샌드박스 | 인터랙티브 tool-UI; Tauri surface 성숙 후 ROI↑(지금은 조기) | 중(나중) |
| pending-worktree 상태머신 + snapshot | worktree dispatch 견고함, 상태머신은 robustness 증분 | 중 |
| SSH-remote app-server / cloud remote-control | 로컬 전용 철학, 원격 fabric은 큰 결정 | 낮~중 |
| user_dialog_request redelivery (CC 2.1.170) | crash-resume reinject 일부 커버(🟡); 승인-request 특정 redelivery만 갭 | 낮~중 |
| codex-rs 0.140 코어(ext crates/cloud_config/SpendControl/responses_lite) | 점진/엔터프라이즈; quanta 슬라이스 구조·budget 이미 유사 | 낮 |
| 상용·코스메틱(§2.8: appgen 공유/voice/avatar/mobile/pricing) | surface·상용 결합, 메커니즘 흡수가치 낮음 | 낮 |

---

## 4. 코드검증된 갭 매트릭스 (false-gap 방지 적대검증 결과)

| 주장 갭 | 판정 | quanta 증거(file:line) |
|---|---|---|
| 인라인 per-hunk diff accept/reject | 🟡 PARTIAL | `src/apps/cli/diff-preview.ts`(렌더)+`src/protocol/session/commands.ts:42`(`ApprovalRespondCommand` decision=approve\|deny, whole-call); per-hunk 없음 |
| chatSessions / 에디터 확장 패키지 | ❌ CONFIRMED | repo 전체 `contributes`/`engines.vscode`/`chatSessions` 0; `src/apps/agent/mode-presets/ide.ts`("어댑터는 repo 밖") |
| app-server 외부 에디터 트랜스포트 | 🟡 PARTIAL | `src/ipc/session/index.ts`(stdio/WS transport)+`src/protocol/session/`(session.v1) 있으나 외부 에디터용 app-server 진입점 미배선; 소비자=web-daemon |
| external-agent import | ✅ FALSE-GAP | `src/migration/importer.ts:124`(jsonl)+`src/migration/external-config/types.ts`(config) |
| LSP-MCP | 🟡 PARTIAL | `src/mcp/server.ts`(MCP서버 O)+`src/lsp/`(client 전용); 브릿지 ❌ |
| per-thread heartbeat | ✅ FALSE-GAP | `src/scheduler/heartbeat.ts`(targetThreadId, thread당 1개)+`src/scheduler/runtime.ts:244` |
| hooks per-hook model | ❌ CONFIRMED | `src/agent/command-hooks/types.ts`(`CommandHookBinding={event,matcher,command}`, model 없음) |

---

## 5. Claude Code IDE 2.1.170 행동 변화 (manifest 동일, 코드만)
- **`model_refusal_fallback`** — 거부 턴 fork/중립화 후 `refusal_fallback_prompt` 재프롬프트 (신뢰성, 흡수 ROI 상)
- **`user_dialog_request` + pending 재전달** — initialize 시 미해결 권한요청 redelivery + auto_cancel
- `suppressControlResponse` 프리미티브, `get_usage` request, `claude-community`/`claude-plugins-community` 마켓 allowlist
- → T03/T02 검토 시 참조. refusal-fallback은 별도 소형 티켓 후보.

## 6. codex-rs 0.140 코어 판정
점진-plus. 새 도구/샌드박스모드/모델 없음. 실질 델타 = `ext/` 크레이트 리팩터 + `cloud_config`·`SpendControl`·`responses_lite` 신규 서브시스템 + code_mode delegation + remote-control pairing 성숙. 흡수 우선순위 낮음.

## 7. 함정·교훈 (착수 전 숙지)
1. **콘텐츠-해시 빌드 diff는 토큰레벨로** — 파일-카운트는 churn에 묻힘(이번 1차 오판 재발, 2회째).
2. **흡수 후보 = quanta synonym broad-grep으로 false-gap 거른 것만.** (이번 2건 적발)
3. **surface 가용성으로 흡수 ROI 게이팅 금지**([[surface-model]]) — 메커니즘은 기존 surface(CLI/Web-Tauri)나 thin 확장으로 흡수 가능.
4. **app-server는 mutation/steering용 typed channel, slash.run 재발명 금지**([[jun-09-cli-web-parity-plan-and-existing-mechanism]]) — T02는 control-request/session verb 위에.
5. 신규 도구 풀배선 라쳇(zero-unwired) 준수; manifest 단독 owner.

## 8. 통합 시밍 SSOT (각 티켓 통합 계획의 공통 앵커)

설계 전 grep 필수([[knob-config-systems-inventory]]) — 한 세션 재발명 방지. 실측 확인된 경로:

| 축 | SSOT 위치 | 규율 |
|---|---|---|
| **LLM 도구** | `src/tool/surface/manifest.ts` (BASE 무게이트 / GATED `{gate, per-surface default}`) | two-way drift guard `tests/unit/tool-surface-manifest-hellgate.test.ts` — 등록 도구↔manifest 행 양방향 일치. fc(기능축)와 별개([[tool-surface-ssot]]) |
| **knob** | `src/config/knob-inventory.ts` `{envKey:QUANTA_*, kind, default, group, home, describe, readSite}`; home∈runtime-config/runner-knobs/bench | **orphan ratchet** `tests/unit/knob-registry-completeness-ratchet-hellgate.test.ts` ORPHAN_CEILING=0 — 모든 QUANTA_* read는 readSite 등록 必. 게이트 on/off는 @/shared `gateOn`/`gateDisabled` SSOT |
| **CLI 통합** | `src/apps/cli/slash/registry-session.ts`(세션) / `registry-app.ts`(앱) | slash.run 재발명 금지; 도구는 surface-무관(레지스트리 공통) |
| **Web 통합** | `src/protocol/agent-state/projection.ts`(9-event subset push) + `src/apps/web-daemon` | **별도 web-frontend 없음** — web = daemon + agent-state 채널. mutation은 control-request(ADR-0496), readout은 out-of-band |
| **config** | `src/config/types.ts`(`HooksSettings`/`HookGroupSetting` 등) + `loader.ts`/`merge.ts`; layer=managed/project/user | capability-granting 키는 trust-gated. 신규 config 키는 기존 layer 모델 위에 |
| **트랜스포트** | `src/ipc/session/index.ts`(stdio/WS) + `src/protocol/session/`(session.v1) | canonical boundary=SessionProtocol(NOT AgentEvent); additive versioning |

**티켓별 통합 무게중심:** T06=LLM도구(manifest) · T04=config(types.ts hooks) · T01=Web(projection) · T02=CLI+Web(transport/verb) · T03=config(ladder preset)+승인UI · T05=CLI+Web(diff-ops) · T07=신규 surface(코어 무결합).
