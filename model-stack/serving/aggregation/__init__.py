# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""Aggregation layer for the coordinator-stable ensemble.

Exposes the tiered cascade voter, the teacher-proxy fallback, the mock
cascade for integration tests, and supporting data shapes. The
coord_serving HTTP endpoint lives here too but is not re-exported
(it's launched as an entrypoint).
"""

from .mock_cascade import MockCascadeBehavior, MockTierExecutor, mock_cascade_decide
from .teacher_proxy import TeacherProxy, TeacherProxyConfig
from .tiered_voter import (
    AggregatedDecision,
    CoordinatorVote,
    EnsembleConfig,
    Tier,
    TieredEnsembleVoter,
    TierExecutor,
    TierResult,
    VoteAggregator,
)

__all__ = [
    "AggregatedDecision",
    "CoordinatorVote",
    "EnsembleConfig",
    "MockCascadeBehavior",
    "MockTierExecutor",
    "Tier",
    "TierExecutor",
    "TierResult",
    "TieredEnsembleVoter",
    "TeacherProxy",
    "TeacherProxyConfig",
    "VoteAggregator",
    "mock_cascade_decide",
]
