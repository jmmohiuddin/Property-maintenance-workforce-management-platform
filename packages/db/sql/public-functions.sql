-- =============================================================================
-- The public surface.
--
-- Run AFTER rls.sql.
--
-- A visitor submitting the quote form on the marketing site has no session and
-- therefore no tenant context, but their enquiry has to land in a specific
-- tenant's lead queue. That is the same bootstrap problem authentication has,
-- and it gets the same answer: one narrow SECURITY DEFINER function rather than
-- a loosened policy.
--
-- Every addition here is a hole in the tenant boundary that an unauthenticated
-- visitor can reach, so the bar is much higher than for app_auth_*. There are
-- two functions, and the second earns its place by narrowing that surface
-- rather than widening it: without a rate limiter, the first function's caller
-- can be driven as fast as an attacker can send packets.
-- =============================================================================

-- Resolve a tenant slug to its id, for the public website only.
--
-- Returns nothing but the id: no name, no settings, no domain. A visitor
-- cannot enumerate tenants with this because they must already know the slug,
-- and knowing the slug reveals nothing they did not already have.
CREATE OR REPLACE FUNCTION app_public_resolve_tenant(p_slug text)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id FROM tenants
   WHERE slug = p_slug
     AND is_active
     AND deleted_at IS NULL
   LIMIT 1;
$$;

REVOKE ALL ON FUNCTION app_public_resolve_tenant(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_public_resolve_tenant(text) TO meridian_app;

-- ── Rate limiting ───────────────────────────────────────────────────────────

-- The bucket table is written only through the function below.
--
-- ENABLE, deliberately not FORCE. A table with FORCE and no policy is
-- unwritable by everyone including this function's owner, which would make the
-- limiter fail on every call. ENABLE alone denies the application role - no
-- policy means no rows - while leaving the definer able to do its job.
ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY;

-- The blanket grant in rls.sql names every table in the schema, including this
-- one. RLS already blocks it, but a limiter the limited party can reset is not
-- worth having, so the grant is withdrawn as well.
REVOKE ALL ON public.rate_limits FROM meridian_app;

-- Count one hit against a bucket and say whether it is still allowed.
--
-- The whole operation is a single INSERT ... ON CONFLICT so that concurrent
-- requests cannot interleave a read and a write and both conclude they were
-- under the limit. A read-then-update version of this is a race that lets N
-- simultaneous requests all pass a limit of 1.
--
-- A fixed window, not a sliding one: it is a few lines instead of a table of
-- timestamps per caller, and the worst case - twice the limit across a window
-- boundary - is irrelevant for a contact form. It would matter for a login,
-- which is why login throttling lives in app_auth_* against a real counter on
-- the user row instead.
CREATE OR REPLACE FUNCTION app_public_rate_limit(
  p_bucket text,
  p_limit integer,
  p_window_seconds integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_hits integer;
  v_expired boolean;
BEGIN
  IF p_bucket IS NULL OR p_bucket = '' OR p_limit < 1 OR p_window_seconds < 1 THEN
    -- Refuse to silently allow everything on a malformed call.
    RAISE EXCEPTION 'app_public_rate_limit: invalid arguments';
  END IF;

  INSERT INTO rate_limits AS r (bucket, window_start, hits)
  VALUES (p_bucket, now(), 1)
  ON CONFLICT (bucket) DO UPDATE
     SET hits = CASE
                  WHEN r.window_start < now() - make_interval(secs => p_window_seconds) THEN 1
                  ELSE r.hits + 1
                END,
         window_start = CASE
                  WHEN r.window_start < now() - make_interval(secs => p_window_seconds) THEN now()
                  ELSE r.window_start
                END
  RETURNING r.hits, r.window_start < now() - make_interval(secs => p_window_seconds)
       INTO v_hits, v_expired;

  RETURN v_hits <= p_limit;
END;
$$;

REVOKE ALL ON FUNCTION app_public_rate_limit(text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_public_rate_limit(text, integer, integer) TO meridian_app;

-- Housekeeping. Buckets are tiny but unbounded in number, and nothing else
-- deletes them; an untended limiter table grows for the life of the site.
CREATE OR REPLACE FUNCTION app_public_rate_limit_sweep(p_older_than_seconds integer DEFAULT 86400)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_removed integer;
BEGIN
  DELETE FROM rate_limits
   WHERE window_start < now() - make_interval(secs => p_older_than_seconds);
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  RETURN v_removed;
END;
$$;

REVOKE ALL ON FUNCTION app_public_rate_limit_sweep(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_public_rate_limit_sweep(integer) TO meridian_app;

-- =============================================================================
-- M9 — the recruitment public surface (`ATS-2`, `ATS-3`, `ATS-16`).
--
-- Appended here rather than put in a new file for a reason that is not
-- stylistic: `.github/workflows/ci.yml` applies a hardcoded, ordered list of
-- sql/ files, and rls.sql ends with a blanket `GRANT ... ON ALL TABLES` that
-- undoes any REVOKE applied before it. A new file would be applied by nobody in
-- CI and by whoever remembered in production. This file is already in the list,
-- already in the right position, and is already the home of "things an
-- unauthenticated visitor may reach".
--
-- ── WHY THE WHOLE WRITE HAPPENS IN HERE ─────────────────────────────────────
--
-- The quote form resolves a tenant through `app_public_resolve_tenant` and then
-- does its insert through `withTenant()`. That works, and it means an
-- unauthenticated HTTP request runs the rest of its transaction with
-- `app.tenant_id` set — i.e. with the tenant's full row-level-security scope
-- attached to it. For a lead that is a contained risk; for an applicant record
-- carrying certificate numbers and a phone number it is not the trade to make.
--
-- So `app_public_submit_application` does the entire unit of work — resolve the
-- role, match or create the candidate, write the application, write the
-- certificates, write the consent row, write the activity event — and the
-- application never sets a tenant GUC on an unauthenticated request at all. The
-- surface an anonymous caller can reach is these five functions and their
-- arguments, not "every table in the tenant".
--
-- The rate limiter above still gates it. Without one, the caller can be driven
-- as fast as an attacker can send packets, and each call writes rows.
-- =============================================================================

-- ── The outcome clock (ATS-16) ──────────────────────────────────────────────
--
-- The applicant is told "we will contact you within three working days,
-- whatever the outcome". This computes the timestamp behind that sentence, so
-- the promise on the confirmation screen and the number the accountability
-- report measures against are the same number rather than two numbers that
-- drift.
--
-- Working days, using the tenant's own calendar: the UAE weekend is
-- configurable (`OPEN-8`) and public holidays are data, not arithmetic, because
-- Islamic-calendar dates are confirmed by moon sighting a day or two ahead.
-- Promising three days over Eid and counting them as three would produce a
-- report full of breaches nobody caused.
CREATE OR REPLACE FUNCTION app_recruitment_outcome_due(
  p_tenant uuid,
  p_from timestamptz,
  p_working_days integer DEFAULT 3
)
RETURNS timestamptz
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_weekend smallint[];
  v_day     date := (p_from AT TIME ZONE 'Asia/Dubai')::date;
  v_left    integer := greatest(p_working_days, 0);
  v_guard   integer := 0;
BEGIN
  SELECT weekend_days INTO v_weekend FROM calendar_settings WHERE tenant_id = p_tenant;
  -- The documented default: Saturday and Sunday. A tenant that has never opened
  -- the calendar screen still gets a correct clock.
  v_weekend := coalesce(v_weekend, ARRAY[6, 0]::smallint[]);

  WHILE v_left > 0 AND v_guard < 60 LOOP
    v_day := v_day + 1;
    v_guard := v_guard + 1;

    IF NOT (extract(dow FROM v_day)::smallint = ANY (v_weekend))
       AND NOT EXISTS (
         SELECT 1 FROM public_holidays
          WHERE tenant_id = p_tenant AND holiday_date = v_day
       )
    THEN
      v_left := v_left - 1;
    END IF;
  END LOOP;

  -- End of the working day in Dubai, not the same clock time three days later.
  -- "Within three working days" does not mean 09:14 on Thursday.
  RETURN (v_day + time '18:00') AT TIME ZONE 'Asia/Dubai';
END;
$$;

REVOKE ALL ON FUNCTION app_recruitment_outcome_due(uuid, timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_recruitment_outcome_due(uuid, timestamptz, integer) TO meridian_app;

-- ── ATS-2: the open roles, as the careers site sees them ────────────────────
--
-- Returns published fields only. Not the hiring manager, not the approval
-- trail, not the headcount already filled, not the internal reference — a
-- careers page that leaks the requisition's internal state is a careers page
-- that tells a competitor how the pipeline is going.
--
-- Only `open`, only inside the posting window, only not-deleted. A closed role
-- that stays indexed produces applications nobody is reading, which is the
-- silent-rejection failure arriving before anyone has even applied.
CREATE OR REPLACE FUNCTION app_public_open_roles(p_tenant uuid)
RETURNS TABLE (
  public_slug text,
  title text,
  trade text,
  grade text,
  contract_type text,
  headcount integer,
  location_city text,
  location_area text,
  min_experience_years integer,
  summary text,
  responsibilities text,
  physical_requirements text,
  required_certifications jsonb,
  salary_band_min_minor bigint,
  salary_band_max_minor bigint,
  currency text,
  opens_at timestamptz,
  closes_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT r.public_slug::text, r.title::text, r.trade::text, r.grade::text,
         r.contract_type::text, r.headcount, r.location_city::text, r.location_area::text,
         r.min_experience_years, r.summary, r.responsibilities, r.physical_requirements,
         r.required_certifications, r.salary_band_min_minor, r.salary_band_max_minor,
         r.currency::text, r.opens_at, r.closes_at
    FROM job_requisitions r
    JOIN tenants t ON t.id = r.tenant_id AND t.is_active AND t.deleted_at IS NULL
   WHERE r.tenant_id = p_tenant
     AND r.status = 'open'
     AND r.deleted_at IS NULL
     AND (r.opens_at IS NULL OR r.opens_at <= now())
     AND (r.closes_at IS NULL OR r.closes_at > now())
   ORDER BY r.opens_at DESC NULLS LAST, r.title;
$$;

REVOKE ALL ON FUNCTION app_public_open_roles(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_public_open_roles(uuid) TO meridian_app;

-- ── ATS-3: the application itself ───────────────────────────────────────────
--
-- One call, one transaction, one unit of work.
--
-- ── DUPLICATE HANDLING (ATS-11), AND WHY IT IS CONSERVATIVE HERE ────────────
--
-- The strict matcher — phone AND email both exact — may auto-link, so it does.
-- The loose matcher only *suggests*, and a suggestion is a human decision, so
-- this function does not act on it except in one case: when the loosely matched
-- candidate already has a LIVE application for this same role. That is not a
-- duplicate person, it is the same person tapping Submit twice or applying
-- again a day later, and creating a second application for it would put two
-- cards for one human on the pipeline board and start two outcome clocks.
--
-- Everything else that looks like a duplicate is written as a new candidate and
-- surfaced to a recruiter by `duplicateSuggestions()`. Nothing is merged
-- automatically and nothing is ever deleted by a merge.
--
-- ── WHAT THIS FUNCTION CANNOT BE ASKED TO DO ────────────────────────────────
--
-- There is no argument for visa status (`ATS-5` — Trade Check stage only, never
-- the public form), no argument for date of birth, nationality, gender, health
-- or a photograph (`ATS-6`), and no argument for a score or a stage other than
-- the first (`ATS-19`). The form cannot ask for them because the function it
-- posts to has nowhere to put them.
-- Dropped first, and it has to be. `CREATE OR REPLACE` cannot change the row
-- type defined by a function's OUT parameters — Postgres refuses with "cannot
-- change return type of existing function" — so a file that is re-applied on
-- every deploy (which is what the README's ordered list means) must be able to
-- get past an older signature. Nothing depends on this function through a view,
-- so the drop is safe; the GRANT below is re-issued immediately after.
DROP FUNCTION IF EXISTS app_public_submit_application(
  uuid, text, text, text, text, text, text, text, text, text, boolean, text, jsonb, boolean, text
);

CREATE OR REPLACE FUNCTION app_public_submit_application(
  p_tenant uuid,
  p_role_slug text,
  p_full_name text,
  p_phone text,
  p_email text,
  p_trade text,
  p_grade text,
  p_experience_band text,
  p_current_location text,
  p_availability text,
  p_has_driving_licence boolean,
  p_essential_functions text,
  p_certificates jsonb DEFAULT '[]'::jsonb,
  p_talent_pool_consent boolean DEFAULT false,
  p_source text DEFAULT 'careers_site'
)
-- ── WHY EVERY OUT PARAMETER IS PREFIXED ──────────────────────────────────────
--
-- `out_`, on all six, because plpgsql resolves a bare name against BOTH the
-- table columns and the function's own parameters and refuses when both match.
-- Named `candidate_id`, `reference` and `status_token` — the obvious names —
-- this function threw `column reference "candidate_id" is ambiguous` from
-- `ON CONFLICT (candidate_id, pool_key)`, and a conflict target is one of the
-- few places a column name CANNOT be qualified, so there was no local fix.
--
-- Found by submitting the real form in a browser with the talent-pool box
-- ticked: the only path that reaches that statement, and the one path the first
-- version of the test suite did not cover. Prefixing removes the whole class
-- rather than this one instance of it.
RETURNS TABLE (
  out_application_id uuid,
  out_candidate_id uuid,
  out_reference text,
  out_status_token text,
  out_outcome_due_at timestamptz,
  out_was_existing boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_req        job_requisitions%ROWTYPE;
  v_first_stage uuid;
  v_local      text := right(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g'), 9);
  v_email      text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_candidate  uuid;
  -- Separate from v_candidate, and it has to be: `SELECT ... INTO` writes NULL
  -- when it finds no rows, so reusing v_candidate for the re-submission lookup
  -- would discard a strict match made a moment earlier and create a duplicate
  -- person on every second application.
  v_matched    uuid;
  v_existing   uuid;
  v_app        uuid;
  v_reference  text;
  v_token      text;
  v_due        timestamptz;
  v_year       int := extract(year FROM now() AT TIME ZONE 'Asia/Dubai')::int;
  v_next       int;
  v_cert       jsonb;
  v_expiry     date;
BEGIN
  IF p_tenant IS NULL OR coalesce(btrim(p_full_name), '') = '' OR length(v_local) < 7 THEN
    RAISE EXCEPTION 'app_public_submit_application: name and a contactable phone number are required';
  END IF;

  -- The role must be genuinely open. Checked here and not only in the action,
  -- because this function is the boundary and the action is a convenience in
  -- front of it.
  SELECT * INTO v_req
    FROM job_requisitions
   WHERE tenant_id = p_tenant
     AND public_slug = p_role_slug
     AND status = 'open'
     AND deleted_at IS NULL
     AND (opens_at IS NULL OR opens_at <= now())
     AND (closes_at IS NULL OR closes_at > now());

  IF NOT FOUND THEN
    RAISE EXCEPTION 'app_public_submit_application: no open role with slug %', p_role_slug
      USING ERRCODE = 'no_data_found';
  END IF;

  SELECT id INTO v_first_stage
    FROM requisition_stages
   WHERE requisition_id = v_req.id AND deleted_at IS NULL
   ORDER BY sequence
   LIMIT 1;

  -- ── Candidate: strict match, then the same-role live-application case ─────
  IF v_email IS NOT NULL THEN
    SELECT id INTO v_candidate
      FROM candidates
     WHERE tenant_id = p_tenant
       AND deleted_at IS NULL
       AND merged_into_candidate_id IS NULL
       AND phone_local_digits = v_local
       AND lower(email) = v_email
     ORDER BY created_at
     LIMIT 1;
  END IF;

  -- ── The re-submission check, run whether or not the strict matcher hit ───
  --
  -- Two different people arrive here and both need the same answer: somebody
  -- who tapped Submit twice on a slow connection, and somebody applying again a
  -- day later for a role they are already live on. Creating a second
  -- application for either puts two cards for one human on the pipeline board
  -- and starts two outcome clocks.
  --
  -- Deliberately NOT nested inside "the strict matcher missed". An earlier
  -- version was, and the effect was that a repeat applicant whose phone AND
  -- email both matched — the *easiest* case to recognise — fell straight
  -- through to the INSERT and hit the `applications_live_key` unique index.
  -- The test that submits the same application twice is what caught it.
  --
  -- The loose matcher is used here and only here, and it is not a merge: it is
  -- scoped to one requisition and to live applications, so the worst case is
  -- two people sharing a phone being told they have already applied for that
  -- one role — visible and correctable — rather than silently merged.
  SELECT a.candidate_id, a.id INTO v_matched, v_existing
    FROM applications a
    JOIN candidates c ON c.id = a.candidate_id
   WHERE a.tenant_id = p_tenant
     AND a.requisition_id = v_req.id
     AND a.status = 'active'
     AND a.deleted_at IS NULL
     AND c.deleted_at IS NULL
     AND (
           c.id = v_candidate
           OR c.phone_local_digits = v_local
           OR (v_email IS NOT NULL AND lower(c.email) = v_email)
         )
   ORDER BY a.applied_at
   LIMIT 1;

  IF v_existing IS NOT NULL THEN
    -- Idempotent. The applicant sees the reference they already have rather
    -- than a second one, and no second outcome clock is started.
    UPDATE candidates
       SET last_interaction_at = now(), updated_at = now()
     WHERE id = v_matched;

    RETURN QUERY
      SELECT a.id, a.candidate_id, a.reference::text, a.status_token::text,
             a.outcome_due_at, true
        FROM applications a WHERE a.id = v_existing;
    RETURN;
  END IF;

  IF v_candidate IS NULL THEN
    INSERT INTO candidates (
      tenant_id, full_name, phone, email, primary_trade, grade, experience_band,
      current_location, has_driving_licence, over_eighteen,
      last_interaction_at, retention_basis, delete_after
    ) VALUES (
      p_tenant, btrim(p_full_name), btrim(p_phone), v_email, p_trade, p_grade,
      p_experience_band, p_current_location, coalesce(p_has_driving_licence, false), true,
      now(),
      -- ATS-18. Consent is a different lawful basis with a different clock, so
      -- it is recorded as a different basis rather than as a longer date on the
      -- same one.
      CASE WHEN p_talent_pool_consent THEN 'consent' ELSE 'pre_contractual' END,
      ((now() AT TIME ZONE 'Asia/Dubai')::date
        + CASE WHEN p_talent_pool_consent THEN interval '12 months' ELSE interval '6 months' END)::date
    )
    RETURNING id INTO v_candidate;
  ELSE
    -- ATS-11: candidate-level data collapses to one value with the OLDER
    -- profile winning. So the name is not overwritten; only facts the applicant
    -- has just restated about their current situation are refreshed, and only
    -- where they were previously unknown.
    UPDATE candidates
       SET email = coalesce(email, v_email),
           grade = p_grade,
           experience_band = p_experience_band,
           current_location = p_current_location,
           has_driving_licence = has_driving_licence OR coalesce(p_has_driving_licence, false),
           last_interaction_at = now(),
           retention_basis = CASE WHEN p_talent_pool_consent THEN 'consent' ELSE retention_basis END,
           delete_after = greatest(
             delete_after,
             ((now() AT TIME ZONE 'Asia/Dubai')::date
               + CASE WHEN p_talent_pool_consent THEN interval '12 months' ELSE interval '6 months' END)::date
           ),
           updated_at = now()
     WHERE id = v_candidate;
  END IF;

  -- ── The reference ────────────────────────────────────────────────────────
  --
  -- Allocated here rather than through `app_next_reference`, and the reason is
  -- the whole point of this function: that one reads the tenant from
  -- `app.tenant_id` on the connection, and an unauthenticated caller has none.
  -- Setting the GUC from in here to satisfy it would hand the anonymous request
  -- an ambient tenant scope for the remainder of its transaction — exactly the
  -- property this design exists to avoid.
  -- Seeded above anything already stored, exactly as app_next_reference does
  -- for JOB/QUO/INV/CON. Without this, the first allocation on a seeded or
  -- migrated database hands out a number that is already on an application and
  -- the unique index rejects the whole submission — which is an applicant lost
  -- to a counter.
  -- Every column qualified with `a.`. This function's OUT parameters include
  -- `reference` and `candidate_id`, so an unqualified column name here is
  -- ambiguous between the row and the output variable, and plpgsql refuses it
  -- rather than guessing.
  INSERT INTO reference_counters (tenant_id, prefix, year, last_value)
  SELECT p_tenant, 'APP', v_year,
         coalesce(max((regexp_match(a.reference, '(\d+)$'))[1]::int), 0) + 1
    FROM applications a
   WHERE a.tenant_id = p_tenant
     AND a.reference LIKE 'APP-' || v_year || '-%'
  ON CONFLICT (tenant_id, prefix, year)
  DO UPDATE SET last_value = reference_counters.last_value + 1, updated_at = now()
  RETURNING reference_counters.last_value INTO v_next;

  v_reference := 'APP-' || v_year || '-' || lpad(v_next::text, 5, '0');
  -- 64 hex characters, from two v4 UUIDs.
  --
  -- The tracking link is the only credential an applicant ever gets, so it is
  -- generated here — where nothing the applicant typed can influence it —
  -- rather than in the application layer.
  --
  -- `gen_random_uuid()` and not `gen_random_bytes()`: the latter needs the
  -- pgcrypto extension, which this deployment does not install and which is not
  -- worth adding for one value. Two v4 UUIDs carry 244 bits of randomness from
  -- the same strong RNG, which is an unguessable token by any margin that
  -- matters. The concatenation is unguessable and the column is unique-indexed,
  -- so a collision is a failed insert rather than one applicant reading
  -- another's page.
  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  v_due := app_recruitment_outcome_due(p_tenant, now(), 3);

  INSERT INTO applications (
    tenant_id, reference, candidate_id, requisition_id, current_stage_id,
    stage_entered_at, status, availability, essential_functions, source,
    applied_at, outcome_due_at, status_token
  ) VALUES (
    p_tenant, v_reference, v_candidate, v_req.id, v_first_stage,
    now(), 'active', p_availability, p_essential_functions, coalesce(p_source, 'careers_site'),
    now(), v_due, v_token
  )
  RETURNING id INTO v_app;

  -- ── ATS-4: certificates, expiry required ─────────────────────────────────
  FOR v_cert IN SELECT * FROM jsonb_array_elements(coalesce(p_certificates, '[]'::jsonb))
  LOOP
    -- `YYYY-MM` from the form, stored as the last day of that month: a card
    -- that says 03/2028 is valid through March, and storing the first would
    -- expire it a month early on every dispatch check.
    v_expiry := (to_date(v_cert->>'expiresOn', 'YYYY-MM') + interval '1 month - 1 day')::date;

    INSERT INTO candidate_certifications (
      tenant_id, candidate_id, scheme, certificate_no, level, issuing_body, expires_on
    ) VALUES (
      p_tenant, v_candidate,
      left(btrim(v_cert->>'scheme'), 120),
      nullif(left(btrim(coalesce(v_cert->>'certificateNo', '')), 80), ''),
      nullif(left(btrim(coalesce(v_cert->>'level', '')), 40), ''),
      nullif(left(btrim(coalesce(v_cert->>'issuingBody', '')), 160), ''),
      v_expiry
    );
  END LOOP;

  -- ── ATS-13: consent, its own record, its own clock ───────────────────────
  IF p_talent_pool_consent THEN
    INSERT INTO talent_pool_members (
      tenant_id, candidate_id, pool_key, consent_captured_at, consent_source,
      reconfirm_due_at, added_reason
    ) VALUES (
      p_tenant, v_candidate, p_trade, now(), 'application_form',
      -- Ninety days. A tradesperson's availability and certification validity go
      -- stale in weeks, so a pool re-confirmed annually is a list of people who
      -- have all found other work.
      now() + interval '90 days', 'applied'
    )
    ON CONFLICT (candidate_id, pool_key) DO UPDATE
      SET consent_captured_at = now(),
          consent_withdrawn_at = NULL,
          reconfirm_due_at = now() + interval '90 days',
          updated_at = now();
  END IF;

  INSERT INTO application_events (
    tenant_id, application_id, event_type, to_stage_id, note, actor_kind, payload
  ) VALUES (
    p_tenant, v_app, 'applied', v_first_stage,
    'Applied on the careers site', 'candidate',
    jsonb_build_object('role', v_req.public_slug, 'source', coalesce(p_source, 'careers_site'))
  );

  RETURN QUERY SELECT v_app, v_candidate, v_reference, v_token, v_due, false;
END;
$$;

REVOKE ALL ON FUNCTION app_public_submit_application(
  uuid, text, text, text, text, text, text, text, text, text, boolean, text, jsonb, boolean, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_public_submit_application(
  uuid, text, text, text, text, text, text, text, text, text, boolean, text, jsonb, boolean, text
) TO meridian_app;

-- ── ATS-16: the applicant's own view of their application ───────────────────
--
-- The single most requested thing in this entire module, from the only person
-- whose opinion of it is never collected. Around 65% of applicants never or
-- rarely hear back; this is the screen that makes "where has it got to" a
-- question with an answer at any hour, without an account, without a password,
-- and without a support call.
--
-- Keyed on a 64-character random token and nothing else. It returns one
-- application, and it returns the pipeline as the applicant should see it:
-- stage names and whether each has been reached. Not the disposition reason
-- code, not recruiter notes, not other candidates.
CREATE OR REPLACE FUNCTION app_public_application_status(p_token text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'reference', a.reference,
    'roleTitle', r.title,
    'roleSlug', r.public_slug,
    'candidateFirstName', split_part(c.full_name, ' ', 1),
    'appliedAt', a.applied_at,
    'status', a.status,
    'outcomeDueAt', a.outcome_due_at,
    'outcomeSentAt', a.outcome_sent_at,
    -- The message itself, once it has actually been sent. Never before: the
    -- cancellable window (ATS-15) exists because decisions change, and a
    -- rejection readable on a tracking page an hour before it is withdrawn is
    -- the same harm as having sent it.
    'outcomeMessage', CASE WHEN a.outcome_sent_at IS NOT NULL THEN a.outcome_message END,
    -- ATS-8, mirrored to the candidate so they see the same truth the recruiter
    -- does: if we are waiting on them, say so and say what for.
    'blockedOn', a.blocked_on,
    'blockedNote', a.blocked_note,
    'currentStageSequence', s.sequence,
    'stages', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
               'name', st.name, 'sequence', st.sequence,
               'reached', st.sequence <= coalesce(s.sequence, 0)
             ) ORDER BY st.sequence), '[]'::jsonb)
        FROM requisition_stages st
       WHERE st.requisition_id = r.id AND st.deleted_at IS NULL
    )
  )
    FROM applications a
    JOIN candidates c ON c.id = a.candidate_id
    JOIN job_requisitions r ON r.id = a.requisition_id
    LEFT JOIN requisition_stages s ON s.id = coalesce(a.archived_at_stage_id, a.current_stage_id)
   WHERE a.status_token = p_token
     AND a.deleted_at IS NULL
   LIMIT 1;
$$;

REVOKE ALL ON FUNCTION app_public_application_status(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_public_application_status(text) TO meridian_app;
