/**
 * spec-to-test slice barrel (ADR-0253).
 *
 * Self-contained. Re-exports only:
 *   - types  (Spec / Scenario / TestFixture / GenError / Result)
 *   - port   (SpecToTestGen / GenerateOptions)
 *   - impl   (defaultSpecToTestGen / generateSpecTest)
 *
 * Default-OFF: nothing here runs unless a host calls the generator.
 * NO imports from @/agent, @/tool, @/permission, @/runtime — pure leaf slice.
 */

export { defaultSpecToTestGen, generateSpecTest } from "./default-generator"
export type {
  GenerateOptions,
  SpecToTestGen,
} from "./port"
export type {
  GenError,
  Result,
  Scenario,
  Spec,
  TestFixture,
} from "./types"
