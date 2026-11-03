# 분석 (`sql/70_analytics.sql`)

`erp_snapshot_at(at)`, `erp_flow_stats(from, to)`, `erp_demand_series(variant, bucket, from, to, as_of)`, `erp_stock_history(variant, from, to)`, `erp_price_history(variant)`, `erp_quote_revisions(from, to)`, `erp_payment_behavior(partner)`, `erp_ar_forecast_inputs()`. 예측 계산은 브라우저(`web/src/lib/forecast.ts`)에서 한다.
