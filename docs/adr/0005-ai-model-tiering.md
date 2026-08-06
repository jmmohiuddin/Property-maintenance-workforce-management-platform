# ADR 0005: AI model selection and tiering

**Status:** Accepted (design) · **Date:** 2026-08-06 · **Implementation:** phase 4

## Context

The platform has several planned AI capabilities with very different economics and very different
consequences when wrong:

| Capability | Volume | Latency need | Cost of a wrong answer |
| --- | --- | --- | --- |
| Job triage (trade, priority, duration) | Every job | Seconds | Wrong technician dispatched; SLA missed |
| Quote drafting | Every quotation | Minutes acceptable | Money quoted wrong; margin lost |
| Dispatch scoring | Every assignment | Sub-second | Suboptimal route; recoverable |
| Report summarisation | Every completed job | Minutes acceptable | Customer-facing text is wrong |
| AI receptionist | Every out-of-hours call | Real time | Emergency mishandled; genuine harm |
| Contract analysis | Rare, high value | Minutes acceptable | Obligation missed; legal exposure |

Using one model for all of them either overspends on trivial classification or underperforms on the
work that carries real consequences.

## Decision

**Default to Claude Opus 5 (`claude-opus-5`).** Every capability starts here. Tiering down is an
explicit, measured decision the business makes per capability after seeing real accuracy on real
data — not an assumption baked in before launch.

Model IDs and pricing as of August 2026:

| Model | ID | Context | Input / output per MTok |
| --- | --- | --- | --- |
| Claude Opus 5 | `claude-opus-5` | 1M | $5 / $25 |
| Claude Sonnet 5 | `claude-sonnet-5` | 1M | $3 / $15 |
| Claude Haiku 4.5 | `claude-haiku-4-5` | 200K | $1 / $5 |

Planned starting assignment, to be revised against measured accuracy:

| Capability | Start on | Rationale |
| --- | --- | --- |
| AI receptionist | `claude-opus-5` | Highest consequence. An emergency misjudged at 3am is the worst failure this platform can have, and it is not a place to economise. |
| Contract analysis | `claude-opus-5` | Rare, high value, long documents. Volume is low enough that cost is irrelevant. |
| Quote drafting | `claude-opus-5` | Directly determines revenue and margin. |
| Job triage | `claude-opus-5`, evaluate `claude-sonnet-5` | High volume, so the strongest tiering candidate — but only once we can show accuracy holds on a real job corpus. |
| Report summarisation | `claude-opus-5`, evaluate `claude-sonnet-5` | Customer-facing, so quality is visible. |
| Dispatch scoring | Not an LLM | See below. |

**Dispatch scoring should not use an LLM at all.** Ranking technicians by distance, skill match,
certification validity and shift capacity is a constraint-satisfaction problem with an exact answer.
A scoring function is faster, cheaper, deterministic, testable and explainable. Reaching for a model
here would be using the expensive tool because it is available.

## API conventions

- **Adaptive thinking**: `thinking: {type: "adaptive"}`. On Opus 5 this is also the default when the
  field is omitted. The fixed `budget_tokens` form is removed and returns a 400.
- **Effort** controls depth: `output_config: {effort: "..."}`. Start at `high`; `xhigh` for contract
  analysis; sweep down to `medium`/`low` where evaluation shows quality holds. `low` and `medium` are
  unusually strong on Opus 5 and are the main cost lever.
- **No sampling parameters.** `temperature`, `top_p` and `top_k` are rejected on Opus 5. Steer
  behaviour with prompting.
- **`max_tokens` caps thinking plus response together.** Size it with that in mind, and stream
  anything above ~16K.
- **Handle `stop_reason: "refusal"` before reading `content`.** Opus 5 runs safety classifiers and can
  decline; code that indexes `content[0]` unconditionally breaks. Opt into server-side fallbacks.
- **Structured output** via `output_config.format` with a JSON schema, so triage and quote drafts
  arrive as validated objects rather than parsed prose.
- **Prompt caching** on the stable prefix (system prompt, service catalogue, tenant profile). The
  catalogue is large and identical across calls, which is exactly the shape caching rewards. The
  cacheable minimum on Opus 5 is 512 tokens.

## Guardrails

These matter more than the model choice.

1. **Every AI call is logged** to `ai_interactions`: model, prompt hash (not the prompt — it carries
   customer PII), tokens, cost, latency, the record it affected, and whether a human accepted the
   output. Without this, neither accuracy nor cost per tenant is observable.
2. **AI output is proposed, never applied.** `jobs.ai_triage`, `quotes.ai_generation` and
   `job_reports.ai_summary` sit alongside the human-authored fields rather than replacing them.
   `ai_summary_approved_by_id` records who signed off.
3. **No AI-only path to money or dispatch.** A quote must be approved by a person before it reaches a
   customer. A P1 emergency must reach a human dispatcher.
4. **Tier changes require evidence.** Moving a capability from Opus 5 to Sonnet 5 requires a
   documented evaluation on real records showing accuracy holds. `acceptedByHuman` in
   `ai_interactions` is the metric.

## Consequences

**Good.** Starting at the top means quality problems are prompt or design problems, not model
problems, which makes debugging tractable. The interaction ledger makes both cost and accuracy
measurable per capability and per tenant. Keeping dispatch deterministic keeps the highest-frequency
decision explainable to a dispatcher who asks "why him?".

**Bad.** Starting on Opus 5 everywhere costs more than starting cheap. That is deliberate: the
alternative is discovering a quality problem in production on customer-facing output, and the
evaluation data needed to tier down safely only exists after running the expensive tier first.

**Risk.** AI cost scales with job volume, so a tenant with high volume and low margin could become
unprofitable before anyone notices. `ai_interactions.cost_micros` exists to make that visible, and
per-tenant cost alerting should ship with phase 4 rather than after it.
