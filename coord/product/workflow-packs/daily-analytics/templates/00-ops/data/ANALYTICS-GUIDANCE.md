# Analytics Guidance

Recurring instructions become reusable rules here.

## Rule Template

```text
rule_id:
instruction:
applies_to:
source_of_truth_role:
reconciliation_label_required:
report_template_requirement:
utility_output_label:
owner_ticket:
last_reviewed:
```

## Example Rule

```text
rule_id: GUIDE-0001
instruction: Use ad-platform metrics for creative direction, and site/app/order
  analytics for product truth.
applies_to: paid media daily reviews
source_of_truth_role: ad platform is directional for creative; order system is
  authoritative for realized orders.
reconciliation_label_required: directional-only unless matched to order data.
report_template_requirement: show directional and matched metrics separately.
utility_output_label: directional-only
owner_ticket: ANALYTICS-001
last_reviewed: 2026-01-15
```
