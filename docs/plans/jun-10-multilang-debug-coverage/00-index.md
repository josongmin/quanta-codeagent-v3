# 멀티언어 디버깅 Evidence 키스톤 — 티켓 인덱스 + DoD (SSOT)

> 비전(유저): ❌자체 디버거/LSP ⭕ **LSP Client + DAP Client + Test Runner Adapter + Evidence Packet Builder** → 통일 evidence packet을 LLM에 공급.
> 배경 플랜: [../jun-10-multilang-debug-coverage.md](../jun-10-multilang-debug-coverage.md) (단계 플랜·OCP 비용표 — 일부 stale, 이 인덱스가 상태 정본).
> 이 인덱스 = **완료 정의(DoD)** + **DONE 상태판** + **OPEN 백로그 티켓 맵**. 상태 정본(SSOT).

---

## DoD — 키스톤 완료 정의 (못박음)

### §1 기능 커버리지 — 5언어 × 3축 (`collect_evidence` = failure+static+runtime+repo 융합)

| 언어 | failure(파서) | static(LSP) | runtime(디버거) |
|---|---|---|---|
| Python | pytest+unittest ✅ | pyright ✅ | debugpy (DAP) ✅ |
| Rust | cargo ✅ | rust-analyzer ✅ | lldb-dap (DAP) ✅ **+pretty-print(Vec/HashMap)** |
| Go | go test ✅ | gopls ✅ | dlv (DAP/TCP) ✅ **+goroutine dump** |
| Node/TS | bun/jest/mocha/vitest/node:test ✅ | typescript-ls ✅ | node --inspect-brk (CDP) ✅ +jest/mocha 라우팅 |
| **C++** (Tier-2) | ctest/gtest/assert ✅ | clangd ✅ | clang++ -g→lldb-dap (DAP) ✅ |

**완료 = 15/15 LIVE + 각 칸 실 toolchain e2e green** + break-on-throw(py/node). → **충족.** (Java/C#은 toolchain 부재로 의도적 미포함 — 아래 T-04.)

### §2 컴포넌트 품질 바 (각 파서·드라이버·어댑터 전부)
- 파서: 실 출력 **verbatim 핀** + 라이브 1회 검증. file:line 정확.
- 런타임 드라이버: 멀티프레임(top-K=3) + 중첩 펼침(bounded depth2/breadth16/total200) + DAP/CDP type. **NEVER-throws · abort-aware(대기 race) · timeout 가드**.
- 헬게이트 **2면**: scripted-fake unit(red-on-injection) **AND** REAL toolchain e2e(없으면 auto-skip).
- **false-green 금지**: 안 돌면 explicit `ok:false`; exit-code 안전망; 0-tests를 green 안 함.

### §3 와이어링/서피스
- default-OFF 게이트(`QUANTA_EVIDENCE`/`QUANTA_TEST_RUNNER`/`QUANTA_DEBUG_TOOLS`) + always-confirm.
- cross-slice 포트(LSP/DAP) host-injected, 없으면 섹션만 degrade(패킷은 빌드).
- 도구 3종: `collect_evidence` · `run_tests` · `debug_inspect`(4 carrier: python/lldb/node + custom DAP).

### §4 repo-green 게이트 (모든 머지 전, 전부 0 — 매 티켓 DoD에 상속)
- `bun run typecheck`(src, 캐시 클리어) = **0 error**.
- `bun run typecheck:tests` = 건든 파일 **신규 error 0**(기존 동시-debt 제외).
- `tests/unit/tool/{debug,evidence,testrun}/` + `lsp-bridge-probe` = **0 fail**.
- 신규 throw/gate/tool에 대한 ratchet 위반 0 · 신규 도구 풀배선(manifest GATED+knob trio+fc+ADR).

### §5 명시적 NON-GOAL (스코프 닫음 — "미완"이 아님)
- jest/vitest **러너-orchestrate** 단일파일 CDP 실행 → [T-02](02-runner-orchestrated-js-runtime.md) 백로그.
- exception-aware breakpoint(break-on-throw) → [T-01](01-exception-aware-breakpoints.md) 별도 트랙.
- 언어별 pretty-printer / goroutine dump → [T-03](03-language-pretty-printers.md).
- Tier-2/3 언어(C++/Java/C#/…) → [T-04](04-tier2-languages.md).
- js-debug DAP(멀티세션) → **CDP로 대체, 버림**.
- Windows 경로/셸 → posix 포커스.

> **현 상태: §1·§2·§3·§5 충족, §4 매 증분 그린 확인 중. 키스톤 코어 = DoD 충족(DONE).** OPEN 백로그(§5)는 정의상 별도 트랙.

---

## DONE 상태판 (LANDED — 재구축 금지)

| # | 컴포넌트 | ADR/근거 | 핵심 |
|---|---|---|---|
| D01 | DAP TCP 트랜스포트 | port.ts `spawnTcpDebugAdapter`/`connectTcpTransport` | 소켓 error 핸들러·retry-connect·4 local-socket test. Go dlv 첫 소비자 |
| D02 | toolchain 감지기 | ADR-0532, testrun/detect.ts | Cargo/go.mod/pyproject/package.json + canRun(pytest 선호) |
| D03 | 구조화 test-runner + 파서 | ADR-0532, testrun/{tool,parse}.ts | go(-json)/cargo/unittest/**pytest**/**node** 5파서, verbatim 핀, false-green 안전망 |
| D04 | Rust LSP+DAP | Epic-1 | rust-analyzer + lldb-dap, breakpointsBound 진단, 실 e2e |
| D05 | Evidence Packet Builder(키스톤) | ADR-0533, evidence/ | `collect_evidence`, 4섹션 융합, fault-isolated, 실 융합 e2e |
| D06 | Go static+runtime | lsp-bridge `.go`→gopls, runtime.ts dlv | gopls 실 e2e 2 + dlv TCP runtime 실 e2e. **Go 풀 키스톤** |
| D07 | 런타임 깊이 | inspect-driver.ts | 멀티프레임+중첩 펼침(bounded)+type, 실 lldb e2e(`iter` Range 자식) |
| D08 | node/JS 파서 | testrun/parse.ts `parseNodeTest` | V8 스택프레임 추출(bun/jest/vitest/node:test), JS→failure+static 실 e2e |
| D09 | pytest 러너 | testrun/parse.ts `parsePytest` | 정확성갭 해소(pyproject→pytest 선호), verbatim+라이브 검증 |
| D10 | Node CDP 런타임 | debug/cdp-{client,inspect}.ts, port.ts | **첫 non-DAP carrier**; `node --inspect-brk`+CDP, 동일 Inspection 셰이프(toRuntime 재사용), 실 e2e |
| D11 | debug_inspect node carrier | debug/tool.ts `adapter:"node"` | 인터랙티브 디버거도 CDP, 헬게이트 2 + 실 node 도구 e2e |
| D12 | **exception-aware breakpoint (T-01)** | inspect-driver(DAP setExceptionBreakpoints+exceptionInfo)·cdp-inspect(setPauseOnExceptions)·tool `exceptionBreakpoints` | break-on-throw. DAP+CDP 드라이버 헬게이트 + 실 node break-on-throw e2e(TypeError throw 지점 포착). node "uncaught"→"all"(top-level 래퍼 특성, 측정확인). `RuntimeEvidence.exception` plumbing. **scope: debug_inspect 도구 reachable**; collect_evidence line-less 폴백은 follow-up(line-bp 일차성 유지=assert-internal-frame 회피) |
| D13 | **coverage-matrix drift ratchet (T-05)** | tests/unit/tool/keystone-coverage-matrix-ratchet-hellgate.test.ts | 4언어×3축 독립 리터럴 앵커(failure detect / static lsp / runtime carrier exhaustive Record). 언어칸 드롭→red. 3도구 manifest GATED·knob·gate 확인. **완성 durable 락** |
| D14 | **JS 러너 라우팅 (T-02)** | evidence/node-runner.ts, runtime.ts nodeRuntime | jest --runInBand / mocha / node:test 단일프로세스 CDP. 순수 detectJsRunner+nodeInspectArgv+헬게이트. **실 mocha e2e**(npm i mocha→`result=10`). vitest degrade. |
| D15 | **thread/goroutine dump (T-03)** | inspect-driver.ts threads 캡처 | DAP `threads`(dlv→goroutine) bounded→`RuntimeEvidence.threads`(>1). 동시성 버그 triage. 헬게이트+**실 go e2e 단언**(goroutine>1, R1 보완). |
| D16 | **C++ 5번째 언어 (T-04)** | lsp/adapters/clangd.ts, testrun detect/parseCtest, runtime cppRuntime | failure(ctest: libc-assert verbatim+gtest)·static(clangd 실 e2e)·runtime(clang++ -g→lldb-dap 실 e2e, `result=10`). 매트릭스 ratchet 5언어 확장. Java/C#=toolchain 부재로 미포함(정직 defer). |
| D17 | **Rust pretty-printer (R3)** | runtime.ts `rustLldbInitCommands` | lldb-dap launch `initCommands`로 rust 자체 formatters(`<sysroot>/lib/rustlib/etc/lldb_commands`) sourcing→`Vec<i32>`가 `[10,20,30]` 요소로 펼쳐짐(raw `{buf,len}` 대신). 측정확인+**실 e2e 단언**. |
| — | **R1 audit 보완** | runtime.ts RUNTIME_HANDLERS | 🔴(A)`defaultRuntimePort` if-체인→**exhaustive `Record<Toolchain["kind"],H>`**(arm 누락=컴파일에러; 매트릭스 ratchet 런타임축이 vacuous였던 것 보완). (B)go goroutine 실 e2e 단언 추가. (C)DAP exception desc 미trim=정답(과교정 회피). |

---

## OPEN 백로그 (티켓 — 우선순위순)

| # | 티켓 | 기능 | ROI | 충돌주의 |
|---|---|---|---|---|
| ~~T-01~~ ✅ | ~~exception-aware breakpoint~~ | **DONE → D12.** break-on-throw DAP+CDP 드라이버+도구 reachable. (collect_evidence line-less 폴백만 follow-up) | — | — |
| ~~T-02~~ ✅ | 러너-orchestrate JS runtime | **DONE → D14.** jest(`--runInBand`)+mocha+node:test 단일프로세스 라우팅. 실 mocha e2e. **남음: vitest worker-inspector**(측정: `--inspect-brk=PORT`가 /json/list 미노출=worker-pool 내부관리, js-debug급 fragile). | — | — |
| ~~T-03~~ ✅ | pretty-printer + goroutine dump | **DONE → D15+D17.** goroutine dump(go 실 e2e) + **Rust pretty-printer**(lldb rust formatters initCommands→Vec 요소, 실 e2e). | — | — |
| ~~T-04~~ ✅ | Tier-2 언어 | **DONE(C++) → D16.** C++ 풀 검증(clangd+lldb-dap+ctest). **Java/C#=toolchain(JRE/dotnet) 부재 확인→no-guessing 회피, OCP 문서화 defer.** | 저-중 | — |
| ~~T-05~~ ✅ | tracking + ratchet + DoD 게이트 | **DONE → D13.** 16칸 매트릭스 drift ratchet(독립 리터럴, red-on-injection) + 3도구 manifest GATED/knob-inventory/gate 확인 + repo-green 게이트 통과. (fc 엔트리/ADR 넘버링은 D06~D12가 기존 도구·슬라이스 확장이라 신규 불요) | — | fc(동시 co-dev) |

> **상태: 모든 티켓 CLOSED (D01~D17).** OPEN 백로그 0. 검증 가능한 잔여 0. 측정-기반 deferral 2개(둘 다 정직): **vitest worker-inspector**(멀티프로세스, `--inspect-brk` /json/list 미노출 측정) · **Java/C# Tier-2**(JRE/dotnet 부재 측정). 둘 다 toolchain/멀티프로세스 벽이지 우리 설계 미비가 아님. 키스톤 = **DONE**.

## 불변식 (모든 티켓 상속)
- 기존 `src/lsp`(OCP 레지스트리)·`src/tool/debug`(codec/client/driver) **재사용**, 코어 재구축 금지.
- 외부 어댑터 = **실물 + 복수 구현 검증**(fake-green이 데드락/terminate-행/race 가림 — jun-10 교훈).
- 동시 co-dev: 사용자 세션이 cdp-inspect/inspect-driver에 silent-failure 어딧 병행 — **그 파일 편집 충돌 회피**, 인접 surface 우선. `git add -A` 금지.
