# sep-14 — 클론한 레포가 quanta를 조종하는 경로 차단 + 상태 표시 정직성

기준: main `f189bcd3c` 이후(동시 세션 sep-12 truth-guard 캠페인이 계속 커밋 중).
출발점: `.extracted_source/REFRESH-DIFF-2026-09-13.md` §A (SEC-1~5, BUG-1~4).

## 0. 이 계획이 어떻게 만들어졌나

1. 오케스트레이터가 REFRESH-DIFF의 강한 주장을 직접 재현하다가 계획 전제 3개가 틀린 것을 찾았다:
   Bun 컴파일 바이너리가 cwd `bunfig.toml` preload를 실행한다(SEC-0, 신규). Bun이 `.env`를 먼저 읽어서
   ADR-0555 출처 가드는 production에서 비활성이다. 실제 SDK 에러는 `classifyErrorReason` 정규식에 안 걸린다.
2. 6개 클러스터 × (R1 설계 → R2 적대 → R2 객관 검증 + 설계 수정), 에이전트 18개를 병렬로 돌렸다.
   결과는 `evidence/cluster-{A..F}-final.json`, 적대 보고는 `cluster-*-r2-attack.json`에 있다.
3. 통합 계획 초안을 컨텍스트 없는 적대 2렌즈(보안 커버리지, 품질·순서)와 객관 검증자에게 넘겼다.
   발견 26건 중 25건이 확정됐고, 계획에 없던 구멍 3개(NW-1, NW-2, NW-3)가 재현됐다.
   결과는 `evidence/plan-audit.json`에 있다.
4. 사용자 결정 6개를 받았다(§2).

`evidence/*.json`의 revisedDesign·revisedTests·implementationOrder가 lane 구현 명세다.
이 문서의 §3 교정 사항이 JSON보다 우선한다.

## 1. 확정된 구멍 (기본 설정 노출, 측정)

| id | 등급 | 무엇 |
|---|---|---|
| A-H1 SEC-0 | CRITICAL | 설치 바이너리·Tauri 데몬 바이너리가 실행 cwd의 `bunfig.toml` preload를 실행하고 `.env/.env.local/.env.development`를 읽는다. `quanta --version`에서도 재현된다 |
| A-H3 SEC-1 | CRITICAL | cwd dotenv의 `OPENAI_BASE_URL`/`ANTHROPIC_BASE_URL`이 실제 env 키를 공격자 호스트로 보낸다(chat 45 + embeddings 6) |
| A-H4 | CRITICAL | cwd dotenv `QUANTA_PERMISSION=bypass`로 권한 상승 |
| A-H5 | CRITICAL | cwd `.env`의 `QUANTA_API_KEY_HELPER`가 LLM 조립 중 임의 셸 명령을 실행 |
| D-H3 | CRITICAL | 레포 `.mcp.json` 명령이 CLI·웹데몬 세션 시작 시 신뢰 결정 없이 실행(sep-12 J-9 형제) |
| NW-1 | HIGH | 레포 `.quanta/memory.sqlite`(legacy-cwd 스토어)가 세션 메모리가 된다. 행이 시스템 프롬프트 "Memory hints"로 들어가고, 세션 요약이 레포 파일에 되쓰인다 |
| NW-2 | HIGH | 레포 `.quanta/tool-output` 심볼릭 링크 → 도구 출력 spill이 레포 밖에 쓰고 prune이 `*.txt`를 지운다(80→49) |
| B | HIGH | LSP 기동이 워크스페이스 코드를 전체 env로 실행한다: pyright 레포 인터프리터·`.pth`·sitecustomize, PATH 상의 워크스페이스 서버 바이너리, shebang `node`, rust build.rs·rustc-wrapper·build.rustc, tsserver·tsconfig 플러그인. @Symbol 멘션과 세션 시작 prewarm도 같은 경로 |
| B-DB1 | HIGH | `bunScrubbedSpawner`가 `extra`를 브랜드 env 뒤에 spread → `extra:{env:process.env}`로 스크럽 우회 |
| C SEC-3 | HIGH | `write_stdin`에 extractor 없음(HARD_DENY·fence·content 키 grant 모두 못 봄), completeness census가 6-tool router를 못 봄, `exec_command` 선언 env가 grant 키·프롬프트에 안 보임 |
| D-H1 SEC-5 | HIGH | 비신뢰 레포 AGENTS.md/CLAUDE.md가 권위 있는 규칙으로 시스템 프롬프트에 들어간다(REPL, `-p`, stdio, 웹데몬). 형제: project-grants overlay(bash grant), `.quanta/agents`, plugins auto-wire, vendor/glob rules, dotenv로 옮긴 skill dir, `environment.toml`(NW-3) |
| E-H1/H2/H4/H5 | HIGH | `/context`·경고·canvas가 시스템 프롬프트만 센다. @file+도구 라운드 뒤 트리거가 +50k로 조기 컴팩션한다. provider 앵커가 프롬프트마다 유실된다. 모델명 추론으로 캐시 토큰을 이중 계산한다 |
| F-H1/H3/H4/H8/H9/H10/H11 | HIGH | 타입 에러가 문자열로 평탄화돼 실제 401/402/quota가 unknown으로 표시된다. quota가 rate_limit으로 재시도되고 한 턴에 물리 호출이 60회다. Responses 표면이 SSE `error`를 무시한다. 커널 onTurnErrored가 category를 버린다. 웹 goal이 실패 한 번 후 멈춘다. CLI goal이 auth/quota를 20회까지 재시도한다 |
| F-H12/H13 | HIGH | 웹 제출이 비원자적 append+run이고, 전달 실패를 무시한 채 draft를 비운다. 고아 draft가 다음 프롬프트에 붙는다 |
| D-H2 BUG-1 | MED | V2 세션 읽기가 `Message.origin`을 떨구고, rename/archive/fork/rewind/updateAtomic 저장 때 영구 소실 |

MED/LOW 전체 목록은 각 cluster JSON의 `confirmedHoles`에 있다.

## 2. 사용자 결정 (2026-09-14)

- **U-1 레포 신뢰 UX**: TTY는 1회 프롬프트(y → `~/.quanta/trust.json`의 realpath git root, n → 해당 artifact 없이 계속, `/rules`·`/status`에 ignored 표시). 비대화형(`-p`, CI, stdio, SDK)은 명시 신뢰가 없으면 무시하고 한 줄 안내(`quanta trust`, 실제 env `QUANTA_TRUSTED_PATHS`, `--trust-project`). sep-12 J-9의 열린 결정도 이 답으로 닫는다.
- **U-2 SEC-4**: 판정·게이트·테스트는 구현한다. 운영자가 없으면 거부한다. 기본ON은 기록된 벤치 trajectory의 명령을 floor로 오프라인 재생해서(NW-12) 뒤집히는 정확한 목록을 확인한 뒤 전환한다.
- **U-3 dotenv**: checkout 루트 동일성 규칙. realpath(cwd) === 실행 중인 코드의 checkout 루트일 때만 로드하고, 컴파일 바이너리는 절대 로드하지 않는다. 영향: 설치 바이너리는 프로젝트 `.env*`의 provider 키를 더는 읽지 않는다(NW-20 안내).
- **U-4 goal 복구불가 에러**: 기존 Blocker 모델을 쓴다(`turn-failure:<code>` dependency blocker, `/goal unblock`으로 해제). 일시 에러는 observation으로 두고 서로 다른 시도 3회에서 승격한다. goal을 삭제하지 않는다.
- **U-5 LSP 신뢰**: 신뢰 폴더는 지금처럼(레포 venv 인터프리터, 워크스페이스 tsserver, build script/proc-macro). 비신뢰 폴더는 실행을 차단한다: pyright는 신뢰 인터프리터 + venv site-packages를 extraPaths로, TS는 PATH의 전역 tsserver가 있으면 사용하고 없으면 "TS LSP 비활성: 폴더 미신뢰" 표시, rust는 build script/proc-macro off + RUSTC/RUSTC_WRAPPER/RUSTUP 핀. **항상 적용**: env 스크럽(provider 키 없음), 서버 바이너리와 shebang 인터프리터의 신뢰 경로 해석(워크스페이스·node_modules·.venv 거부).
- **U-6 컴팩션 측정**: 표시·경고·트리거가 한 측정 SSOT를 읽는다. 다음 라운드 주입분은 정의상 제외하고 크기를 표시한다. 기본ON은 NW-13 영수증을 확인한 뒤 전환한다(@file·다중 프롬프트, n>1, 전후 컴팩션 횟수·첫 발동 라운드, 0/0이면 "not exercised"). E1 → E2 단계로 진행한다.

## 3. 교정 사항 (cluster JSON보다 우선)

- **R-1**: U-3=(a)이므로 D의 `operatorEnvView`(S3)와 forge 테스트 S-T2를 버린다. 대신 D S-T3에 forge arm을 둔다: scratch cwd `.env.dev`의 `QUANTA_TRUSTED_PATHS=<repo>`는 `.mcp.json` 마커를 만들지 못하고, 같은 값을 spawn env로 주면 만든다. S-T1에는 `QUANTA_TRUSTED_PATHS='.'` → untrusted(비절대경로 거부) arm을 둔다. 잔여 위험: 적대적 cwd에서 quanta 소스를 손으로 실행하는 경우(Bun autoload + bunfig preload, 프로세스 내에서 막을 수 없는 전면 침해).
- **A**: 실행 때마다 뜨는 경고는 없앤다. 대신 provider 키 누락 실패 경로에서 launch dir에 dotenv가 있을 때만 안내한다(NW-20). A-T4/T5는 hermetic하게 만든다: 실제 env에 키를 두지 않고, `.env.dev`가 키와 listener base URL을 준다. 리스너 0회 + 정확한 missing-key 메시지·exit code를 확인한다(NW-11).
- **B**: U-5에 맞춘다. 신뢰 경로 해석에 shebang 인터프리터를 넣는다(NW-4). `QUANTA_LSP_HARDENED` env opt-out은 두지 않는다(repo-forgeable 채널에 kill switch를 두지 않는다는 원칙). 결정적 wiring arm은 servers.ts create, warm-pool, mention buildLspLookup, startBackgroundLspPrewarm, availability probe를 recording spawner로 돌려 argv·env·initializationOptions를 wire에서 확인한다(NW-9). real-e2e는 효과 확인용으로만 둔다. 벤치 LSP grounding은 전후를 측정한다(NW-18). 신뢰 입력은 D의 `resolveProjectTrust`만 쓴다(B C10은 W2).
- **C**: commit 3의 env 이름 denylist를 폐기한다. `exec_command`의 extractShellCommand가 정렬·quote된 `env K=V … <command>`를 반환하게 한다(grant 키·프롬프트·HARD_DENY가 env를 봄, HOME·CFLAGS 유지, NW-19). SEC-3a 호환성 문구를 정정한다: 멀티라인 stdin이 bash와 같은 over-match를 겪는다는 parity arm을 둔다(NW-15). SEC-4 RANK drift guard에는 `SHELL_ASSESSMENT_KINDS` const tuple과 rank 접근자를 둔다(NW-16).
- **D**: artifact 집합에 legacy-cwd 메모리 스토어(NW-1)와 `environment.toml` + `.codex/environments/environment.toml`을 넣고, `.quanta/apps.json`은 명시 분류한다(NW-3). S2(`.mcp.json` 게이트)는 비대화형 `quanta trust [--revoke] [path]`(NW-7)와 같은 push로 낸다. 커넥터 설치기(모델 도구 `mcp_connector_install`)는 신뢰를 부여하지 않는다. 비신뢰 폴더에 설치하면 결과에 "폴더를 신뢰해야 로드됨"을 알리고, round-trip 테스트를 신뢰/비신뢰 두 arm으로 둔다(NW-8). 웹데몬 AGENTS.md 효과 arm을 둔다(NW-10).
- **E**: E1은 단일 reading 생산자, digest + 주입분 차감, 세션별 carry, 어댑터 `promptTokens`(F의 `AnthropicConfig.baseURL` 사용, env 변이 금지), CLI holder·경고·canvas total을 담고, T10 census는 "total을 계산하는 함수는 정확히 하나"로 좁힌다. E2는 served window key, 웹 StatusBar 판정 + drift contract, 이름 변경, 삭제를 담는다. E는 F C1–C7에만 의존한다.
- **F**: C6을 둘로 나눈다. W1에는 category carry, turn.submit guard, goal-work-compose를 넣는다. goal-wake-compose.ts의 SESSION_STATUS_SETTLED 소비는 C8(blocker)과 같은 커밋이나 그 뒤에 넣는다. C10(SDK maxRetries=0)은 모든 boot port를 `decorateSwappableModelPort`로 감싼 뒤(NW-6), 벤치는 throttle 측정 후. C11(Responses completed 없이 종료 → network)은 프록시별 기록 fixture 후(NW-14). 실제 401 fixture는 운영자가 1회 캡처해 출처와 함께 커밋하고, 자동 테스트에서 벤더를 호출하지 않는다.

## 4. 웨이브 (웨이브 안은 파일 disjoint 병렬, 웨이브 사이는 순차)

**W1** (lane마다 `.worktrees/s14-<lane>` 워크트리, main 트리 직접 수정 금지)
- `A`: C1 컴파일 플래그 SSOT + AST census → C2 fork/shim runtime argv → C3a 로더 API → C3b 5개 진입점 전환·bench 파서 삭제·테스트 이관(NW-11, NW-20) → C4 문서·ADR
- `B1`: C1 funnel seal → C2 LSP_ENV_ALLOWLIST(DEFAULT에서 파생) → C3 initializationOptions 채널 → C4 `LSP_HARDENING: Record<LspServerKind, {trusted, untrusted}>` SSOT + 신뢰 명령·shebang 인터프리터 resolver(NW-4). 모든 LSP spawn은 funnel로(위치 census)
- `C3`: SEC-3a write_stdin extractor(+NW-15) → SEC-3b assembled-universe census → NW-19 env fold-in → [P] prefix verb 억제
- `D1`: BUG-1 B1–B6
- `DS1`: D-S1 `src/config/project-trust.ts`(branded decision, realpath git root, containment, 절대경로만, home grant는 session-only) + `MODE_PROJECT_TRUST_SOURCE` Record
- `F1`: C1 LLM_ERROR_KINDS → C2 경계 분류기 → C3 Responses → C4 PTL을 경계로 → C5 loop stopCategory 필수 → C6a 커널 carry·submit·goal-work → C7 usage_limited kind 게이트
- `S`: NW-2 spill 심볼릭 격리

**W2**: D-S2 + NW-7 + NW-8 → D-S4..S7(+NW-1, NW-3, NW-10) · B C5..C10(신뢰 결정 소비, U-5, NW-9, NW-18) · F C8 blocker + C6b wake 소비 + C9 + 웹 W1–W4 · F NW-6 → C10, NW-14 → C11 · C SEC-4(NW-12, NW-16) + SEC-3d exec_command sandbox + logical-line assembly

**W3**: E1 → NW-13 영수증 → E2

공유 파일 직렬화: `src/shared/index.ts`(B1, F1), `src/agent/index.ts`(D1, F1). land할 때 앞 lane이 main에 들어간 뒤 뒤 lane이 rebase한다.

## 5. 커밋·어딧 규율

커밋 단위 (lane 워크트리 안에서):
1. RED 테스트를 먼저 쓰고, 현재 트리에서 실제로 red인지 측정한다.
2. 구조적으로 구현한다(SSOT, 표현 불가능한 invalid state, composition root 배선).
3. 뮤테이션을 증명한다. cp로 백업하고 뮤턴트 토큰이 적용됐는지 확인한 뒤 실행하고, cp로 복원한다. `git checkout`으로 복원하지 않는다.
4. 대상 테스트를 돌리고, 타입 확장이 있으면 main의 tsc로 워크트리 tsconfig 전체를 typecheck한다. biome은 내 파일만 돌린다.
5. lane 브랜치에 작은 커밋으로 남긴다.

land (오케스트레이터, main 트리):
1. `git rev-parse --abbrev-ref HEAD`가 `main`인지 문자열로 확인한다.
2. 대상 경로에 대해 dirty 겹침, lane base 이후 main 커밋 겹침, staged leak을 확인한다.
3. 겹치면 워크트리에서 rebase하고 다시 검증한다.
4. 커밋별로 파일을 복사하고 `git commit --only -F <msg> -- <paths>`로 커밋한 뒤, `git show --stat`으로 leak이 없는지 확인한다.
5. 웨이브마다 `QUANTA_TYPECHECK_NO_SKIP=1 bun run typecheck:all`과 영향받는 unit·integration 계층을 돌린다.

헬어딧 (웨이브·lane마다):
- 컨텍스트 없는 적대 → 객관 검증 → 구조적 TDD 보완을 반복한다.
- 적대+객관 양쪽 모두 새 진짜 결함이 0이고 적대 라운드가 3회 이상이면 종료한다.
- 서브에이전트의 "green" 보고는 오케스트레이터가 테스트·뮤턴트를 직접 재실행해서 확인한다.

## 6. 수용한 잔여 위험

- 적대적 cwd에서 quanta 소스를 손으로 실행하는 경우(Bun autoload/preload)
- 인터프리터 REPL로 흘린 stdin 페이로드
- tty 라인 편집 vs raw 바이트
- 벤더 에러 union과 실제 API의 drift
- 캡처하지 않은 quota/billing 본문
- 데몬 재시작 후 웹 dedup 창
- resume 시 carry 미영속
- gopls 미측정
- Tauri 바이너리(재빌드 전까지)
- 신뢰 부여 시점과 이후 내용 변경 사이의 TOCTOU(CC·Codex와 동일)

## 7. 진행 상태

| 웨이브/lane | 상태 | main 커밋 |
|---|---|---|
| W1 A | 구현 + 5라운드, main 위로 rebase·조정 중: sep-13 SEC-1 스크럽(`28d68bd85`)은 Bun이 먼저 읽는 `.env`에서 동작하지 않음(측정: base URL·bypass·키 헬퍼가 경고 0개로 통과) → checkout-root 로더가 대체하고 스크럽은 제거(두 세션과 합의). sep-12 `operator-trusted-paths.ts`는 유지 | |
| W1 B1 | 대기 | |
| W1 C3 | 대기 | |
| W1 D1 | 대기 | |
| W1 DS1 | 기반 land (sep-12 truth-guard, ADR-0559) — 아래 §7.1 | `b6d0d27d0`, `d2a8c4b7b` |
| W1 F1 | 대기 | |
| W1 S | land (구현 + 적대/객관 5라운드, 마지막 라운드 확정 0; 오케스트레이터 재검증: rebase 무충돌, lane·광역 라쳇 176/177(남은 1은 main에도 있는 foreign `test-shard-lease` tmp-leak red), symlink 거부 뮤턴트 8 red, tsc 0, biome clean) | `b7d5488e3`..`75b8679e8` (13) |
| W2 | 대기 | |
| W3 | 대기 | |

### 7.1 sep-12 truth-guard 캠페인이 먼저 land한 기반 (2026-09-14, 운영자 결정)

sep-12 라운드 9의 A-F1(LSP가 워크스페이스 코드 실행)을 고치던 세션이 같은 영역의 폴더 신뢰 게이트를 만들었고,
운영자가 "이 계획의 기반으로 land하고 U-1에 맞춘다"를 골랐다. ADR-0559가 정본이다. 이 계획의 lane은 아래를
전제로 이어서 만든다(재구현하지 않는다).

#### 7.1.1 sep-12 라운드 11이 추가로 land한 것 (2026-09-14/15, main `bafdd1b7e`)

라운드 11 적대 어딧에서 나온 것들. lane은 이것들을 전제로 만든다(세션 간 합의 기록: 이전 sep-14 오케스트레이터와 조율함).

- `a0882eaa7` MCP 설정 경로: 운영자 설정은 **실제 env의 절대경로**뿐. dotenv 출처 값은 그 dotenv 폴더, 상대경로는 실행
  폴더의 신뢰를 따른다(`src/host/mcp-config-source.ts`, ADR-0559 결정 4 개정). DS1 lane의 `e76f27329`(상대경로)와
  같은 결함을 덮으므로 재구현하지 않는다. **남은 것**: Bun이 먼저 자동 로드하는 `.env`의 절대경로(`${PWD}/x.json`)는
  출처가 없어 운영자 값으로 읽힌다 — lane A(SEC-0).
- `0b1e62e2d` LSP 가용성 프로브: `isAvailable`/`lspBinaryAvailable`가 신뢰 판단 폴더를 **필수 인자**로 받고
  캐시·test override·spawn 전에 신뢰를 확인한다(그 전에는 `<ws>/bin/gopls --version`이 API 키와 함께 먼저 실행됐다).
  nav 풀의 별도 assert는 이 호출로 합쳤다. **lane B(2)가 이어서**: env 스크럽, PATH 필터, 신뢰 바이너리·shebang 해석,
  `beforeSpawn` 필수화, 위치 census(내 regex arm 대체). lane B는 이 필수 인자 위에 쌓는다.
- `d89b0e569` 도구 identity: 승인된 호출은 도구 **자기 이름**으로 실행된다(모델용 tool_use만 별칭; tool_result는 id를
  나른다). `ToolRegistry.derive`가 origin·policy 이름을 보존하고 `new ToolRegistry(` 위치를 census가 고정한다.
  C3 lane은 이 dispatch 한 줄 위로 rebase한다(shellSubject 리더는 action에서 읽으면 호환).
- `3ae3db325` daemon allowlist 문서 정정 + **열린 결정**: daemon preset 가드 + `acceptEdits`에서 `bash`의
  `curl … -d @.env`가 off-list 호스트로 허용된다(측정). allowlist 자세에서 셸 거부 vs OS egress 강제 — 운영자 결정 대기.
- 그 외 같은 라운드: `49ac088eb`(merge 탐지기 규칙), `73a920bb9`(node REPL 정지·늦은 출력), `5c8b7805f`(메모리 안내),
  `9ed041e44`(테스트 fence `env: null`). 상세와 재현은 `docs/plans/sep-12-truth-guard-hardening/corrections.md` §L.

| 이 계획 항목 | 들어간 것 | 이 계획과 다른 점 / 남은 것 |
|---|---|---|
| DS1 결정 | `@/agent/workspace-trust`(authority, 하위 폴더 포함·가장 가까운 기록 우선, 미설치=비신뢰) + `@/host/workspace-trust`(trust.json·`QUANTA_TRUSTED_PATHS`·질문 해석). 신뢰 대상은 realpath git checkout 루트, 홈 폴더 yes는 세션 한정 | 모듈 위치가 `src/config/project-trust.ts`가 아니다. branded decision 타입, `MODE_PROJECT_TRUST_SOURCE` Record는 없다(헤드리스 에이전트는 `AGENT_MODE_WORKSPACE_TRUST` Record) |
| U-1 질문 | 대화형 REPL 시작 전 1회(TTY만, 기본 no) | `/rules`·`/status`의 ignored 표시, `quanta trust`, `--trust-project`는 없다 |
| D-S2 `.mcp.json` | `readMcpConfig`의 cwd 폴백을 신뢰 폴더에서만 읽음 + 운영자 알림(CLI·웹데몬 공통) | `quanta trust` 명령, 커넥터 설치기 결과 문구(NW-8)는 남음 |
| D-S5 계열 | 플러그인 auto-wire, project-grants overlay 신뢰 게이트 + 알림 | AGENTS.md/CLAUDE.md, `.quanta/agents`, rules, skill dir, environment.toml(NW-3), legacy-cwd 메모리(NW-1)는 남음 |
| B | spawn 직전 `beforeSpawn` 게이트(에이전트는 게이트된 팩토리로만 서버 생성, census), prewarm·멘션·shadow_verify 포함, 거부는 이유로 도구에 전달 | **U-5 강화 모드는 없다**: 비신뢰 폴더의 LSP는 지금 완전히 꺼진다(계획보다 엄격). env 스크럽, 신뢰 경로 바이너리·shebang 해석(NW-4), recording spawner wiring arm(NW-9), 벤치 전후 측정(NW-18)은 남음 |
| 진입점 | 모든 `import.meta.main` 파일 분류 테스트. CLI 바이너리·헤드리스(ci-bot/daemon은 항상 비신뢰)·웹데몬·serve는 기록된 결정, 벤치·eval·terminal brain-mode는 전체 신뢰 | SDK 호스트는 authority를 설치해야 LSP가 동작 |

테스트: `tests/unit/cli/workspace-trust-hellgate.test.ts`(가짜 서버 바이너리 + paired control, 뮤턴트 14개 red).
테스트 프로세스는 스크래치 폴더만 신뢰한다(`tests/setup.ts`).

### 7.2 재조정 (2026-09-14 오후) — 다른 세션이 main에 넣은 것과 이 계획의 대응

| main 커밋 | 무엇 | 이 계획의 대응 |
|---|---|---|
| `b6d0d27d0` 외 (sep-12, ADR-0559) | 폴더 신뢰 authority, TTY 프롬프트, `.mcp.json`·plugins·project-grants·LSP spawn 게이트 | DS1 lane은 중복이라 폐기(land 안 함). 남은 신뢰 항목은 W2에서 이 기반 위에 만든다 |
| `28d68bd85` (sep-13 SEC-1) | dotenv 출처 base URL 스크럽 | 측정: Bun이 먼저 읽는 `.env`에서 동작 안 함(base URL·bypass·키 헬퍼가 경고 0개로 통과), `.env.dev`에서도 `OPENAI_BASE_URL`만 제거. lane A가 원인(컴파일 플래그 + checkout-root 로더)을 고치고 스크럽을 대체. sep-13 세션 합의 |
| `3188cf2d1`, `93aba3560`, `b302178a5` (sep-13 SEC-2) | pyright 워크스페이스 인터프리터 = 신뢰 폴더일 때만, env 스위치 제거 | B1이 main의 신뢰 결정·canonical root를 소비하도록 재조정(§8) |
| `aa4de8d8c` (sep-13 BUG-2) | `/context`에 transcript 합산 | E(W3)가 표시·경고·트리거 단일 측정으로 대체. sep-13 세션 합의 |
| `a0882eaa7` (sep-12) | dotenv 출처·상대경로 MCP config 경로도 폴더 신뢰 필요 | 유지. Bun `.env` 자동 로드 + 절대경로(`${PWD}`)는 lane A 소관 잔여 |
| `2390b979e` (sep-13 OC-4) | seatbelt 읽기 경계 | 겹침 없음 |

sep-13 세션은 W-SESSION(BUG-1/3/4)·W-PERM(SEC-3/4/5)을 이 계획에 넘기고, OC-1(activity stuck)은 C3·F1 land 후
커널 `awaiting_approval` 투영 + W2 goal Blocker 소비 + wait_agent·tool-in-flight producer로 진행한다.

## 8. 수렴 규칙 (W1 경험에서 추가)

어딧 루프가 **연속 3라운드 이상 막는 결함을 확정**하면 패치를 멈춘다. 모든 라운드의 발견을 근본원인별로 묶는
설계 에이전트(읽기 전용)를 돌리고, 그 클래스를 표현 불가능하게 만드는 구조 변경 하나를 구현한 다음 어딧을
다시 시작한다. 계기: C3는 `ShellSubject`를 `ToolAction`의 느슨한 필드 세 개로 들고 다녀서 라운드마다 "이
소비자도 채널을 안 본다"가 나왔고, B1은 main에 canonical root authority가 생긴 뒤에도 자체 `.git` 탐색으로
containment root를 다시 계산해 worktree·submodule 엣지가 계속 나왔다.

범위 fence: lane이 원래 클래스 밖으로 번지면(예: C3의 SEC-4·sandbox·line assembly) W2로 넘기고 lane은 자기
클래스를 닫는 데서 끝낸다.

### W2 (W1 land 후, main 기반 재매핑)
- 신뢰 잔여(ADR-0559 위): `quanta trust`·`--trust-project`, `/rules`·`/status` ignored 행, AGENTS.md/CLAUDE.md·`.quanta/agents`·vendor/glob rules 게이트, `environment.toml`(NW-3), legacy-cwd 메모리(NW-1), 커넥터 설치 결과(NW-8), 웹데몬 AGENTS.md arm(NW-10)
- B: U-5 비신뢰 강화 모드(pyright 신뢰 인터프리터 + extraPaths, PATH tsserver, rust 핀) — main의 "비신뢰 전면 OFF"를 U-5 결정대로 대체, 벤치 LSP grounding 전후 측정(NW-18)
- F: C8 goal blocker + C6b wake 소비 + C9 CLI stop 줄 + 웹 W1–W4, NW-6 → C10, NW-14 → C11
- C: SEC-4 floor(NW-12 오프라인 재생, NW-16), SEC-3d exec_command sandbox, stdin logical-line assembly

### W3
- E1(단일 측정 생산자, `aa4de8d8c` 대체) → NW-13 영수증 → E2
