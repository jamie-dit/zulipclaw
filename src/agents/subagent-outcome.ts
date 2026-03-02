export type SubagentFailureClass =
  | "none"
  | "run_timeout"
  | "model_attempt_timeout"
  | "aborted_by_cancel"
  | "error";

export type SubagentRunOutcome = {
  status: "ok" | "error" | "timeout" | "unknown";
  error?: string;
  iterationLimitReached?: boolean;
  iterationsUsed?: number;
  maxIterations?: number;
  failureClass?: SubagentFailureClass;
};

const TIMEOUT_HINT_RE = /\btimeout\b|timed out|deadline exceeded|context deadline exceeded/i;
const MODEL_TIMEOUT_HINT_RE =
  /all models failed|all model attempts failed|model attempts failed|model attempt|\(timeout\)/i;
const CANCEL_ABORT_HINT_RE =
  /request was aborted|aborterror|aborted by user|operation aborted|cancelled|canceled|interrupted by user/i;

export function classifySubagentFailure(outcome: {
  status: SubagentRunOutcome["status"];
  error?: string;
  failureClass?: SubagentFailureClass;
}): SubagentFailureClass {
  if (outcome.failureClass && outcome.failureClass !== "none") {
    return outcome.failureClass;
  }
  if (outcome.status === "timeout") {
    return "run_timeout";
  }
  if (outcome.status !== "error") {
    return "none";
  }
  const message = String(outcome.error ?? "").trim();
  if (!message) {
    return "error";
  }

  if (CANCEL_ABORT_HINT_RE.test(message)) {
    return "aborted_by_cancel";
  }

  const hasTimeoutHint = TIMEOUT_HINT_RE.test(message);
  if (hasTimeoutHint && MODEL_TIMEOUT_HINT_RE.test(message)) {
    return "model_attempt_timeout";
  }
  if (hasTimeoutHint) {
    return "run_timeout";
  }
  return "error";
}

export function resolveSubagentOutcomeStatusLabel(outcome: SubagentRunOutcome): string {
  const failureClass = classifySubagentFailure(outcome);
  switch (failureClass) {
    case "run_timeout":
      return "timed out (run timeout)";
    case "model_attempt_timeout":
      return "failed: model attempt timed out";
    case "aborted_by_cancel":
      return "failed: cancelled (aborted tool call)";
    case "error":
      return `failed: ${outcome.error || "unknown error"}`;
    default:
      break;
  }

  if (outcome.iterationLimitReached) {
    return "reached the iteration limit";
  }
  if (outcome.status === "ok") {
    return "completed successfully";
  }
  if (outcome.status === "timeout") {
    return "timed out";
  }
  if (outcome.status === "error") {
    return `failed: ${outcome.error || "unknown error"}`;
  }
  return "finished with unknown status";
}

export function resolveFailureMetadataLabel(outcome: SubagentRunOutcome): string | undefined {
  const failureClass = classifySubagentFailure(outcome);
  if (failureClass === "none") {
    return undefined;
  }
  return failureClass;
}
