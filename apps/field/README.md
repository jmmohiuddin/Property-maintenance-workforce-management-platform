# `@meridian/field` — the technician field application (M11)

Expo (React Native) + WatermelonDB, per [ADR 0009](../../docs/adr/0009-field-app-platform-confirmed.md)
and [ADR 0004](../../docs/adr/0004-offline-first-mobile.md). **Not a PWA**, for the reasons those
records give: Safari has no Background Sync at any version, and WebKit evicts script-writable storage
from origins nobody has opened for a week. Neither is fixable from application code, and both would
lose a technician's day.

---

## Read this first: what this workspace can and cannot do

It is **the foundations, not a shippable app**. Nothing here has run on a phone or on a simulator.
It has now run against the real server — see [The wire contract, over real
HTTP](#the-wire-contract-over-real-http) — but over localhost, from a script, never from a handset.
What follows is the honest split.

### Built and verified

Everything in `src/domain`, `src/sync`, `src/media`, `src/auth` and `src/db/schema.ts` is pure
TypeScript with no native imports, is compiled by `npm run typecheck`, and is exercised by
`npm test` — **706 assertions across thirteen suites**, run under plain `tsx` with no device and no
network:

| Area | What is verified |
| --- | --- |
| `domain/ids.ts` | ULIDs sort into creation order across a 500-item burst, and keep doing so after the device clock is wound back three hours. |
| `domain/clock.ts` | Skew is measured from the round-trip midpoint and classified; the device timestamp and the server receipt time are kept separately and the server one is never defaulted. |
| `domain/working-set.ts` | The bounded set (`FLD-2`); the today/tomorrow-plus-open predicate; eviction that never touches a job with unsynced work. |
| `domain/attendance.ts` | The `FLD-4` safety gate refuses on each missing precondition; labour splits travel from on-site time per visit, clamps a tampered clock to zero, and keeps a recorded zero distinct from a blank. |
| `domain/job-card.ts` | `JOB-15` is **rendered, never recomputed** — the server sends `gaps` and all three of its states (never synced / not completable / ready) stay distinct; "no materials" is a positive declaration and is refused when lines exist; a gap code this build has never heard of still reaches the screen. |
| `domain/signature.ts` | The canonical job-sheet text is deterministic and changes when any signed field does. |
| `sync/outbox.ts` | Backoff with full jitter and a cap; `dead` after the budget; crash recovery returns `inflight` rows to `pending` without charging an attempt. |
| `sync/engine.ts` | FIFO per aggregate; one stuck job does not block another; a photo never precedes the event it evidences; all four of the server's result lists fold back correctly, and a `JOB-15` refusal keeps its queued write with the gaps attached instead of dying. |
| `sync/conflicts.ts` | TRD §8.4's table, keyed by `entity/op`; unknown reasons escalate rather than being guessed. |
| `media/*` | Compression targets, chunk plans that resume from what the server already holds at the server's declared chunk size, the "upload now" override, EXIF orientation including the mirrored tags, and an original that is not deleted until the bytes are stored *and* an attachment cites them. |
| `sync/payloads.ts` | Every mutation payload behind a typed builder: `work_complete` cannot be built (completion goes through the job card only), attachments and signatures cite an `uploadId` and never a storage key, a recorded zero survives as zero, a photo exemption needs a code from the office's list, and an unset field is omitted rather than sent as null. |
| `db/schema.ts` | Every offline-captured table carries both clocks; the outbox's drain predicate is indexed; no biometric column exists anywhere. |
| `sync/download.ts` | The download half as a decision: an **absent** taxonomy set means "keep what you have" and an empty one means "there are none", and the two take different code paths; `scope.jobIds` removals are "what I hold, minus this" and never touch a job with unsynced work; a timestamp is refused rather than stored as `NaN`; all four states of `gaps` survive the round trip. |
| `auth/device-store.ts` | A partially-written credential reads back as "not registered"; a rotated token is durable before the caller sees the response; `reuse` clears the stored token and `expired` does not; no token reaches a log or an error message. |

### Built, compiles, **never executed**

`src/db/watermelon.ts`, `src/db/models/`, `src/app/`. These import `react-native`,
`@nozbe/watermelondb` and `expo-*`. Those are now installed, and `npm run typecheck:native` **has
been run and exits 0** — so every line of them has at last met a compiler. Nothing has *run* them:
no simulator, no device, no adapter. In particular `writeWithOutbox` and `applySyncPlan` — the
one-transaction claim the whole "loses nothing" promise rests on — are compiled and unexecuted.

### Not built at all

- **The web-login step of device registration.** Everything downstream of it is built and tested:
  `src/auth/device-store.ts` (secure storage, rotation, the three resolver outcomes) and
  `src/auth/registration.ts`. The gap is that the technician's session cookie has to come from the
  existing web login rendered in a WebView, and `react-native-webview` is not a dependency.
  `WebLoginPresenter` is the seam; until it lands, **no handset can register**, though
  `test/wire-contract.ts` proves every other link by minting a session directly.
- **Camera capture, EXIF extraction, compression, thumbnails.** The policy and arithmetic are built
  and tested; the native calls are not. `CAPTURE_PIPELINE` in `src/media/exif.ts` marks each step.
  Note the server now extracts EXIF into columns itself and ignores the phone's values, so the
  device-side extraction is for the local thumbnail and the orientation bake, not for the record.
- **`FLD-12`'s recommendation photo.** The text syncs as a field of `job_note/upsert`; the
  photograph has nowhere to land, because `job_attachments.kind` has no `photo_recommendation`
  member. The agreed shape is a `recommendationUploadId` on the note payload once a sixth kind
  exists. The device holds the photo's client id and sends nothing rather than inventing a field.
- **`FLD-14` in its entirety, on both sides.** It requires five things: a SHA-256 of the rendered
  sheet, an immutable PDF snapshot in versioned storage, the record locked after signature,
  reason-coded linked amendments, and a contemporaneous emailed copy. Only the canonicalisation of
  (1) and a device-side lock for (3) exist — `packages/docs` has no job-sheet renderer and
  `recordJobSignature` stores an image and a name. **A signature captured today would prove somebody
  drew on a screen and nothing about what they agreed to**, which is why the signature screen refuses
  to save one. See the header of `src/domain/signature.ts` for the piece-by-piece position.
- **Location capture**, **QR/barcode scanning** (`FLD-5`), **push on assignment** (`FLD-18`).

### Cannot be verified here at all

M11's definition of done — *a technician works a full day with no connectivity and loses nothing* —
needs real hardware losing real signal. Nothing in this repository can establish it.

What *can* now be established here is the half of that promise the protocol is responsible for: that
what the phone queues is what the office accepts, and that a refusal does not destroy it. See
[The wire contract, over real HTTP](#the-wire-contract-over-real-http) below. The other half — that the
SQLite write and the outbox write are one transaction, and that the queue survives the operating
system killing the app — is still a claim about `src/db/watermelon.ts`, which no compiler in this
repository has executed.

---

## Why the workspace has two TypeScript projects

`npm run typecheck --workspaces` runs from the repository root, on machines where Expo is not
installed. If this workspace's `typecheck` script compiled the React Native half, the root gate would
be red for everyone.

- `tsconfig.json` — the portable half. What `npm run typecheck` and `npm test` cover. No native imports.
- `tsconfig.native.json` — the React Native half. `npm run typecheck:native`.

The split is not only defensive: keeping the sync engine free of native imports is what makes it
testable at all.

## Dependencies are installed

`npm install` has been run for this workspace. It added 639 packages — Expo, React Native,
WatermelonDB and their trees — to the shared root `node_modules` and rewrote `package-lock.json`.
Nothing already installed was removed and no existing resolution changed: `react` stays at 19.2.8 at
the root for `@meridian/web`, and this workspace's exact `19.1.0` is nested under
`apps/field/node_modules`.

One consequence worth knowing: **this workspace was invisible to npm before the install**, because it
was absent from `package-lock.json`. The root `npm run typecheck` and `npm run test` therefore never
covered it. They do now — the root sweep went from eight workspaces to nine, and gained these
thirteen suites. They are pure `tsx` with no database and no network, so they cost the root gate
nothing but time.

## The API contract

Transcribed from the real route handlers in `apps/web/src/app/api/field/v1/`, not from TRD §8.5 —
the two differ in nine places, listed at the top of `src/sync/protocol.ts`. The whole wire vocabulary
is in that one file so that conforming to the server is a single-file edit.

## The wire contract, over real HTTP

`test/wire-contract.ts` is the only thing in this repository that has ever made the two halves of the
field protocol speak to each other. Everything else on either side is a transcription of the same
documents, so a **shared** misreading of those documents is invisible to both suites: the server suite
(`packages/db/test/field.test.ts`) never goes through a route handler, and the thirteen suites here
never open a socket.

It refuses to hand-check anything. The server's real bytes go through the client's own
`parseSyncResponse()`, `planSyncApply()`, `parseMutationResponse()` and `applyMutationResponse()`, and
the payloads it sends are built by the real builders in `src/sync/payloads.ts` — a field this script
read by eye would be a field the app has still never read.

**It is deliberately not part of `npm test`.** The default suite is hermetic — no server, no database,
no network — so it runs identically on a laptop, in CI and on a clean checkout where nobody has
installed Expo. A test that needs a live `next start` and a live Postgres in that list would make the
whole suite red for environmental reasons, and a gate that is sometimes red for environmental reasons
is a gate people learn to ignore. So it has its own command:

```sh
# 1. your OWN server, on a port nobody else is using.
#    Check the port is free first: `lsof -nP -iTCP:3107 -sTCP:LISTEN`
PORT=3107 npm run start

# 2. in another terminal, from the repository root
FIELD_WIRE_BASE_URL=http://127.0.0.1:3107 npx tsx apps/field/test/wire-contract.ts
```

It needs `DATABASE_ADMIN_URL` (read from the root `.env` if it is not exported) and the `psql` binary,
which is how it reaches the database — importing `@meridian/db` would drag drizzle and the whole
server-side type graph into this workspace's own typecheck, which is exactly what the two-project
split exists to prevent.

**The development database is shared.** Every row the script writes carries a per-run tag, and every
`DELETE` in its cleanup is anchored to an id the run captured or to that tag *and an age*. It creates
one job, one visit, one device and one session, and removes all of them plus their audit rows on the
way out — including when it fails. It also releases the `field-register:<userId>` rate-limit bucket it
spent, because five registrations an hour is right for a phone and wrong for a script.

### What it found, and what those two checks are now

**103 checks, all passing.** Two of them failed when the script was written, and both were defects on
the *server* side of the contract that two green suites could not see. They were asserted rather than
routed around, so that a fix would turn the script green by itself. Both have since been fixed, and
the two checks are now the regression tests for them — the only ones that exercise either path
through the API rather than through the domain layer.

1. **`transitionJob()` could not move a job to `on_site`.** `packages/db/src/domain/jobs.ts`
   interpolated a JavaScript `Date` into ``sql`coalesce(first_response_at, ${now})` ``; the driver
   threw `ERR_INVALID_ARG_TYPE` before the statement was sent. That is not a `UserFacingError`, so the
   per-mutation savepoint did not absorb it: `/api/field/v1/mutations` returned 500 and the **entire
   batch** rolled back, including mutations that had already applied. A technician could not report
   arriving on site, and nothing queued behind that got through either. It reached no suite because
   none moved a job to `on_site` — the one in `projects.test.ts` is `transitionProject`, a different
   function whose name reads the same at a glance. Now `${now.toISOString()}::timestamptz`.
2. **`job_materials` had no `source` or `serial_number` column**, and `recordJobMaterial()` read
   neither key. `FLD-9` has the technician record where a part came from; the server accepted the line
   and silently dropped the answer — worse than a refusal, because a refusal tells the technician.
   Both columns now exist.

The client side had four of its own, all in the *payloads* — the one part of the contract
`src/sync/protocol.ts` has no schema for. Every structure protocol.ts does declare survived contact
unchanged. That split is the useful result: a transcribed contract held exactly where it was written
down, and broke exactly where it was not.

## Layout

```
src/domain/     pure: ids, clock, working set, attendance, job card, signature
src/sync/       pure: protocol, outbox, drain planner, conflict table, transport
src/media/      pure: compression, chunking, upload policy, EXIF
src/db/schema.ts    pure: the WatermelonDB schema as plain data
src/db/watermelon.ts, src/db/models/    React Native only
src/app/        React Native only: shell, sync runner, four screens
test/           ten suites, plain tsx
```
