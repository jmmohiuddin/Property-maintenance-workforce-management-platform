# `@meridian/field` — the technician field application (M11)

Expo (React Native) + WatermelonDB, per [ADR 0009](../../docs/adr/0009-field-app-platform-confirmed.md)
and [ADR 0004](../../docs/adr/0004-offline-first-mobile.md). **Not a PWA**, for the reasons those
records give: Safari has no Background Sync at any version, and WebKit evicts script-writable storage
from origins nobody has opened for a week. Neither is fixable from application code, and both would
lose a technician's day.

---

## Read this first: what this workspace can and cannot do

It is **the foundations, not a shippable app**. Nothing here has run on a phone, on a simulator, or
against the real server. What follows is the honest split.

### Built and verified

Everything in `src/domain`, `src/sync`, `src/media` and `src/db/schema.ts` is pure TypeScript with no
native imports, is compiled by `npm run typecheck`, and is exercised by `npm test` — **538 assertions
across eleven suites**, run under plain `tsx` with no device and no network:

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

### Built, compiles only after `npm install`, **never executed**

`src/db/watermelon.ts`, `src/db/models/`, `src/app/`. These import `react-native`,
`@nozbe/watermelondb` and `expo-*`, none of which is installed in this repository. They are compiled
by `npm run typecheck:native` — **which has never been run**, because the install has not happened.
Treat every line of them as unreviewed by a compiler.

### Not built at all

- **Device registration and authentication.** `getDeviceToken()` returns `null`, so every request is
  unauthenticated and the server answers `device_unknown`. The real flow signs in through a web
  session and receives a token once; `expo-secure-store` is declared and unused.
- **The download half of sync.** `FieldApiClient.pull()` parses a response; nothing writes it to
  SQLite. See `applySyncResponse()` in `src/app/sync-runner.ts`, which throws rather than guessing at
  column names.
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

---

## Why the workspace has two TypeScript projects

`npm run typecheck --workspaces` runs from the repository root, on machines where Expo is not
installed. If this workspace's `typecheck` script compiled the React Native half, the root gate would
be red for everyone.

- `tsconfig.json` — the portable half. What `npm run typecheck` and `npm test` cover. No native imports.
- `tsconfig.native.json` — the React Native half. `npm run typecheck:native`, after `npm install`.

The split is not only defensive: keeping the sync engine free of native imports is what makes it
testable at all.

## Dependencies are declared but **not installed**

`npm install` has not been run for this workspace. Doing so pulls Expo and React Native into the
shared root `node_modules` and rewrites `package-lock.json` — a large change that should be made
deliberately, on its own, not in a session shared with other work.

Until then: the root gates pass because they only touch the portable half, and the app cannot be run.

## The API contract

Transcribed from the real route handlers in `apps/web/src/app/api/field/v1/`, not from TRD §8.5 —
the two differ in nine places, listed at the top of `src/sync/protocol.ts`. The whole wire vocabulary
is in that one file so that conforming to the server is a single-file edit.

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
