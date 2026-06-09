# ADR-0532: Epic-2 — multi-language structured test runner (`run_tests`) + toolchain detector

- **상태**: Accepted (구현·실검증 완료)
- **날짜**: 2026-06-10
- **슬라이스**: `src/tool/testrun/` (NEW: types · detect · parse · tool)
- **출처**: `docs/plans/jun-10-multilang-debug-coverage.md` Phase 0b(감지기)+Phase 2(test-runner)
- **관련**: ADR-0531(DAP debugger — runtime evidence) · 다음 ADR(Evidence Packet Builder — 본 러너가 실패-evidence 절반 공급)

## Context

멀티언어 에이전트 디버깅 플랜의 키스톤(Evidence Packet Builder)은 실패 evidence를 필요로 한다(`failure{command,stderr,test_name}` + 실패 테스트의 file:line). 기존엔 bash로 테스트를 돌릴 뿐 **구조화 파싱이 없었다**(SWE-bench batch의 failure-classifier/verdict는 batch 전용). 범용 `run_tests` 도구가 빠져 있었다.

## Decision

`src/tool/testrun/` 신규 슬라이스:

1. **`detect.ts` (pure)** — `detectToolchain(cwd, existsPort)`: 마커파일→{language, test command, parser}. 순서 우선(Cargo.toml/go.mod가 package.json보다 우선 — Rust/Go 프로젝트의 JS sidecar 오판 방지). 주입 exists-port(실 IO 없음, FS-jail로 마커 probe).
   - Cargo.toml→`cargo test`(cargo) · go.mod→`go test -json ./...`(go) · pyproject/setup.py/setup.cfg→`python3 -m unittest discover -v`(python-unittest) · package.json→`npm test`(generic).
2. **`parse.ts` (pure, NEVER-throws)** — 언어별 파서를 **실제 출력에 핀**(추측 금지):
   - `parseGoJson`: `go test -json` NDJSON 이벤트(Action pass/fail + Test, Output서 `file.go:line: msg` 추출).
   - `parseCargo`: libtest 텍스트(`test NAME ... FAILED`, `---- NAME stdout ----` 블록의 `panicked at FILE:LINE:COL` + assertion, 요약서 passed 카운트). **함정: `--nocapture`는 panic을 블록 밖 inline으로 빼므로 default capture 사용**(replay 블록에서 file:line 추출).
   - `parsePythonUnittest`: 텍스트(`FAIL/ERROR: name` 블록의 traceback `File "PATH", line N` + 예외줄; `Ran N`/`OK`/`FAILED`). **함정: unittest는 STDERR로 출력** → 파서는 stdout+stderr 합쳐 봄. 블록 종료=`===`(다음 블록)/`Ran`(헤더 직후 `---`는 블록 내부).
   - 정규화 결과 `{runner, passed, failed:[{name,file?,line?,message?}], ok}`.
3. **`tool.ts` — `run_tests`** — FS-jail 감지 + 주입 spawn port(Bun.spawn, stdout+stderr 캡처) + parser dispatch + 렌더. `command` 입력으로 감지 override 가능(generic 파싱).

## 보안 posture

- **default-OFF** (`QUANTA_TEST_RUNNER` strict opt-in) — 미설정 ⇒ 미등록(byte-identical).
- **always-confirm tier** — 스위트 실행은 프로젝트 테스트 코드(임의 코드)를 **실행**(bash/debug_inspect와 동일 등급).
- **NEVER-throws** — detect/spawn/parse 결함 → ok:false.

## 배선 (전 SSOT)

`DefaultToolPorts.testRunner` 조건부 등록 → agent-arg-builder `cfg.testRunner` gate → `runtime-config.testRunner = gateOn("QUANTA_TEST_RUNNER")` → knob-inventory → manifest GATED(config-slot, risk mutating) → fc `02-tool-system/run-tests.yaml`.

## 테스트 (red-first, 실 toolchain)

- parse 7(go pass+fail/all-pass/malformed · cargo fail+loc/all-pass · python fail+loc/OK) — **fixture=실 출력 verbatim**.
- detect 7(rust/go/python×2/node/precedence/none).
- **실 e2e 3(`run-tests-real-e2e.test.ts`, toolchain 부재 시 auto-skip)**: cargo 1.95 / go 1.25.4 / python3 unittest 각각 실패 스위트 실행→실패 테스트 name+file:line 추출 확인.

## 기존 `test_runner`(BASE)와의 관계

quanta엔 이미 `src/tool/test-runner/`(BASE, 항상 ON)가 있다 — bash로 bun/npm/pytest 자동감지 실행 후 **exitCode+regex 휴리스틱 verdict 문자열**("passed"/"failed") 반환. `run_tests`(본 ADR, GATED)는 **구조화 per-language 파싱**(실패 테스트 name+file:line+message)이라 목적이 다르다 → 의도적 공존(중복 아님). Evidence Builder는 `run_tests`의 구조화 출력을 소비.

## 어딧 (적대+객관 병렬 → TDD 보완)

- 🔴🔴 **false-green 적발/수정**(테스트러너 최악): ① go 컴파일에러(`build-fail`+패키지 fail, Test 없어 skip되던 것) → build-fail/패키지fail 포착 ② **exitCode 보편 안전망**(exitCode≠0+파싱된 failure 0 → ok:false 강제, 합성 failure) ③ python "Ran 0 tests OK" → ran>0 요구.
- 🔴 **wrong-count 수정**: cargo 다중 요약(lib+doctests) passed **합산**(덮어쓰기→누락 방지) · go 중복 fail dedupe.
- 보강: cargo 다중라인 panic 메시지(left/right) · python 블록 종료조건 tighten(`Ran N tests in `) · **OOM cap**(스트림 8MiB).
- 객관: debug_inspect와 배선 패리티 확인(전 SSOT 일치) · 기존 test_runner와 공존 확인 · all-pass fault 테스트 추가.
- false alarm 기각: pre-abort(tool이 이미 ctx.signal 가드) · Windows 경로(darwin 비목표).

## 다음

Evidence Packet Builder가 본 러너(실패) + debug_inspect(runtime) + lsp_nav(static)를 유저 통일 스키마로 조립. Rust/Go pretty-printer·pytest 러너·node 구조화 파서는 후속.
