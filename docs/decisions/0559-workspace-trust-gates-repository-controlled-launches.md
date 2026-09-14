# ADR-0559: 폴더 신뢰가 저장소가 고르는 실행을 게이트한다

- **상태**: Accepted
- **날짜**: 2026-09-14
- **슬라이스**: `@/agent/workspace-trust` (결정 authority), `@/host/workspace-trust` (기록된 결정 해석·설치), 각 프로세스 진입점
- **관련**: ADR-0498 (central-config project trust — 같은 `~/.quanta/trust.json`), `docs/plans/sep-12-truth-guard-hardening/corrections.md` §J-9 / §K
- **게이트**: 없음 (기본 동작). 신뢰는 `~/.quanta/trust.json`, `QUANTA_TRUSTED_PATHS`, 대화형 CLI의 1회 질문으로만 생긴다.

## Context

클론과 함께 도착하는 파일이 quanta가 띄울 프로그램을 고르는 경로가 여럿 있었고, 어느 것도 묻지 않았다.
이 머신에서 실제 서버로 마커 파일을 만들어 확인했다 (sep-14):

- pyright: `resolvePythonInterpreter`가 `<cwd>/.venv/bin/python`을 골라 넘기고 pyright가 실행한다.
- typescript-language-server: 워크스페이스 `node_modules/typescript`의 tsserver를 우선 로드한다.
- rust-analyzer: `build.rs`를 실행한다.
- 이 서버들은 read-only 도구(`lsp_hover` 등, plan 모드에서 무확인)와 세션 시작 prewarm(도구 호출 없음)이 띄운다.
- CLI 시작 시 `<cwd>/.mcp.json`의 stdio 명령을 띄운다 (`21618e469`가 cwd 폴백을 들이며 "`.mcp.json`은 트리에서 자동 로드하지 않는다"는 기존 설계를 깼다; central-config가 꺼진 기본값에선 정책이 없다).
- 프로젝트 플러그인 매니페스트(`.quanta/plugins`)의 MCP 명령은 모드 정책(ci-bot/daemon만 차단)만 봤다.
- `QUANTA_TRUST_SCOPE`가 켜지면 `.quanta/project-grants.json`의 도구 허용 레코드가 적용됐다.

ADR-0498의 trust store는 central-config가 켜졌을 때 설정 레이어에만 쓰였다. 모드 정책(`modeLoadsRepoRules`)은
대화형 세션의 트리를 "사용자가 고른 저장소"로 보고 전부 신뢰했다.

검증된 기준선: VS Code Workspace Trust(비신뢰 폴더에선 워크스페이스 tsserver 대신 번들, 실행형 확장 제한),
Claude Code의 폴더 신뢰 질문 + 프로젝트 `.mcp.json` 서버 승인, Codex의 프로젝트 `trust_level`.

## Decision

1. **결정 하나.** `@/agent/workspace-trust`의 authority가 "이 경로의 내용이 고른 코드를 실행해도 되는가"에 답한다.
   신뢰는 폴더와 그 하위 폴더에 적용되고(VS Code·Claude Code와 같음), 가장 가까운 기록이 이긴다(하위 폴더의
   명시적 비신뢰가 유지된다). 설정 레이어 병합은 ADR-0498의 정확-경로 규칙을 그대로 쓴다.
2. **기본은 비신뢰.** 프로세스가 authority를 설치하지 않으면 모든 폴더가 비신뢰다. 설치를 잊은 표면은 실행하지
   않고 이유를 말한다.
3. **입력은 명시적인 것만.** `~/.quanta/trust.json`(ADR-0498의 `TrustStore`), `QUANTA_TRUSTED_PATHS`(절대경로,
   부여만, 철회 불가), 대화형 CLI의 1회 질문(기본 no, yes는 기록, no는 기록하지 않아 다음 실행에 다시 묻는다).
   cwd라는 이유만으로는 신뢰되지 않는다. trust 파일을 읽지 못하면 비신뢰이고 질문도 하지 않는다.
   묻고 기록하는 대상은 실행 폴더가 속한 **git checkout 루트**(realpath)다(sep-14 U-1). checkout 밖이면 실행 폴더.
   홈 폴더에 대한 yes는 이번 세션에만 적용하고 기록하지 않는다(기록하면 그 아래 모든 클론이 영구 신뢰된다).
   건너뛴 artifact(`.mcp.json`, 플러그인, grants overlay)는 운영자 알림 한 줄로 이유를 남긴다.
4. **게이트 지점.**
   - 언어 서버: `@/lsp` 클라이언트의 `beforeSpawn` 훅. 에이전트는 `lsp-bridge/servers.ts`의 팩토리로만 서버를
     만들고(census 테스트), 모든 클라이언트가 spawn 직전에 신뢰를 확인한다. scratch 복사본(shadow_verify)은
     원본 폴더로 판단한다. 거부는 "서버 없음"이 아니라 이유로 도구에 전달된다.
   - 프로젝트 `.mcp.json`: `readMcpConfig`의 cwd 폴백은 신뢰 폴더에서만 읽는다. 운영자가 경로를 지정한 설정
     (`QUANTA_MCP_CONFIG` 등)은 신뢰와 무관하다.
   - 프로젝트 플러그인: `autoWirePluginActivation`이 비신뢰 폴더에선 배선하지 않는다.
   - 프로젝트 grants overlay: 신뢰 폴더에서만 읽는다. 사용자 자신의 `~/.quanta/grants.json`은 그대로 적용된다.
5. **진입점마다 결정.** `import.meta.main` 파일 전부를 분류하는 테스트가 있다.
   - 기록된 결정: CLI 바이너리(`src/apps/cli/index.ts`, 모든 서브커맨드 전), 헤드리스 에이전트, web daemon, `serve --stdio`.
   - 대화형 REPL: 시작 전에 1회 질문 (TTY일 때만).
   - 헤드리스 에이전트의 ci-bot/daemon 모드: 기록과 무관하게 비신뢰 (외부인이 쓴 트리).
   - 하네스(bench cli/index, eval, terminal brain-mode): 스스로 만든 트리에서 어차피 그 코드를 실행하므로 전부 신뢰.

## sep-14 계획과의 관계

같은 날 다른 세션이 `docs/plans/sep-14-repo-trust-and-state-honesty/plan.md`(U-1..U-6)를 세웠다. 운영자 결정으로
이 게이트를 그 계획의 기반으로 먼저 land했다. 이 ADR이 채운 것: DS1의 결정 authority(모듈 위치는 계획의
`src/config/project-trust.ts`가 아니라 위 두 슬라이스), D-S2의 `.mcp.json` 게이트(`quanta trust` 명령 제외),
D-S5 계열의 플러그인·grants overlay, B의 spawn 지점 게이트와 진입점 분류. 남은 것: U-5의 비신뢰 폴더 강화 모드
LSP(지금은 완전 차단), `quanta trust [--revoke]`·`--trust-project`, AGENTS.md·rules·dotenv·environment.toml·
legacy-cwd 메모리 스토어(NW-1)·env 스크럽 등 계획의 나머지 lane.

## Consequences

- 신뢰하지 않은 폴더에서 LSP 네비게이션·진단, prewarm, 프로젝트 MCP 서버, 프로젝트 플러그인이 동작하지 않는다.
  LSP는 U-5의 강화 모드가 들어오기 전까지 완전히 꺼진다(계획보다 엄격한 과도기).
  CLI는 처음 한 번 묻고, 헤드리스·web daemon은 CLI에서 신뢰한 기록(같은 파일)이나 `QUANTA_TRUSTED_PATHS`를 쓴다.
- web daemon(Tauri)에는 아직 신뢰를 부여하는 UI가 없다. 기록된 결정만 쓴다.
- 벤치 LSP grounding은 하네스 진입점의 전체 신뢰로 유지된다.
- SDK(`@/sdk`)를 라이브러리로 쓰는 호스트는 authority를 설치해야 LSP가 동작한다.
- 테스트 프로세스는 스크래치 폴더만 신뢰한다(`tests/setup.ts`). 게이트 자체는
  `tests/unit/cli/workspace-trust-hellgate.test.ts`가 가짜 서버 바이너리와 paired control로 고정한다.
