// P9A.4 security guard: authority-bypass / prompt-injection detection.
//
// This module is intentionally client-safe (pure regex, no server imports)
// so both the /api/conversation interpreter and the composer failsafe share
// the exact same patterns. A rejected turn must never mutate authoritative
// financial task state; it only renders a refusal. Ordinary clarification
// ("Actually send him 20.") and legitimate corrections ("Actually make that
// 0.20.") must NOT match these patterns.

export const AUTHORITY_BYPASS_PATTERNS = Object.freeze([
  /\bno approval (needed|required)\b/i,
  /\bwithout approval\b/i,
  /\bwithout asking\b/i,
  /\bskip(ping)? (the )?(approval|settlement|verification)\b/i,
  /\bskip (the )?rules?\b/i,
  /\bbypass.{0,24}(approval|policy|safeguards?|guards?|settlement|verification|checks?|review)\b/i,
  /\bi (have )?approved\b/i,
  /\bapproval (not required|is not needed|is unnecessary)\b/i,
  /\bignore (all )?(previous|prior|above) instructions\b/i,
  /\bignore (the )?(policy|policies|safeguards?|guards?|checks?|rules?|approval)\b/i,
  /\bmark\b.{0,24}\b(completed?|settled|paid|confirmed|done|successful)\b/i,
  /\bpretend\b.{0,40}\b(passed|succeeded|complete|completed|verified|successful|settled|paid)\b/i,
  /\bsay (it|the payment|the transaction)( is| was)? (settled|complete|completed|paid|done|successful)\b/i,
  /\bsay (the )?wallet check passed\b/i,
  /\binvent (a )?transaction hash\b/i,
  /\bwithout (running|verifying|verification|checking) (it|the check|verification)\b/i,
]);

export function containsAuthorityBypassClaim(text: string): boolean {
  return AUTHORITY_BYPASS_PATTERNS.some((pattern) => pattern.test(text));
}

// Fixed refusal copy for security-rejected turns. It must never read as
// success ("I can do that") and must never name a mutated amount.
export const SECURITY_REFUSAL_MESSAGE =
  "I can update the task while it is still editable, but I cannot bypass " +
  "approval or mark it complete before settlement is verified.";
