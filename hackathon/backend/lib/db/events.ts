/**
 * lib/db/events.ts
 *
 * Tiny helper to append step_started / step_completed / step_failed events
 * into fingerprints.step_events (JSONB array in Neon) so the status endpoint
 * can serve live progress from DB rather than fighting the workflow stream.
 *
 * Safe to call fire-and-forget from inside "use step" functions — errors are
 * swallowed so a DB write failure never aborts the workflow.
 */

import { getRawSql } from "./index";

export type StepEventType = "step_started" | "step_completed" | "step_failed";

export interface StepEvent {
  type: StepEventType;
  step_name: string;
  timestamp: string;
  error?: string;
}

/**
 * Append a step event to fingerprints.step_events for the given job_id.
 * Neon jsonb concatenation: step_events || jsonb_build_array($event::jsonb)
 */
export async function pushStepEvent(
  jobId: string,
  event: StepEvent
): Promise<void> {
  try {
    const sql = getRawSql();
    const eventJson = JSON.stringify(event);
    await sql`
      UPDATE fingerprints
      SET step_events = COALESCE(step_events, '[]'::jsonb) || ${eventJson}::jsonb
      WHERE job_id = ${jobId}
    `;
  } catch (err) {
    // Never crash the workflow over a DB event write
    console.warn("[pushStepEvent] failed:", err);
  }
}
