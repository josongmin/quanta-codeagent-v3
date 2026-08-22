export const PATCH_BUDGET_STRICT_ADMISSION_KIND = "patch_budget_strict"

export interface AdmissionBlock {
  kind: typeof PATCH_BUDGET_STRICT_ADMISSION_KIND
}

export const isPatchBudgetStrictAdmission = (
  block: AdmissionBlock | undefined,
): block is AdmissionBlock => block?.kind === PATCH_BUDGET_STRICT_ADMISSION_KIND
