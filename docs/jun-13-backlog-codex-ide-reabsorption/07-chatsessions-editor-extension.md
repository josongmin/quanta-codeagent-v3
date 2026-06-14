# T07 — VS Code `chatSessions` 에디터 확장 (전략)

**현황:** ✅ LANDED (adapter+ratchet, 2026-06-13) · **ROI:** ★ (전략적, 大공수) · **게이트:** N/A(신규 surface)

> **LANDED 노트 (2026-06-13):** 사용자 opt-in("ㄱㄱㄱ") 후 착수. 선결 T01/T02는 이미
> LANDED 확인(처음 slash-vs-dot grep로 false-gap 오판→정정). PURE 어댑터 surface로 구현:
> `surfaces/vscode/src/{chat-session-adapter,status}.ts`(vscode 심볼 0, session.v1만 소비)
> + thin glue `provider.ts`(유일한 `vscode` import). 헬게이트 e2e가 **실 session.v1
> 라운드트립**(`@/ipc/session` bridge+client) 관통: UC1 ChatSessionItem(id/label/status),
> UC2 status 전이(turn.* 경로 + coarse state.updated 경로 + 실패), UC3 신규세션(factory seam),
> UC4 코어-누출 라쳇(`tests/unit/surfaces/vscode/core-no-vscode-leak-ratchet.test.ts`,
> red-on-injection 검증). status는 서버 turn lifecycle서만 파생(낙관적 flip 없음=UI-lie 회피).
> tsconfig path `@surfaces/vscode/*` 등록. proposed-API 버전종속은 `status.ts`(stable enum)
> ↔ `provider.ts#STATUS_TO_VSCODE`(버전 enum 재매핑)로 격리.
>
> **잔여(follow-up):** ① 실제 spawn 가능한 `quanta app-server` CLI 진입점 — 현재는 host가
> 주입하는 `createSession()` factory seam만 정의(어댑터↔실행 경계). 왜: 확장이 엔진을
> 띄우려면 진입점 필요. ROI: 확장 실사용 게이팅. ② conversationEditor(task=에디터 탭) +
> code lens + addToThread(선택영역 컨텍스트) — index §2.6 "T07 의존" 항목. 왜: 네이티브
> 에디터 통합 깊이. ROI: chatSessions 위 UX 완성도. ③ T01 item-level delta를 패널에 rich
> 렌더(현재 어댑터는 status/label까지; item.* 소비 seam은 열려있음). 왜: 북극성 agent-state
> 가시성. ④ follower(T02) co-control 핫키를 패널 액션으로 노출.

## 무엇 (코퍼스 증거)
Codex IDE(`openai.chatgpt`)는 VS Code **네이티브 Agent/Chat Sessions API** provider로 등록:
- `registerChatSessionItemProvider`, scheme `openai-codex`, proposed API `chatSessionsProvider`+`languageModelProxy`.
- `provideChatSessionItems`: codex thread → `ChatSessionItem{id, resource, label, status, timing}`. status 2=진행/1=idle, MCP notification(`task_started`→2, `task_complete`→1)으로 구동.
- thread를 editor 탭으로(`conversationEditor` custom editor "Codex Task").
- inference 백엔드 선택: `isUserUsingCopilotInference()` — Codex thread를 **GitHub Copilot model proxy**로도 구동.

대조: Claude Code IDE는 chatSessions 안 씀(자체 webview 사이드바 + `claude-sessions-sidebar`). 즉 **두 갈래 IDE 전략**(네이티브 챗 통합 vs 자체 webview).

## 왜 가져오나 / 왜 신중한가
quanta는 multi-surface(CLI/Web-Tauri/embedded browser, [[surface-model]])지만 **에디터 확장 surface 자체가 없다**. 이건 진짜 갭이나 **大공수 + 유지비**. surface 가용성으로 흡수 ROI 게이팅 금지 원칙상 메커니즘(provider 어댑터)은 흡수 가치 있으나, "VS Code 확장을 만든다"는 제품 결정이라 ★(전략) 등급. **착수 전 사용자 결정 필요.**

## quanta 현황 (코드 앵커)
- repo 전체 `package.json`에 `contributes`/`engines.vscode` **0**(루트 `@vscode/tree-sitter-wasm`은 grammar dep일 뿐). `chatSessions` 심볼 **0**.
- `src/apps/agent/mode-presets/ide.ts` — `ide` 모드 존재하나 헤더 "에디터 어댑터는 **repo 밖**". 서버측 runner + 선언적 `req.base` 계약만.
- transport(T02 앵커)는 외부 에디터가 소비 가능한 형태(stdio/WS session transport + session.v1)나 외부 진입점 미배선.

## 제안 접근 (만약 진행 시)
1. **선결:** T01(item streaming) + T02(follower co-control)가 먼저. 그것들이 에디터 어댑터가 소비할 protocol surface다.
2. 별 repo(또는 `surfaces/vscode/`)에 얇은 확장: session.v1 ↔ VS Code chatSessions provider 어댑터. quanta 엔진은 app-server류 진입점으로 띄움.
3. status 모델(in-progress/idle)을 session.v1 turn lifecycle서 파생(이미 보유).
4. Claude Code식 자체-webview 갈래도 옵션 — Tauri surface 자산 재사용 가능.

## 함정
- 코어에 VS Code 특정 결합 금지 — 어댑터는 surface 레이어에만. session.v1이 경계.
- proposed API(`chatSessionsProvider`) 안정성 — VS Code 버전 종속.
- 이건 **메커니즘 흡수가 아니라 제품 surface 추가** — 사용자 opt-in 없이 착수 금지.

## 통합 계획 (LLM도구 / CLI+Web / knob / config)
- **LLM 도구:** N/A — surface 추가지 도구 아님.
- **CLI+Web:** 이건 **3번째 surface**(에디터)지 CLI/web 통합이 아님. session.v1 ↔ VS Code `chatSessions` provider 어댑터를 **surface 레이어**(별 repo 또는 `surfaces/vscode/`)에 두고 코어는 app-server류 진입점으로 노출(T02 트랜스포트 재사용). 코어에 VS Code 심볼 누출 금지 — `src/apps/agent/mode-presets/ide.ts`가 명시하듯 어댑터는 repo 밖.
- **knob:** N/A — 확장 빌드 자체가 opt-in 산출물. 코어엔 신규 knob 불필요(엔진은 기존 thin-client/session.v1 게이트 재사용).
- **config:** VS Code `package.json` `contributes`(chatSessions/commands/customEditors)는 **확장 패키지**에만. quanta 코어 config(`src/config/`) 무관 — 코어-surface 결합 라쳇으로 누출 차단.

## DoD (진행 결정 시)
- session.v1 위 thin provider 어댑터(코어 무결합), thread→ChatSessionItem status 매핑.
- e2e: 에디터 챗 패널서 quanta thread 표시 + status 전이.
- 코어 surface-coupling 라쳇 green(VS Code 심볼이 코어에 누출되면 red).

> **결정 대기:** T01/T02 흡수 후 재평가. 단독 착수 비권장.
