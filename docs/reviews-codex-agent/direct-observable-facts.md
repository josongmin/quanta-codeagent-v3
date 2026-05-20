# Direct Observable Facts

Overview router: [may-20-codex-agent-loop.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/may-20-codex-agent-loop.md)

이 문서는 `/docs/analysis/codex-agent/` 아래 다른 분석 문서들이 기대는 **직접 관측 가능한 사실**만 모아 둔 인벤토리다.

규칙:
- 여기에는 `[FACT]`만 적는다.
- 해석, 모델링, 일반화는 다른 문서로 보낸다.

---

## 1. Session environment

1. 현재 작업 루트는 `/Users/songmin/Documents/code-new/semantica-codegraph-v2`다.
2. 현재 shell은 `zsh`다.
3. 현재 날짜 컨텍스트는 `2026-04-29`다.
4. 현재 timezone은 `Asia/Seoul`이다.
5. 현재 collaboration mode는 `Default`다.
6. known mode names are `Default` and `Plan`.
7. `request_user_input`는 현재 mode에서 unavailable이다.
8. `request_user_input` tool description에는 “only available in Plan mode”라고 적혀 있다.
9. `sandbox_mode`는 `danger-full-access`다.
10. permissions instructions는 `danger-full-access`를 “No filesystem sandboxing - all commands are permitted”라고 설명한다.
11. network access는 `enabled`다.
12. approval policy는 `never`다.
13. `sandbox_permissions`를 지정하지 말라고 직접 적혀 있다.

---

## 2. Visible top-level instruction layers

1. system instructions가 존재한다.
2. developer instructions가 존재한다.
3. app context instructions가 존재한다.
4. collaboration mode block이 존재한다.
5. personality spec이 존재한다.
6. skills instructions가 존재한다.
7. plugins instructions가 존재한다.
8. repo-local `AGENTS.md`가 존재하고 현재 repo에 적용된다.

---

## 3. Language / reporting / interaction rules

1. 응답은 한국어로 해야 한다.
2. 코드/주석/커밋 메시지 본문은 영어 우선이다.
3. tool call은 비싸므로 최소화하라는 지침이 있다.
4. 시작 시 `ls -R`, `rg --files` 같은 광범위 탐색을 하지 말라는 지침이 있다.
5. 텍스트 검색에는 `rg`를 선호하라는 지침이 있다.
6. 여러 읽기 작업은 가능하면 병렬화하라는 지침이 있다.
7. 같은 파일을 의미 없이 다시 읽지 말라는 지침이 있다.
8. 검증/테스트는 사용자가 요청하지 않으면 하지 말라는 지침이 있다.
9. 검증을 안 했으면 final answer에서 그 사실을 드러내야 하는 형식 지침이 있다.
10. destructive command를 쓰지 말라는 강한 지침이 있다.
11. subagent는 사용자가 명시적으로 병렬/위임을 요청했을 때만 쓰라는 지침이 있다.
12. Default mode에서는 reasonable assumptions를 선호하고 불필요하게 멈추지 말라는 지침이 있다.

---

## 4. Repo-local AGENTS facts

1. “ROI 무관 SOTA++급 해결”이 명시돼 있다.
2. “휴리스틱, 나이브한 폴백 금지”가 명시돼 있다.
3. `probe-first`, `test-last`가 명시돼 있다.
4. “원인 파일 1~2개만 읽고 바로 패치”가 명시돼 있다.
5. fail-closed 요구가 명시돼 있다.
6. silent fallback 금지가 명시돼 있다.
7. fake success / fake fallback 금지 규칙이 존재한다.
8. Rust verification은 direct cargo가 아니라 `scripts/cg-dispatch` front door를 쓰라고 명시돼 있다.

---

## 5. Visible callable tools

현재 세션에서 직접 callable 한 tool entry:

1. `web.run`
2. `image_gen.imagegen`
3. `functions.exec_command`
4. `functions.write_stdin`
5. `functions.list_mcp_resources`
6. `functions.list_mcp_resource_templates`
7. `functions.read_mcp_resource`
8. `functions.update_plan`
9. `functions.request_user_input`
10. `functions.view_image`
11. `functions.spawn_agent`
12. `functions.send_input`
13. `functions.resume_agent`
14. `functions.wait_agent`
15. `functions.close_agent`
16. `functions.read_thread_terminal`
17. `functions.load_workspace_dependencies`
18. `functions.install_workspace_dependencies`
19. `functions.apply_patch`
20. `mcp__node_repl__.js`
21. `mcp__node_repl__.js_reset`
22. `tool_search.tool_search_tool`
23. `multi_tool_use.parallel`

---

## 6. Tool-specific observable facts

1. `web.run`는 search/open/click/find/screenshot/finance/weather/sports/time을 제공한다.
2. `apply_patch`는 patch grammar가 엄격하고 parallel 금지다.
3. `exec_command`는 `sandbox_permissions` / `justification` / `require_escalated` 관련 필드를 schema에 가진다.
4. `spawn_agent`는 `agent_type`, `fork_context`, `message/items`, `reasoning_effort` 등을 가진다.
5. `spawn_agent` tool documentation은 사용자가 명시적으로 sub-agent/parallel work를 원할 때만 쓰라고 적고 있다.
6. `multi_tool_use.parallel`는 developer tools만 병렬 실행 가능하다.
7. `multi_tool_use.parallel`는 system tools를 직접 병렬 호출할 수 없다.
8. `tool_search.tool_search_tool`는 deferred tool metadata 검색 도구다.

---

## 7. Visible plugin facts

1. enabled plugins:
   - `Browser Use`
   - `Documents`
   - `GitHub`
   - `Presentations`
   - `Spreadsheets`
2. plugins are not invoked directly.
3. plugin instructions는 “underlying skills, MCP servers, and app tools”를 쓰라고 말한다.
4. 관련 plugin이 있으면 standalone capability보다 plugin capability를 선호하라고 적혀 있다.
5. 사용자가 plugin 이름을 명시하면 그 plugin 관련 capability를 우선하라고 적혀 있다.

---

## 8. Visible plugin-contributed skills

1. `browser-use:browser`
2. `documents:documents`
3. `github:gh-address-comments`
4. `github:gh-fix-ci`
5. `github:github`
6. `github:yeet`
7. `presentations:Presentations`
8. `spreadsheets:Spreadsheets`

---

## 9. Visible HITL / confirmation policy facts

1. confirmation policy에는 4단계가 직접 존재한다:
   - `Hand-Off Required`
   - `Always Confirm at Action-Time`
   - `Pre-Approval Works`
   - `No Confirmation Needed`
2. `Hand-Off Required`에는 password change final submit, browser safety barrier bypass, paywall bypass 등이 포함된다.
3. `Always Confirm`에는 deletion, permissions/access changes, CAPTCHA, installation/run, representational communication, subscription changes, financial transactions, system settings changes, medical actions이 포함된다.
4. `Pre-Approval Works`에는 login/browser permissions, file upload, file management, model-generated code 입력, sensitive data transmission 등이 포함된다.
5. typing sensitive data into a form counts as transmission이라고 직접 적혀 있다.
6. reading local telemetry/history data to submit it is sensitive access라고 직접 적혀 있다.

---

## 10. Visible app directives / app features

1. absolute local image/video markdown rendering support가 있다.
2. file references는 absolute path를 써야 한다.
3. `::code-comment{...}` directive를 지원한다.
4. `::archive{...}` directive를 지원한다.
5. git directives를 지원한다:
   - `::git-stage`
   - `::git-commit`
   - `::git-create-branch`
   - `::git-push`
   - `::git-create-pr`

---

## 11. Observable replay/cassette facts from repo evidence

1. `CassetteV1` contract file가 존재한다.
2. `CassetteV1` header comment는 cassette를 replay-significance observation SSOT로 정의한다.
3. cassette는 WAL subset이라고 직접 적혀 있다.
4. cassette records “LLM calls, tool calls, test runs, sandbox execs”라고 직접 적혀 있다.
5. `CassetteRecorder` file가 존재한다.
6. `CassetteReplayValidator` file가 존재한다.
7. replay task doc는 “full golden replay set과 KPI-oriented eval surface는 아직 없다”고 적고 있다.

---

## 12. Observable behavior in this thread

1. 이 대화에서 `web.run`은 사용되지 않았다.
2. 이 대화에서 `exec_command`는 여러 번 사용되었다.
3. 이 대화에서 `multi_tool_use.parallel`는 여러 번 사용되었다.
4. 이 대화에서 `apply_patch`는 여러 번 사용되었다.
5. patch context mismatch가 실제로 발생했다.
6. 그 뒤 `exec_command` 기반 scripted replacement가 사용되었다.
7. 이 대화에서 validation/test run은 수행되지 않았다.
8. `/docs/analysis/codex-agent/` 아래에 문서들이 누적 생성되었다.

---

## 13. Superseding update: automation is directly observable

Later in the thread, the following additional facts became directly observable.

### 13.1 Additional callable tool

1. `codex_app.automation_update` is visible as a callable tool. `[FACT]`

### 13.2 Additional app-level capability fact

1. app context explicitly says the app supports recurring automations, reminders, monitors, follow-ups, and thread wakeups. `[FACT]`
2. app context instructs the agent to search for the automation tool rather than emitting raw directives by hand. `[FACT]`

### 13.3 Additional observed thread behavior

1. a heartbeat automation named `Codex Agent Follow-up` was created in this thread. `[FACT]`
2. the returned automation identifier was `codex-agent-follow-up`. `[FACT]`
3. automation is therefore not merely an app-level hinted capability; it is a current-session directly exercised capability. `[FACT]`

---

## Round 2 update (2026-05-21 deep dive)

이 섹션은 실제 설치된 `Codex.app` (build 2867) 바이너리/asar/리소스/entitlements/IPC 직접 관측 결과를 누적 `[FACT]`로 적는다. 기존 12개 섹션을 이어 14번부터 매긴다.

### 14. App bundle identity

1. `Codex.app` package.json reports app version `26.513.31313`, build `2867`, prod flavor. `[FACT]`
2. bundled Electron version is `42.0.1`. `[FACT]`
3. bundled Node.js runtime is `v24.14.0` (both inside Electron and as separate `node` binary in Resources). `[FACT]`
4. `app.asar` SHA256 integrity hash on this machine is `8242a5ba1fb767ed47284033b053c30f3be701be046f2d9b1525986f8b03b509`. `[FACT]`
5. code signing team identifier is `2DC432GLL2` (OpenAI). `[FACT]`
6. minimum supported macOS version is `12.0` (Monterey). `[FACT]`
7. the app was built with Xcode 16.0. `[FACT]`
8. custom URL scheme registered is `codex://`. `[FACT]`

### 15. Entitlements and security posture

1. `com.apple.security.app-sandbox` = false. `[FACT]`
2. `com.apple.security.automation.apple-events` = true. `[FACT]`
3. `com.apple.security.cs.allow-jit` = true. `[FACT]`
4. `com.apple.security.cs.allow-unsigned-executable-memory` = true. `[FACT]`
5. `com.apple.security.device.audio-input` = true. `[FACT]`
6. `com.apple.security.files.user-selected.read-write` = true. `[FACT]`
7. `com.apple.security.network.client` = true. `[FACT]`
8. `keychain-access-groups` includes `2DC432GLL2.*`. `[FACT]`
9. `NSAllowsArbitraryLoads` = true in `Info.plist` (cleartext HTTP permitted at platform layer). `[FACT]`

### 16. Update channel

1. Sparkle appcast feed URL is `https://persistent.oaistatic.com/codex-app-prod/appcast.xml`. `[FACT]`
2. Sparkle uses Ed25519 signing for updates. `[FACT]`

### 17. Bundled native binaries

1. `codex` Rust binary on disk is 182 MB. `[FACT]`
2. `codex_chronicle` Rust binary on disk is 4.3 MB. `[FACT]`
3. `node` (separately bundled in Resources) is `v24.14.0`. `[FACT]`
4. `rg` (ripgrep) is bundled in Resources. `[FACT]`

### 18. `~/.codex/` on-disk inventory (this machine, 2026-05-21)

1. `~/.codex/rules/default.rules` is 353 KB. `[FACT]`
2. `~/.codex/logs_2.sqlite` is 14.8 GB on disk; its WAL file is 14 GB. `[FACT]`
3. `~/.codex/archived_sessions/` contains 6,326 items. `[FACT]`
4. `~/.codex/memories/extensions/chronicle/resources/` contains 1,390 markdown summary files totaling 39.8 MB. `[FACT]`
5. `~/.codex/pets/` directory exists and is empty on this machine. `[FACT]`
6. `~/.codex/node_repl/` directory exists and tracks Node REPL state used by browser/computer-use plugin bootstraps. `[FACT]`

### 19. `config.toml` and `auth.json`

1. `~/.codex/config.toml` sets `model = "gpt-5.4-mini"`. `[FACT]`
2. `~/.codex/config.toml` sets `model_reasoning_effort = "xhigh"`. `[FACT]`
3. `~/.codex/config.toml` sets `personality = "pragmatic"`. `[FACT]`
4. `~/.codex/config.toml` sets `approvals_reviewer = "user"`. `[FACT]`
5. `~/.codex/config.toml` sets `plan_mode_reasoning_effort = "high"`. `[FACT]`
6. `~/.codex/auth.json` mode is `chatgpt` (ChatGPT/Google OAuth). `[FACT]`
7. `~/.codex/installation_id` on disk is a 36-byte UUID. `[FACT]`

### 20. Models cache

1. `models_cache.json` is ETag-keyed. `[FACT]`
2. cached models on this machine: `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex`, `gpt-5.3-codex-spark`, `gpt-5.2`, `codex-auto-review` (7 models). `[FACT]`
3. all cached models report a context window of 272K tokens. `[FACT]`
4. reasoning-effort enum visible in cache is `low, medium (default), high, xhigh`. `[FACT]`
5. extended reasoning-effort enum visible inside `codex_chronicle` binary adds `none, minimal` (full 6-tier). `[FACT]`
6. service tier `priority` (advertised as 1.5x speed) appears per model in the cache. `[FACT]`

### 21. Thread/event stream surface

1. there are 13 distinct `thread-follower-*` events enumerated in the bundles (see [thread-management/](thread-management/) for the list). `[FACT]`

### 22. IPC surface

1. 378 IPC channels are enumerated across the Electron bundles. `[FACT]`

### 23. Skybridge / MCP UI sandbox

1. there are 12 named `MessagePort`s in the Skybridge MCP UI protocol. `[FACT]`
2. Skybridge iframe origin is `https://web-sandbox.oaiusercontent.com/?app=skybridge&locale=…&deviceType=desktop&unsafeSkipTargetOriginCheck=true`. `[FACT]`

### 24. Bundled plugins

1. 4 plugins are bundled at `/Applications/Codex.app/Contents/Resources/plugins/openai-bundled/plugins/`: `computer-use v1.0.793`, `browser v0.1.0-alpha2`, `chrome v0.1.7`, `latex v0.2.0`. `[FACT]`
2. Chrome plugin extension ID is `hehggadaopoacecdllhhajmbjkdcmajg`. `[FACT]`
3. Chrome plugin native messaging host name is `com.openai.codexextension`. `[FACT]`
4. Chrome plugin privacy notice states "Browser data from using this plugin may be used for training". `[FACT]`

### 25. Anthropic SDK markers in bundles

1. `cache_creation_input_tokens` string appears in `app-session.js`. `[FACT]`
2. `cache_read_input_tokens` string appears in `app-session.js`. `[FACT]`
3. `anthropic.response.timestamp` string appears in `app-session.js`. `[FACT]`
4. `anthropic_error` string appears in `worker.js`. `[FACT]`
5. `anthropic.stream_error` string appears in `worker.js`. `[FACT]`

### 26. Round 2 — observed correction

1. ~~`comment-preload.js` was filed under MCP-related preloads in Round 1.~~ **CORRECTED 2026-05-21**: Round-2 evidence shows `comment-preload.js` is the browser sidebar annotation overlay preload, not part of the MCP sandbox; the MCP sandbox preload is a separate 2KB file `sandbox-preload.js`. `[FACT]`
