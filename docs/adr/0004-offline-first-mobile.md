# ADR 0004: Offline-first technician mobile app

**Status:** Accepted (design) · **Date:** 2026-08-06 · **Implementation:** phase 3

## Context

Technicians work in basements, plant rooms, lift shafts, car parks and buildings with no signal. The
job card, photos and customer signature are captured exactly where connectivity is worst.

An app that requires connectivity to record work does not get used. Technicians fall back to paper,
the data never reaches the platform, and every downstream feature — SLA reporting, invoicing against
signed work, first-time-fix rate — is built on nothing.

Offline capability is therefore a correctness requirement, not a nice-to-have.

## Decision

**Expo (React Native) + WatermelonDB, syncing to the platform API.**

- **Expo** — one codebase for iOS and Android, mature native module story for camera, GPS and
  background location, and OTA updates so a field fix does not wait on app store review. Technician
  turnover is high; the app must be installable from a store link without a build pipeline in the
  loop.
- **WatermelonDB** — SQLite-backed, observable queries, and a documented sync protocol. Years of
  production use in exactly this shape of app.

## Alternatives considered

**PowerSync.** Connects to Postgres via change data capture and streams filtered subsets to SQLite.
Genuinely attractive — sync is solved rather than built. Rejected for now because it introduces a
second system between the app and the database with its own operational and failure characteristics,
and because our sync surface is narrow: a technician needs their own jobs for the next few days, not
an arbitrary filtered view of the database. Reconsider if the sync layer becomes a maintenance
burden.

**ElectricSQL + TanStack DB.** Coherent on Postgres and technically elegant. Rejected as less
battle-tested on React Native specifically, and the reads-sync/writes-via-API split adds a concept
without solving a problem we have.

**PWA with service workers.** Cheapest option. Rejected: background GPS and reliable camera access
are weak on mobile browsers, and both are core to the technician workflow.

## Sync design

**What syncs down:** the technician's assigned visits for the next 7 days, plus the properties,
units, assets, access instructions and customer contacts those visits touch. Not the whole tenant.

**What syncs up:** job status transitions, job reports, materials consumed, attendance events, GPS
traces, and photo/signature blobs.

**Conflict resolution:** last-write-wins per field, except status transitions, which are replayed as
an ordered event log against `job_events`. A technician marking a job complete offline while a
dispatcher cancels it online is a real conflict that needs a human, not a merge rule — those surface
on the dispatch board rather than resolving silently.

**Photos and signatures** upload separately from record sync, queued, resumable, and heavily
compressed. A day of job photos over a hotel's guest wifi is the realistic worst case.

**Clock skew:** device clocks are wrong. Every offline-captured record carries both the device
timestamp (`recorded_offline_at`) and the server receipt time, and reports use the server time. This
is why `attendance_events` has a separate `recorded_offline_at` column.

## Consequences

**Good.** Technicians can work through a full shift with no signal. Sync is incremental, so a day of
queued work does not take minutes to upload.

**Bad.** Offline-first is materially harder to build and test than online-only. Every write path
needs a conflict story, and the test matrix includes states that only occur offline. Budget for that
in phase 3 rather than discovering it.

**Risk.** Storage growth on device. Cap the local database, evict completed jobs older than 30 days,
and make photo retention policy explicit before launch rather than after the first "storage full"
report from a technician mid-shift.
