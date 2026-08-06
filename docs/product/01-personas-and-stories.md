# Personas and user stories

Six personas. Each has a job to be done, a current failure mode, and the stories that address it.

---

## 1. Rania — Operations Manager (the primary user)

Runs the dispatch desk. 180 technicians, 40 to 90 jobs a day, a phone that does not stop.

**Today:** a whiteboard, a WhatsApp group per trade, and knowledge that lives only in her head. She
is the single point of failure — when she is on leave, response times visibly slip.

**Success:** she can go on leave.

| # | Story | Priority |
| --- | --- | --- |
| OPS-1 | See every open job on one board, grouped by priority and SLA risk, so I can triage without asking anyone | P1 |
| OPS-2 | See which technicians are available, where they are, and what they are qualified for, before assigning | P1 |
| OPS-3 | Be warned before a job breaches its SLA, not after | P1 |
| OPS-4 | Assign a job and have the technician notified with address, access notes and fault description | P1 |
| OPS-5 | See why the system suggested a technician, so I can overrule it with a reason | P2 |
| OPS-6 | Reassign a job when a technician is delayed, and have the customer told automatically | P2 |
| OPS-7 | See yesterday's completed jobs with photos and sign-offs, without opening each one | P3 |

**Design consequence:** `jobs_board_idx` and `jobs_sla_idx` exist for OPS-1 and OPS-3.
`job_visits.assignment_reason` exists for OPS-5 — an unexplainable suggestion is one she will ignore.

---

## 2. Bilal — HVAC Technician

Ten years in the trade, six AC services a day, works in plant rooms with no signal.

**Today:** paper job cards, photos on his personal phone, and a supervisor call to find out where he
is going next.

**Success:** he never has to re-enter the same information twice.

| # | Story | Priority |
| --- | --- | --- |
| TECH-1 | See today's jobs with addresses and access instructions, offline | P1 |
| TECH-2 | Navigate to the next job in one tap | P1 |
| TECH-3 | Record what I found and what I did, offline, and have it sync when I get signal | P1 |
| TECH-4 | Take before and after photos attached to the job, not to my camera roll | P1 |
| TECH-5 | Capture the customer's signature on the device | P1 |
| TECH-6 | Record parts used so nobody asks me at the end of the month | P2 |
| TECH-7 | Flag that a job needs a return visit, with the reason | P2 |
| TECH-8 | Clock in and out at the site, without arguing about it later | P2 |

**Design consequence:** every TECH story is offline-first, which is why
[ADR 0004](../adr/0004-offline-first-mobile.md) treats it as a correctness requirement. TECH-8 is why
`attendance_events` stores raw events with geofence flags rather than computed hours.

---

## 3. Fatima — Property Manager (the customer)

Manages 12 buildings for a developer. Reports to an owners association that asks hard questions.

**Today:** emails a WhatsApp number and hopes. Has no idea what was done last month until she asks.

**Success:** she can answer the owners association without phoning the contractor.

| # | Story | Priority |
| --- | --- | --- |
| CUST-1 | Raise a maintenance request against a specific building and unit, with photos | P1 |
| CUST-2 | See the status of every open request without emailing anyone | P1 |
| CUST-3 | See who is coming and when, and track them on the day | P2 |
| CUST-4 | Approve or reject a quotation online, with a record of who approved it | P1 |
| CUST-5 | Download a monthly report of all work across my buildings | P1 |
| CUST-6 | See my contract's coverage and what is explicitly excluded | P2 |
| CUST-7 | See invoices and pay online | P2 |

**Design consequence:** CUST-5 is why job data is structured rather than free text — the report is
generated from records, not written up afterwards. CUST-6 is why `contracts.exclusions` is a column
shown verbatim in the portal rather than a PDF clause nobody reads.

---

## 4. Sameer — Homeowner (the emergency caller)

Water coming through the ceiling. 2am. Has never heard of this company.

**Today:** searches, calls five numbers, gets voicemail on four.

**Success:** someone answers and turns up.

| # | Story | Priority |
| --- | --- | --- |
| EMG-1 | Find a company that actually operates at 2am, in a search result or an AI answer | P1 — **shipped** |
| EMG-2 | See the phone number immediately without navigating | P1 — **shipped** |
| EMG-3 | Know what to do while I wait so the damage stops getting worse | P1 — **shipped** |
| EMG-4 | Know roughly what it will cost before I commit | P1 — **shipped** |
| EMG-5 | Get a tracking link so I know someone is actually coming | P2 |

**Design consequence:** EMG-1 is the entire AEO/GEO strategy. EMG-3 is the `HowTo` block on the
emergency page — it is genuinely useful *and* it is the shape of content generative engines reach
for, which is the ideal case where doing the right thing for the user and for retrieval coincide.

---

## 5. Omar — Managing Director

Owns the P&L. Wants to know whether the business is healthy without reading a spreadsheet.

| # | Story | Priority |
| --- | --- | --- |
| MD-1 | See revenue, margin and job volume by service line and by month | P2 |
| MD-2 | See which contracts are up for renewal in the next 90 days | P1 |
| MD-3 | See technician utilisation and first-time-fix rate | P2 |
| MD-4 | See overdue invoices ranked by amount and age | P1 |
| MD-5 | Know which customers are at risk before they leave | P3 |

**Design consequence:** MD-2 drives `contracts_expiry_idx`; MD-4 drives `invoices_ageing_idx`. Both
are indexed because they are dashboard queries that run constantly.

---

## 6. Priya — Accountant

Raises invoices, chases payment, closes the month.

| # | Story | Priority |
| --- | --- | --- |
| ACC-1 | Raise an invoice from a completed, signed-off job without re-typing anything | P1 |
| ACC-2 | Invoice a contract on its billing cycle automatically | P2 |
| ACC-3 | See what is unbilled, so revenue does not leak | P1 |
| ACC-4 | Record payments and reconcile against the gateway | P2 |
| ACC-5 | Send reminders on overdue invoices without writing each one | P2 |

**Design consequence:** ACC-1 is why invoices link to jobs and quotes, and why totals are stored
rather than recomputed. ACC-4 is why `payments_gateway_key` is unique — webhooks retry, and a
duplicate payment row is a real accounting problem.

---

## What phase 1 actually delivers

Of the 34 stories above, **four are shipped**: EMG-1 through EMG-4, all on the public website. Every
other story is designed — the schema supports it and the roadmap sequences it — but not built.

That ratio is the honest picture of where this project is.
