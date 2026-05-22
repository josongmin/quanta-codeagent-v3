# Cursor 3.2.16 — Audit Corrections (Evidence-Based Hallucination Review)

> [cursor.md](cursor.md) / [cursor-localization.md](cursor-localization.md) / [cursor-repomap.md](../code-agent-suit/cursor-repomap.md)에 있는 모든 구체 claim(protobuf 필드 번호 / enum 값 / RPC 이름 / verbatim 템플릿 / 심볼)을 3개 병렬 agent로 직접 grep+strings 재검증. **압도적 다수는 ✅ verified**, 하지만 **22개 명확한 ❌ correction + 10개 ★ 신규 발견 + 4개 ❓ unverifiable** 적출. 이 문서가 patch source-of-truth.

## 0. 검증 결과 요약 (높은 수준)

| 검증 그룹 | 검증된 항목 수 | ❌ wrong | ⚠️ partial | ❓ unverifiable |
|---|---|---|---|---|
| Wire protocol (oneof 멤버·필드#·enum) | ~200 | 6 | 4 | 1 |
| RPC 인벤토리 (서비스·메서드·엔드포인트) | ~85 | 4 | 1 | 0 |
| Localization (구조·심볼·디스크) | ~50 | 3 | 4 | 1 |
| Verbatim 템플릿 문자열 | ~25 | 4 | 5 | 0 |
| Hook / AI tracking / corpus | ~25 | 1 | 1 | 2 |
| **합계** | **~385** | **18** | **15** | **4** |

→ **검증된 claim 비율 ~95%**. 그러나 14% 정도(18+15+4=37)에 정확도 문제 있음 — 일부는 namespace 오타급, 일부는 *spirit-correct but literal-wrong*, 일부는 진짜 hallucination.

## 1. ★ 가장 중요한 정정 5개 (의사결정에 영향)

### 1.1 ❌ "symbolic-link 탈옥 방어 deny" 증거가 틀렸다 (영향: P0 흡수 #1)
- **이전 claim** (cursor-repomap.md §7, cursor.md §2H, P0 흡수 시사): `cursorsandbox` Rust 바이너리에 `"found symlink in .git/hooks"` 같은 preflight symlink 탐지 문자열이 있고, `.git/hooks`/`.git/config`/`.vscode`/`.cursor` write deny가 sandbox 프로파일에 박혀있다.
- **실제 검증**: ❌ NAPI strings에 `"found symlink in .git/hooks"` 0건. `.git/hooks` 서브스트링 자체 NAPI 0건. 실제 보이는 건 `.git/logs/HEAD`, `.git/index` 같은 **file event ignore 필터** 문자열뿐 — 이건 watcher 무시 패턴이지 sandbox deny 아님.
- **의미**: "symbolic-link 탈옥 방어 deny" Cursor가 *그 형태로* 한다는 증거 없음. **P0 흡수 #1 (quanta dispatch seam에 `.git/hooks` write 정적 deny)은 여전히 좋은 아이디어**지만 *Cursor를 근거로* 제시할 수 없음. quanta 자체 보안 결정으로 재포지셔닝 필요.
- **patch 필요**: cursor.md / cursor-localization.md / cursor-repomap.md에서 "symlink 탈옥 방어" 부분 삭제 또는 "Cursor 미관측"으로 재표기.

### 1.2 ❌ ClientSideToolV2 "63 values" → 실제 **53 entries** (sparse 0,1,3,5-9,11,12,15,16,18,19,23-35,38-63)
- **누락된 항목**: `#24 CLIENT_SIDE_TOOL_V2_BACKGROUND_COMPOSER_FOLLOWUP` (검증됨)
- **patch**: 도구 카운트 표기 수정. 63은 *max field number*이지 *member count* 아님.

### 1.3 ❌ "138 RPCs total in cursor-retrieval" → 실제 **211 (AiService 단독 185)**
- **patch**: cursor.md §1A 표, cursor-localization.md §3.4, RPC 인벤토리 문서 — 카운트 모두 수정.
- 추가로 **IDE 번들엔 총 1,035 RPC binding**, **57개 별도 aiserver.v1 service** 존재 (claim한 ChatService/RepositoryService/CodebaseSnapshotService/AiService 4개는 빙산 일각).

### 1.4 ❌ "api3.cursor.sh = Updates/Statsig" → 실제 **Cursor Tab 자동완성** (`{purpose:"Cursor Tab"}`)
- 검증된 코드: `{domain:"api3.cursor.sh", purpose:"Cursor Tab"}` IDE @46830077, `ue("cursorTab","api3.cursor.sh")` @46832965
- 추가 발견: `api4.cursor.sh` = "Cursor Tab (regional)"
- **patch**: cursor.md §0 endpoint 표, RPC 인벤토리 doc.

### 1.5 ❌ "trusted MCP 도메인 하드코딩 (mcp.notion.com/linear.app/figma.com/sentry.dev/prisma.io)" → 거의 없음
- 실제 검증: `mcp.notion.com` 만 1건(Notion onboarding 샘플), 나머지 4개 도메인 IDE 번들에 **0건**. 하드코딩된 trusted MCP allowlist는 **존재하지 않음**.
- **patch**: cursor-repomap.md §0 "신뢰 MCP 도메인 하드코딩" 줄 삭제.

## 2. 위치/네임스페이스 정정 (4건)

### 2.1 ⚠️ AgentServerMessage / AgentClientMessage 위치
- 이전 claim: ENGINE에 정의
- 실제: **IDE 번들에만 정의** (`workbench.desktop.main.js`), ENGINE에 없음.
- **patch**: §3 응답 envelope 위치 annotation 수정.

### 2.2 ⚠️ UnifiedMode / ThinkingLevel 네임스페이스
- 이전 claim: `agent.v1` 추측
- 실제: **`aiserver.v1.StreamUnifiedChatRequest.UnifiedMode`** 및 **`aiserver.v1.StreamUnifiedChatRequest.ThinkingLevel`** (nested)

### 2.3 ⚠️ CodeChunk.Intent 네임스페이스
- 실제: **`aiserver.v1.ConversationMessage.CodeChunk.Intent`** (nested) — 10값 (UNSPECIFIED+9)
- 별도로 **`aiserver.v1.CodeChunk.Intent`** 도 존재 (top-level, 3값) — 이름 같지만 다른 enum. 혼동 주의.

### 2.4 ⚠️ J0h / IO_ verbatim 문자열 위치
- 이전 claim: ENGINE에 있음
- 실제: **IDE 번들에만** (ENGINE 0 hits, IDE 1 hit). subagent 관련 사용자-대면 메시지는 IDE 책임.

## 3. ToolCall 멤버 명명 정정 (44개 전부)

- 이전 claim: short name (`shell`, `delete`, `glob`, `grep`, `read`, `mcp`, ...)
- 실제: 전부 **`_tool_call` 접미사**: `shell_tool_call`, `delete_tool_call`, `glob_tool_call`, `grep_tool_call`, `read_tool_call`, `mcp_tool_call`, ... (총 44개)
- **필드 번호는 다 맞음** (1,3,4,5,8-10,12-25,28-46,48-52)
- **patch**: cursor.md §3, cursor-repomap.md 도구 표 — short→full name 교체.

## 4. 누락된 RPC 서비스 (★ 10개 발견)

### 4.1 누락된 agent.v1 서비스 4개 (cursor.md §1C / 인벤토리)
- **`agent.v1.PtyHostService`** (6): `SpawnPty`/`AttachPty`(stream)/`SendInput`/`ResizePty`/`ListPtys`/`TerminatePty` — **로컬 PTY 관리 1급**, claim 없음. control-cli skill 백엔드 가능성.
- **`agent.v1.TmuxSessionService`** (4): `CreateSession`/`ListSessions`/`KillSession`/`AttachSession` — **tmux 통합 1급**. babysit/long-running 셸 워크플로.
- **`agent.v1.PrivateWorkerApiService`** (2): `GetWorkerId`(Unary), `WatchStatus`(ServerStreaming)
- **`agent.v1.PrivateWorkerBridgeExternalService`** (1): `Connect`(BiDi) — cloud worker 브릿지

### 4.2 누락된 aiserver.v1 서비스 (총 57개 중 claim 4개)
주목할 서비스 (IDE 번들 검출):
- **`AnalyticsService.UploadIssueTrace`** (이미 endpoint path 검증으로 알고 있던 것)
- **`AuthService`** — 인증
- **`BackgroundComposerService`** — 백그라운드 composer (babysit 등)
- **`BugbotService`** — Bugbot PR 리뷰
- **`CmdKService`** — Cmd-K 인터페이스 (StreamFullFileCmdK 외 추가)
- **`ConversationsService`** — 대화 영속/조회
- **`CppService`** — C++ 특화 (cursor++?)
- **`CursorPredictionService`** — Cursor Tab 백엔드
- **`FastApplyService`** — fast-apply 모델 (Cursor 차별화 점)
- **`FastSearchService`** — 검색 별도
- **`FileSyncService`** — 파일 sync 별도 (RepositoryService와 다른?)
- **`GitGraphService`** — git graph 시각화
- **`MCPRegistryService`** — MCP 서버 레지스트리
- **`MarketplaceService`** — 확장 마켓플레이스
- **`ReviewService`** — 코드 리뷰 (PR 리뷰 캔버스?)
- **`SchedulerService`** — 스케줄 작업
- **`ShadowWorkspaceService`** — shadow workspace (변경 미리보기?)
- **`ToolCallEventService`** — 도구콜 이벤트 (텔레메트리?)
- **`UploadService`** — 파일/blob 업로드
- **`VmDaemonService`** — VM 데몬 (cloud agent)
- + `aiserver.v1.ReplayChatService.StreamReplayChat`(sibling to ChatService)
- + `aiserver.v1.RepositoryService` 실제 **19 methods** (claim 16) — 정확한 19개 verified 됨

### 4.3 `fileRetrievalActions.*` RPC family (treesitter.* 패턴과 같은 위임)
- `fileRetrievalActions.getLineCounts`, `fileRetrievalActions.getShallowDirectoryTree` 등 — 파일 ops도 서버 위임 패턴
- **의미**: treesitter만이 아니라 **여러 file-retrieval 메서드도 서버 RPC**. 클라가 정말 가벼움을 추가 증명.

### 4.4 누락된 엔드포인트
- **`repo42.cursor.sh`** = 인덱싱 (`bKu="https://repo42.cursor.sh"`)
- `prod.authentication.cursor.sh`, `authenticator.cursor.sh` (auth)
- `downloads.cursor.com` (앱 다운로드)
- 지역 cloud agent `agent-gcpp-uswest.api5.cursor.sh` (singular `agent`, claim의 `agentn`과 별개)

### 4.5 누락된 변종 메서드 이름
- `GetNewChatNudge` → 실제 2개: `GetNewChatNudgeLegacyModelPicker`, `GetNewChatNudgeParameterizedModelPicker`

## 5. Verbatim 문자열 정정 (4건)

### 5.1 ❌ `<cursor_commands>` 템플릿 변수 (cursor.md §2G.1.l)
- 이전 claim: `--- Cursor Command: ${filename} ---`
- 실제: `--- Cursor Command: ${l.filename} ---` (객체 프로퍼티 접근)

### 5.2 ❌ Diff-tab 액션 개수 (cursor.md §2G.1.q)
- 이전 claim: **10 액션**
- 실제: **9 액션** — `babysit-pull-request-in-cloud`, `commit`, `commit-and-create-pull-request`, `commit-and-push`, `create-branch-and-commit`, `create-branch-commit-and-push`, `create-pull-request`, `fix-merge-conflicts`, `push`
- (`createBranchCommitAndPush` 와 `commit-and-push` 등은 별개 액션)

### 5.3 ❌ "Side-question reminder" verbatim 텍스트 (cursor.md §2G.1)
- 이전 claim: `<system_reminder>This is a side question from the user...</system_reminder>` verbatim 인용
- 실제: **IDE에 해당 prose 0건**. 오직 feature flag 이름 `cli_btw_side_question:{client:!0,default:!0}` 만 존재.
- **출처 잘못 식별**. CC(Claude Code) 바이너리에서 본 걸 Cursor에 잘못 귀속시킨 가능성. **삭제 또는 출처 정정 필요**.

### 5.4 ⚠️ Rust 문자열 미세 차이
- `"cannot perform incremental update on an ignore file (root hash cannot be None)"` → 실제는 닫는 `)` 없음 (`"...cannot be None"`로 끝남, format string concat)

## 6. 카운트 정정 (현실 시점 데이터)

| 항목 | 이전 claim | 실제 (오늘 측정) | 비고 |
|---|---|---|---|
| Transcript 파일 | 863 | **896** | 라이브 누적 |
| `ai_code_hashes` rows | ~104,611 | **107,158** | 라이브 누적 |
| `scored_commits` rows | ~1,129 | **1,160** | 라이브 누적 |
| `ai-code-tracking.db` 크기 | ~62 MB | 62,590,976 B = **59.7 MiB / 62.6 MB(decimal)** | 둘 다 OK |
| v1 AiPercentage 평균 | ~23% | **23.18%** | ✅ |
| v2 AiPercentage 평균 | ~99.95% | **99.951%** | ✅ |
| .scm 파일 | 0 | **5** | VS Code core syntax highlighting용 (retrieval 아님) — claim의 *spirit*은 맞으나 *literal*은 틀림 |

## 7. ❓ Unverifiable (증거 부족 — 의존 시 주의)

- **`GrepClient.query/.onDidChange/.onDidCreate/.onDidDelete`** TS 호출부: NAPI 익스포트엔 있지만 RETRIEVAL TS 번들엔 `.debug`만 직접 호출. watcher 이벤트가 merkleClient 경유로 wire되는지 별도 dispatch인지 불명확. cursor.md §2H의 "GrepClient용 별도 FS watcher"는 *과대해석*일 가능성.
- **`Zp_`** permission precedence deny>ask>allow 머거: 심볼 존재 verified, 구현체 의미는 미검증.
- **`Lnb`** followup_message handler: 심볼 존재 verified, 구현체 미검증.
- **hook-step.ts 소스 path**: minified bundle에서 `/hooks/src/hook-step.ts` 문자열 확인됨 ✅ (D1).

## 8. ★ 신규 발견 — 추가 흡수 가치 (10개)

### 8.1 `crepectl` 듀얼 코드패스
NAPI strings: `"failed to execute 'crepectl build'"`, `"using external crepectl binary at '"`, `"using in-process index builder"` — **NAPI 안 in-process index OR 외부 crepectl 서브프로세스** 두 경로 모두 지원. 단일 grep 데몬이라는 단순화는 부정확.

### 8.2 Cursor의 디스크 인덱스 포맷 (NAPI 내부)
NAPI에 `index.bin`, `metadata.jsonl`, `postings.bin`, `.staging`, `"index too large: postings file would exceed 4GB limit at offset"` 문자열들 — **로컬에도 일부 인덱스 디스크 포맷 존재** 가능성 (crepectl 측). cursor-localization.md §17의 "임베딩 캐시 0" 주장은 *임베딩 한정*으론 맞으나 *전체 인덱스 디스크 포맷 0*은 너무 강한 주장이었음.

### 8.3 `codebase_snapshot.client.*` OTel 텔레메트리 키
`codebase_snapshot.client.snapshot.{blobs_written,blobs_skipped,bytes_written}`, `codebase_snapshot.client.scan.stale_patch_dropped` — Codex `codex.*` 키 패턴과 평행. quanta OTel vocab(memory `codex-otel-attribute-vocabulary`)에 reference로 추가 가치.

### 8.4 Cursor의 Rust crate 레이아웃 노출
`crates/gix-snapshot/src/engine/snapshot_writer/{commit,tree,ingest}.rs`, `crates/gix-snapshot/src/engine/coordinator/scan.rs`, `crates/merkle_tree/src/lib.rs`, `crates/crepe/src/{lib,index,query,regex,serialization}.rs` — **Anysphere의 Rust crate 구조 노출**. v3가 비슷한 incremental sync 필요시 reference crate 목록.

### 8.5 `MerkleClient` 추가 NAPI 메서드 3개
`getAllDirFilesToEmbed`, `getAllFiles`, `getTreeStructure` — 이전 docs 누락.

### 8.6 `cannotImportExtensions` 차단 리스트 14개 verbatim
- claim했던 `github.copilot`만이 아니라: `GitHub.copilot-chat`, `TabNine.tabnine-vscode`, `sourcegraph.cody-ai`, `Blackboxapp.blackbox`, `Continue.continue`, `Codeium.codeium`, `supermaven.supermaven`, **`anthropic.claude-code`**, **`openai.chatgpt`**, `sourcegraph.amp`, `augment.vscode-augment`, `eamodio.gitlens`(!), `vscjava.migrate-java-to-azure`
- **흥미로운 신호**: `anthropic.claude-code` + `openai.chatgpt` + `eamodio.gitlens`(GitLens!) 까지 차단 — 단순 경쟁 차단 넘어 *Cursor 자체 git/blame 기능 강제* 의도 추정

### 8.7 `agent.v1.PtyHostService` (6 methods) + `TmuxSessionService` (4 methods)
이건 큰 발견. cursor-agent-exec가 **PTY와 tmux 1급 통합** — `control-cli`/`babysit` 같은 long-running CLI 워크플로의 백엔드. Cursor의 "셸 통합력"을 정량화하는 핵심 인프라.

### 8.8 `agent.v1.LifecycleService.ClaimWorker` + 별도 worker bridge 2 services
- `PrivateWorkerApiService.{GetWorkerId, WatchStatus}` + `PrivateWorkerBridgeExternalService.Connect`(BiDi)
- = **cloud worker fleet 풀세트 인프라**. Cursor cloud agent의 "VM 풀에서 워커 claim → BiDi 브릿지로 작업" 풀 패턴.

### 8.9 `aiserver.v1.ShadowWorkspaceService`
"변경 미리보기 워크스페이스" — 변경 사항을 fork된 워크스페이스에서 *먼저 시도하고* 검증한 뒤 메인에 머지하는 패턴? Cursor의 다음 차별점 후보. 별도 깊이 조사 가치.

### 8.10 `aiserver.v1.FastApplyService`
Cursor의 핵심 차별화 = fast-apply 모델 (수만 토큰 코드를 *모델이 직접 patch*하는 방식, edit는 streamed full content). **별도 service로 분리**. quanta는 fast-apply 인프라 없으니 흡수 불가지만, 존재 자체가 Cursor 아키텍처에서 fast-apply의 격을 보여줌.

## 9. Patch 적용 가이드 (문서별)

### 9.1 `cursor.md` 정정
| 위치 | 정정 |
|---|---|
| §0 endpoints 표 | `api3.cursor.sh`= Cursor Tab (Updates/Statsig 아님) |
| §1 `AgentClientMessage`/`AgentServerMessage` 위치 | "IDE 번들" 명시 (ENGINE 아님) |
| §1 envelope 멤버 카운트 | AgentClientMessage 8멤버, AgentServerMessage 6멤버 모두 ✅ |
| §1A ChatService 14개 | ✅ 변경 없음 + sibling `ReplayChatService` 1개 추가 |
| §1B `ConversationMessage.MessageType` HUMAN/AI 위치 | aiserver.v1 nested, ✅ |
| §1C 인벤토리 카테고리 | "138 RPC" → **211 (또는 IDE 1035)**, "4 service" → **57 aiserver.v1 service** |
| §1B/C 도구 표 (44 ToolCall) | 모든 name에 `_tool_call` 접미사 추가 |
| §2H 코드 로컬라이제이션 요약 | "GrepClient용 별도 FS watcher" → "GrepClient는 NAPI export, TS 측 호출은 `.debug`만 직접 확인됨, 워처 별도 구독 ⚠️ 확신 낮음"으로 약화 |
| §2H "심볼릭링크 탈옥 방어" 줄 | ❌ 삭제 또는 "Cursor 미관측, 흡수는 quanta 자체 결정"으로 재표기 |
| §2G.1.l Cursor Command 템플릿 변수 | `${filename}` → `${l.filename}` |
| §2G.1.q diff-tab 개수 | "10 액션" → "**9 액션**" |
| §2G.1 side-question reminder 항목 | ❌ 삭제 (verbatim 출처 잘못, CC와 혼동 가능) |
| §3 enum 값 | UnifiedMode/ThinkingLevel 네임스페이스 = `aiserver.v1.StreamUnifiedChatRequest.*` |
| §3 ToolCall 44 표 | name 접미사 정정 |
| §3 ClientSideToolV2 수 | "63" → "**53 entries, max field# 63 (sparse)**" + #24 BACKGROUND_COMPOSER_FOLLOWUP 추가 |

### 9.2 `cursor-localization.md` 정정
| 위치 | 정정 |
|---|---|
| §0 RETRIEVAL 크기 | "4.03 MB" 그대로 OK (decimal). decimal/binary 혼동 주의 |
| §1.3 `Rechunker` enum | UNSPECIFIED 값 string으로 미관측 (proto 정의엔 보통 있음) |
| §4 crepectl 단일 데몬 | **듀얼 코드패스** 명시 — NAPI in-process OR 외부 crepectl 서브프로세스 |
| §3.3 GrepClient | TS 호출부는 `.debug`만 직접 확인됨, `.query`/`.onDid*`은 NAPI export 존재하나 wire 미확인 |
| §7 디스크 상태 "SQLite/벡터/임베딩 캐시 0" | *임베딩* 한정으론 ✅; crepectl/NAPI 측 `index.bin/postings.bin/metadata.jsonl/.staging` 등 일부 디스크 인덱스 포맷 존재 가능성 (NAPI strings 증거) 추가 |
| §17 (delta sync) | 모두 ✅ verified, 변경 없음 |
| §17.13 oversized "silent skip" | ✅ verified |
| 신규 발견 (§8 위 모두) | 새 절(§18) 추가 권장 |

### 9.3 `cursor-repomap.md` 정정
| 위치 | 정정 |
|---|---|
| §0 evidence "신뢰 MCP 도메인 하드코딩" 줄 | ❌ 삭제 (확인 안 됨) |
| §7 "심볼릭링크 탈옥방어 deny" 줄 | ❌ 삭제 또는 재표기 |
| §3 도구 44개 표 | name 접미사 `_tool_call` 추가 |
| §3b subagent | ✅ 유지 |

### 9.4 메모리 정정 (`cursor-3.2-absorption.md`)
| 항목 | 정정 |
|---|---|
| P0 #1 "심볼릭링크 탈옥방어 정적 deny" | "**Cursor 미관측, quanta 자체 보안 결정**"으로 출처 정정. 흡수 가치 자체는 유효(`.git/hooks` write가 코드 실행 벡터인 건 사실). |
| "138 RPC" 인용 | "**211+ RPC (AiService 185 단독), IDE 번들엔 1035 binding**"로 업데이트 |
| 트랜스크립트 통계 | 라이브 카운트는 라이브임을 명시 (claim 시점 측정값) |

## 10. quanta 흡수 영향 정정

### 10.1 P0 #1 재포지셔닝 — 여전히 유효, 단 근거 정정
- **이전**: "Cursor 흡수 — `.git/hooks`/`.git/config` write deny"
- **정정**: "**quanta 자체 보안 강화 — `.git/hooks`/`.git/config` write는 임의 코드 실행 벡터이므로 dispatch seam에 정적 deny.** Cursor에 같은 패턴이 있다는 증거는 못 찾음 — 흡수가 아니라 quanta self-improvement로 추진."
- 0072 ADR 추진 시 출처 명확히.

### 10.2 PtyHostService / TmuxSessionService 신규 흡수 후보 (Tier 1)
- Cursor가 `agent.v1.PtyHostService` (6 methods) + `TmuxSessionService` (4 methods)를 1급 RPC로 노출 = **장기 실행 CLI 작업의 인프라 분리**.
- quanta `tool/shell`의 async-shell 흡수(P1, 진행 중)와 결합 시: PTY/tmux 별도 layer로 추상화하면 control-cli skill 백엔드 + bench 환경의 multi-process 시나리오에서 큰 가치.

### 10.3 ShadowWorkspaceService — 별도 dig 권장 (Tier 0 후보)
- 이름이 강력 — "변경을 fork 워크스페이스에서 먼저 시도 후 검증" 패턴이면 quanta verify-this/closeout-guard와 강하게 시너지.
- 다음 라운드에서 별도 dig 필요.

## 11. 신뢰도 매트릭스 (앞으로 docs 인용 시)

| 마킹 | 의미 |
|---|---|
| ✅ verified | bundle strings/grep으로 본 단어/패턴/필드 번호. 인용 안전. |
| ⚠️ partial | 일부 verified, 일부 추론 또는 cosmetic 오차 (예: 위치, 접미사). 사용 시 주의. |
| ≈ inferred | proto schema/symbol 의미에서 추론, 의미는 확실하나 정확한 동작 미관측. |
| 🔒 server-side | 클라 측에서 못 봄. 가설로만 표기. |
| ❓ unverifiable | symbol은 보이나 의미 미관측. 의존 금지. |
| ❌ wrong | 검증 결과 틀림. 정정 필수. |

이전 docs는 이 마킹을 적용했지만 *너무 후하게* 사용한 사례 있음 (예: ❌ 항목들이 ✅로 표기됐던 것). 앞으로 *negative result*(못 찾음)는 적극 ❓ 또는 ❌로 표기 권장.

## 12. 후속 작업 권고

| 순위 | 작업 | 출력 |
|---|---|---|
| 1 | 위 §9 patch list 적용 (cursor.md / cursor-localization.md / cursor-repomap.md / 메모리) | 정정된 docs |
| 2 | `aiserver.v1.ShadowWorkspaceService` 깊이 dig | 신규 흡수 후보 분석 |
| 3 | `aiserver.v1.FastApplyService` 깊이 dig | Cursor 차별화의 핵심 정량화 (흡수 불가지만 reference) |
| 4 | `PtyHostService`+`TmuxSessionService` proto 풀 스키마 + 실제 wire 호출 추적 | quanta async-shell 흡수 P1 + control-cli 백엔드 후보 |
| 5 | 57 aiserver.v1 service 전수 매핑 (현재 4개만 깊이 알려짐) | RPC 전체 인벤토리 신규 문서 |

---

## 결론 한 줄

**압도적 다수(95%)의 wire-protocol·enum·RPC·심볼 claim은 evidence로 verified. 그러나 18건의 명확한 hallucination (특히 "심볼릭링크 탈옥 방어 deny"는 P0 흡수 추론의 근거 자체였음 — 정정 필수)이 있고, 10건의 신규 발견(PtyHostService/ShadowWorkspaceService/FastApplyService 등 57개 aiserver service 빙산)으로 Cursor 아키텍처는 처음 추정보다 훨씬 크고 분화된 시스템임이 드러남. 위 §9 patch 적용 + §12 후속 dig 권장.**
