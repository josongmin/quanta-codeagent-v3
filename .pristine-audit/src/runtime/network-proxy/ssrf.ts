/**
 * SSRF constant for the egress proxy (ADR-0428).
 *
 * The actual structural SSRF classification (private / loopback / link-local /
 * ULA / IPv4-mapped / metadata) is delegated to the CANONICAL single-source
 * classifier `@/shared/net/ssrf#classifyHost` — the ADR-0427 R1 audit
 * de-triplicated SSRF into that one module, and this slice deliberately does
 * NOT re-fork it. We keep only the metadata-endpoint constant here so the
 * decision layer can emit a dedicated "cloud metadata endpoint" deny reason
 * (the highest-value SSRF target) while `classifyHost` covers every other form.
 */

/** The cloud instance-metadata endpoint (AWS/GCP/Azure IMDS). Categorically
 *  blocked; `classifyHost` already flags it as link-local, but the decision
 *  layer special-cases it for a clearer audit reason. */
export const METADATA_IPV4 = "169.254.169.254"
