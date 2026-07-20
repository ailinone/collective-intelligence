<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Safety Policy

## Principles

1. Models must refuse harmful requests reliably (>= 95% refusal rate)
2. Models must not over-refuse benign requests (<= 5% false positive rate)
3. Safety evaluation runs at every alignment stage, not just final
4. No model is deployed without passing safety benchmarks
5. Adversarial robustness is tested before every promotion

## Harm categories (refusal required)

| Category | Examples |
|----------|----------|
| Violence | Instructions for physical harm |
| CSAM | Any content involving minors |
| Weapons | Weapon manufacturing instructions |
| Malware | Code for malicious software |
| Fraud | Social engineering, scam scripts |
| PII extraction | Techniques to extract personal data |
| Illegal activity | Drug synthesis, illegal surveillance |
| Hate speech | Discriminatory content generation |
| Self-harm | Encouragement of self-harm |
| Deception | Impersonation, deepfake generation |

## Allowed categories (refusal NOT desired)

| Category | Examples |
|----------|----------|
| Education | Academic discussion of sensitive topics |
| Security research | Defensive cybersecurity with context |
| Creative writing | Fiction involving conflict (with boundaries) |
| Medical information | General health information |
| Legal information | Legal rights and procedures |
| Historical discussion | Historical events including difficult ones |
| Scientific discussion | Chemistry, biology in academic context |

## Safety training pipeline

1. **Safety dataset**: Mix of harmful-refusal and helpfulness-preservation pairs
2. **Training**: SFT on safety data after DPO alignment
3. **Mixing ratio**: 60% safety refusal, 40% helpfulness preservation
4. **Evaluation targets**:
   - Harmful prompts: >= 95% refusal rate
   - Borderline prompts: target ~10% refusal (conservative)
   - Benign prompts: <= 2% false refusal rate

## Adversarial testing

Before promotion, models are tested against:
- Prompt injection attacks
- Jailbreak attempts (role-play, encoding, instruction manipulation)
- Context manipulation
- Authority claim attacks
- Multi-turn attacks

Target: >= 80% resistance rate across all attack types.

## Incident response

If a deployed model shows safety failures in production:
1. Automatic alert via Grafana
2. Failure captured in flywheel
3. Targeted safety replay set generated
4. Emergency safety tune if refusal rate drops below 90%
5. Rollback if emergency tune insufficient
