# ADR-0533: Keystone — Evidence Packet Builder (`collect_evidence`)

- **상태**: Accepted (core 구현·실융합 검증 완료; enrichment bridge는 명시적 follow-up)
- **날짜**: 2026-06-10
- **슬라이스**: `src/tool/evidence/` (NEW: types · builder · tool)
- **출처**: `docs/plans/jun-10-multilang-debug-coverage.md` Phase 3 (키스톤)
- **관련**: ADR-0531(debug_inspect=runtime) · ADR-0532(run_tests=failure) · lsp_nav(static) — 본 ADR이 이 셋을 융합

## Context

멀티언어 디버깅 플랜의 키스톤. 흩어진 신호 소스(run_tests=실패 / DAP=runtime / LSP=static / git=repo)를 LLM이 손으로 오케스트레이션하는 대신, **한 번 호출로 통일 패킷**을 만든다.

## Decision

`src/tool/evidence/`:

1. **`types.ts`** — `EvidencePacket`(유저 스키마 필드 일치): `{language, repo_context{changed_files,diagnostics}, failure{command,test_name,message?,file?,line?}, runtime{stack,locals}|null, static{definition_chain,references,type_info,diagnostics}|null, patch_constraints{public_api_change_allowed,style?}}`. 각 소스 독립 optional.
2. **`builder.ts` — `buildEvidence(cwd, sources, opts)` (pure 오케스트레이터)** — detect → run suite → TOP failure(file+line 있는 첫 번째) 선택 → 그 failure만 static(LSP at site) + runtime(DAP for test)으로 enrich → repo(git). **모든 소스는 `safe()`로 fault-isolated**(없거나 throw해도 해당 섹션만 null, 패킷은 항상 반환) = **NEVER-throws**. green suite ⇒ failure null, enrich 안 함. **failure.file를 절대경로로 정규화 후 포트에 전달**(test runner는 상대경로 보고하나 LSP/DAP는 절대경로 필요 — 안 하면 silent 실패).
3. **`tool.ts` — `collect_evidence`** — same-slice 소스(detect+runToolchain+git changed-files) 실배선 + cross-slice(lspStatic/runtime) 주입 포트. `parseGitPorcelain`(rename `->`/quoted/untracked 처리, pure). **ok = (failure===null)**(run_tests와 일관, 패킷은 항상 output). default-OFF `QUANTA_EVIDENCE` + always-confirm.

## 배선 / 현재 상태 (정직)

- **core LIVE**: detect + run_tests(실패) + git repo_context = 프로덕션 실동작.
- **static LIVE (jun-10 bridge 완료)**: `@/agent/lsp-bridge`에 `evidenceLspStatic()`(= `lspNavProvider` 위 hover/definition/references 수확, 컬럼 스캔+ContentModified 견딤+session.stop finally) 추가, **agent-arg-builder가 `cfg.evidence ? { evidence: { lspStatic: evidenceLspStatic() } }`로 프로덕션 주입** → 패킷 `static` 섹션이 프로덕션 실값. 실 rust-analyzer e2e 2개(직접 포트 + buildEvidence 융합)로 증명.
- **runtime(DAP) = Python+Rust LIVE (jun-10)**: `src/tool/evidence/runtime.ts` `defaultRuntimePort`(in-slice — DAP는 @/tool/debug라 bridge 불요), toolchain.kind 디스패치. **Python(debugpy)**: test command `[python,-m,MOD,..]`→`{module,args}` launch+실패라인 bp. **Rust(lldb-dap)**: `cargo test --no-run --message-format=json`로 테스트 바이너리 경로→lldb-dap launch+**realpath'd 실패라인 bp**(cargo DWARF comp_dir=canonical). 둘 다 stack/locals 포착. default-wired, abort signal threaded(cargo compile 포함), 미지원 kind/무 adapter면 null degrade. 실 e2e 2언어(python locals `result=10`, rust locals `result=10`)+node degrade 테스트.
- inert 아님: **failure+repo+static+Python/Rust runtime 프로덕션 LIVE**. Go/TS runtime(dlv/js-debug, DAP TCP 선행)만 follow-up.
- 전 SSOT: DefaultToolPorts.evidence(object 포트) → agent-arg-builder `cfg.evidence?{evidence:{}}` → runtime-config.evidence=gateOn("QUANTA_EVIDENCE") → knob-inventory → manifest GATED → fc.

## 테스트

- builder hellgate 7 + tool+git 10(porcelain/abs-path/ok-semantics/**unsupported-kind runtime degrade**).
- **실 융합 e2e 5**(부재 시 skip): `keystone-real-e2e`(실 cargo+실 rust-analyzer static) · `evidence-lsp-bridge-real-e2e`×2(프로덕션 `evidenceLspStatic` 포트+융합) · `runtime-real-e2e`(**실 debugpy**, locals `result=10`) · `runtime-rust-real-e2e`(**실 cargo+lldb-dap**, locals `result=10`). 단일 호출 4섹션(failure/static/runtime/repo) 2언어 실융합 증명.

## 어딧 (적대+객관 병렬 → TDD 보완)

- 🔴 git porcelain naive `slice(3)` rename/quoted 깨짐 → `parseGitPorcelain`(pure, `->`/unquote). 🔴 상대경로→LSP/DAP silent 실패 → builder abs 정규화. 🟡 ok:true-always → ok=failure-null(run_tests 일관). 🟡 top `!` → undefined 가드. ✅ slice isolation·never-throws·diagnostics 소스 클린.
- 객관: ADR(본)+fc 누락 적발→작성. 스키마 유저 플랜 §3과 field-for-field 일치 확인. **enrichment 프로덕션 미배선 정직 표기**.

## 다음 (follow-up, (기능)+(왜)+(ROI))

- ✅ ~~LSP/DAP enrichment 프로덕션 bridge~~ — **완료**: static(evidenceLspStatic, agent-arg-builder)+Python runtime(defaultRuntimePort, in-slice) 모두 프로덕션 LIVE.
- ✅ ~~Rust runtime~~ — **완료 (lldb-dap, cargo test --no-run + realpath bp)**.
- **(기능) Go/TS runtime** — dlv-dap(go)/js-debug(ts). **(왜)** runtime tier-1 완성. **(ROI)** 중·L — DAP TCP 트랜스포트 선행 필요.
- **(기능) DAP TCP 트랜스포트** — Go(dlv)/TS(js-debug) DAP 차단해제(현 port는 stdio 전용). **(왜)** tier-1 Go/TS runtime/debug. **(ROI)** 높음·M.
