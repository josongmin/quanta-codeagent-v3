/**
 * Pure resume-key identity. The resume key is the S3-prefix that scopes one
 * instance's cassette + receipt under one campaign: `${campaignId}/${instanceId}`.
 *
 * Each component is sanitized for an S3 key independently (so a stray slash in a
 * campaign/instance id can never inject an extra path segment): unsafe chars
 * collapse to "_", and leading/trailing slashes are stripped. The single join
 * slash between the two sanitized components is the ONLY separator. Pure — no
 * env, no clock, no I/O.
 */

/** Collapse anything outside the S3-safe set to "_", then strip edge slashes. */
const sanitizeComponent = (raw: string): string =>
  raw
    // S3 keys are happiest with [A-Za-z0-9._-]; "/" is a path separator, so a
    // slash INSIDE a component must collapse too (no smuggled path segments).
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    // strip any leading/trailing "_" produced from edge slashes/spaces so the
    // component never starts/ends with a separator-ish char
    .replace(/^_+|_+$/g, "")

export const resumeKey = (p: { campaignId: string; instanceId: string }): string =>
  `${sanitizeComponent(p.campaignId)}/${sanitizeComponent(p.instanceId)}`
