# IDE 통합 + LSP/Diagnostics

VS Code / JetBrains 익스텐션 연결, 인에디터 diff 뷰어, 그리고 언어 서버 진단(diagnostics)을 모델 컨텍스트로 되먹이는 경로를 다룬다. 핵심은 **"Claude가 파일을 편집 → IDE/LSP가 새 에러를 감지 → 다음 턴 `<diagnostics>` system-reminder로 주입 → 모델이 스스로 수정"** 루프가 실제로 코드에 존재한다는 점이다 (확인).

문서 표기: minified 토큰은 `백틱`, 글로서리 등재분은 `직관이름(\`min\`)` 병기.

---

## 1. 호출 그래프

### 1.1 IDE 연결 (lockfile 기반 포트 디스커버리)

```
IDE 익스텐션 (VS Code / JetBrains)
  └─ 부팅 시 ~/.claude/ide/<port>.lock 작성
       { workspaceFolders[], pid, ideName, transport:"ws"|..., runningInWindows, authToken }

claude.exe 측:
  rgH(workspace)                      // IDE lockfile 스캔 + 매칭
   ├─ W$5()                           // lockfile 디렉토리 목록 산출
   │    ├─ x6()/"ide"  (= ~/.claude/ide 또는 $CLAUDE_CONFIG_DIR/ide)
   │    └─ WSL: /mnt/c/Users/<user>/.claude/ide  (P$5/toLocalPath)
   ├─ W86()                           // *.lock 파일 enumerate, mtime desc 정렬
   ├─ rq7(lockPath)                   // 개별 lockfile 파싱 → {port,pid,ideName,
   │                                  //   useWebSocket,workspaceFolders,authToken}
   ├─ $CLAUDE_CODE_SSE_PORT 우선 매칭  // 명시 포트가 있으면 그 lock 선택
   └─ workspaceFolders ∩ cwd 매칭 + xj8(host,port) TCP 살아있음 체크

  → MCP 서버 config 합성:
      { type:"ws-ide",  url:"ws://127.0.0.1:<port>", ideName, authToken,
        ideRunningInWindows }   (useWebSocket=true)
      { type:"sse-ide", url:..., ideName, ideRunningInWindows }  (그 외)

  Cy(name,config) (MCP connect, ef.js:15072)
   ├─ type==="ws-ide": new WebSocket(url, {protocols:["mcp"],
   │     headers:{"X-Claude-Code-Ide-Authorization": authToken}})  → Uj6 transport
   ├─ type==="sse-ide": CH6 SSE transport (인증 헤더 없음)
   └─ 연결 성공 → tengu_mcp_ide_server_connection_succeeded
                  + aq7(client)  // ide_connected notification 송신
```

연결된 IDE는 `clients` 배열에 `name:"ide"`(또는 `"claude-vscode"`)로 등록된다. 조회 헬퍼:

- `FI(clients)` — `type==="connected" && name==="ide"`인 클라이언트 반환 (ef.js:6386298)
- `GY_(clients)` / `Bj8` — IDE 표시 이름 산출 (`sse-ide`/`ws-ide` config의 `ideName`, 없으면 터미널 추론) (ef.js:6385859)
- IDE가 노출하는 MCP 도구 화이트리스트: `TO3 = ["mcp__ide__executeCode","mcp__ide__getDiagnostics"]` (ef.js:15072, **확인**)

stale lockfile 정리: `Z$5()`가 lockfile마다 `pid` 생존(`iq7`) + 포트 TCP(`xj8`) 검사 후 죽은 것 `unlink` (ef.js:6379415 근방).

### 1.2 익스텐션 자동 설치 / 자동 연결

설정 기본값 (ef.js:4440550 근방, **확인**):

```
autoConnectIde: false          // IDE 자동 연결 (opt-in)
autoInstallIdeExtension: true  // 익스텐션 자동 설치 (opt-out)
diffTool: "auto"
externalEditorContext: false   // 외부 에디터 선택/열린파일 컨텍스트 주입 (opt-in)
```

자동 설치 경로 `K97(...)` (ef.js:6386 근방):

```
K97:
  v_().autoInstallIdeExtension ?? true
  && !$CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL
  → lgH() 로 IDE 종류 탐지 → P86(ide) 설치필요? → gq7(ide) → G$5(ide)

G$5(ide):                                   // ef.js:6379538
  L$5(ide)  // code --install-extension / JetBrains plugin 설치
  d("tengu_ext_installed")  +  EH("ide_extension_install")
  실패 → d("tengu_ext_install_error")
  설치 직후 diffTool 미설정이면 diffTool:"auto" 강제
```

`Skip` 환경변수: `CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL`, `CLAUDE_CODE_IDE_SKIP_VALID_CHECK`.

### 1.3 인에디터 diff 뷰어

```
Edit/Write 도구 (또는 거부 diff)
  └─ openDiff 경로 (ef.js:10177146)
       FI(clients) 로 IDE client 획득 (없으면 throw "IDE client not available")
       WSL+runningInWindows 시 경로 변환 (cgH.toIDEPath)
       Bn("openDiff", {old_file_path,new_file_path,new_file_contents,tab_name}, client)
        └─ 응답 분기:
            _93(resp) → 사용자가 IDE에서 수정 후 수락 → {newContent: resp[1].text}
            eq3(resp) → 그대로 수락               → {newContent: 제안값}
            H93(resp) → 거부                       → {newContent: 원본}
       q97(client) = Bn("closeAllDiffTabs",...)   // 쿼리 시작 시 잔여 탭 정리
```

`tengu_ext_will_show_diff` / `tengu_ext_diff_accepted` / `tengu_ext_diff_rejected` 텔레메트리 (확인).

### 1.4 IDE → 모델 컨텍스트 주입 (system-reminder attachment)

`SnH`(`SnH`, attachment 생성기)가 매 턴 attachment 배열을 만들고 `makeAttachmentMessage(\`T9\`)`로 `<system-reminder>` user 메시지화한다. IDE 연결(`j`=IDE 활성) 시 활성화되는 attachment 슬롯 (ef.js:10241400 근방, **확인**):

```
o$("ide_selection",     e93)   // 에디터 현재 선택 영역
o$("ide_opened_file",   q73)   // 에디터 현재 열린 파일
o$("diagnostics",       W73)   // IDE-MCP getDiagnostics 델타
o$("lsp_diagnostics",   Z73)   // CC 내장 LSP 클라이언트 진단
```

생성기:

- `e93(sel,ctx)` → `{type:"selected_lines_in_ide", ideName, lineStart, lineEnd, filename, content, displayPath}` (선택 텍스트/라인 없으면 `[]`, 권한 없는 경로면 `[]`) (ef.js:10248474)
- `q73(file,ctx)` → 열린 파일 (선택 텍스트가 있으면 selection 쪽에 양보하여 skip)

---

## 2. 핵심 로직 — Post-edit diagnostics 루프

### 2.1 IDE-MCP 경로: `hb` 진단 트래커 (싱글톤)

`class hb` (ef.js:10625366, 인스턴스 `N4H`). VS Code/JetBrains 익스텐션의 LSP 결과를 `mcp__ide__getDiagnostics` MCP 호출로 풀(pull)한다.

상태:

```
hb {
  baseline: Map<normalizedUri, Diagnostic[]>      // 편집 직전 스냅샷
  rightFileDiagnosticsState: Map<uri, Diagnostic[]>  // diff "_claude_fs_right:" 추적
  lastProcessedTimestamps: Map<uri, ts>
  mcpClient                                        // initialize() 시 주입
}
```

루프 3단계 (모두 **확인**):

1. **편집 직전 베이스라인 스냅샷** — `beforeFileEdited(path)`
   - Edit/Write 실행 직전 `N4H.beforeFileEdited(j)`가 호출됨 (ef.js:9552524 — Edit/Write 공용 파일 쓰기 헬퍼 내부; `N4H.ensureFileOpened`는 코드상 별도 존재)
   - `Bn("getDiagnostics",{uri:"file://"+path}, mcpClient)`로 **편집 전** 진단을 받아 `baseline[path]`에 저장
   - 파일 경로 불일치(`OAq`) 시 `vH(...)` 보고 후 중단

2. **편집 발생** — Edit/Write가 파일 수정. IDE 익스텐션이 LSP를 돌려 새 진단을 가짐 (claude.exe 외부, 비동기).

3. **다음 턴 델타 추출 + 주입** — `W73(ctx)` (ef.js:10259164)
   - 가드: `ctx.options.tools`에 `Bash(\`Cq\`)` 또는 `PowerShell?(\`y9\`)` 도구가 있어야 함 (즉 코드 실행 가능 세션에서만)
   - `N4H.getNewDiagnostics()` 호출:
     - `Bn("getDiagnostics",{}, mcpClient)`로 **전체** 현재 진단을 받음
     - `baseline`에 키가 있는 파일만 필터 (= 이번에 우리가 건드린 파일만)
     - `_claude_fs_right:` (인에디터 diff 우측 버퍼) 진단이 있으면 그쪽을 우선
     - `areDiagnosticsEqual`로 baseline에 없던 **새 진단만** diff 추출
     - baseline을 현재 값으로 갱신
   - 결과 → `[{type:"diagnostics", files:[...], isNew:true}]` attachment
   - `bt7(files,"ide-mcp")` → `tengu_lsp_diagnostics_injected {diagnostics_chars, diagnostic_count, file_count, source}` (ef.js:10258958)

쿼리 시작 훅 `N4H.handleQueryStart(clients)` (ef.js:14041213) — 첫 호출 시 `FI(clients)`로 IDE client를 `initialize()`, 이후엔 `reset()`(베이스라인 클리어). 동시에 `q97(ide)`로 잔여 diff 탭 닫음.

`areDiagnosticsEqual` 동등성 기준: `message`+`severity`+`source`+`code`+`range.start/end.{line,character}` 전부 일치 (확인).

### 2.2 CC 내장 LSP 경로: `lspPushRegistry` 레지스트리 (push 기반)

IDE 익스텐션과 별개로, CC가 직접 LSP 서버에 붙어 `notifications/publishDiagnostics`를 **push로 수신**하는 두 번째 경로가 있다 (`injectNewDiagnostics`, `lsp_diagnostics`).

- 핸들러 등록 (ef.js:9509500 근방): 각 LSP 서버에 diagnostics notification 핸들러를 건다. `P77({serverName,files})`로 글로벌 레지스트리 `lspPushRegistry`에 적재. 빈 진단은 skip. 핸들러가 3회 연속 실패하면 `WARNING ... failed 3 times consecutively` 로깅. 등록 결과 `lsp_diagnostics_register` 성공/실패 텔레메트리 (`diagnostics_register`).
- 적재/전달 (ef.js:6432751 — `Z77()`):
  - 미전송(`!attachmentSent`) 항목 수집 → `qz5`로 중복 제거(`diagnostics_dedup`, 실패 시 `lsp_diagnostics_dedup_failed`)
  - severity 정렬(`f77`) 후 **볼륨 제한**: 파일당 `d86`개, 전체 `M77`개 초과분 truncate
  - 전달된 진단을 `$wH`(uri→Set)에 fingerprint(`W77`) 기록해 차후 중복 억제
  - `attachmentSent=true` 마킹 + 전송 완료 항목 `lspPushRegistry`에서 삭제
  - `lsp_diagnostics_deliver` 텔레메트리 (`diagnostics_deliver`)
- `Z73(ctx)` (ef.js:10259372): 동일하게 Bash/PowerShell 도구 가드 → `Z77()`로 pending set 받아 `{type:"diagnostics",files,isNew:true}` attachment 생성 → `bt7(files,"lsp")` → 전달 후 `G77()`로 `lspPushRegistry` 클리어. 예외 시 빈 배열 + `vH` 보고.
- `G77()` 클리어, `R77()` 전체 상태 리셋(`lspPushRegistry`+`$wH`).

두 경로 모두 결과 attachment 타입은 `"diagnostics"`로 동일하며, 모델은 다음 턴 `<system-reminder>` 안에서 파일별 진단 목록을 본다. 포맷터 `hb.formatDiagnosticsSummary` (ef.js:10628602):

```
  <severity symbol> [Line <l>:<c>] <message> [<code>] (<source>)
```

라인/컬럼은 0-base → +1 변환하여 사람이 읽는 1-base로 출력 (확인). 모델은 이 텍스트를 보고 같은 턴 또는 다음 턴에 Edit으로 자가 수정한다. 즉 **edit → LSP 에러 → 모델 인지 → 수정** 루프가 닫혀 있음 (확인).

### 2.3 `lspRecommendation` — 언어 서버 익스텐션 설치 추천

별개 기능. **LSP 서버를 직접 설치하는 게 아니라, 현재 편집 파일 확장자에 맞는 marketplace 플러그인을 추천**한다 (ef.js:13952600 근방).

```
TiK(filePath):                                  // 추천 후보 산출
  NHO() 가 true면 즉시 [] (비활성)
  ext = extname(filePath) 소문자
  VHO(): 모든 marketplace config 로드 → 각 플러그인 .lspServers 파싱
    kHO/KiK: lspServers 객체에서 {extensions:Set, command} 추출
             (extensionToLanguage 키들을 확장자 집합으로)
  필터:
    - ext가 플러그인 extensions에 포함
    - settings.lspRecommendationNeverPlugins 에 없음
    - mQ(pluginId): 이미 설치됨이면 skip
    - HiK(command): 명령 실행 가능 검증
```

비활성 조건 `NHO()` (ef.js:13955386, **확인**):

```
settings.lspRecommendationDisabled === true
  || settings.lspRecommendationIgnoredCount >= RHO(=5)
```

관련 settings 키: `lspRecommendationDisabled`, `lspRecommendationIgnoredCount`, `lspRecommendationNeverPlugins`, `lspRecommendationShownThisSession`. 문자열 형태 `lspServers`(마켓플레이스 경로)는 "not readable from marketplace"로 skip (확인).

---

## 3. State / Schema

### 3.1 MCP transport 스키마 (IDE 전용 타입)

`dbO` enum + 디스크리미네이티드 유니온 (ef.js:2397200 근방, **확인**):

```
sse-ide:  { type:"sse-ide", url, ideName, ideRunningInWindows?, alwaysLoad?, role? }
ws-ide:   { type:"ws-ide",  url, ideName, authToken?, ideRunningInWindows?, ... }
```

`ws-ide`만 `authToken` 보유 → WebSocket 헤더 `X-Claude-Code-Ide-Authorization: <token>`. `sse-ide`는 인증 헤더 없는 SSE.

### 3.2 IDE lockfile 스키마 (`~/.claude/ide/<port>.lock`)

`rq7()` 파싱 결과 (ef.js:6377336, **확인**):

```
파일명:  <port>.lock          // 포트번호가 파일명
내용(JSON):
  {
    workspaceFolders: string[],   // 매칭에 사용 (cwd ∩ 검사)
    pid:    number,               // 생존 검사
    ideName: string,
    transport: "ws" | ...,        // "ws" → useWebSocket
    runningInWindows: boolean,    // WSL 경로 변환 트리거
    authToken: string             // ws-ide 인증 토큰
  }
  // JSON 파싱 실패 시 줄 단위 폴백 → workspaceFolders로 간주
```

검색 디렉토리 (`W$5`): `~/.claude/ide` (또는 `$CLAUDE_CONFIG_DIR/ide`), WSL은 추가로 `/mnt/c/Users/<user>/.claude/ide`. `*.lock` mtime 내림차순 정렬(최신 우선). 매칭: `$CLAUDE_CODE_SSE_PORT` 명시 포트 > `workspaceFolders`가 cwd 포함 + TCP 응답(`xj8`, 500ms timeout).

### 3.3 진단 attachment 형태

```
selected_lines_in_ide:  { type, ideName, lineStart, lineEnd, filename, content, displayPath }
diagnostics:            { type:"diagnostics", files:[{uri,diagnostics:[...]}], isNew:true }
Diagnostic:             { message, severity, source, code,
                          range:{start:{line,character}, end:{line,character}} }
```

`source` 식별자: IDE-MCP 경로 `"ide-mcp"`, 내장 LSP 경로 `"lsp"` (텔레메트리 `source` 필드).

### 3.4 텔레메트리 이벤트 (확인)

| 이벤트 | 의미 |
|---|---|
| `tengu_mcp_ide_server_connection_succeeded` / `_failed` | IDE MCP(ws-ide/sse-ide) 연결 결과 (connectionDurationMs, serverVersion) |
| `tengu_lsp_diagnostics_injected` | 진단 주입 (diagnostics_chars, diagnostic_count, file_count, source) |
| `tengu_ext_installed` / `tengu_ext_install_error` | 익스텐션 설치 결과 |
| `tengu_ext_will_show_diff` / `tengu_ext_diff_accepted` / `tengu_ext_diff_rejected` | 인에디터 diff 결과 |
| `tengu_ext_at_mentioned` / `tengu_ext_ide_command` | IDE 측 @멘션·커맨드 |
| `tengu_vscode_<eventName>` | VS Code 익스텐션이 `log_event` notification으로 푸시한 임의 이벤트 (스키마 `L$8`, ef.js:5845700) |
| `tengu_ide_<eventName>` | 범용 IDE notification 이벤트 (스키마 `_d3`, ef.js:13269200) |
| perf marker | `ide_extension_install`, `lsp_diagnostics_register`, `lsp_diagnostics_deliver` |

VS Code 익스텐션에는 연결 직후 experiment gate 푸시도 한다 (`Zc9`, ef.js:5845700): `experiment_gates` notification으로 `tengu_vscode_review_upsell`, `tengu_vscode_onboarding`, `tengu_brick_follow`, `tengu_vellum_siding`, `tengu_auto_mode_state` 등 전달.

### 3.5 관련 설정 키

```
autoConnectIde            (default false)   // IDE 자동 연결 opt-in
autoInstallIdeExtension   (default true)    // 익스텐션 자동 설치 opt-out
diffTool                  (default "auto")  // 인에디터 diff 뷰어 선택
externalEditorContext     (default false)   // ide_selection/ide_opened_file 주입 opt-in
lspRecommendationDisabled            // LSP 플러그인 추천 완전 비활성
lspRecommendationIgnoredCount        // >=5 이면 자동 비활성
lspRecommendationNeverPlugins        // 추천 제외 플러그인 ID 목록
lspRecommendationShownThisSession    // 세션당 1회 제한 플래그
```

환경변수: `CLAUDE_CODE_SSE_PORT`(명시 포트), `CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL`, `CLAUDE_CODE_IDE_SKIP_VALID_CHECK`, `CLAUDE_CONFIG_DIR`.

---

## 4. 차이점 (v0.2.8 대비) — 추정

v0.2.8 추출본이 본 분석 범위에 없어 **추정** 기반.

| 영역 | v0.2.8 (추정) | v2.1.143 (확인) |
|---|---|---|
| IDE 진단 경로 | 단일 (IDE-MCP pull) | **이중**: IDE-MCP pull(`hb`/`N4H`) + CC 내장 LSP push(`lspPushRegistry` 레지스트리) |
| post-edit 루프 | 단순 getDiagnostics | baseline 스냅샷(`beforeFileEdited`) → 델타(`getNewDiagnostics`) → `<system-reminder>` 자동 주입 → 자가수정 |
| 진단 주입 게이트 | 무조건 | Bash/PowerShell 도구 보유 세션 한정 + dedup(`qz5`) + 볼륨 제한(파일당 `d86`/전체 `M77`) + fingerprint(`$wH`) 중복 억제 |
| transport | sse-ide | sse-ide + **ws-ide**(authToken + `X-Claude-Code-Ide-Authorization` 헤더) |
| 익스텐션 설치 | 수동 | `autoInstallIdeExtension` 기본 on, 설치 후 `diffTool:"auto"` 자동 세팅 |
| LSP 추천 | 없음 (추정) | `lspRecommendation*` — marketplace 플러그인 확장자 매칭 추천, ignore 5회 시 자동 비활성 |
| diff 응답 | accept/reject | accept / **IDE 내 수정 후 accept**(`_93` → 수정본 회수) / reject 3분기 |
| 컨텍스트 주입 | ide_selection 위주 | ide_selection + ide_opened_file + diagnostics + lsp_diagnostics, `externalEditorContext` opt-in 게이트 |

### 핵심 발견 요약

1. **자가수정 루프 실재 (확인)**: `beforeFileEdited`(편집 직전 baseline) → 편집 → `getNewDiagnostics`(델타) → `injectNewDiagnostics`이 `{type:"diagnostics",isNew:true}` attachment 생성 → `makeAttachmentMessage`로 `<system-reminder>` user 메시지화 → 다음 턴 모델이 진단을 보고 Edit으로 수정. "Claude가 에러를 만들면 다음 턴에 본다"가 명시적으로 구현됨.
2. **진단 경로 이중화 (확인)**: IDE 익스텐션 경유(`mcp__ide__getDiagnostics`, pull) **및** CC가 직접 LSP에 붙는 push 경로(`lspPushRegistry`/`lspPushRegistry`) 둘 다 존재. IDE 미연결이어도 후자만으로 진단 주입 가능.
3. **연결은 lockfile 포트 디스커버리 (확인)**: 익스텐션이 `~/.claude/ide/<port>.lock`에 포트·PID·workspace·authToken을 쓰고, CC가 이를 스캔→cwd 매칭→`ws://127.0.0.1:<port>` WebSocket(MCP 프로토콜) 또는 SSE로 접속. `name:"ide"` MCP 서버로 등록.
4. **`mcp__ide__*`는 화이트리스트 2종 (확인)**: `mcp__ide__executeCode`, `mcp__ide__getDiagnostics`만 노출(`TO3`).
5. **`lspRecommendation`은 LSP 설치가 아니라 플러그인 추천 (확인)**: 편집 파일 확장자 ↔ marketplace 플러그인 `lspServers` 매칭으로 익스텐션 설치를 권유하는 nudge. 5회 무시 시 자동 비활성.
