// One current quality record per task. Old execution failures without a review, assessment,
// or quality-agent finding are not quality findings.
export const qualityProjection = `
  WITH facts AS (
    SELECT t.id,t.goal,t.state,t.acceptance_mode,t.updated_at,r.id AS review_id,r.round,r.decision,
      r.assessment, result_counts.*, node.currently_checking, node.quality_passed,
      latest.kind AS last_action, latest.event_state, latest.occurred_at AS last_action_at, r.created_at AS reviewed_at
    FROM tasks t
    LEFT JOIN LATERAL (
      SELECT id, round, decision, assessment, created_at FROM task_acceptance_rounds
      WHERE task_id=t.id AND revision_number=t.revision_number ORDER BY round DESC LIMIT 1
    ) r ON TRUE
    CROSS JOIN LATERAL (
      SELECT count(*)::integer AS item_count,
        count(*) FILTER (WHERE item->>'status'='met')::integer AS met,
        count(*) FILTER (WHERE item->>'status'='missing')::integer AS missing,
        count(*) FILTER (WHERE item->>'status'='uncertain')::integer AS uncertain
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.assessment->'items')='array' THEN r.assessment->'items' ELSE '[]'::jsonb END) item
    ) result_counts
    CROSS JOIN LATERAL (
      SELECT bool_or(n.state IN ('leasing','running')) AS currently_checking,
        bool_and((n.output#>>'{output,passed}')='true') FILTER
          (WHERE n.state='completed' AND n.output->>'status'='succeeded' AND jsonb_typeof(n.output#>'{output,passed}')='boolean') AS quality_passed
      FROM task_plans p JOIN task_nodes n ON n.plan_id=p.id
      WHERE p.task_id=t.id AND p.version=coalesce(t.current_plan_version,(SELECT max(previous.version) FROM task_plans previous WHERE previous.task_id=t.id))
        AND n.capability='quality.define_and_verify'
    ) node
    LEFT JOIN LATERAL (
      SELECT kind,state AS event_state,occurred_at FROM task_activity_events WHERE task_id=t.id AND
        kind IN ('acceptance_started','delivery_assessed','human_rework_requested','human_accepted','task_accepted','direct_answer','supplement_requested')
      ORDER BY id DESC LIMIT 1
    ) latest ON TRUE
    WHERE t.state IN ('awaiting_review','accepted') OR r.id IS NOT NULL OR node.quality_passed IS NOT NULL
      OR (t.state IN ('planned','running','awaiting_user_input') AND
          (node.currently_checking OR latest.kind IN ('acceptance_started','human_rework_requested')))
  ), classified AS (
    SELECT facts.*,
      CASE
        WHEN state='awaiting_review' THEN 'pending_review'
        WHEN state='accepted' THEN 'accepted'
        WHEN state IN ('planned','running','awaiting_user_input') AND
          (currently_checking OR (last_action='acceptance_started' AND (reviewed_at IS NULL OR last_action_at>=reviewed_at))) THEN 'checking'
        WHEN state IN ('planned','running','awaiting_user_input') AND last_action='human_rework_requested' THEN 'rework'
        WHEN state IN ('planned','running','awaiting_user_input') AND decision='supplement' THEN 'supplement'
        ELSE 'assessed' END AS status,
      CASE
        WHEN state <> 'accepted' THEN NULL
        WHEN decision='accept' OR last_action='human_accepted' OR acceptance_mode='human_review' THEN 'human'
        WHEN acceptance_mode='platform_auto' AND (review_id IS NOT NULL OR
          (last_action IN ('direct_answer','task_accepted') AND event_state='accepted')) THEN 'automatic'
        ELSE NULL END AS accepted_by
    FROM facts
  )
  SELECT id,id AS "taskId",goal,state,status,acceptance_mode AS "acceptanceMode",review_id AS "reviewId",round,decision,
    accepted_by AS "acceptedBy", state='awaiting_review' AS "reviewRequired", missing AS "missingCount",uncertain AS "uncertainCount",
    CASE WHEN jsonb_typeof(assessment->'reportedGaps')='array' THEN assessment->'reportedGaps' ELSE '[]'::jsonb END AS "reportedGaps",
    CASE WHEN missing>0 OR quality_passed=FALSE THEN 'failed'
         WHEN uncertain>0 OR assessment->>'review'='true' OR assessment ? 'error' THEN 'uncertain'
         WHEN (item_count>0 AND met=item_count) OR quality_passed=TRUE THEN 'passed'
         WHEN status IN ('checking','pending_review') THEN 'pending' ELSE 'unrecorded' END AS verdict,
    updated_at AS "updatedAt"
  FROM classified`;

export const automaticPass = `q."acceptedBy"='automatic' AND q.verdict='passed'`;
export const qualityTotals = `
  SELECT count(*) FILTER (WHERE status='pending_review') AS "pendingReview",
    count(*) FILTER (WHERE status='checking') AS checking, count(*) FILTER (WHERE status='supplement') AS supplement,
    count(*) FILTER (WHERE status='rework') AS rework, count(*) FILTER (WHERE status='accepted') AS accepted,
    count(*) FILTER (WHERE status='assessed') AS assessed, count(*) FILTER (WHERE verdict='failed') AS failed,
    count(*) FILTER (WHERE ${automaticPass}) AS "automaticPassed"
  FROM (${qualityProjection}) q`;
