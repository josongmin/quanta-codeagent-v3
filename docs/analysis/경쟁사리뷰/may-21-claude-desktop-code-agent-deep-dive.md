# Claude Desktop 1.7196.3 — 코드 에이전트 surface 심층 분석

> **목적**: [feature catalog](may-21-claude-desktop-feature-catalog.md)에서 식별된 코드 에이전트 영역
> (`LocalSessions` 130 + `LocalAgentModeSessions` 71 + `CCDScheduledTasks` 8 + 관련 보조 surface)을
> **3축**으로 평가 — (A) 에이전트 품질 향상 패턴, (B) UI/UX 혁신, (C) 확장 도구를 통한 사용성 개선.
> 각 항목: **무엇 → 구현 방법(추론) → 왜 기깔나는지 → quanta-v3 시사점**.
>
> 수집 일자: 2026-05-21

---

## A. 에이전트 품질을 끌어올리는 패턴

### A1. **Rewind + Fork = 시간 여행 + 분기 탐색**

| 메서드 | 노출 surface |
|---|---|
| `LocalSessions.rewind`, `LocalAgentModeSessions.rewind` | 두 세션 트랙 모두 노출 |
| `LocalSessions.forkSession` | LocalSessions 전용 |

**구현 추론**: 메시지 단위 체크포인트가 transcript에 저장되어 있고, `rewind(messageId)`가 그 지점으로 상태(파일시스템 + 에이전트 컨텍스트)를 되돌림. `forkSession`은 rewind 지점에서 **새 세션으로 분기**시켜 원본은 보존.

**왜 기깔남**:
- 에이전트가 잘못된 결정을 했을 때 "되돌리고 다시" UX가 1-클릭. CLI/터미널 에이전트의 약점(돌이킬 수 없는 사이드 이펙트)을 정면 해결.
- Fork는 한 문제에 대해 여러 접근을 병렬 탐색 (A/B branch). 결과적으로 에이전트 다양성 자체가 품질이 됨.

**v3 시사점**: [[subagent-sota-hardening]]의 `checkpoint`/`continue_from`을 **메시지 ID 단위 rewind UX**로 격상시킬 만함. 단순 resume이 아닌 "임의 시점으로 점프" + "그 시점에서 새 세션 fork"는 별도 IPC + transcript indexing 필요.

---

### A2. **3축 모드 제어 — Model × Effort × PermissionMode**

```
setModel(model)              // 모델 선택 (carousel)
setEffort(effort)            // default | max | high | medium | low  (5단계)
setFastMode(bool)            // 별도 ON/OFF (effort와 직교)
setPermissionMode(mode)      // default | plan | acceptEdits | readOnly | bypassPermissions (5단계)
setAvailableCodeModels(...)  // 동적으로 표시할 모델 목록 푸시
```

**모델 카탈로그 게이팅**: `setAvailableCodeModels` 인자에 `["claude-mythos-preview","claude-opus-4-6", ...]` 같은 enum 배열 — **`claude-mythos-preview`는 Opus 4.6 라인의 미공개 후속 preview 모델 코드네임("Mythos")**. 서버가 사용자별로 노출 가능한 모델 셋을 푸시 → 클라이언트 코드 변경 없이 모델 베타 게이팅 가능.

**구현 추론**: 4개 슬롯이 세션 상태에 독립적으로 저장되고, 각 turn 시작 시 prompt/system 합성과 토큰 예산 결정에 합쳐서 들어감. `bypassPermissions`는 "Run coding task in bypass permissions mode?" 확인 다이얼로그를 거치고, `plan`은 `getPlanForSession` + `planModeInstructions`로 별도 산출물(코드 작성 없이 계획만).

**왜 기깔남**:
- 모드가 **직교(orthogonal)**. quanta-v3의 모드도 직교성이 깨지면 사용자 혼란.
- `setAvailableCodeModels`로 **서버가 클라이언트에 모델 카탈로그를 푸시**. 새 모델 출시 시 앱 업데이트 없이 추가 가능.
- `acceptEdits`는 권한 자동 부여(승인 다이얼로그 스킵)이지만 `bypassPermissions`는 전체 우회 — 두 단계 분리가 안전성-속도 tradeoff를 잘 표현.

**v3 시사점**: v3는 Plan/Apply/Bypass 같은 모드 모델을 명시적으로 갖고 있지 않은 듯. **Plan Mode를 별도 산출물(`planModeInstructions`)로 분리**하는 패턴은 깔끔. 모델 목록도 client에 하드코딩 말고 server-pushed로.

---

### A3. **WIP 안전 그물 — discardWorkingTree / stashWorkingTree / commitWipForBranchSwitch**

| 메서드 | 의미 |
|---|---|
| `getWorkingTreeStatus`, `isWorkingTreeDirty`, `getUncommittedChanges` | 매 turn 전후 dirty check |
| `stashWorkingTree` | git stash로 일시 보관 |
| `commitWipForBranchSwitch` | **브랜치 전환 시 자동 WIP 커밋** |
| `discardWorkingTree` | 명시적 confirmation 후만 destructive |
| `commitAllChanges`, `createLocalPr` | 정상 흐름 |

**구현 추론**: `commitWipForBranchSwitch`가 핵심 — 사용자가 다른 PR/이슈로 컨텍스트 스위치할 때 자동으로 `wip: <session-title>` 커밋을 만들고 새 브랜치로 안전 이동. 돌아오면 `git reset HEAD~1`이나 stash pop으로 복원.

**왜 기깔남**:
- 에이전트가 만든 변경이 **세션 외부에 노출되기 전에 자동 캡슐화**. 사용자가 의식하지 않아도 데이터 손실 0.
- 그리고 destructive ops(`discardWorkingTree`)는 분리된 별도 IPC로만 — 실수로 호출 안 됨.

**v3 시사점**: v3가 working tree dirty 상태에서 무엇을 보장하는지 명시 필요. **session boundary = git checkpoint**라는 invariant를 [[subagent-sota-hardening]]의 working-tree snapshot에 추가.

---

### A4. **AutoFix + FastMode + 컨텍스트 메트릭**

```
setAutoFixEnabled(bool)
setFastMode(bool)
getContextUsage(sessionId)   // 라이브 미터
getCodeStats(sessionId)      // 변경 코드 라인 등
getPlanForSession(sessionId)
```

**구현 추론**:
- **AutoFix** = lint/typecheck 실패 시 자동 retry-with-fix loop (PreToolUse hook으로 wire-up되어 있을 가능성 — `hooks:{PreToolUse:[{matcher:"Task"...`).
- **FastMode** = 보조 turn(요약/계획/내부 reasoning)을 더 작은 모델로 라우팅.
- **getContextUsage** = 토큰 사용량 라이브 표시 → 사용자가 컨텍스트 압박을 시각적으로 확인하고 fork/rewind 결정.

**왜 기깔남**:
- 메트릭이 IPC로 노출 = renderer가 "ContextBar" 같은 UI 위젯을 쉽게 그릴 수 있음. 에이전트 작업이 **계량 가능한 자원**으로 보임.
- AutoFix는 사용자가 "lint 실패했어 고쳐줘" 안 쳐도 됨.

**v3 시사점**: `getContextUsage` 같은 메트릭 surface가 v3에 있는지 점검. CLI에서도 status line으로 노출하면 [[surface-model]]에 부합.

---

### A5. **요약 계층화 — Session / Transcript / Space 3단**

```
LocalSessions.summarizeTranscript(sessionId)     // 단일 세션 transcript 요약
LocalSessions.summarizeSession(sessionId)        // session-level (메타데이터?)
LocalSessions.stopSessionSummary(sessionId)      // long-running 중단 가능
CoworkSpaces.summarizeSpace(spaceId)             // space (여러 세션) 요약
CoworkSpaces.setAutoDescription(spaceId, ...)    // 자동 description
```

**구현 추론**: 세 레벨이 독립 호출 가능 + **중단 가능**. summarize가 동기 백그라운드 job → 진행 중에도 사용자가 `stopSessionSummary` 호출 가능.

**왜 기깔남**:
- 요약을 "자동 트리거 + 중단 가능 + 계층화"로 만든 게 깔끔. v3가 자동 compaction을 하나의 시점에 한 번에 trigger한다면 부족.
- Space-level 요약은 "이번 주에 뭐했지" 같은 retrospective view 가능.

**v3 시사점**: compaction이 [[cc-v2-sota-absorption]] §1.2 <20k override랑 연동되는데, **사용자가 명시적으로 trigger/cancel** 할 수 있는 IPC도 노출하면 좋음.

---

### A6. **Background Task Suggestions (Radar Cards)**

```
LocalSessions.popBackgroundTaskSuggestion()        // 다음 제안 pull
CoworkRadar.getCards()
CoworkRadar.setCardStatus(id, "dismissed" | ...)
CoworkRadar.adoptSession(cardId)                   // 카드 → 활성 세션
CoworkRadar.recordCardEngagement(cardId)
CoworkRadar.onRadarUpdated()                       // event stream
```

**구현 추론**: 에이전트가 백그라운드에서 "이거 해두면 좋아요" 제안을 생성 → Radar에 카드로 쌓임. 사용자가 한 카드를 `adoptSession`하면 **즉시 활성 세션으로 promote**. CCD/Cowork ScheduledTasks가 카드를 생산할 수도.

**왜 기깔남**:
- 에이전트가 **수동적 응답자가 아니라 능동적 제안자**. "next-best-action" UX를 IPC 표준으로 표현.
- `recordCardEngagement`로 사용자 반응 학습 → 어느 종류 카드를 자주 adopt하는지 RL signal.

**v3 시사점**: v3가 idle 상태에서 능동 제안할 수 있는 surface가 있나? **Radar Card 패턴**은 quanta가 multi-surface(CLI/Web)에서 동시에 띄울 수 있는 일급 객체로 적합.

---

### A7. **Bridge Permission Preflight (원격 권한 사전 승인)**

```
LocalAgentModeSessions.onBridgePermissionPreflight        // 원격 세션이 권한 요청 전 preflight
LocalAgentModeSessions.respondBridgePermissionPreflight   // 로컬에서 사전 응답
```

이벤트 9종: `bridge_event_attestation`, `bridge_message_receive(+ parse_failed)`, `bridge_permission_posted`, `bridge_permission_resolved`, `bridge_session_status`, `bridge_socket_error`, `bridge_state`, `bridge_timeout`.

**구현 추론**: 원격(클라우드) 에이전트 세션이 권한 필요한 동작을 하기 **전에 preflight 메시지를 보내 사용자 확인**을 받음. `attestation` 이벤트로 원격 세션의 신원/정책을 검증. preflight가 resolve되면 실제 action으로.

**왜 기깔남**:
- 원격 에이전트에 대한 **신뢰 경계가 명시적**. 단순 토큰 인증이 아니라 매 action 전 preflight + attestation. SSH-style "host key verification"의 에이전트 버전.
- timeout/socket_error/parse_failed가 모두 분리된 이벤트 → 디버깅 가능.

**v3 시사점**: v3가 원격 에이전트 + 로컬을 잇는 시점이 오면 이 패턴이 정답에 가까움. [[anthropic-sdk-in-codex]] 같은 외부 호출에도 적용 가능.

---

### A8. **Teleport-to-Cloud**

```
LocalSessions.getTeleportReadiness(sessionId)
LocalSessions.teleportToCloud(sessionId)
```

**구현 추론**: 로컬에서 시작한 세션(파일시스템 상태 + transcript + 트러스트된 폴더 + MCP 설정)을 **클라우드 환경에 패키징해서 이전**. `getTeleportReadiness`로 사전 점검(uncommitted 변경, native 도구 의존 등) → green이면 teleport.

**왜 기깔남**:
- "내 노트북 닫고 클라우드에서 계속"이 1-클릭. Cowork microVM과는 다른 축 — Teleport는 **세션 자체의 이주**.
- Readiness check가 분리되어 미리 경고 가능 ("이 세션은 native xxx 도구 의존성 때문에 teleport 안 됨").

**v3 시사점**: v3의 multi-surface 비전이 "CLI ↔ Web" 양방향이라면, **세션 이주 protocol**이 핵심. teleportReadiness의 사전 점검 모델은 그대로 차용 가능.

---

### A9. **Side Chat (메인 방해 없는 보조 채팅)**

```
LocalSessions.startSideChat(sessionId)
LocalSessions.sendSideChatMessage(sideChatId, msg)
LocalSessions.stopSideChat(sideChatId)
```

**구현 추론**: 메인 세션의 transcript를 건드리지 않고 **별도 transcript로 분기**된 임시 채팅. 메인 세션의 컨텍스트(파일 상태 등)는 공유하지만 답변은 메인 컨텍스트에 합쳐지지 않음.

**왜 기깔남**:
- "지금 진행 중인 코드 변경은 그대로 두고 옆에서 빨리 뭐 하나 물어보고 싶다"의 정답.
- 메인 turn의 토큰 예산을 보호하면서 보조 질문 가능.

**v3 시사점**: v3 CLI에 `claude --side <main-session-id>` 같은 추가 모드가 있을 만함. UI에서는 panel split.

---

### A10. **Warm Session (콜드 스타트 제거)**

```
LocalSessions.warmSession(sessionId)
```

**구현 추론**: 사용자가 클릭하기 전에 미리 cwd 인덱스, MCP 서버 연결, PTY, working tree 스냅샷을 만들어둠.

**왜 기깔남**: 첫 turn 응답 지연이 거의 0. UX-퍼셉션 차이 큼.

**v3 시사점**: 세션 목록 UI에서 hover 시 warmSession 호출 → 진입 즉시 가용.

---

### A11. **CLI ↔ GUI 양방향 — importCliSession / logCliEvent + claude-ssh 별도 배포**

```
LocalSessions.importCliSession(path | id)
LocalSessions.logCliEvent(eventData)
```

**구현 추론**: CLI에서 진행 중이거나 종료된 세션을 GUI로 import. CLI가 실시간으로 보낸 이벤트를 GUI가 mirror (live attach 같은 UX).

**`claude-ssh` 별도 배포**: 원격 SSH 작업용 CLI가 `downloads.claude.ai/claude-ssh-releases`에서 배포되어 `userData/claude-ssh-remote/`에 격리 설치됨. 메인 CLI와 다른 release channel.

**왜 기깔남**:
- CLI와 GUI 사이의 벽 제거. quanta가 multi-surface라면 이게 표준.
- `claude-ssh`를 메인 CLI에서 분리 → 원격 측 의존성/업데이트 사이클을 독립적으로 관리. 보안 패치 핫픽스도 빠름.

**v3 시사점**: [[surface-model]]의 "surface 가용성으로 게이팅하지 말 것" 원칙이 정확히 이 방향. v3에 동일 IPC 필요. **원격 측 바이너리는 별도 채널**이라는 패턴은 SSH/원격 기능 추가 시 차용.

---

## B. UI/UX 혁신

### B1. **multi-window 세분화**

| 윈도우 | 역할 |
|---|---|
| `mainWindow` | 풀 채팅/Code/Cowork |
| `quickWindow` | ⌥Space 같은 Spotlight 진입 (`Escape` global shortcut으로 dismiss) |
| `buddyWindow` | BLE 펫 페어링 — 권한 prompt를 펫이 표시 |
| `coworkArtifact` | 아티팩트 미리보기 별도 창 |
| `computerUseTeach` | Computer Use 온보딩 (별도 창으로 분리) |
| `findInPage` | ⌘F 오버레이 |
| `FloatingPenguinMini` (`focus`, `getState`, `pickProject`) | 마스코트형 mini-helper |
| `aboutWindow` | 진단/지원 번들 제출 |

**왜 기깔남**: 각 윈도우가 자체 webPreferences + partition. **권한 prompt를 별도 윈도우(buddy)**로 띄우는 발상이 특히 흥미 — 권한 alert가 메인 UI를 가리지 않음.

**v3 시사점**: Tauri 측 v3 web surface 설계할 때 "메인 / quick / artifact / teach" 같은 분리를 미리 고려. quickWindow는 자체 IPC class (`QuickWindow_requestDismiss/requestSkooch`)까지 있음.

---

### B2. **`reviewDiff` — Diff에 대고 직접 리뷰 코멘트**

```
LocalSessions.reviewDiff(diffSpec)
```

**구현 추론**: PR diff를 받아 line-by-line 리뷰 comment를 에이전트가 생성 → `getPrReviewComments`/`updatePrBody`로 GitHub에 직접 푸시. CLI의 `/ultrareview`가 결과를 main thread에 합치는 것과 달리, **diff-only sub-agent**.

**왜 기깔남**: 메인 세션의 컨텍스트를 오염시키지 않으면서 diff만 평가하는 isolated agent. Side Chat의 코드 리뷰 특화 버전.

**v3 시사점**: `/ultrareview`가 multi-agent로 가는 게 [[memory: codex-desktop-build-2867-round-2]] reviewer-tier 패턴과 일치. v3 reviewer tier에 "diff-only" sub-mode 추가 고려.

---

### B3. **권한 다이얼로그가 BLE 펫에 표시 가능**

```
BuddyRemoteFeed.permissionDecision    // BLE 펫의 버튼으로 권한 응답
BuddyRemoteFeed.sync
```

**왜 기깔남**: 권한 확인이 OS 알림 + 메인 윈도우 + (옵션) BLE 펫 → ambient computing. 사용자가 화면에 없어도 펫 버튼으로 응답 가능.

**v3 시사점**: niche지만, **권한 응답 채널을 surface-agnostic하게 추상화**한다는 발상은 일급. v3 multi-surface와 호환.

---

### B4. **Artifact Park & Capture (정지된 상태 캡처)**

```
CoworkArtifacts.parkAndCaptureArtifact(id)   // 동작 중 artifact를 정지 + 캡처
CoworkArtifacts.printArtifactToPdf(id)
CoworkArtifacts.shareArtifact(id) / unshareArtifact / isSharingEnabled
CoworkArtifacts.restoreArtifactVersion(id, ver)
CoworkArtifacts.refreshImportedArtifact(id)
```

**왜 기깔남**: 라이브 아티팩트(예: dashboard, app)를 **재현 가능한 상태로 정지** → PDF export, share URL, 버전 복원. 단순 스크린샷이 아닌 상태 캡슐화.

**v3 시사점**: v3 아티팩트 시스템이 있다면 "park" = 결과 reproducibility 보장의 1차 메커니즘.

---

### B5. **15-Editor One-Click Open**

```
LocalSessions.getInstalledEditors()
LocalSessions.openInEditor(editorId, file)
LocalSessions.openInVSCode(file)             // VSCode는 named shortcut
LocalSessions.isVSCodeInstalled()
```

지원: vscode, cursor, zed, xcode, neovim, emacs, intellij/goland/pycharm/phpstorm/rubymine/clion/rider/webstorm/appcode, windsurf.

**왜 기깔남**: 에이전트가 변경한 파일을 사용자가 **선호하는 IDE에 1-클릭으로 띄움** → 에이전트 + 인간 페어 프로그래밍의 자연스러운 핸드오프.

**v3 시사점**: 16 editor를 일일이 지원할 필요 없음 — `xdg-open` + 사용자 설정 fallback이면 충분. 다만 **`getInstalledEditors`로 동적 표시** 패턴은 차용.

---

### B6. **Session State Tagging — `running` / `idle` / `waiting`**

코드에 가장 많이 등장: `idle` (74회), `running` (56회), `waiting` (10회). `setVisibility`로 hidden/visible 토글.

**구현 추론**: 세션마다 상태 라벨이 있고 UI가 색/배지로 표시. `waiting`은 권한 응답/SSH 비밀번호/사용자 입력 대기.

**왜 기깔남**: 사용자가 멀티 세션을 동시에 띄울 때 **어느 세션이 사람 개입 필요한지 한눈에**. `setVisibility(hidden)`은 백그라운드로 보내되 살아있게.

**v3 시사점**: v3가 `idle/running/waiting/needs-input` 4상태 모델을 명시적으로 갖고 있는지 점검. 없으면 추가.

---

### B7. **Quick Entry + Global Shortcut**

```
QuickEntry.show, hide
GlobalShortcut.setGlobalShortcut, getGlobalShortcut
QuickWindow.requestDismiss, requestDismissWithPayload, requestSkooch
```

**구현 추론**: 사용자 정의 단축키로 quickWindow 호출 → 한 줄 입력 → `requestDismissWithPayload`로 mainWindow에 메시지 전달.

**왜 기깔남**: Spotlight/Alfred-style **0-friction 진입**. 코딩 도중 발견된 의문을 IDE 안에서 바로 던지고 답 받음.

**v3 시사점**: macOS Tauri 측에 globalShortcut + 빠른 입력 창 우선순위 높임.

---

### B8. **Computer Use 컨텍스트 그라운딩 — `noteCuWindowMentions`**

```
LocalAgentModeSessions.noteCuWindowMentions(sessionId, mentions)
ComputerUseTcc.getCurrentSessionGrants()
ComputerUseTcc.listInstalledApps()
```

**구현 추론**: Computer Use 중 에이전트가 본 윈도우(예: Slack, VS Code 창)들을 노트해 두면, 후속 turn에서 LLM이 "방금 본 창의 컨텍스트"를 참조 가능. TCC grant 상태도 매 세션 단위로 isolated.

**왜 기깔남**: 화면 grounding이 단순 "최근 스크린샷"이 아니라 **app/window 단위로 라벨링**. 권한도 per-session.

**v3 시사점**: v3가 computer-use를 어디까지 갈지 별개로, **session-scoped grant** 모델 자체는 모든 권한에 적용 가능.

---

### B9. **PreToolUse Hook이 GUI에도 wire-up**

```js
hooks:{PreToolUse:[{matcher:"Task",hooks:[async ve=>{...}]}]}
hooks:{...e.hooks,PreToolUse:[...((...))??[],{matcher:[..."MultiEdit"].join("|"),hooks:[async R=>{...}]}]}
```

**구현 추론**: Claude Code의 hook 시스템(`~/.claude/settings.json`의 hooks)을 **GUI도 그대로 사용**. 즉 사용자가 CLI에서 정의한 hook이 데스크탑에서도 동작.

**왜 기깔남**: surface 간 정책 일관성. CLI에 `block dangerous bash` hook이 있으면 GUI에서도 자동 적용.

**v3 시사점**: v3가 hooks 시스템을 가질 때 **하나의 settings.json으로 모든 surface 통제**가 표준 패턴. [[verify-workflow]]에 hook 정책 추가 고려.

---

### B10. **Renderer → Main Reverse-RPC**

```
respondPluginSearch       // renderer가 main의 plugin 검색에 응답
respondDirectoryServers   // renderer가 main의 MCP discovery에 응답
respondSlashMenuSkills    // renderer가 main의 slash menu에 응답
```

**구현 추론**: 일부 검색/UI 결정은 **renderer 측 컴포넌트가 가장 잘 안다** (UI state). main이 renderer에 "yo 답 좀" 보내면 renderer가 IPC로 응답. 일반적 ipcMain.handle 흐름의 역방향.

**왜 기깔남**: UI state를 main에 push하지 않아도 됨 → renderer가 single source of truth로 남음.

**v3 시사점**: v3에 IPC가 도입될 때 이 양방향 패턴(main → renderer query)을 명시적으로 모델링.

---

## C. 확장 도구를 통한 사용성 개선

### C1. **DXT (Desktop eXTension) — 서명/allowlist/자동 업데이트 풀스택**

```
installDxt, installDxtFromDirectory, installDxtUnpacked, handleDxtFile, showInstallDxtDialog
previewExtensionInstallation, installExtensionFromPreview
isDesktopExtensionSignatureRequired, isDesktopExtensionDirectoryEnabled, refreshAllowlistCheck
getExtensionVersion(s), getIsUpdateAvailable, extensionDownloadProgress
getManifestCompatibilityResult
```

**왜 기깔남**: 확장 설치를 **preview → install → settings**의 3단으로 분리. 조직 IT가 signature 강제 + allowlist 설정 가능. quanta-v3가 향후 plugin/extension 시장을 가질 때 그대로 따라가야 할 보안 모델.

**v3 시사점**:
- `previewExtensionInstallation` 패턴 = 설치 전에 매니페스트 + tool list 보여주고 confirm.
- Manifest compatibility check (`getManifestCompatibilityResult`)는 v3가 plugin runtime API 버저닝할 때 필요.

---

### C2. **MCP 두 호스트 × 4 런타임**

| 호스트 | 위치 | 용도 |
|---|---|---|
| `directMcpHost.js` | Electron utility process, Zod 스키마 검증 | 신뢰된/번들된 MCP (빠름) |
| `nodeHost.js` | 별도 Node.js child + parentPort + MessagePort | 사용자 설치 MCP (격리 강함) |

`claude.settings.AppConfig.setIsUsingBuiltInNodeForMcp(bool)` — built-in Node 사용 여부 토글.

**지원 런타임 4종**: `python | node | binary | uv` — Python MCP는 **uv**(Astral의 빠른 Python 패키지 manager)로 부트스트랩. node/binary 외에 uv 분리는 Python 의존성 지옥을 회피하기 위한 일급 선택.

**왜 기깔남**:
- trust level에 따라 **다른 host로 라우팅**. 빠른 신뢰 path + 격리된 신규 path 양립.
- Python 부트스트랩에 uv를 일급 채택 = 사용자가 conda/pip env 안 만들어도 즉시 실행.

**v3 시사점**: v3 MCP integration이 plugin trust level별로 분리되어야 한다는 강한 시그널. **`python` 런타임은 uv 기반**으로 고정하면 사용자 마찰 0.

---

### C3. **Custom 3rd-party Setup — 24 메서드 풀 lifecycle**

```
listConfigs, readConfig, writeConfig, createConfig, deleteConfig, duplicateConfig, renameConfig, exportConfig
setAppliedConfig, getConfigHealth, recheckConfigHealth
probeMcpServer, probeEgressHosts, authorizeAndProbeMcpServer, forgetMcpOAuth
openDeviceCodeWindowForE2e, openSetupWindow, triggerBootstrapAuth, bootstrapState_$store$
getLoginDesktop3pStatus, setDeploymentMode, relaunchApp
```

**왜 기깔남**:
- Config import/export (`exportConfig`/`duplicateConfig`) = 팀 내 공유 가능.
- Health check + egress probing (`probeEgressHosts`) = 프록시 환경에서 작동 확인.
- Device code OAuth window for E2E test = QA 친화.
- Deployment mode (single/team/enterprise 추정) = 동일 앱이 다양한 배포 시나리오 커버.

**v3 시사점**: v3가 [[quanta-v3-state]] dual-provider 설정 UX 만들 때 **config CRUD + health + egress probe**를 IPC class 단위로 분리한 게 정답에 가까움.

---

### C4. **Plugin Marketplace — Local vs Remote 두 트랙**

```
CustomPlugins (16):  marketplace 검색/설치/업데이트/조직 plugin
LocalPlugins (16):   로컬 plugin OAuth + env vars + CLI shim ops
```

`getPluginShimOps`/`setPluginShimPermission`/`onCliOpAlwaysAllowed` — **plugin이 노출하는 CLI shim**도 권한 제어.

**왜 기깔남**: plugin이 단순 함수 호출이 아니라 **CLI 명령으로도 노출**, 그 명령의 권한도 세션 단위로 토글 가능. "이 plugin의 `db migrate` 명령은 항상 허용" 같은 fine-grained 룰.

**v3 시사점**: plugin 시스템이 [[codex-absorption-complete]] 흡수 범위 안에 있을 텐데, **CLI shim + always-allow 정책**까지는 v3 phase 1 범위 밖. 다만 IPC shape은 미리 모델링 가능.

---

### C5. **Skills — preview → save → sync → slash menu integration**

```
Skills.previewSkillFile(path)
LocalAgentModeSessions.{listLocalSkills, getLocalSkillFiles, saveLocalSkill, deleteLocalSkill}
LocalAgentModeSessions.{revealLocalSkill, setLocalSkillEnabled, syncSkills}
LocalAgentModeSessions.respondSlashMenuSkills    // slash menu에서 skill 자동완성

HTTP: anthropic-beta: skills-2025-10-02         // API 활성화 헤더
File: 30 MB 상한, signature 검증
```

**왜 기깔남**:
- File system 단위 (drop-in skill file)으로 추가 + 30MB 제한 + 시그너처 검증.
- **slash menu**에 자동 등록 → "/myskill" 같은 즉시 호출.
- `syncSkills` = 클라우드와 동기화.
- API beta 헤더 (`skills-2025-10-02`)로 토글 → 서버사이드 기능 게이팅과 분리.

**v3 시사점**: skills를 file system + slash menu 1급 시민으로 모델링한 게 깔끔. [[codex-absorption-complete]] ADR-0023과 일치.

---

### C6. **SSH 풀 통합 — config + trust + interactive password**

```
ensureSSHConnected, testSSHConnection
getSSHConfigs, setSSHConfigs
getTrustedSSHHosts, setTrustedSSHHosts, validateSSHPath
resolveSSHSettings, getSSHGitInfo, getSSHSupportedCommands
listSSHDirectory                         // 원격 파일 탐색
onSSHPasswordRequired, respondToSSHPassword   // 인터랙티브 비밀번호
```

**왜 기깔남**: 에이전트가 원격 호스트에서 작업할 때 **trust + 비밀번호 prompt가 IPC로 그대로 노출** → desktop UI가 직접 응답. ssh agent 의존 없이도 가능.

**v3 시사점**: v3가 원격 작업을 지원할 때 host key trust + 인터랙티브 응답 모델 필요. [[surface-model]]와 짝.

---

### C7. **GitHub + gh CLI 깊은 통합**

```
checkGhAvailable, installGh
listGhIssues, getGhIssue, ensureBranchPushed
createLocalPr, generateLocalPrContent, updatePrBody
getPrDetails, getPrChecks, getPrReviewComments, getPrStateForBranch
mergePr, enableAutoMerge, disableAutoMerge
reviewDiff
launchUltrareview
```

**왜 기깔남**: PR 생성/리뷰/머지가 전부 데스크탑에서 일관. **enableAutoMerge**까지 native IPC로 노출 — CI 통과 시 자동 머지를 1-클릭. ultrareview 시작도 GUI 버튼.

**v3 시사점**: v3 `/ultrareview` CLI 명령은 좋지만, **launchUltrareview를 IPC로 동일하게 노출**해 web surface에서도 호출 가능하게.

---

### C8. **iOS Simulator 직접 제어**

```
Simulator.{listDevices, installAndLaunch, attach, detach, gesture}
Simulator.attachment_$store$
```

**왜 기깔남**: 모바일 코드 작업 시 에이전트가 빌드 → 시뮬레이터 → **터치 제스처까지 native IPC**로 자동화. iOS 디버깅에서 UI 검증을 사람이 안 해도 됨.

**v3 시사점**: 모바일 dev 흐름이 v3에 들어오면 차용 가치 큼. 일단 시그널만.

---

### C9. **WakeScheduler — OS 깨워서 실행**

```
WakeScheduler.getStatus()                         // supported/unsupported
WakeScheduler.openSettings()
flags: wakeSchedulerEnabled, wakeSchedulerApprovedThisCycle,
       wakeSchedulerCourtesyFlippedKeepAwake, wakeSchedulerRegisteredAtVersion
```

**구현 추론**: macOS `pmset schedule wake` 또는 launchd `StartCalendarInterval`로 잠자기에서 깨워서 ScheduledTask 실행. **사용자 동의 사이클(courtesy flip)**로 잠자기 모드 처리.

**왜 기깔남**: 백그라운드 자동 작업이 노트북 슬립을 깨고 실행 → 진정한 "내 잠든 동안 일하는 에이전트". 단순 cron이 아닌 OS 통합.

**v3 시사점**: niche지만 ScheduledTask 디자인할 때 sleep wake 매커니즘은 별도 surface layer로 분리.

---

### C10. **Chrome Native Messaging 양방향**

```
ChromeExtension (3 methods)
LocalAgentModeSessions.setChromePermissionMode(mode)   // 브라우저 권한 모드
Helpers/chrome-native-host                              // Mach-O 바이너리
```

**왜 기깔남**: Chrome 확장이 데스크탑 앱에 stdio로 직접 연결. **에이전트가 사용자의 브라우저 컨텍스트(쿠키/세션)를 빌릴 수 있음** → "내 GitHub 세션으로 PR 열어"가 한 번에.

**v3 시사점**: 브라우저 통합은 v3 web surface와는 다른 축. niche이지만 RPA 측면에서 강력.

---

### C11. **Office Add-in 통합**

```
OfficeAddinFiles (11)
```

Word/Excel/PPT 안에서 Claude 사이드패널 → desktop app과 file 상태 동기화. `onAddinNeedsContext` 이벤트로 add-in이 필요한 컨텍스트를 desktop에 요청.

**왜 기깔남**: 사무직 통합. 비-코드 작업도 같은 에이전트로.

**v3 시사점**: 범위 외.

---

### C12. **인터랙티브 OAuth in-app**

```
LocalAgentModeSessions.interactiveAuth_$store$_{getState,update}
LocalAgentModeSessions.triggerInteractiveAuth, revokeInteractiveAuth
```

**구현 추론**: MCP 서버나 plugin이 OAuth 인증 필요할 때 desktop이 **별도 OAuth 윈도우**를 띄우고 콜백을 받음. 결과는 `$store$` 패턴(=Zustand-style 양방향 sync)으로 renderer에 노출.

**왜 기깔남**: terminal CLI는 OAuth 콜백을 받기 어려운데, desktop은 자체 윈도우로 처리 → MCP/plugin 도입 마찰 0.

**v3 시사점**: v3가 web surface를 가지면 동일. CLI-only일 땐 device code flow로 fallback.

---

### C13. **Observability 3-stack — Sentry × Statsig × GrowthBook**

| 스택 | 패키지 | 역할 |
|---|---|---|
| **Sentry** | `@sentry/electron`, `@sentry/node`, `@sentry/opentelemetry`, `@sentry/instrumentation` | 크래시 + 분산 트레이싱 (OTel 통합) |
| **Statsig** | (statsig-node) | A/B 실험 + dynamic config |
| **GrowthBook** | (growthbook SDK) | feature flag + targeting |

**구현 추론**: 같은 이벤트에 대해 Sentry는 디버깅용 trace, Statsig는 실험 노출, GrowthBook은 enterprise feature gate. 3 stack을 동시 운용하는 게 흥미.

**왜 기깔남**: 단일 스택 lock-in 회피. 실험(Statsig)과 운영 게이팅(GrowthBook)을 분리해서 **실험이 끝나면 깔끔하게 제거** 가능.

**v3 시사점**: v3가 OSS 지향이면 OTel + GrowthBook 정도가 정답. Sentry는 옵션.

---

### C14. **표준 도구셋 13종 — Claude Code v2와 byte-identical**

노출 도구: `Bash, Read, Write, Edit, MultiEdit, Glob, Grep, NotebookEdit, WebFetch, WebSearch, TodoWrite, Task, ExitPlanMode`.

**왜 기깔남**: GUI와 CLI가 **같은 도구셋**을 노출 → 학습 비용 0, 동작 일관. v3의 [[cc-v2-sota-absorption]] byte-identical invariant와 정확히 같은 원칙.

**v3 시사점**: 이미 [[codex-absorption-complete]] / [[cc-v2-sota-absorption]] 흡수에 반영됨 — 점검만 필요.

---

### C15. **외부 바이너리 의존도 (호출 횟수 기준)**

| 바이너리 | call count | 용도 |
|---|---|---|
| `code` | 71 | VS Code 진입 |
| `node` | 59 | MCP nodeHost, plugin shim |
| `git` | 21 | 워킹트리/PR/브랜치 |
| `ssh` | 18 | 원격 |
| `claude` | 13 | CLI 진입점 |
| `uv` | 12 | Python MCP 부트스트랩 |
| `sftp` | 9 | 원격 파일 |
| `cursor` | 5 | Cursor editor |
| `npm` | 4 | plugin 설치 |
| `gh` | 3 | GitHub PR |

**왜 기깔남**: 의존도 분포가 명확. `git`(21) + `ssh`(18) + `gh`(3) = 50회 → **코드 에이전트의 가장 hot path는 git/원격**. v3가 어디에 노력을 쏟아야 하는지의 정량 시그널.

**v3 시사점**: `uv`가 12회로 `gh`(3)보다 많은 호출 = Python MCP가 일급 시민. v3에 uv 의존 추가 검토.

---

## D. v3가 흡수할 만한 항목 우선순위

| Tier | 항목 | 이유 |
|---|---|---|
| **Tier 0 (필수)** | A1 Rewind+Fork, A2 3축 모드, A3 WIP 안전망, A5 요약 계층, A11 CLI↔GUI 양방향, B9 PreToolUse hook, C2 MCP 두 호스트, C7 PR 통합 | quanta-v3 핵심 가치 + [[surface-model]] 일관성 |
| **Tier 1 (강추)** | A4 메트릭, A6 Radar Cards, A7 Bridge Preflight, A8 Teleport, A9 Side Chat, A10 Warm Session, B6 세션 상태, B10 Reverse RPC, C3 Custom3p 24 메서드, C5 Skills 풀 lifecycle | 품질 차이를 만드는 디테일 |
| **Tier 2 (참고)** | B1 multi-window 세분, B2 reviewDiff, B5 15-editor, B7 QuickEntry, B8 CU grounding, C1 DXT, C4 marketplace, C6 SSH | 차용 패턴은 좋되 구현은 후순위 |
| **Tier 3 (범위 외)** | A6 Cowork microVM, B3 BLE 펫, B4 artifact park, C8 Simulator, C9 WakeScheduler, C10 Chrome NM, C11 Office | niche / 별도 도메인 |

---

## E. 1단계 액션 (현 sprint 흡수 후보)

1. **Rewind UX** — quanta의 [[subagent-sota-hardening]] checkpoint를 message-ID 단위 rewind/fork로 격상.
2. **WIP 안전망** — `commitWipForBranchSwitch` 동등물을 v3 git 통합 정책에 추가.
3. **PreToolUse hooks 통합** — [[verify-workflow]]에 hook 정책 명시 (lint/typecheck/test 실패 자동 retry).
4. **Plan Mode 분리** — `getPlanForSession` + `planModeInstructions` 패턴. 계획 산출물을 코드 없이 별도로.
5. **CLI ↔ Web 양방향 IPC** — `importCliSession`/`logCliEvent` 동등 IPC로 [[surface-model]] 일관성 보강.
6. **Bridge Preflight (장기)** — 원격 에이전트 도입 시점에 attestation + permission preflight 모델 채택.

## G. SOTA++ Round — 구현 깊이 발견

### G1. **Cowork microVM 게스트 — 일반 Linux 배포판이 아닌 hermetic Go runtime**

`smol-bin.arm64.img` (EXFAT, 디스크 라벨 `SDK_DAEMON`) 안에 단 3개 statically-linked ARM64 ELF 바이너리:
- **`sdk-daemon`** (~15MB) — 핵심 daemon. `github.com/mdlayher/vsock` import. gRPC: `coworkd/rpc`, `HostProxyConfigParams`, `AddApprovedOauthTokenParams`.
- **`cli-wrapper`**
- **`sandbox-helper`**

구조:
- **vsock** = host↔guest 저지연 IPC (Apple Virtualization Framework `VZVirtioSocketDevice`).
- **FUSE bindfs** = 호스트 폴더를 게스트 sandbox로 노출 (마운트 시 `/bin/mount`).
- **MITM proxy** at `/var/run/mitm-proxy.sock` = `*.anthropic.com` 요청 가로채서 inspect/modify.
- **`srt-settings.json`** allowlist = `npm`, `pip`, `github`, `anthropic`, `crates.io` 만 통과.
- **FIPS 140 compliance mode** 코드 경로 존재.

**왜 기깔남**: kernel + init도 없이 **Go 정적 바이너리만으로 부팅**. 공격 표면 극단 축소. 일반 Linux microVM(Firecracker/Krun/etc.) 대비 attack surface 1/10 수준. MITM proxy로 모든 외부 트래픽을 host가 가시화/제어.

**v3 시사점**: v3가 sandbox 코드 실행을 추가하면 "최소 게스트 = 자체 컴파일 정적 바이너리 + vsock" 패턴이 정답. Linux 배포판 마운트는 안 함.

---

### G2. **`claude-native` = Computer Use 엔진의 실체**

`/Applications/Claude 2.app/Contents/Resources/app.asar.unpacked/node_modules/@ant/claude-native/claude-native-binding.node` (Rust napi):

| capability | 기능 |
|---|---|
| 마우스 | `move/press/release/click`, scroll up/down/left/right |
| 키보드 | `Successfully typed text`, key name validation |
| 스크린 | `encode_frame_jpeg`, `data:image/png;base64` (capture+encode) |
| frameworks | AppKit, CoreGraphics, ApplicationServices, **Carbon** (legacy key event hook) |

별도 `node-pty/build/Release/pty.node` = `PtyFork/PtyOpen/PtyResize/PtyGetProc` — Anthropic이 fork하지 않은 표준 node-pty.

**왜 기깔남**: Computer Use가 별도 RPA 프레임워크가 아니라 **앱 내부 native binding** → 추가 권한 prompt 없음, latency 낮음, Carbon (deprecated)까지 동원해 키 이벤트 후킹.

**v3 시사점**: Computer Use가 v3 로드맵에 들어오면 **자체 Rust napi binding**이 정답. PyAutoGUI 같은 외부 도구로는 같은 latency/권한 통합 불가.

---

### G3. **`disclaimer` wrapper — untrusted process launch 패턴**

```js
// shell-path-worker.js 풀 발췌
function getUntrustedLaunchOptions(options) {
  if (process.platform !== "darwin") return options;
  const disclaimerPath = path.join(contentsPath, "Helpers", "disclaimer");
  return { cmd: disclaimerPath, args: [options.cmd, ...options.args] };
}
```

**`Helpers/disclaimer`** 바이너리는 단 한 줄: `posix_spawnp` + **`POSIX_SPAWN_SETDISCLAIM`** flag → child가 부모의 entitlements/sandbox 권한을 상속하지 않음. macOS 공식 sandbox 격리 기법.

사용처: **사용자 shell** (zshrc/bashrc PATH 해상도). 사용자가 zshrc에 악성 코드 심어도 Claude 앱 entitlement는 못 받음.

**왜 기깔남**: Electron 앱이 사용자 shell을 실행하는 건 광범위한 권한 위험 — Anthropic은 OS 레벨 격리로 정면 해결.

**v3 시사점**: v3 CLI/shell 통합 시 사용자 shell 부팅을 **반드시 untrusted 모드로**. `disclaimer` 동등물 Linux/Windows 대응은 별도 layer 필요 (Linux: bwrap, Windows: AppContainer).

---

### G4. **Transcript Search Worker — SQLite FTS5가 아니라 line-by-line JSONL scan**

`transcript-search-worker/transcriptSearchWorker.js` (110줄):
```js
const SNIPPET_RADIUS = 80;
async function scanFile(session, needle, messageTypes) {
  const stream = fs.createReadStream(session.transcriptPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    const parsed = JSON.parse(line);
    if (!messageTypes.has(parsed.type)) continue;
    const text = extractText(parsed.message?.content);
    const idx = text.toLowerCase().replace(/\s+/g, " ").indexOf(needle);
    if (idx !== -1) { snippet = makeSnippet(...); break; }
  }
}
```

JSONL 라인 스트리밍 + 첫 매치 후 break + 80-char radius 스니펫. SQLite/FTS5 안 씀.

**왜 기깔남(역설)**: "당연히 FTS5일 거"라는 예상을 깬다. **세션이 작아서 라이브 스캔이 빠르다**는 의미 — 세션 transcript 자체가 commit log처럼 append-only JSONL이라 인덱싱 부담 0. 단순함이 SOTA.

**v3 시사점**: v3 transcript 형식이 JSONL append-only면 검색 worker도 같은 패턴 차용. 인덱스 유지 비용 0.

---

### G5. **Preload Bridge — 9 surface + 강한 origin allowlist**

`mainView.js` (180KB) 가 노출하는 9개 `contextBridge.exposeInMainWorld` 키:

```
claudeAppBindings        // registerBinding(name, callback) 동적 IPC 채널 등록기
claudeAppSettings        // 설정 store
buddyBle                 // BLE 펫
desktopBootFeatures      // 사용 가능 feature flag
desktopEnterpriseConfig  // org config
desktopNestLocalUsername // Nest surface 진입
desktopTelemetryConfig   // Sentry/GrowthBook/Statsig DSN 동적 주입
electronIntl             // i18n
electronWindowControl    // window 제어
```

**origin allowlist** (preload 진입 차단):
```
https://claude.ai, https://preview.claude.ai
https://claude.com, https://preview.claude.com
localhost, app://localhost
*.ant.dev (staging)
```

**왜 기깔남**:
- `claudeAppBindings.registerBinding(name, fn)` = **renderer가 동적으로 IPC 채널 listener 등록**. 600+ method 모두 generic register 위로 흐름.
- origin 검사를 webFrame routingId/frameToken 비교까지 더해 iframe 사칭 방어.
- DSN을 코드에 안 박고 **`desktopTelemetryConfig`로 런타임 주입** → 빌드 1개로 staging/prod/enterprise 분리.

**v3 시사점**: v3 web surface(Tauri)도 동일 패턴 — `__TAURI_INVOKE__` 위에 generic register + origin allowlist. 빌드 1개로 환경 분기.

---

### G6. **Enterprise Auth — 22+ `ANTHROPIC_*` env**

| 그룹 | 변수 |
|---|---|
| Core | `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_LOG`, `ANTHROPIC_VERSION`, `ANTHROPIC_MODEL` |
| **Bedrock (AWS)** | `ANTHROPIC_BEDROCK_BASE_URL`, `ANTHROPIC_BEDROCK_SERVICE_TIER` |
| **Vertex (GCP)** | `ANTHROPIC_VERTEX_BASE_URL`, `ANTHROPIC_VERTEX_PROJECT_ID`, `ANTHROPIC_SERVICE_ACCOUNT_ID` |
| **Foundry (Azure AI Foundry)** | `ANTHROPIC_FOUNDRY_API_KEY`, `ANTHROPIC_FOUNDRY_BASE_URL`, `ANTHROPIC_FOUNDRY_RESOURCE` |
| **OIDC Federation** | `ANTHROPIC_IDENTITY_TOKEN`, `ANTHROPIC_IDENTITY_TOKEN_FILE`, `ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID`, `ANTHROPIC_SCOPE`, `ANTHROPIC_PROFILE` |
| **3-tier model override** | `ANTHROPIC_DEFAULT_HAIKU_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION` |
| **Custom model** | `ANTHROPIC_CUSTOM_MODEL_OPTION_NAME`, `..._DESCRIPTION` |
| Config | `ANTHROPIC_CONFIG_DIR`, `ANTHROPIC_CUSTOM_HEADERS` |

특기:
- **Azure AI Foundry 1급 지원** = AWS/GCP/Azure 3대 클라우드 inference 트라이얼.
- **`IDENTITY_TOKEN_FILE`** = Kubernetes/GKE projected SA token 파일 직접 읽기 (k8s workload identity 통합).
- **`SMALL_FAST_MODEL_AWS_REGION`** = Haiku는 별도 region 라우팅(다른 region이 더 싸거나 빠르거나).
- "FEDERATION_RULE_ID (profile takes precedence)" = profile config > env > default 3단 우선순위.

**왜 기깔남**: Anthropic이 enterprise inference 라우팅을 **단일 CLI/desktop**으로 다 흡수. 다중 클라우드 SaaS 의존성을 cli env 22개로 환원.

**v3 시사점**: v3 dual-LLM provider 설계 ([[quanta-v3-state]])에 **3-tier model override + region split + token file** 패턴 차용. provider-agnostic 추상이 정답.

---

### G7. **Hook Wire-up — `AWF_GUARDED_TOOLS_MATCHER`**

```js
AWF_GUARDED_TOOLS_MATCHER = "Read|Write|Edit|MultiEdit|NotebookEdit|Grep|Glob"
hooks: { PreToolUse: [
  { matcher: "Task", hooks: [async ve => { ... }] },                        // sub-agent 가드
  { matcher: AWF_GUARDED_TOOLS_MATCHER, hooks: [async t => { ... }] }       // FS-touching 도구 가드
]}
```

**AWF** = Anthropic Workflow Framework (대문자 약자). 두 종류 hook이 빌트인:
1. `Task` matcher → sub-agent 호출 직전 가드 (sub-agent 정책 enforcement)
2. `Read|Write|Edit|MultiEdit|NotebookEdit|Grep|Glob` → 모든 FS-touching 도구 직전 가드 (trust 경계 검증)

**왜 기깔남**: 두 categorization이 본질적으로 다름 — sub-agent 분기는 정책 layer, FS 도구는 경계 layer. 한 hook system이 둘 다 처리.

**v3 시사점**: v3 hooks가 `Task` matcher와 FS-도구 matcher를 **분리해서 wire-up**해야 [[verify-workflow]] enforcement가 자연스러움. matcher pattern이 정규식인 점도 차용.

---

### G8. **Observability — Sentry release pinning + GrowthBook integration**

- **Sentry SENTRY_RELEASE** = `ca0c62bc1d73c3f4d2f37816bd25565587fb4443` (이 빌드의 git commit) — 빌드별 release pin → 어느 commit에서 발생한 에러인지 1-to-1 추적.
- **debug ID** `594a4e3e-2dd6-479f-9f8d-04ab813825aa` — 빌드별 고유 ID.
- **Sentry stack**: `@sentry/electron, @sentry/node, @sentry/opentelemetry, @sentry/instrumentation` 4종 layered.
- **GrowthBook** = class-level integration (`growthbookClass`, `growthbookEmitter`, `growthbookIntegration`) — A/B/feature flag.
- **Statsig** = `statsigIntegration` class만 노출, IPC 없음 → main-only.

**왜 기깔남**: 3 stack 분리 + commit SHA 단위 pin. 단일 telemetry endpoint lock-in 회피. Sentry는 crash, GrowthBook은 flag, Statsig는 experiment.

**v3 시사점**: v3가 telemetry 도입할 때 commit SHA pin 필수. release 추적 불가능하면 prod 디버깅 지옥.

---

### G9. **HTTP Header / Beta Channel 카탈로그**

**14 anthropic-* custom headers**:
```
anthropic-version           anthropic-client-platform
anthropic-api-key           anthropic-client-version
anthropic-admin-api-key     anthropic-client-os-platform
anthropic-beta              anthropic-client-os-version
anthropic-client-app        anthropic-device-id
anthropic-client-feature    anthropic-workspace-id
anthropic-telemetry         anthropic-marketplace
anthropic-mcp-registry      anthropic-plugins
anthropic-skills            anthropic-desktop-topbar
anthropic-dangerous-direct-browser-access
```

**3 beta channels** (활성화에 별도 헤더 값 필요):
- `environments-2025-11-01` — **Environments API** (신규, Cowork/sandbox 관련 추정)
- `oauth-2025-04-20` — OAuth 신 흐름
- `skills-2025-10-02` — Skills API

**왜 기깔남**:
- `anthropic-dangerous-direct-browser-access` = 클라이언트가 직접 (CORS bypass) 액세스함을 self-attest → 서버는 이 헤더 없이는 dangerous path 거부.
- `anthropic-workspace-id` = 한 사용자가 여러 워크스페이스/조직 동시 액세스.
- `anthropic-mcp-registry` 헤더가 **MDM key `disableNonessentialServices`로 게이팅** → IT 관리자가 끄면 MCP registry 통신 차단.

**v3 시사점**: v3가 자체 API 가지면 `dangerous-*` self-attest 헤더 패턴 차용 — 보안 책임을 클라이언트가 명시.

---

### G10. **Streaming Event Schema (Anthropic 표준)**

코드에 6개 이벤트 명시:
```
message_start, message_delta
content_block_start, content_block_delta
tool_use, tool_result
+ "rate_limit", "rate_limit_event"
```

`status === 429` + `"retry-after"` 헤더 처리 + `maxRetries` (path별 0/2/3/5 다름).

**왜 기깔남**: 한 클라이언트가 **path별 maxRetries를 다르게** — 모델 추론은 3-5회, 도구 호출은 0회, 메타 호출은 2회. 통계적으로 더 합리적.

**v3 시사점**: retry 정책을 호출 종류별로 분리 — global maxRetries는 안티 패턴.

---

### G11. **Built-in Slash Commands — Anthropic 노출 5종**

```
/context   "Show what's using your context window"
/usage     "Show your Claude Code usage"
/color     "Set this session's prompt-box glow color"
/navigate  "Navigate to a URL, or go forward/back in browser history"
/wait      "Wait for a specified duration"
```

`/navigate`는 browser-bridge MCP 의존 — "If you don't have a valid tab ID, use `tabs_context_mcp` first to get available tabs". 즉 **에이전트 자체가 슬래시 명령을 호출하면서 MCP를 통해 브라우저 탭 컨텍스트를 가져옴**.

**별도 발견**: `claude-mcp-browser-bridge`, `browser_batch`, `tabs_context_mcp` = 번들된 브라우저 MCP. Computer Use 외에 일반 브라우저 자동화도 MCP 추상화.

**왜 기깔남**: `/color`(취향) + `/context`(메타) + `/wait`(스케줄) + `/navigate`(컴퓨터 사용)이 한 평면 — **모드와 능력 구분 없음**. 사용자 입장에선 균일.

**v3 시사점**: v3 슬래시 명령 카탈로그가 부족하면 차용. 특히 `/context`는 [[cc-v2-sota-absorption]] §1.2 <20k와 직결.

---

### G12. **API Host 풀 — Multi-region + Multi-environment + Multi-product**

| 호스트 | 용도 |
|---|---|
| `api.anthropic.com`, `api-staging.anthropic.com` | core API |
| `claude.ai`, `claude.com`, `preview.claude.ai`, `preview.claude.com` | web app + preview |
| `claude-staging.fedstart.com`, `claude.fedstart.com` | **FedStart 정부/규제 클라우드** |
| `platform.claude.com/oauth/{authorize,code/callback}` | platform OAuth |
| `console.anthropic.com/oauth/code/callback` | console OAuth |
| `claude-ai.staging.ant.dev` | dev/staging |
| `mcp-proxy.anthropic.com` | **MCP HTTP 프록시** (사용자 측 stdio MCP를 HTTP로 리프트) |
| `microsoft365.mcp.claude.com/mcp` | MS365 MCP |
| `pivot.claude.ai/manifest.xml` | Office Add-in manifest |
| `anthropic.enterprise.slack.com` | Slack enterprise app |
| `downloads.claude.ai/{claude-code,claude-ssh,vms/linux}-releases` + `releases/darwin/universal/` | 4 download channel |
| `support.anthropic.com` | support docs |

**왜 기깔남**:
- **FedStart** 도메인 노출 = 정부 클라우드 (FedRAMP/IL5 인증) 별도 환경.
- **`mcp-proxy.anthropic.com`** = 사용자 측 MCP를 Anthropic 측 HTTP 엔드포인트로 리프트 → 클라이언트 LB 사용 + 인증 통합.
- 4개 분리된 download channel = 컴포넌트별 release cadence 분리.

**v3 시사점**: 환경 라우팅(prod/staging/preview/gov)을 단일 enum + base URL 함수로 추상화 — 14곳에 흩어진 host를 단일 origin resolver로 모음.

---

### G13. **MDM 게이트 패턴**

`anthropic-mcp-registry` HTTP 헤더 = `{ mdmKey: "disableNonessentialServices" }` 게이팅.

발견된 비슷한 게이트:
- `disableEssentialTelemetry`, `disableNonessentialTelemetry`, `disableNonessentialServices` (3-tier telemetry opt-out)
- `disableAutoReconnect`, `disableAutoUpdates`, `disableSessionsDiskCleanup`
- `secureVmFeaturesEnabled` (Cowork VM 게이트, profile-only)
- `hardwareBuddyEnabled`, `isDxtEnabled`, `isDxtDirectoryEnabled`, `isDxtAutoUpdatesEnabled`
- `isUsingBuiltInNodeForMcp`

조직 IT가 macOS configuration profile로 `mdmKey`를 강제할 수 있고, 사용자는 끌 수 없음 — **enterprise 정책의 표준 통합**.

**v3 시사점**: v3가 enterprise 시장 진입 시 MDM-controllable preferences 분리가 필수. `mdmKey` 마커를 preference schema에 일급 표현.

---

### G14. **Cowork Memory Sync — 충돌 해결 + 대량삭제 거부**

22개 이벤트 (`cowork_memory_sync_*`) 시퀀스:
```
started, push, push_ok, push_conflict, push_conflict_exhausted, push_error
push_refused_mass_delete, push_rejected
pull, pull_applied, pull_empty, pull_not_modified, pull_overwrote_local
conflict_pulled
ensure_space_store_invalid_id, space_store_added
state_file_missing, state_persist_failed, state_read_failed, state_stat_failed, state_unreadable
stopped, unavailable
```

**`push_refused_mass_delete`** = **클라이언트가 갑자기 대량 삭제하면 서버가 거부**. 동기화 버그/공격으로 메모리 wipe되는 사고 방지.

**왜 기깔남**: 분산 시스템의 "thunderbolt prevention". CRDT 식 머지 + heuristic guard 결합.

**v3 시사점**: v3가 memory sync 추가할 때 mass-delete guard는 무조건 필수. 단순 last-writer-wins는 위험.

---

### G15. **Squirrel 자동 업데이트 — 4 signal**

```
--squirrel-install
--squirrel-updated
--squirrel-obsolete
--squirrel-uninstall
```

`autoUpdater.setFeedURL` + `checkForUpdates` + `quitAndInstall`. Squirrel.framework가 install/update/obsolete/uninstall lifecycle 신호를 main에 전달 → app이 first-run, post-update, deprecated, uninstalling 분기.

ownership fix 흐름 (i18n: "This app's file ownership is preventing auto-updates from working smoothly. Claude needs to fix the ownership, which requires administrator access. You'll be prompted for your fingerprint or password.") = sudo Touch ID 흐름까지 통합.

**왜 기깔남**: 자동 업데이트가 "ownership 깨짐" edge case까지 처리. 보통 silent fail.

**v3 시사점**: macOS Tauri/Electron 어느 쪽이든 ownership/codesign 충돌 처리 흐름은 미리 설계.

---

## H. 최종 우선순위 갱신 (SOTA++ 통합)

| Priority | 새로 추가 | Why |
|---|---|---|
| **Tier 0 추가** | G3 disclaimer 패턴(untrusted shell launch), G7 AWF hook matcher 분리, G6 token-file federation | 보안 invariant — 빠질수록 점점 어려워짐 |
| **Tier 1 추가** | G5 preload bridge origin allowlist, G6 3-tier model override, G9 path별 maxRetries, G14 mass-delete guard, G13 mdmKey 마커 | 운영 품질 |
| **Tier 2 추가** | G4 JSONL stream search (단순), G10 streaming schema, G11 built-in slash 5종, G12 host resolver | 차용 패턴 |
| **Tier 3** | G1 Go runtime guest VM, G2 Carbon-level computer use, G8 4-stack Sentry, G15 ownership fix | niche 또는 별도 도메인 |

## I. Round 4 — OS 통합 + MCP 런타임 풀스택

### I1. **`directMcpHost.js` 15,879줄 = 완전한 MCP 런타임 (단순 Zod 래퍼 아님)**

핵심 클래스:
- `Protocol` (라인 5015) — `_requestHandlers`/`_notificationHandlers`/`_responseHandlers` 맵 + ID 증분
- `Client` (12865), `Server` (15342) — Protocol 상속
- `MessagePortServerTransport` (15859) — Electron MessagePort 기반 main↔utility IPC, payload `{type:"mcp", message}`
- `AjvJsonSchemaValidator` (12588) — **AJV 기반** (Zod와 별개로 JSON Schema spec 풀 지원). `$id` 캐시.

**MCP 표준 메서드**: `tools/{list,call}`, `resources/{list,read}`, `prompts/{list,get}`, `roots/list`, `ping`, `initialize`, `initialized`.

**Anthropic 자체 확장 (MCP spec 너머)**:
| 확장 | 메서드 | 용도 |
|---|---|---|
| **Tasks API** | `tasks/{list,get,result,cancel}` | 장기 실행 작업 비동기 상태 추적 (`TaskStore` + `TaskMessageQueue`) |
| **Sampling** | `sampling/createMessage` | Server → Client 역방향 (MCP 표준이지만 풀 통합) |
| **Elicitation** | `elicitation/create` | 사용자 입력 요청, **form-mode + url-mode** + OAuth |
| **Streaming** | `requestStream()` AsyncGenerator | `callToolStream`이 `outputSchema`로 structured output 검증 |
| **OAuth** | 14개 에러 클래스 + WWW-Authenticate 파싱 | `403 insufficient_scope` → 자동 scope upscope 재인증 |
| **Notifications** | `notifications/{progress,cancelled,tasks/status,elicitation/complete,...}` | server-initiated 비표준 알림 |

**흥미로운 패턴**:
- `_listChangedDebounceTimers` Map — tools/resources 변경 알림 폭주 방지.
- TaskMessageQueue — SSE 재연결 시 메시지 손실 방지.
- `registerCapabilities()`가 transport 연결 **전에만** 호출 가능 (immutable capabilities).

**왜 기깔남**: MCP를 단순 "tool list + tool call" 정도로 쓰는 게 아니라 **OAuth + Elicitation + 장기작업 + Streaming까지 다 wire-up**한 풀스택. 한 MCP server가 사용자에게 OAuth 콜백 받고, 5분짜리 작업 돌리고, 결과를 stream하고, 중간에 progress 알림하고, 실패 시 scope를 자동 upgrade하는 시나리오가 표준.

**v3 시사점**:
- v3 MCP는 적어도 **Tasks + Elicitation**까지 가야 long-running tool이 쓸 만함.
- AJV vs Zod 두 검증기 동시 운용 — JSON Schema 표준 호환성 + Zod 타입 추론 양립.
- `MessagePort` 패턴은 Electron utility process 격리의 정석.

---

### I2. **OS 통합 풀스택**

**App 메타데이터**:
| 항목 | 값 |
|---|---|
| Bundle ID | `com.anthropic.claudefordesktop` |
| Team ID | `Q6L2SF6YDW` (Anthropic PBC) |
| Profile name | `Claude Desktop Developer ID` |
| 서명 방식 | **Developer ID (App Store 아님)** — Anthropic 직접 배포 |
| Provisioning 유효 | 2026-04-30 ~ **2044-04-25 (18년)** |
| `LSApplicationCategoryType` | `public.app-category.developer-tools` |
| `NSUserActivityTypes` | **`com.anthropic.claude.code.session`** — Handoff 활성화 |

**URL Scheme**: `claude://` (1개).

**Document Types**: `.dxt` (Desktop Extension), **`.mcpb`** (MCP Bundle), `.skill`.

**Entitlements (11종)**:
- `cs.allow-jit` (V8 JIT 컴파일)
- `device.{audio-input, camera, bluetooth, usb, print}`
- `personal-information.{location, photos-library}`
- **`virtualization`** (Cowork VM)
- `application-identifier` + `team-identifier`

**왜 기깔남**:
- **18년 유효 provisioning** = Anthropic이 인증서 manual 갱신 부담을 18년 단위로 미룸.
- **App Store 아님** = sandbox 우회 가능, 더 강한 권한 (특히 `virtualization`).
- **Handoff 통합** = Mac ↔ iPad 사이 세션 이어받기 (`NSUserActivityTypes`).
- **`.mcpb` 파일 타입** = MCP가 OS-레벨 파일 포맷으로 등록 — Finder 더블클릭으로 설치.

**v3 시사점**:
- macOS Tauri 측 v3 surface에 **Handoff `NSUserActivityTypes` 일찍 등록** — 모바일 surface 추가 시 무료.
- `.mcpb`/`.dxt` 같은 **OS-등록 파일 포맷**은 신뢰의 시그널. v3가 plugin/extension 가지면 동등.

---

### I3. **userData 디스크 레이아웃 — `~/Library/Application Support/Claude/`**

```
Claude/
├── claude-code/2.1.138/                # 별도 SDK 패키지 (v2.1.138)
│   └── .verified                       # 검증 마커
├── claude-code-sessions/               # 세션 데이터
├── claude-code-vm/2.1.138/claude       # VM용 동일 SDK
├── local-agent-mode-sessions/          # Agent Mode 세션 (LocalAgentModeSessions surface)
├── vm_bundles/claudevm.bundle/         # Cowork VM 본체
│   ├── rootfs.img.zst                  # 압축 rootfs
│   ├── rootfs.img                      # 전개 rootfs
│   ├── sessiondata.img                 # 별도 disk (세션 데이터 격리)
│   ├── vmIP                            # 할당 IP
│   ├── machineIdentifier               # VM 고유 ID
│   └── gvisorMacAddress                # gVisor MAC (Google gVisor 추정)
├── claude_desktop_config.json          # 사용자 설정 (top-level: preferences, apiKeys)
├── Cookies, Trust Tokens               # SQLite (Chromium)
├── Session Storage, IndexedDB          # LevelDB (Chromium)
├── GPUCache, DawnGraphiteCache, Code Cache, WebStorage  # Chromium 표준 캐시
├── Crashpad/settings.dat               # 크래시
├── sentry/                             # Sentry 로컬 큐
└── shared_proto_db/                    # Protocol Buffer LevelDB

~/Library/Logs/Claude/
├── main.log                            # Electron main
├── claude.ai-web.log                   # ion-dist 측
├── ssh.log                             # claude-ssh
├── coworkd.log                         # 게스트 daemon (호스트 측 mirror)
├── cowork_vm_node.log                  # ★ VM 측 Node 서비스
├── cowork_vm_swift.log                 # ★ VM 측 Swift 서비스
└── unknown-window.log
```

**Key 발견**:
1. **`claude-code/2.1.138/` SDK가 userData에 별도 설치** = 앱 업데이트와 분리된 cadence로 CLI 패키지 업데이트. 코드 v2.1.138.
2. **VM이 dual-daemon**: `cowork_vm_node` + `cowork_vm_swift` = Node.js와 Swift 두 service가 게스트 안에서 동시 동작 (Agent 1 분석의 Go runtime은 sdk-daemon만이고, Node/Swift는 추가 서비스).
3. **`gvisorMacAddress`** = gVisor 격리 사용 가능성 (Google 컨테이너 sandbox). 아니면 게스트 내부 networking VIP.
4. **`rootfs.img.zst` + `rootfs.img`** 둘 다 보관 = 첫 부팅에 전개 후 캐시.
5. **`sessiondata.img`이 rootfs와 분리** = rootfs는 read-only 베이스, 세션 데이터만 변경 가능 (COW 패턴).

**v3 시사점**:
- v3가 CLI를 patch 단위로 배포할 때 userData 측 SDK 디렉터리 분리가 정답.
- VM disk 설계 시 rootfs (RO) + sessiondata (RW) 분리가 표준.
- 로그를 main/web/ssh/cowork-host/cowork-vm-node/cowork-vm-swift로 6분리 = 디버깅 시 노이즈 격리.

---

### I4. **Bridge WebSocket — 격리 도메인 + 5단계 Trust Scope**

**Bridge endpoint**:
- `wss://bridge.claudeusercontent.com` (prod)
- `wss://bridge-staging.claudeusercontent.com` (staging)
- `wss://localhost` (dev)

**`claudeusercontent.com`** = `anthropic.com`과 별도 도메인. **사용자 콘텐츠 격리 origin** (GitHub의 `githubusercontent.com`과 같은 패턴). cookie/CSP/CSRF 측면에서 main API와 완전 격리.

**Trust scope 5단계** (`saveTrust(scope)` 인자):
```
always_allow > project > workspace > session > deny
```

`once_only`도 별도 enum으로 존재 (한 번만 허용 = scope 저장 안 함).

**왜 기깔남**:
- Bridge가 별도 도메인 = bridge 측 XSS가 메인 API 토큰 못 훔침.
- Trust scope를 **공간(project/workspace) × 시간(session/always)** 매트릭스로 표현 → 사용자 멘탈 모델 깔끔.

**v3 시사점**:
- v3 web surface가 사용자 콘텐츠 호스팅하면 별도 origin 사용 ([[surface-model]] 보안 보강).
- Trust scope 5단계는 v3 권한 모델의 정답에 가까움.

---

### I5. **System Prompt — append + section cache**

```js
systemPrompt: ...this.initConfig.systemPrompt
systemPromptAppend: ...
systemPromptSectionCache: new Map()
```

- **`systemPrompt`** = base (Anthropic 기본).
- **`systemPromptAppend`** = 사용자 추가 (CLAUDE.md, project 컨벤션 등).
- **`systemPromptSectionCache`** = 섹션 단위 캐싱 → Anthropic prompt cache 헤더(`cache_control`)와 짝.

**왜 기깔남**: prompt를 monolithic이 아니라 **section composable**로 다루고 그 단위로 캐싱 → prompt cache hit ratio 극대.

**v3 시사점**: v3 system prompt를 section 배열로 (base + project + session + append) 분리, 각 section에 cache key 부여. [[cc-v2-sota-absorption]] §1.2 prompt cache 흐름과 직결.

---

### I6. **WSS bridge + Tasks API = "능동 에이전트"의 기술 토대**

I1의 **MCP Tasks API**와 I4의 **Bridge WSS**가 합쳐서 무엇을 가능하게 하는지:
1. 사용자가 desktop에서 작업 시작 → bridge로 원격 환경에 task 푸시.
2. 원격이 `tasks/get`/`tasks/result`로 진행 상황 폴링.
3. 진행 중 `notifications/progress`로 desktop UI 업데이트.
4. 결과는 SSE 끊겨도 TaskMessageQueue에 보관 → 재연결 시 ack 후 drain.
5. 작업 중 추가 OAuth 필요? → `elicitation/create` (url-mode)로 사용자 브라우저 열기.

즉 [3.6 Background Task Suggestions (Radar)](#a6-background-task-suggestions-radar-cards) 의 백엔드 구현이 정확히 이 stack.

**v3 시사점**: Radar 같은 능동 제안 surface를 가지려면 Tasks API + Bridge WSS + Elicitation 3종 셋트가 필요. 어느 하나 빠지면 idle 상태에서 사용자 입력 받아 안전하게 OAuth flow 띄울 방법이 없음.

---

## J. 최종 종합 — v3가 흡수할 12개 invariant

이 모든 분석에서 추출한 **변하지 않아야 하는** v3 설계 원칙:

1. **메시지 ID 단위 rewind/fork** — 시간여행은 사용자의 마지막 안전망 (A1).
2. **5×5 직교 모드** — model × effort × permission × fastMode × visibility 4-5축은 절대 합치지 말 것 (A2).
3. **WIP commit은 자동, discard는 명시 확인** — `commitWipForBranchSwitch` 패턴 (A3).
4. **session boundary = git checkpoint** — invariant (A3, B6).
5. **CLI ↔ GUI 동일 settings + 동일 hooks** — surface 일관성 (A11, B9).
6. **MCP 두 호스트 × 4 런타임** — trust × runtime 직교 (C2).
7. **시스템 도구는 PreToolUse hook으로 wire-up, matcher 정규식 분리** — Task vs FS-touching (G7).
8. **사용자 shell launch는 untrusted 격리** — disclaimer 패턴 (G3).
9. **enterprise OIDC + token file + 3-tier model + region override** — 한 클라이언트로 multi-cloud (G6).
10. **MDM mdmKey 마커가 preference schema에 일급** (G13).
11. **bridge 같은 사용자 콘텐츠 endpoint는 별도 origin** (I4).
12. **system prompt는 section 배열 + 각 section 단위 cache** (I5).

이 12개는 후속 변경이 와도 깨지면 안 되는 부분. v3 ADR에 명문화 권장.

## F. 원본 데이터

- 코드 에이전트 surface 209 메서드: `/tmp/ipc-methods.txt`에서 LocalSessions/LocalAgentModeSessions/CCDScheduledTasks 필터.
- Enum 값 풀: permission `default|acceptEdits|bypassPermissions|plan|skip_all_permission_checks`, effort `low|medium|max`, session state `idle|running|waiting`, visibility `hidden|visible`, card `dismissed|adopted|engaged`, wake `supported|unsupported`.
- Bridge 이벤트 9종: `bridge_event_attestation, bridge_message_receive(+ parse_failed), bridge_permission_posted, bridge_permission_resolved, bridge_session_status, bridge_socket_error, bridge_state, bridge_timeout`.
- 지원 에디터 15+: vscode, cursor, zed, xcode, neovim, emacs, intellij/goland/pycharm/phpstorm/rubymine/clion/rider/webstorm/appcode, windsurf.
- claude:// deep-link 라우트: `/cowork, /code, /sessions, /authorize, /healthcheck, /usage, /update, /sso-callback, /shared-artifact, /remote-control, /disclaimer, /worker, /stream, /properties, /tmp, ...`.
