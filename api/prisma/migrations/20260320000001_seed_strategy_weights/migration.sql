-- Seed strategy_weights with Bayesian priors to activate learning-driven routing immediately.
-- sample_count = 5 meets the getStrategyRecommendation() minimum threshold.
-- Values derived from estimatedQualityBoost and estimatedCostMultiplier metadata in each strategy.
INSERT INTO "strategy_weights"
  ("task_type", "complexity", "strategy", "weight", "success_rate", "avg_quality", "avg_cost_efficiency", "sample_count")
VALUES
  ('code-generation', 'high',   'parallel',          1.5, 0.85, 0.78, 0.72, 5),
  ('code-generation', 'medium', 'quality-multipass',  1.4, 0.83, 0.82, 0.65, 5),
  ('code-generation', 'low',    'single',             1.1, 0.90, 0.72, 0.95, 5),
  ('code-review',     'high',   'debate',             1.6, 0.80, 0.82, 0.58, 5),
  ('code-review',     'medium', 'consensus',          1.4, 0.84, 0.76, 0.68, 5),
  ('code-review',     'low',    'single',             1.1, 0.90, 0.70, 0.93, 5),
  ('analysis',        'high',   'debate',             1.5, 0.78, 0.80, 0.55, 5),
  ('analysis',        'medium', 'consensus',          1.3, 0.82, 0.73, 0.70, 5),
  ('refactoring',     'high',   'quality-multipass',  1.5, 0.82, 0.83, 0.60, 5),
  ('refactoring',     'medium', 'quality-multipass',  1.3, 0.80, 0.80, 0.63, 5),
  ('debugging',       'high',   'collaborative',      1.4, 0.83, 0.79, 0.65, 5),
  ('debugging',       'medium', 'collaborative',      1.3, 0.82, 0.76, 0.68, 5),
  ('general',         'low',    'single',             1.2, 0.90, 0.72, 0.95, 5),
  ('qa',              'low',    'single',             1.2, 0.91, 0.70, 0.96, 5),
  ('qa',              'medium', 'single',             1.1, 0.89, 0.71, 0.90, 5),
  ('documentation',   'medium', 'single',             1.1, 0.88, 0.71, 0.91, 5)
ON CONFLICT ("task_type", "complexity", "strategy") DO NOTHING;
