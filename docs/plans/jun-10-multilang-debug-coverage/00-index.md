# 멀티언어 디버깅 Evidence 키스톤 — 티켓 인덱스 + DoD (SSOT)

> 비전(유저): ❌자체 디버거/LSP ⭕ **LSP Client + DAP Client + Test Runner Adapter + Evidence Packet Builder** → 통일 evidence packet을 LLM에 공급.
> 배경 플랜: [../jun-10-multilang-debug-coverage.md](../jun-10-multilang-debug-coverage.md) (단계 플랜·OCP 비용표 — 일부 stale, 이 인덱스가 상태 정본).
> 이 인덱스 = **완료 정의(DoD)** + **DONE 상태판** + **OPEN 백로그 티켓 맵**. 상태 정본(SSOT).

---

## DoD — 키스톤 완료 정의 (못박음)

### §1 기능 커버리지 — 목표 16칸 (`collect_evidence` = failure+static+runtime+repo 융합)

| 언어 | failure(파서) | static(LSP) | runtime(디버거) |
|---|---|---|---|
| Python | pytest+unittest ✅ | pyright ✅ | debugpy (DAP) ✅ |
| Rust | cargo ✅ | rust-analyzer ✅ | lldb-dap (DAP) ✅ |
| Go | go test ✅ | gopls ✅ | dlv (DAP/TCP) ✅ |
| Node/TS | bun/jest/vitest/node:test ✅ | typescript-ls ✅ | node --inspect-brk (CDP) ✅ |

**완료 = 16/16 LIVE + 각 칸 실 toolchain e2e 1회 이상 green.** → **충족 (16/16).**

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

---

## OPEN 백로그 (티켓 — 우선순위순)

| # | 티켓 | 기능 | ROI | 충돌주의 |
|---|---|---|---|---|
| [T-01](01-exception-aware-breakpoints.md) | exception-aware breakpoint | break-on-throw: 정밀 failure-line 없거나 예외가 깊은 곳서 throw될 때 throw 지점서 정지+예외정보 | **높음**(SOTA, 전 언어, false-line 회피) | inspect-driver.ts/cdp-inspect.ts(동시 co-dev) |
| [T-02](02-runner-orchestrated-js-runtime.md) | 러너-orchestrate JS runtime | jest/vitest/단순.ts 단일파일 CDP 실행(현재 node:test 자체실행만) | 중(JS 런타임 커버 확대) | runtime.ts |
| [T-03](03-language-pretty-printers.md) | 언어 pretty-printer + goroutine dump | Rust Vec/HashMap/Arc·Go goroutine·Py dataclass 가독 렌더 | 중(evidence 가독성) | 없음(신규 매핑층) |
| [T-04](04-tier2-languages.md) | Tier-2 언어 | C++(clangd)·Java(jdtls/java-debug)·C#(Roslyn/netcoredbg) | 저-중(점진) | 없음(OCP 증분) |
| [T-05](05-tracking-fc-ratchet-dod-gate.md) | tracking + fc + ratchet + DoD CI 게이트 | §4를 ratchet/fc로 영구 가드, 새 언어칸 회귀 방지 | **높음**(완성 유지) | fc(동시 co-dev) |

> **다음 결정 1개만**: (A) 키스톤 여기서 CLOSE (T-05만 돌려 못박고 종료) / (B) T-01(exception-aware)을 DoD §1에 끌어올려 다음 스코프 OPEN. 어느 쪽이든 이 인덱스 기준으로 한 번에 간다.

## 불변식 (모든 티켓 상속)
- 기존 `src/lsp`(OCP 레지스트리)·`src/tool/debug`(codec/client/driver) **재사용**, 코어 재구축 금지.
- 외부 어댑터 = **실물 + 복수 구현 검증**(fake-green이 데드락/terminate-행/race 가림 — jun-10 교훈).
- 동시 co-dev: 사용자 세션이 cdp-inspect/inspect-driver에 silent-failure 어딧 병행 — **그 파일 편집 충돌 회피**, 인접 surface 우선. `git add -A` 금지.
