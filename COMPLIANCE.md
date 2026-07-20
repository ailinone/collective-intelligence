<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# License Compliance & Enforcement Policy

This project is licensed under the **GNU Affero General Public License, version 3
or later (AGPL-3.0-or-later)**. This document explains what the license requires
of anyone who uses or deploys this software, and how the copyright holder —
**Ailin One, Inc.** — responds when those terms are not met.

> This is a policy document for humans. Nothing described here is enforced
> automatically by the software at runtime. The program contains no license
> "kill switch," no usage telemetry, and no phone-home mechanism — such
> mechanisms are incompatible with GPL/AGPL §7 (which forbids adding
> restrictions beyond those the license itself grants). Compliance is
> monitored and enforced by **people**, through the process below.

---

## 1. What the AGPL requires of you

If you **use** this software as-is, internally, you already comply — the AGPL
grants broad freedom to run the program for any purpose.

Obligations arise when you **convey** the software or **make a modified version
available to others over a network**:

1. **Distribution (§4–6).** If you distribute this software or a derivative, you
   must pass on the complete corresponding **source code** under the same
   AGPL-3.0-or-later terms, keep all copyright and license notices intact, and
   include the `LICENSE` file.

2. **Network use — the AGPL's defining clause (§13).** If you run a **modified
   version** of this program and let users interact with it **remotely over a
   network** (e.g. as a hosted API or SaaS), you **must offer those users the
   complete corresponding source code of your modified version**, under
   AGPL-3.0-or-later, at no charge. Running it privately without modification
   does not trigger this; offering a modified version as a network service does.

3. **No additional restrictions (§7).** You may not impose further terms — you
   cannot relicense it as proprietary, strip the AGPL from it, or wrap it in an
   EULA that removes freedoms the AGPL grants.

If the AGPL's network-copyleft obligation does not fit your use case (for
example, you want to embed this in a proprietary product), that is exactly what
a **separate commercial license** is for — see §5 below.

---

## 2. How this project makes compliance easy (and violations visible)

The project ships several honest, passive provenance signals. None of them
restricts use; they exist so that good-faith operators know their obligations
and so the copyright holder can identify deployments during a routine external
review:

| Signal | Where | Purpose |
|---|---|---|
| Full license text | `LICENSE` | The AGPL-3.0 terms, verbatim. |
| Copyright / source notice | `NOTICE`, `README.md` | Names the holder and the canonical source URL. |
| Per-file SPDX headers | every source file | An `SPDX-License-Identifier` tag naming AGPL-3.0-or-later — survives file copying. |
| Machine-readable manifest | `REUSE.toml` | Makes license coverage verifiable by `reuse lint`. |
| HTTP response headers | `X-License`, `X-Source-Code`, `X-Copyright` | Visible via `curl -I <host>`; identify a deployment's license and source. |
| In-app source offer | `/source` endpoint | Satisfies the AGPL §13 duty to offer Corresponding Source to network users. |

Because the HTTP and in-app signals are part of the licensed work, a third party
who strips them to disguise an unauthorized deployment is removing a copyright
notice — itself a separate, and clearer, violation of the AGPL (§5) and of
copyright law generally.

---

## 3. Reporting a suspected violation

If you believe a deployment or fork is not complying with the AGPL, or you are
an operator who wants to self-report and get right, contact:

**compliance@ailin.one**

Please include: the URL or repository, what you observed (e.g. missing source
offer, stripped notices), and the date. We treat good-faith reports and
good-faith self-reports very differently from deliberate concealment.

---

## 4. Our enforcement approach — community-oriented, not litigation-first

Ailin One, Inc. follows the widely adopted **[Principles of Community-Oriented
GPL Enforcement](https://sfconservancy.org/copyleft-compliance/principles.html)**
articulated by the Software Freedom Conservancy and the FSF. Enforcement exists
to **secure compliance**, not to generate revenue or punish. The process is
staged and gives every party a real chance to comply before escalation:

1. **Detection.** Periodic external review of public deployments and forks
   (see the compliance-scanner tooling kept privately by the maintainers). Every
   finding is reviewed by a human before any contact is made — automated
   detection never triggers automated legal action.

2. **First contact — private and factual.** We reach out privately, describe the
   specific obligation we believe is unmet, and point to the exact remedy
   (usually: publish your modified source and restore notices). No public
   naming, no demand for damages at this stage.

3. **Reasonable time to cure.** The recipient is given a fair, explicit window
   to come into compliance, with our help if they want it.

4. **Escalation only if ignored.** If good-faith contact is refused over a
   sustained period, we escalate — formal legal notice, and litigation only as a
   genuine last resort. Our priority throughout remains compliance and
   restoration of the source freedoms, not a settlement.

5. **Prompt closure.** Once a party complies, the matter is closed and
   acknowledged. Compliance is the win.

We will **not** use enforcement as a trap, will not demand disproportionate
penalties for innocent mistakes, and will prioritize the community's access to
source over any commercial interest of ours.

---

## 5. Commercial licensing (the lawful alternative to violating)

The AGPL is the **only** license under which this software is offered to the
public. If your intended use is incompatible with the AGPL's network-copyleft
obligation — for instance, you want to offer a hosted service based on a
modified version **without** publishing your modifications — you do not have to
violate the license. Ailin One, Inc., as the sole copyright holder, can grant a
**separate commercial license** on negotiated terms.

Contact **licensing@ailin.one**.

> Scope note: contributions are accepted under the **Developer Certificate of
> Origin** (`DCO.md`, inbound = outbound AGPL). Third-party contributions are
> therefore licensed to the project under AGPL-3.0-or-later only, and the
> commercial-license option above covers the code whose copyright Ailin One,
> Inc. holds. If the project later adopts a contributor agreement with a
> relicensing grant, it will be announced in `CONTRIBUTING.md` and will apply
> only to contributions made after that change.

---

## 6. Trademarks

The AGPL licenses **copyright**, not trademarks. The names, logos, and brand of
Ailin One, Inc. and the "Ailin" / "Collective Intelligence" product identity are
**not** granted by the AGPL. A fork is free (and encouraged) to use the code, but
must not present itself as the official project or use the marks in a way that
implies endorsement. See [`TRADEMARKS.md`](TRADEMARKS.md).

---

*This document is a statement of policy, not legal advice, and is not a
modification of the AGPL. In any conflict, the text of `LICENSE` governs.*
