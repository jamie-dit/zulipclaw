import type { ReplyPayload } from "../types.js";

/**
 * LINE directives are not supported in Zulip-only builds.
 */
export function parseLineDirectives(payload: ReplyPayload): ReplyPayload {
  return payload;
}

export function hasLineDirectives(_text: string): boolean {
  return false;
}
