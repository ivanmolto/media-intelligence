-- Metrics for one enrichment run key (spec §7), from the article_enrichments rows.
-- Run by `npm run eval:metrics`; $1 = requested_model, $2 = prompt_version,
-- $3 = taxonomy_version. The README pastes this file and its output.
--
-- Latency and mean tokens are over `done` rows. A dedup-copied row has null
-- latency, tokens, cost and attempts (deviation 18), so it is in the status counts
-- and in nothing else. The totals are over every row, failed ones included: that
-- is what the run spent.
SELECT
  count(*) FILTER (WHERE status = 'pending')                               AS pending,
  count(*) FILTER (WHERE status = 'processing')                            AS processing,
  count(*) FILTER (WHERE status = 'done')                                  AS done,
  count(*) FILTER (WHERE status = 'failed')                                AS failed,
  count(*) FILTER (WHERE status = 'failed' AND error = 'invalid_output')   AS failed_invalid_output,
  count(*) FILTER (WHERE status = 'failed' AND error = 'timeout')          AS failed_timeout,
  count(*) FILTER (WHERE status = 'failed' AND error = 'provider_error')   AS failed_provider_error,
  count(*) FILTER (WHERE status = 'done' AND attempts = 1)                 AS done_first_attempt,
  count(latency_ms) FILTER (WHERE status = 'done')                         AS latency_n,
  percentile_cont(0.5)  WITHIN GROUP (ORDER BY latency_ms)
    FILTER (WHERE status = 'done')                                         AS latency_p50_ms,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)
    FILTER (WHERE status = 'done')                                         AS latency_p95_ms,
  round(avg(input_tokens)  FILTER (WHERE status = 'done'), 1)              AS mean_input_tokens,
  round(avg(output_tokens) FILTER (WHERE status = 'done'), 1)              AS mean_output_tokens,
  avg(cost_usd) FILTER (WHERE status = 'done')                             AS mean_cost_usd,
  sum(attempts)                                                            AS provider_calls,
  sum(input_tokens)                                                        AS total_input_tokens,
  sum(output_tokens)                                                       AS total_output_tokens,
  sum(cost_usd)                                                            AS total_cost_usd,
  array_agg(DISTINCT model)    FILTER (WHERE model IS NOT NULL)            AS models,
  array_agg(DISTINCT provider) FILTER (WHERE provider IS NOT NULL)         AS providers
FROM article_enrichments
WHERE requested_model = $1 AND prompt_version = $2 AND taxonomy_version = $3;
