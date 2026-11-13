/**
 * Shared vocabulary of the scenario validator: the issue shape and the closed set of issue codes.
 *
 * Codes are stable identifiers. Tests and tooling match on `code`, never on `message`.
 */

export type IssueSeverity = 'error' | 'warning';

export type ValidationCode =
  // Identity and uniqueness
  | 'scenario-id-not-kebab-case'
  | 'scenario-id-file-mismatch'
  | 'scenario-id-duplicate'
  | 'node-id-duplicate'
  | 'link-id-duplicate'
  | 'zone-id-duplicate'
  | 'phase-id-duplicate'
  | 'step-id-duplicate'
  | 'packet-id-duplicate'
  | 'action-id-duplicate'
  // Registries
  | 'node-kind-unknown'
  | 'protocol-unknown'
  | 'protocol-not-declared'
  // Topology and references
  | 'link-endpoint-missing'
  | 'link-self'
  | 'link-duplicate-pair'
  | 'node-shared-cell'
  | 'node-zone-unknown'
  | 'step-phase-unknown'
  | 'step-focus-unknown'
  | 'sequence-lane-unknown'
  | 'action-node-unknown'
  // Packet routes, floods and outcomes
  | 'packet-from-unknown'
  | 'packet-to-unknown'
  | 'packet-via-unknown'
  | 'route-unlinked-hop'
  | 'flood-target-unknown'
  | 'flood-target-not-neighbour'
  | 'flood-without-broadcast'
  | 'outcome-node-off-route'
  | 'outcome-lost-after-destination'
  | 'outcome-dropped-at-source'
  // Timing and limits
  | 'packet-at-negative'
  | 'packets-not-sorted-by-at'
  | 'wire-time-decreasing'
  | 'timing-invalid'
  | 'concurrent-packets-exceeded'
  | 'step-title-empty'
  | 'step-title-too-long'
  | 'step-summary-empty'
  | 'step-summary-too-long'
  | 'reference-url-invalid'
  | 'packet-label-too-long'
  // Addresses
  | 'address-ipv4-malformed'
  | 'address-ipv4-outside-documentation'
  | 'address-ipv6-malformed'
  | 'address-ipv6-outside-documentation'
  | 'address-hostname-not-reserved'
  // TCP
  | 'tcp-first-not-syn'
  | 'tcp-second-not-syn-ack'
  | 'tcp-syn-ack-wrong-ack'
  | 'tcp-seq-mismatch'
  | 'tcp-ack-missing'
  | 'tcp-ack-beyond-peer'
  | 'tcp-endpoint-mismatch'
  // IPv4 fragments
  | 'ip-fragment-length-missing'
  | 'ip-fragment-gap'
  | 'ip-fragment-length-not-multiple-of-8'
  | 'ip-fragment-mf-flag'
  | 'ip-fragment-total-mismatch';

export interface ValidationIssue {
  severity: IssueSeverity;
  /** Stable machine-readable identifier, for example `route-unlinked-hop`. */
  code: ValidationCode;
  /** Location inside the scenario, for example `steps[2].packets[0].via`. */
  path: string;
  /** Human-readable explanation with the offending values. */
  message: string;
}

export function errorIssue(code: ValidationCode, path: string, message: string): ValidationIssue {
  return { severity: 'error', code, path, message };
}

export function warningIssue(code: ValidationCode, path: string, message: string): ValidationIssue {
  return { severity: 'warning', code, path, message };
}
