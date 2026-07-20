<!--
Copyright (C) 2026 Ailin One, Inc.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Launch decision record — first public release

**Decision owner:** Alisson Idalo, sole maintainer and sole officer of
Ailin One, Inc. (Delaware C-Corp), sole copyright holder of the published
code. **Status:** draft until the GO signature line below is filled at push
time.

## Legal basis for launching on standard terms (no bespoke counsel review)

Every legal instrument shipped in this release is a **standard, widely
adopted text used verbatim**, none of which requires drafting by counsel to
be effective:

| Instrument | Text | Provenance |
|---|---|---|
| Code license | GNU AGPL-3.0-or-later, verbatim (sha256-matched against gnu.org) | Free Software Foundation |
| Contributor certification | Developer Certificate of Origin 1.1, verbatim | Linux Foundation |
| Code of conduct | Contributor Covenant 2.1, verbatim | Organization for Ethical Source (CC-BY-4.0) |
| License metadata | SPDX identifiers + REUSE specification | Linux Foundation / FSFE |
| Third-party attribution | THIRD_PARTY_NOTICES.md from lockfile-pinned inventory | Generated, reproducible |

The dual-licensing position (public AGPL + private proprietary + commercial
licensing option) rests on a single legal fact that does not require
drafting: **Ailin One, Inc. is the sole copyright holder** of the published
code. A CLA — the one instrument that genuinely benefits from counsel —
was deliberately **deferred** (DCO chosen for launch), which removes the
only draft-quality legal text from the release.

## Risks accepted at launch (revisit triggers named)

1. **No counsel-reviewed IP matrix.** Mitigation: sole-authorship history,
   per-file clearance manifest (2,700+ decisions with reasons), REUSE
   metadata, third-party components attributed. **Trigger to engage
   counsel:** first external contribution of substance, or first commercial
   licensing negotiation.
2. **DCO-only inbound.** External contributions are AGPL-only and cannot be
   commercially relicensed. **Trigger:** first significant external
   contribution → adopt counsel-reviewed CLA (applies prospectively) or
   re-implement.
3. **Trademark unregistered** (common-law ™ only, documented in
   TRADEMARKS.md). **Trigger:** first observed misuse, or revenue
   justifying registration (~US$250-350/class, USPTO classes 9+42).
4. **Patent posture** relies on AGPL §11's built-in patent grant; no
   separate patent policy. **Trigger:** counsel engagement per (1).

## Import gate (standing rule)

No external patch from the public repository may enter the private
repository without a license clearance: a third-party AGPL-only
contribution inside the private tree would make the hosted service a
derivative work not wholly owned by Ailin One, triggering §13 over the
entire deployment, including proprietary extensions.

## GO signature

- [ ] Credentials rotation completed and verified (SMTP + provider keys)
- [ ] Final export scanned (secret signatures + TruffleHog): zero findings
- [ ] Repository protections active (branch protection, secret scanning,
      private vulnerability reporting)
- [ ] **GO given by:** _______________ **date:** _______________
