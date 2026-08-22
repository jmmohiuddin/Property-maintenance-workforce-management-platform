import type { LeadStage } from "@meridian/core";

/**
 * The stages a person may move a lead to from the leads screen (`LEAD-6`).
 *
 * `won` is missing on purpose. A lead becomes won by being converted, which
 * creates the customer, the property and the job in one transaction — a
 * dropdown that could set it directly would produce won leads with nothing
 * behind them, and the pipeline report and the job list would disagree about
 * how much work the business took on.
 *
 * In its own module because the action needs it to reject anything else and the
 * form needs it to draw the control. Two copies of a list like this diverge, and
 * the copy that diverges is always the one doing the checking.
 */
export const STAGE_CHOICES: readonly {
  value: LeadStage;
  label: string;
  /** True where `LEAD-6` requires a reason from the controlled list. */
  needsReason: boolean;
}[] = [
  { value: "new", label: "New", needsReason: false },
  { value: "contacted", label: "Contacted", needsReason: false },
  { value: "qualified", label: "Qualified", needsReason: false },
  { value: "quoted", label: "Quoted", needsReason: false },
  { value: "negotiating", label: "Negotiating", needsReason: false },
  { value: "lost", label: "Lost", needsReason: true },
  { value: "dormant", label: "Dormant", needsReason: true },
];
