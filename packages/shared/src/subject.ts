// Subject normalization for threading. Shared so the inbound Email Worker and
// the outbound send path in the API agree on what counts as the "same" thread
// (a reply we send and the reply that comes back must normalize identically).

const REPLY_PREFIX = /^\s*(?:re|fwd?|fw)(?:\[\d+\])?:\s*/i;

export interface NormalizedSubject {
  norm: string;
  /** True when the subject carried a reply/forward prefix (Re:, Fwd:, …). */
  isReply: boolean;
}

export function normalizeSubject(subject: string): NormalizedSubject {
  let s = subject;
  let isReply = false;
  while (REPLY_PREFIX.test(s)) {
    s = s.replace(REPLY_PREFIX, "");
    isReply = true;
  }
  return { norm: s.replace(/\s+/g, " ").trim().toLowerCase(), isReply };
}
