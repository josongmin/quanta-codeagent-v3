# 멀티언어 에이전트 디버깅 — 언어셋 커버리지 플랜 (jun-10)

> 유저 비전: ❌자체 디버거/LSP ⭕ **LSP Client + DAP Client + Test Runner Adapter + Evidence Packet Builder** → 통일된 evidence packet을 LLM에 공급.
> 이 문서는 그 비전을 **quanta 현 코드에 grounding**한 실행 플랜. (broad-grep 검증 완료 — 중복설계 회피)

## 0. 현황 — 이미 있는 것 (재구축 금지)

| 유저 컴포넌트 | quanta 상태 | 근거 |
|---|---|---|
| **LSP Client** | ✅ **EXISTS + LIVE 도구** | `src/lsp/`(generic jsonrpc base + def/ref/hover/diagnostics/symbols/**call-hierarchy**/rename/format/sig-help). 어댑터: **pyright(Py)·typescript(TS)·rust-analyzer(Rust, jun-10 Epic-1)**. `src/tool/lsp_nav/`(8 nav 도구)로 LLM 노출, `src/agent/lsp-bridge.ts`가 **OCP 레지스트리**(언어 추가=어댑터 1 + 엔트리 1줄) |
| **DAP Client** | ✅ **EXISTS + LIVE 도구** (jun-10 빌드) | `src/tool/debug/`(codec/client/inspect-driver/port, **stdio**). 어댑터: **debugpy(Py)·lldb-dap(C/C++/Rust/Swift)**. `debug_inspect` 도구(always-confirm, default-OFF). 실 2언어 검증(ADR-0531) |
| **Test Runner Adapter** | 🟡 **부분** | 범용 도구는 없음(현재 bash로 실행). SWE-bench batch에 `runner/batch/corpus/failure-classifier.ts`·`eval/repair/validator.ts`·`eval/verdict.ts`(재사용할 패턴) |
| **Evidence Packet Builder** | ❌ **신규(키스톤)** | 없음. LSP+DAP+test를 유저 JSON 스키마로 통합하는 층이 빠짐 |

부가 자산: `bash`(임의 테스트 실행) · 브라우저 도구(Playwright급 프론트 evidence: trace/console/network/DOM/screenshot) · 디버깅 스킬(`localize-fault`/`debug-trace`/`explain-stack-trace`/`loop-on-ci`) · `runtime/env-probe`(toolchain 감지 확장점).

**결론:** 4 컴포넌트 중 **2개(LSP·DAP Client)는 이미 LIVE**. 진짜 일감은 (a)언어 어댑터 확장 (b)**DAP TCP 트랜스포트**(Go/TS 차단해제) (c)Test Runner Adapter (d)**Evidence Packet Builder(키스톤)**.

## 1. 언어별 확장 비용 (OCP 구조 활용)

- **LSP 언어 추가** = thin 어댑터 1개(서버 command + ext→languageId) + lsp-bridge 레지스트리 1줄. (jsonrpc/capability/정규화는 base가 이미 함)
- **DAP 언어(stdio)** = 프리셋 1줄 + launch-config 빌더 분기. (lldb-dap은 C/Rust/Swift/Zig 공용 — 프리셋만)
- **DAP 언어(TCP: Go dlv-dap / TS js-debug / Java / C#)** = **Phase 0의 TCP 트랜스포트 선행** 후 프리셋.
- **Test Runner** = 러너별 파서 1개(구조화 출력 정규화).

## 2. 단계 플랜

### Phase 0 — 토대 (나머지가 의존)
- **0a. DAP TCP 트랜스포트** — `src/tool/debug/port.ts`가 stdio 전용. `DebugAdapterPort`에 socket transport 추가(spawn→포트 listen→TCP 연결, framing 동일). **tier-1 Go/TS의 단일 최대 차단요인.** (기능)dlv-dap·js-debug 연결 (왜)Go/TS DAP 불가 (ROI)높음·M.
- **0b. Toolchain/언어 감지기** ✅ **LANDED (jun-10, ADR-0532)** — `src/tool/testrun/detect.ts`(Cargo.toml→cargo / go.mod→go / pyproject·setup→python / package.json→npm; 순서우선; 주입 exists-port). 7 test. Evidence Builder가 소비. C#/Java 마커는 후속.

### Phase 1 — Tier-1 언어 (Python/Go/Rust/TS = 유저 MVP)
- **Python** ✅ LSP(pyright)+DAP(debugpy) 완료 → **pytest 구조화 러너만 추가**.
- **Rust** ✅ **LANDED (jun-10 Epic-1)** — LSP 어댑터(rust-analyzer) + lsp-bridge `.rs` 엔트리 + DAP lldb-dap(실검증). 실 rust-analyzer 1.95.0 e2e(def+hover) + 실 cargo+lldb-dap DAP e2e(stack/locals, realpath 매칭). 보강: breakpoint **바인딩 실패 진단**(`breakpointsBound` — verified:false면 "디버그정보/경로 확인" NOTE; setBreakpoints 타임아웃 시엔 오진단 안 함). 남음: `cargo test --message-format=json` 러너(Phase 2) · Vec/HashMap/Arc pretty-printer(후속).
- **Go** — LSP 어댑터(gopls) NEW · DAP=dlv-dap(**Phase 0a TCP 필요**) · 러너 `go test -json` · **goroutine dump** evidence(동시성 버그).
- **TS/JS** — LSP(typescript) ✅ · DAP=js-debug(**Phase 0a TCP 필요**) · 러너 vitest/jest `--reporter=json` · 프론트는 **기존 브라우저 도구**(Playwright trace/HAR/DOM) 재사용.

### Phase 2 — Test Runner Adapter (구조화) ✅ **LANDED (jun-10, ADR-0532)**
- `run_tests` 도구(`src/tool/testrun/`): 감지→실행→정규화 `{passed, failed:[{name,file,line,message}]}`. 파서 go(-json)/cargo(text)/python(unittest), **실 출력에 핀**. default-OFF `QUANTA_TEST_RUNNER`+always-confirm, NEVER-throws. **false-green 안전망**(exitCode≠0+무failure→ok:false; go build-fail 포착). 실 cargo/go/python e2e + fault hellgate(25 test). 기존 `test_runner`(bash 휴리스틱 verdict, BASE)와 **공존**(이건 구조화 per-language). 남음: pytest 러너·node 구조화 파서·Rust/Go pretty-printer.

### Phase 3 — Evidence Packet Builder (키스톤) ✅ **LANDED (jun-10, ADR-0533)** — failure+repo+static+Python runtime 프로덕션 LIVE
- `src/tool/evidence/`(types+builder+tool) `collect_evidence` 도구. detect→run suite→top failure→static/runtime enrich→repo 조립. NEVER-throws(소스별 fault-isolated)·abs-path 정규화·ok=failure-null. **실 융합 e2e**(실 cargo 실패+실 rust-analyzer static 한 패킷). default-OFF QUANTA_EVIDENCE+always-confirm. 16 test. **현 프로덕션=failure+repo+static 실값**(static은 `evidenceLspStatic` bridge로 LIVE 배선, 실 rust-analyzer e2e 2개 증명). **Python+Rust runtime도 LIVE**(`defaultRuntimePort` in-slice debugpy, default-wired, abort-threaded; 실 debugpy e2e로 locals `result=10` 포착). Go/TS runtime(dlv/js-debug, DAP TCP 선행)만 follow-up. 22 test. ADR-0533.
- 유저 통일 스키마로 조립:
  ```
  { language, repo_context{changed_files,symbols,diagnostics},
    failure{command,stderr,test_name},
    runtime{crash_frame,stack,locals,threads},
    static{definition_chain,references,type_info},
    patch_constraints{style,public_api_change_allowed} }
  ```
- 오케스트레이션: **감지기(0b)** → **test-runner(2)** 실패 포착 → **DAP(debug_inspect)** 실패지점 runtime(stack/locals/threads) → **LSP(lsp_nav)** 정적(def-chain/refs/types/diagnostics) → 조립.
- 형태: `collect_evidence` 도구 + (선택)스킬. 이게 있어야 LSP+DAP가 "따로 노는 도구"에서 **"한 번 호출로 LLM이 전체 그림"**으로 격상. **진짜 키스톤.**

### Phase 4 — Tier-2/3 (점진)
- **Tier-2**: C++(clangd LSP + lldb-dap ✅ + sanitizer 트레이스 evidence) · Java(jdtls LSP + java-debug DAP/TCP + Gradle/Maven) · C#(Roslyn LSP + netcoredbg DAP).
- **Tier-3**: Kotlin(JDWP) · Swift(lldb-dap ✅ 프리셋) · Zig(lldb-dap ✅ + zls) · PHP(Xdebug) · Ruby(rdbg).
- 각 언어 = §1 비용표대로 어댑터/프리셋/러너 증분.

## 3. 우선순위 (유저 tiering 반영)

1. **Phase 0a(DAP TCP) + 0b(감지기)** — 토대, Go/TS 차단해제.
2. **Rust** — lldb-dap 이미 동작이라 LSP 어댑터+러너만 = **최저비용 신규 언어**. 먼저 치기 좋음.
3. **Go** — TCP 후 gopls+dlv+goroutine.
4. **TS 러너 + js-debug** + **Phase 3 Evidence Builder**(Python/Rust로 먼저 골격 검증 후 일반화).
5. Tier-2/3 증분.

## 4. 불변식 (모든 슬라이스)
- 기존 `src/lsp`(generic base, OCP 레지스트리)·`src/tool/debug`(codec/client/driver) **재사용** — 코어 재구축 금지.
- 각 신규 도구 default-OFF + knob trio + manifest GATED + fc + ADR.
- 외부 어댑터 붙는 코드는 **실물 + 복수 구현체 검증 필수**(jun-10 교훈: fake-green이 데드락·terminate-행 가림; debugpy↔lldb-dap이 서로 다른 버그 노출).
- NEVER-throws + 모든 대기 timeout/abort 가드(adapter마다 DAP 스펙 해석 다름).

## 5. 한 줄 요약
LSP·DAP **클라이언트는 이미 LIVE**. 남은 건 **TCP 트랜스포트 + 언어 어댑터(특히 Rust=최저비용) + 구조화 test-runner + Evidence Packet Builder(키스톤)**. 자체 디버거/LSP는 안 만든다 — 어댑터·오케스트레이션만.
