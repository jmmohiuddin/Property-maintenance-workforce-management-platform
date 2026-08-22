-- =============================================================================
-- KPI-2 — the ATS half of the product event stream.
--
-- 0017 shipped six emitters and declared six families with none. One of those
-- six said the ATS tables did not exist. They did: 0014_recruitment created
-- job_requisitions, requisition_stages, candidates, applications,
-- application_events, talent_pool_members and recruitment_costs, in this same
-- tree, three migrations earlier. The registry entry was written before 0014
-- landed and was never revisited, so the weekly report has been printing
-- "applicant pipeline is not instrumented" over a database that has been
-- recording applicants the whole time.
--
-- That is not a stale comment. PRODUCT_EVENT_NAMES is a gate — an event name
-- absent from it is refused rather than written — and productEventReport prints
-- the uninstrumented list as the named holes in the software. A false entry in
-- that list is the same failure the registry exists to prevent, pointed the
-- other way: it reports a hole that is a table away from being filled, and the
-- longer it says so the more certain it becomes that nobody looks.
--
-- ── WHY THE TRIGGER HANGS OFF applications AND NOT application_events ───────
--
-- application_events is the ATS activity feed (ATS-11) and it already records
-- stage_changed, archived and hired with a timestamp. Hanging the emitter off
-- it would be one line shorter and would inherit exactly the failure mode
-- 0017's entire argument is against: that table is written by application code,
-- so an event exists only where somebody remembered to insert one.
--
-- applications is the row whose transition IS the fact being measured. Three
-- consequences decide it:
--
--   * A hand-repair during an incident (UPDATE applications SET
--     current_stage_id = ...) moves the pipeline and writes no activity-feed
--     row. The funnel would lose the move silently, in the week somebody was
--     repairing things by hand, which is the week the funnel matters.
--   * The unauthenticated careers-site path writes through
--     app_public_submit_application in sql/public-functions.sql, a SECURITY
--     DEFINER function that does not go through the domain layer at all. A
--     trigger on the table catches it; an emitter in TypeScript never sees it.
--   * Every fact these events carry is already on NEW or OLD — requisition,
--     stage pointers, status, disposition reason, applied_at, stage_entered_at.
--     No join is needed to build the payload, which matters for the reason
--     below.
--
-- ── WHY IT WATCHES status AS WELL AS current_stage_id ──────────────────────
--
-- This is the trap, and it is the single most important line in the file.
--
-- hireCandidate (domain/recruitment.ts) sets status = 'hired' and does NOT
-- touch current_stage_id. A trigger keyed on the stage pointer alone would
-- therefore miss every hire — the one transition the whole module exists to
-- produce, and the END of the two timestamps G13 is measured between. It would
-- miss it silently, and the funnel would show applicants walking to the offer
-- stage and evaporating.
--
-- So the guard is the conjunction of both: an UPDATE emits nothing only when
-- neither the stage pointer nor the status moved. Everything else is a
-- transition and gets reported.
--
-- ── ONE EVENT NAME, SUB-CASES IN THE PROPERTIES ────────────────────────────
--
-- ats_stage_changed carries stage moves, hires and archivals alike, with
-- from_status/to_status and from_stage_id/to_stage_id as the discriminators.
-- This is how job_status_changed already works: one family, the sub-case in the
-- payload. Splitting it into a name per outcome multiplies the names a report
-- has to union before it can answer one question, and a query that forgets one
-- of them loses a third of the traffic without saying so.
--
-- ── WHY THE INSERT IS EMITTED TOO ──────────────────────────────────────────
--
-- ats_application_received fires on INSERT, and it is a separate name rather
-- than a sub-case, because an arrival is not a transition: it has no prior
-- state to diff and nothing to put in from_status. 0017 already establishes
-- exactly this pairing twice over -- lead_created beside lead_stage_changed,
-- job_created beside job_status_changed -- so the shape is the house pattern
-- and not a new idea.
--
-- It matters more here than in either of those. The careers-site path writes
-- through app_public_submit_application, a SECURITY DEFINER function that
-- never touches the domain layer, so without this the most common way an
-- applicant enters the business leaves no trace at all in the event stream.
-- And G14's whole subject is applicants who arrive and are owed an outcome:
-- a stream that records every stage change but not the arrival can describe
-- what happened to people it cannot count.
--
-- The two paths are split on TG_OP before anything else, because PL/pgSQL
-- raises "record old is not assigned yet" the moment an INSERT trigger reads
-- an OLD field. The UPDATE guard below therefore never sees an INSERT.
--
-- ── WHY THE STAGE TYPE IS NOT RESOLVED HERE ────────────────────────────────
--
-- Reports would rather group on requisition_stages.stage_type than on a stage
-- id, because the type survives a tenant renaming "Trade check" to "Bench test"
-- and the id does not tell a reader anything. Resolving it would mean a SELECT
-- on requisition_stages from inside this trigger, and that SELECT is not
-- reliable: the generic loop in sql/rls.sql puts FORCE ROW LEVEL SECURITY and a
-- USING (tenant_id = app_current_tenant()) policy on that table, and
-- app_current_tenant() is unset during the seed, during migrations, and inside
-- the public application function. The lookup would return nothing in exactly
-- those cases and the property would be silently null — worse than absent,
-- because a null groups as its own bucket.
--
-- Making it work would mean either relying on the definer role holding
-- BYPASSRLS, which 0017 already refuses to rely on because it is a property of
-- the deployment's role grants rather than of this repository, or setting the
-- tenant GUC from inside a trigger, which is a side effect on the calling
-- session. So the ids are carried and the type is joined at read time, inside a
-- tenant transaction where the policy is satisfied and the join is a primary
-- key lookup.
--
-- ── tenant_id COMES FROM THE ROW ───────────────────────────────────────────
--
-- NEW.tenant_id, exactly like all six emitters in 0017, and never
-- app_current_tenant(). The INSERT policy on product_events is WITH CHECK
-- (true) precisely because the SECURITY DEFINER emitter runs outside tenant
-- context, so the row's own tenant_id is the only thing keeping one tenant's
-- events out of another's report. A trigger that took the tenant from the
-- session would write NULL during the seed and the wrong id during any
-- cross-tenant maintenance, and nothing would raise.
--
-- ── NO PII, THE SAME RULE 0017 STATES ──────────────────────────────────────
--
-- These rows outlive the applications they describe, and ATS-18's retention
-- purge deletes candidates. A name or a phone number in a property bag is a
-- name the purge cannot find. Ids, statuses, codes and durations only. The
-- candidate id is deliberately absent for the same reason: it is a foreign key
-- into a table the purge empties.
-- =============================================================================

CREATE OR REPLACE FUNCTION app_product_event_applications() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		-- The top of the funnel. Deliberately no candidate_id: that is a foreign
		-- key into a table the ATS-18 purge empties, and these rows outlive it.
		PERFORM app_product_event(NEW.tenant_id, 'ats_application_received', 'application', NEW.id,
			jsonb_build_object(
				'requisition_id', NEW.requisition_id,
				'stage_id', NEW.current_stage_id,
				'source', NEW.source,
				'availability', NEW.availability
			));
		RETURN NEW;
	END IF;

	-- Nothing moved. A corrected phone number, a note, a blocked_on flag: none
	-- of them is a transition, and emitting on them would make the funnel count
	-- edits rather than progress.
	IF NEW.current_stage_id IS NOT DISTINCT FROM OLD.current_stage_id
	   AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
		RETURN NEW;
	END IF;

	PERFORM app_product_event(NEW.tenant_id, 'ats_stage_changed', 'application', NEW.id,
		jsonb_build_object(
			'requisition_id', NEW.requisition_id,
			-- Where it was and where it went. Both null-able and both carried
			-- raw: on a hire the stage pointer does not move, so from and to are
			-- equal, and that is the honest record of what happened.
			'from_stage_id', OLD.current_stage_id,
			'to_stage_id', NEW.current_stage_id,
			-- The discriminator. active to hired is the G13 terminus; active to
			-- archived is the G14 drop-out.
			'from_status', OLD.status,
			'to_status', NEW.status,
			-- Null on a stage move; set when the application ended. ATS-16 keeps
			-- these two because the stage pointer has already moved on by the
			-- time anybody asks where the pipeline loses people.
			'disposition_reason_code', NEW.disposition_reason_code,
			'archived_at_stage_id', NEW.archived_at_stage_id,
			-- Time the application sat in the stage it was in when this
			-- transition began, measured from the OLD entry stamp. ATS-8 is
			-- about who is blocking a hire, and in a market where a good
			-- technician holds three offers the answer is usually a stage nobody
			-- looked at for nine days.
			'minutes_in_stage',
			  GREATEST(0, (EXTRACT(epoch FROM (now() - OLD.stage_entered_at)) / 60)::int),
			-- Computed here rather than by joining back to the application
			-- later, for the reason 0017 gives for minutes_since_created: the
			-- application row can be purged under ATS-18 and the target is a
			-- median over a window, not a per-row lookup.
			'days_since_applied',
			  ((now() AT TIME ZONE 'Asia/Dubai')::date
			   - (NEW.applied_at AT TIME ZONE 'Asia/Dubai')::date),
			'blocked_on', NEW.blocked_on
		));

	RETURN NEW;
END
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS product_event_applications ON public.applications;--> statement-breakpoint
CREATE TRIGGER product_event_applications
	AFTER INSERT OR UPDATE ON public.applications
	FOR EACH ROW EXECUTE FUNCTION app_product_event_applications();--> statement-breakpoint

-- ── KPI-3: the index the hiring panel reads ────────────────────────────────
--
-- The dashboard's days-to-hire query walks application_events looking for the
-- hire stamp of every hired application. application_events_application_idx is
-- (tenant_id, application_id, occurred_at) with no event_type, which serves one
-- application's timeline and not "every hire in the last year".
--
-- Partial on the one event type the dashboard asks for. The feed is dominated
-- by stage_changed and applied rows, and a hire is a handful a year.
CREATE INDEX IF NOT EXISTS "application_events_hired_idx"
	ON "application_events" USING btree ("tenant_id", "application_id", "occurred_at")
	WHERE "event_type" = 'hired';
