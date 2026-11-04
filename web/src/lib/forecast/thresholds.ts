// How much evidence each model needs before it gives a number. Measured on synthetic companies; see
// experiments/whatif/results-thresholds.json. sql/70_analytics.sql holds the same numbers, and a test keeps them equal.
export const NEED = {
  quote_conversion: 40,
  demand_sales_months: 15,
  demand_true_days: 30,
  demand_true_sales_months: 12,
  quarter_outlook_months: 24,
  whatif_price_months: 9,
  stockout_days: 30,
  whatif_sales_months: 9,
  whatif_policy_days: 270,
  whatif_policy_days_with_purchase: 180,
  whatif_realloc_days: 180,
  realloc_warehouses: 2,
  drop_episodes: 5,
  receipts: 10,
  whatif_lead_receipts: 10,
  reorder_receipts: 30,
  paid_invoices: 100,
  term_changes: 3,
  journal_months: 3,
  asset_history_months: 12,
} as const
