# ADR 0009: The field app is React Native, as ADR 0004 already decided

**Status:** Accepted · **Date:** 2026-08-21 · **Closes:** `OPEN-1` · **Confirms:** [ADR 0004](0004-offline-first-mobile.md)

## Context

Phase 3 cannot start until the field application's platform is settled. `OPEN-1` in the Product
Requirements Document names this as the highest-consequence unresolved decision blocking the phase,
and §8.1 of the Technical Requirements Document is titled "Platform decision — reversing the earlier
ADR".

**There is nothing to reverse.** ADR 0004, accepted 2026-08-06, selected **Expo (React Native) +
WatermelonDB** and considered a PWA explicitly as an alternative:

> **PWA with service workers.** Cheapest option. Rejected: background GPS and reliable camera access
> are weak on mobile browsers, and both are core to the technician workflow.

Two documents state otherwise. TRD §8.1 asserts "The earlier architecture decision selected an
offline-first PWA." PRD `OPEN-1` offers the choice as "React Native (recommended, §M11) or PWA
(existing ADR)". Both describe ADR 0004 as having decided the opposite of what it decided.

The consequence was not academic: the question was put to the owner as an open decision, and the
owner answered it, when the answer had been recorded fifteen days earlier. A specification that
misdescribes its own decision record costs the same thing a comment misdescribing its function
costs — somebody acts on it.

## Decision

**Expo (React Native) + WatermelonDB.** Confirmed, unchanged from ADR 0004. `OPEN-1` is closed.

The reasoning in TRD §8.1 is sound and is adopted as supporting evidence rather than as a reversal.
It is stronger than ADR 0004's own argument, because it identifies the failure mode precisely:

- **Background Sync is unsupported in Safari at any version.** A PWA on iOS cannot sync after the
  technician leaves a basement unless they reopen the app — which is the product's core promise.
- **WebKit evicts script-writable storage** for origins with no user interaction for roughly seven
  days. Persistent storage is granted heuristically; home-screen installation helps and guarantees
  nothing. Unsynced job data can vanish over a holiday, silently.
- **Web push on iOS requires a manual home-screen install** with no automatic prompt — a real
  drop-off for a non-technical workforce.
- **No Web NFC or Web Bluetooth on iOS**, ruling out asset-tag scanning and instrument integration.

The commonly cited counter-argument is out of date and should not be repeated: the 50 MB Safari
storage cap has not applied since iOS 17. **Capacity is fine. Eviction and background sync are the
problem, and neither is fixable from application code.**

**What stays on the web,** per TRD §8.1 and not in dispute: the dispatcher console, the customer
"track my technician" page, and the customer-facing sign-off page opened on the customer's own
phone. Those are online-mostly and benefit from zero install.

## Corrections this ADR makes to the record

1. TRD §8.1's premise sentence is factually wrong about ADR 0004 and is corrected in place. Its
   evidence table is correct and is kept.
2. PRD `OPEN-1` is marked resolved, and its framing of the alternative as "existing ADR" is
   corrected.

Neither document's technical content changes. Only their description of what was already decided.

## Consequences

**Good.** Phase 3's platform question is closed with no work discarded, because no work had been
built against the wrong answer. ADR 0004's sync design, bounded working set, conflict-resolution
rules and clock-skew handling all stand and are now backed by a sharper argument.

**Bad.** One additional build target and app-store distribution, exactly as ADR 0004 anticipated.
That cost was accepted then and is accepted now.

**Worth noting.** This is the fourth instance this week of a document describing behaviour or a
decision it does not have — after a cron route reporting a purge as non-existent while it ran, a
reporting registry declaring tables absent three migrations after they landed, and a domain function
documenting a refusal its caller never performs. The pattern is not confined to code comments, and
specifications are not exempt from the rule that a document must tell the truth about itself.
