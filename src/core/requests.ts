/**
 * Request tracking — each escalation gets an ID so responses
 * can be matched back to the right request.
 */

export interface EscalationRequest {
  id: string;
  timestamp: number;
  question?: string;
  context?: string;
  targetModel: string;
  prompt?: string;
  status: "pending" | "completed" | "cancelled" | "error";
  response?: string;
}

let counter = 0;

export function generateRequestId(): string {
  counter++;
  const ts = Date.now().toString(36);
  return `agi-${ts}-${counter}`;
}
