# Product & Technical Master Document

**Status:** Source of truth as of 2026-08-09. Supersedes nothing; consolidates everything.
**Produced by:** Post-hoc product/engineering audit (reverse-engineered from the implementation, the commit history, and the session record in which the system was built).

This is the documentation set that should have existed before the first line of code. It was
reconstructed *after* development, so it does two jobs at once: it states what the product is,
and it audits the gap between what exists and what should exist.

## How to read the labels

| Label | Meaning |
| --- | --- |
| **INFERRED REQUIREMENT** | Not stated by anyone; reconstructed from what the code does. Treat as a requirement only after confirmation. |
| **IMPLICIT DECISION** | A choice that was made by writing code, not by deciding. It may be right, but nobody chose it on purpose. |
| **UNKNOWN — NEEDS CONFIRMATION** | The implementation cannot answer this. A human must. |
| **CONTRADICTION** | Two parts of the system (or the system and its own copy) disagree. |

## Parts

| Part | File | Covers (deliverable §§) |
| --- | --- | --- |
| 1. Product | [01-product.md](01-product.md) | Executive summary, product overview, problem, personas, vision & goals, current product analysis, PRD, user stories, feature spec, user flows (§1–10) |
| 2. Design | [02-design.md](02-design.md) | Product design document, information architecture, UX/UI specification (§11–13) |
| 3. Technical | [03-technical.md](03-technical.md) | Technical requirements, system architecture, database, API, security, technical design, testing, analytics & observability (§14–21) |
| 4. Audit & Forward | [04-audit-and-roadmap.md](04-audit-and-roadmap.md) | Current vs ideal, product debt, technical debt, risk register, traceability, backlog, roadmap, recommendations, process retrospective, final assessment (§22–31) |

## Relationship to existing documents

The repo already contains documentation written *during* development:
`docs/adr/0001–0005` (stack, catalogue, multi-tenancy, offline mobile, AI tiering),
`docs/architecture/01–06`, `docs/product/00–01`, `docs/ops/03-launch-checklist.md`.
Those remain valid as deeper dives. Where this master document and an older document
disagree, **this document wins**, and the older one should be amended.

## The one paragraph that matters

Meridian is a multi-tenant property-maintenance operations platform (lead → job → dispatch →
quote → invoice, plus customer portal and a search/AI-optimised public site) whose security
architecture and money handling are genuinely production-grade, but whose **operational shell is
still demo-grade**: there is no way to create a user, a tenant, or a recovered password without
SQL; nothing schedules notification retries; nothing monitors errors; and the marketing site
publishes fabricated statistics. The single most important open decision is strategic, not
technical: **is this one company's internal tool, or a multi-tenant SaaS?** The database says
SaaS; the hardcoded brand identity says internal tool. Every roadmap choice downstream depends
on that answer. See Part 4, §22 and §31.
