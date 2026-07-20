-- Copyright (C) 2026 Ailin One, Inc.
--
-- This file is part of Collective Intelligence Engine (ci).
-- Licensed under the GNU Affero General Public License v3.0 or later.
-- See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
--
-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Source: https://github.com/ailinone/collective-intelligence

-- Provider Runtime Inventory: corrected post-fix-c85b844 (2026-04-28)
-- Lists every provider materialized in the models table with model count
-- and the union set of capabilities discovered across all its models.
WITH per_model_caps AS (
  SELECT m.provider_id,
         m.uid,
         array_agg(DISTINCT a.capability ORDER BY a.capability) AS caps
  FROM models m
  LEFT JOIN model_capability_assertions a ON a.model_uid = m.uid
  GROUP BY m.provider_id, m.uid
),
provider_caps AS (
  SELECT provider_id,
         COUNT(DISTINCT uid) AS model_count,
         ARRAY(SELECT DISTINCT unnest(caps) FROM per_model_caps p2 WHERE p2.provider_id = p1.provider_id ORDER BY 1) AS distinct_caps
  FROM per_model_caps p1
  GROUP BY provider_id
)
SELECT row_number() OVER (ORDER BY model_count DESC) AS rk,
       provider_id,
       model_count,
       cardinality(distinct_caps) AS n_caps,
       array_to_string(distinct_caps, ', ') AS capability_set
FROM provider_caps
ORDER BY model_count DESC;
