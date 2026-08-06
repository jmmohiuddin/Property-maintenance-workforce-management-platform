# Data lifecycle and retention

## The problem table

`technician_locations` receives a row per technician per GPS ping. At 180 technicians pinging every
30 seconds during a 10-hour shift, that is roughly **216,000 rows per day**, or 79 million per year.

Left alone this table dominates the database, slows every backup, and makes the nearest-technician
query progressively worse.

### Plan

1. **Partition by month** (`PARTITION BY RANGE (recorded_at)`). Not yet applied; the table is created
   unpartitioned in `0000_init.sql` because partitioning an empty table before the ping cadence is
   known is premature. Do this before the mobile app ships, which is when the table starts filling.
2. **Keep 30 days hot.** Live tracking and same-month disputes need this.
3. **Roll off to cold storage** after 30 days as compressed Parquet in object storage. Old traces are
   occasionally needed for a payroll or attendance dispute, so they are archived rather than dropped.
4. **Delete after 12 months.** This is employee monitoring data; keeping it indefinitely is neither
   necessary nor defensible.

A separate `technician_last_known_location` table (one row per technician, upserted) should serve the
dispatch query, so the hot path never scans the history table at all. Not yet built.

## Retention by data class

| Data | Hot | Archive | Delete | Why |
| --- | --- | --- | --- | --- |
| `technician_locations` | 30 days | 12 months | 12 months | Employee monitoring; minimise |
| `attendance_events` | 24 months | 5 years | Per UAE labour record requirements | Payroll disputes |
| `job_events` | 12 months | Life of job record | With the job | Explains job timelines |
| `audit_log` | 12 months | 7 years | 7 years | Financial and compliance evidence |
| `ai_interactions` | 6 months | 24 months | 24 months | Model behaviour investigation, cost analysis |
| `notifications` | 90 days | none | 90 days | Delivery debugging only |
| Jobs, quotes, contracts, invoices | Indefinite | — | — | Business records; disputes surface years later |
| Job photos and signatures | Life of job + 7 years | — | With the job record | Evidence in damage and insurance claims |
| `communications` | Life of customer relationship | — | 24 months after account closure | CRM history |
| `sessions` | Until expiry | — | 30 days after expiry | Forensics on a compromised account |

## Deletion requests

When a customer requests deletion:

- **Erase**: contact details, `communications` bodies, job photos of their property, signature images
- **Retain, anonymised**: the job, quote, invoice and payment rows, with personal fields nulled and
  the customer replaced by a tombstone reference

Financial records cannot be deleted on request; they are required for tax and audit. The
distinction between erasing personal data and retaining an anonymised transaction record is the one
that matters, and it needs a documented procedure before the portal launches.

Note the interaction with `audit_log`: it is append-only by design, so a deletion request cannot
remove audit entries. Personal data must therefore be kept **out** of `changed_fields` where
possible, or the audit log becomes an un-erasable copy of everything. This is a real design tension
and it is not yet resolved. It should be settled before the portal handles live customer data.

## Backups

- Continuous WAL archiving, target RPO 15 minutes
- Point-in-time recovery retained 30 days
- Nightly logical dumps retained 90 days, stored in a different region
- **Quarterly restore drills.** An untested backup is a hypothesis, not a backup.

## Where this document is referenced from

`packages/db/src/schema/workforce.ts` points here from the `technician_locations` definition, so
anyone about to add a query against that table sees the growth problem first.
