# 공통 계약 — PROPOSED, 구현 전 고정할 인터페이스

## 소유 모듈

- `tools/dev/test-policy.ts` (NEW): test ID, tier, runtime capability, 자원, 외부 입력 정책.
- `tools/dev/verification-selection.ts` (NEW): base/head/diff → 선택된 test ID와 이유. `verify-scope.ts`의 기존 구현을 재사용·보강한다.
- `tools/dev/verification-execution-policy.ts` (NEW): timeout, 병렬도, locale/env, runner 버전.
- `tools/dev/test-shard-receipt.ts` (EXISTING): 실행 결과 cache identity/검증의 단일 소유자.
- `tools/dev/test-shard-plan.ts` (EXISTING): population partition과 안정적 membership.
- `tools/dev/verification-result.ts` (NEW): local/CI 공통 결과 집계. runner에 gate별 성공 해석을 중복 구현하지 않는다.

## 타입 초안

```ts
type VerificationTier = "smoke" | "prepush" | "pr" | "full" | "nightly";
type Outcome = "passed" | "failed" | "cancelled" | "blocked" | "not-selected";

interface TestPolicy {
  id: string;                  // repo-relative file + optional stable case group
  runner: "bun" | "vitest" | "external";
  tiers: VerificationTier[];   // cross-tier overlap is intentional; within-run duplicates rejected
  cost: "small" | "medium" | "large";
  resources: string[];         // declared dependencies, unknown => exclusive
  requiredCapabilities: string[];
  inputScope: "whole-tree" | "declared";
  owner: string;
  alwaysRun: boolean;
}

interface SelectionPlan {
  schema: string;
  tier: VerificationTier;
  baseSha: string;
  headSha: string;
  snapshotDigest: string;
  policyDigest: string;
  populationDigest: string;
  selected: { id: string; reasons: string[] }[];
  notSelected: { id: string; reason: string }[];
  fallback: { scope: "none" | "full"; reasons: string[] };
}

interface ExecutionPolicy {
  version: string;
  runnerIdentity: string;       // Bun revision, OS/arch, declared tools
  timeoutPolicyDigest: string; // includes internal deadline scale
  intraParallel: number;       // exact width; boolean is insufficient
  isolationPolicyDigest: string;
  environmentDigest: string;   // normalized declared verdict inputs; no raw credentials
}
```

타입 이름은 설계 초안이다. 구현 시 기존 타입과 통합하고 같은 판정을 내리는 소유 모듈을 중복 생성하지 않는다.

## 스냅샷과 변경 집합

- CI는 실제로 실행하는 SHA와 diff 기준 base SHA를 기록한다. PR head, GitHub merge ref, merge-group SHA를 같은 값으로 취급하지 않는다.
- local prepush는 hook stdin의 ref update와 실제 push 대상 commit을 기준으로 한다. 여러 ref, branch 생성, 원격 base 부재의 정책을 명시한다.
- 변경 파일의 삭제·rename은 base와 head 양쪽 그래프의 영향을 합친다. staged/working tree/commit snapshot을 혼합하지 않는다.
- dirty smoke는 허용하되 실행 전후 content digest가 같아야 한다. dirty receipt를 clean full receipt로 재사용하지 않는다.
- 판단할 수 없는 변경은 `fallback=full`로 계획한다. 자동 full 실행이 금지된 상황에서는 `blocked/full-required`와 실행 계획을 반환하며 스스로 full을 시작하지 않는다.

## 캐시 identity

- 기본: suite + population/manifest + test membership/content + 관찰 가능한 tree inputs + ExecutionPolicy.
- `declared` 범위는 입력 집합 완전성이 검증된 테스트만 opt-in. 정적 import closure만으로 인증하지 않는다.
- source scanner, glob/git 조회, 동적 import, subprocess, 외부 toolchain, 읽는 문서는 실제 관찰 입력에 포함한다. `.md` 또는 다른 `.test.ts`를 형식만으로 무조건 제외하지 않는다.
- narrower scope와 cross-suite reuse는 별도 기능이다. declared inputs가 있다고 즉시 suite/manifest를 제거하지 않는다.
- exact timeout scale 및 exact 병렬도를 유지한다. `parallel green ⇒ serial green`, `short deadline green ⇒ long deadline green` 가정 금지.
- 모든 worker JUnit은 저장 전에 검증한다. artifact 유무는 표현 선택이며, 이미 동일 조건에서 실행한 성공 XML을 출력 경로만 다르다는 이유로 버리지 않는다.
- `cache=off`: result cache 조회/재사용 0. dependency download/build cache 사용 여부는 별도 필드로 보고한다.

## 최종 결과 계약

- selection universe = selected ∪ notSelected, 교집합 없음. unknown classification으로 누락되는 ID 없음.
- selected = executed ∪ validated-cache-hit, 중복 없음. 누락·skip·cancel·failed는 required PASS 불가.
- `not-selected`는 선언된 정책에 의해만 허용한다. capability 미설치·worker 실패를 not-selected로 위장하지 않는다.
- 필수 artifact는 `head/base/policy/population/shardMembership/executionPolicy`를 결합한다. 다른 SHA나 정책의 XML을 개수만 맞춰 합치지 않는다.
- partial local 결과는 partial로 표시한다. full 결과에는 현재 full population 전체가 포함돼야 한다.
- quarantined 결과는 별도 집계하고 실제 full manifest에서는 계속 드러낸다. skip을 executed-pass에 더하지 않는다.

## 구현 회귀 전략

선택기·캐시·집계기는 작은 synthetic repository와 가짜 runner로 검증한다. source edit, indirect helper, fixture, docs/ADR input, global preload, another test, deletion/rename, invalid XML, cancellation, no-artifact를 각각 주입한다. 이 테스트 때문에 전체 corpus를 반복 실행하지 않는다.
