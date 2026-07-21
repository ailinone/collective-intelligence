<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

<p align="center">
  <img src=".github/assets/banner.png" alt="Ailin¹ Collective Intelligence — thousands of AI models coordinate inside one collective model" width="100%">
</p>

# Ailin¹ Collective Intelligence

> 🌐 Englisch ist die kanonische Version. Diese Übersetzung folgt Commit 596a94e6 — im Zweifel lies das englische README ([README.md](README.md)).

> 🌐 [English](README.md) · [简体中文](README.zh-CN.md) · [Português (BR)](README.pt-BR.md) · [Español](README.es.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Русский](README.ru.md)

**Tausende KI-Modelle koordinieren sich in einem einzigen kollektiven Modell.**

Strukturierte Diversität, unabhängiges Reasoning und vollständige
Entscheidungs-Provenienz bei jedem Request — entworfen, um Ausgaben
zuverlässiger, resilienter und auditierbarer zu machen als jede
Einzelmodell-Integration. Jeden Tag erscheint ein neues Modell, das
behauptet, das beste zu sein. Dies ist die Schicht, in der sie
zusammenarbeiten. Vollständige Dokumentation: **[ailin.guide](https://ailin.guide)**.

[![License: AGPL-3.0-or-later](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue)](LICENSE)
[![CI](https://github.com/ailinone/collective-intelligence/actions/workflows/ci.yml/badge.svg)](https://github.com/ailinone/collective-intelligence/actions/workflows/ci.yml)
[![REUSE compliance](https://github.com/ailinone/collective-intelligence/actions/workflows/license-compliance.yml/badge.svg)](https://github.com/ailinone/collective-intelligence/actions/workflows/license-compliance.yml)
[![DCO](https://img.shields.io/badge/DCO-required-brightgreen)](DCO.md)
[![Providers](https://img.shields.io/badge/provider_integrations-~90-8A2BE2)](https://ailin.guide/architecture/provider-ecosystem)
[![Models indexed](https://img.shields.io/badge/models_indexed-76%2C636-blueviolet)](#zehntausende-modelle-immer-an-der-frontier)
[![Strategies](https://img.shields.io/badge/collective_strategies-32_registered-6A5ACD)](#der-weg-eines-requests)
[![GitHub stars](https://img.shields.io/github/stars/ailinone/collective-intelligence?style=social)](https://github.com/ailinone/collective-intelligence/stargazers)
[![Discussions](https://img.shields.io/badge/discussions-open-2ea44f?logo=github)](https://github.com/ailinone/collective-intelligence/discussions)

[Quickstart](#quickstart) · [Die nächste Frontier](#kollektive-intelligenz-die-nächste-frontier-der-ki) ·
[Warum ein Kollektiv](#warum-ein-kollektiv-das-größte-einzelmodell-schlägt) ·
[Die Belege](#gegen-die-frontier-bewiesen--öffentlich) ·
[Immer an der Frontier](#zehntausende-modelle-immer-an-der-frontier) ·
[Wie es funktioniert](#architektur-auf-einen-blick) ·
[Mitwirken](#mitwirken--kollektive-intelligenz-braucht-ein-kollektiv) · [Docs](https://ailin.guide)

---

## Kollektive Intelligenz: Die nächste Frontier der KI

Die KI-Industrie hat sich darauf konzentriert, immer größere Einzelmodelle
zu bauen. Ailin¹ verfolgt einen komplementären Ansatz: ein Kollektiv aus
**76,636 KI-Modellen** (Live-Produktionszählung, 2026-07), die gemeinsam
kollaborieren, debattieren, kritisieren und synthetisieren können — und
[strukturierte Diversität](https://ailin.guide/architecture/cognitive-diversity) auf Probleme anwenden, bei denen ein
Einzelmodell ein Single Point of Training, of Architecture, of Bias und
of Failure ist.

**Das ist kein Multi-Model-Routing. Das ist kein API-Gateway. Das ist
Kollektive Intelligenz**: ein System, in dem Modelle aus jeder großen
Architektur — Frontier-APIs, Open-Weight-Herausforderer und unsere eigene
Modellfamilie — über [Dutzende Strategien](https://ailin.guide/architecture/strategy-catalog) koordinieren, mit dem Ziel
höherer Zuverlässigkeit, breiterer Evaluationsabdeckung und vollständigerer
Auditierbarkeit, als jede Einzelmodell-Integration sie bietet.

Das Prinzip ist in der Forschung zu kollektiver Intelligenz und kognitiver
Diversität verankert — Hong & Pages Resultat „diversity trumps ability"
und die Arbeiten von Woolley et al. zu kollektiver Leistung (siehe die
öffentliche [Bibliographie](https://ailin.guide/reference/bibliography)).
Ailin¹ setzt dieses Prinzip als Engineering-Plattform um: eine
Discovery-Engine, die 76,636 Modelle indexiert, Dutzende
Koordinationsstrategien, ein [Audit-Substrat](https://ailin.guide/architecture/collective-intelligence), das
jede Koordinationsentscheidung aufzeichnet, und eine
Closed-Loop-Trainingspipeline. Einige dieser Schichten sind heute
Production-Grade, andere reifen noch — die Docs tragen Status-Badges,
sodass du immer weißt, was ausgeliefert wird und was auf der Roadmap
steht.

## Warum ein Kollektiv das größte Einzelmodell schlägt

Frontier-Modelle werden immer größer, und das jeweils stärkste
Einzelmodell ist bemerkenswert. Aber ein Einzelmodell ist immer ein Single
Point of Training, ein Single Point of Architecture, ein Single Point of
Failure und ein Single Point of Bias. Ein gut koordiniertes Kollektiv
adressiert jede dieser strukturellen Grenzen auf eine Weise, die
Skalierung allein nicht leisten kann.

- **Resilienz.** Ein Einzelmodell bedeutet eine einzelne Abhängigkeit.
  Ist sein Provider an einem gegebenen Tag degradiert, gedrosselt,
  rate-limitiert oder falsch bepreist, ist jeder Call betroffen. Das
  Kollektiv routet ohne Eingreifen um Provider-Ausfälle, degradierte
  Modelle und lokale Fehler herum — der Request gelingt trotzdem, mit
  vollständiger Provenienz
  ([Resilienz-Deep-Dive](https://ailin.guide/architecture/why-collective-resilience)).
- **Evaluationsdiversität.** Verschiedene Modelle werden auf
  verschiedenen Daten mit verschiedenen Zielen trainiert. Viele von ihnen
  zu fragen und die Ausgaben zu vergleichen deckt Fehler und blinde
  Flecken auf, die ein einzelnes Modell — wie groß auch immer — mit
  voller Überzeugung wiederholen würde. Das Kollektiv verwandelt
  Uneinigkeit in ein Qualitätssignal statt in einen Bug.
- **Anti-Konzentration.** Die Abhängigkeit von einem Modell kettet eine
  Organisation an Roadmap, Preisgestaltung und Policy-Entscheidungen
  eines einzigen Anbieters. Das Kollektiv entkoppelt Fähigkeit von jedem
  einzelnen Provider — die Plattform funktioniert weiter, während sich
  die Frontier verschiebt und einzelne Provider aufsteigen, fallen oder
  ihre Preise ändern.
- **Reduzierter Single-Point-Bias.** Jedes Modell trägt die Verzerrungen
  seiner Trainingsdaten, seine Refusal-Muster und seine stilistischen
  Defaults. Ein Kollektiv architektonisch unterschiedlicher Modelle
  verdünnt den Einfluss der blinden Flecken jedes einzelnen Modells —
  insbesondere in Arbitrationsstrategien, die Konvergenz über unabhängige
  Reasoner hinweg verlangen.
- **Dynamische Spezialisierung.** Kein einzelnes Modell ist in allem das
  beste. Ein Kollektiv kann den richtigen Spezialisten der richtigen
  Aufgabe zuweisen — reasoning-lastig, code-lastig, Vision, Long-Context,
  Low-Latency — und jeden Request zu Modellen routen, die genau dort
  stark sind, wo die Aufgabe Stärke verlangt.
- **Stärkere Governance.** Enterprise-Workloads brauchen auditierbare
  Entscheidungen, gedeckelte Kosten, Mandantenisolation und verlässlichen
  Fallback. Eine Einzelmodell-Integration überlässt es dem Integrator,
  diese Kontrollen zu bauen. Das Kollektiv erzwingt Governance auf der
  Plattformschicht: Entscheidungs-Provenienz, Kosten-Caps,
  Quota-Isolation und Policy-Durchsetzung gelten für jeden Request, jede
  Strategie, jedes Modell.

Der Effekt verstärkt sich gegenseitig. Das sind keine sechs unabhängigen
Features — es sind sechs Facetten einer einzigen strukturellen
Entscheidung: Koordiniere viele Modelle gut, und das Ergebnis ist
zuverlässiger, besser steuerbar, langlebiger — und auf der wachsenden
Menge von Aufgaben, deren Korrektheit sich objektiv verifizieren lässt,
**messbar genauer als jedes Frontier-Flaggschiff, das wir getestet haben**
(97% vs. 68–82% — Belege unten).

## Gegen die Frontier bewiesen — öffentlich

Wir testen die These gegen uns selbst, öffentlich, mit objektiver
Bewertung: gepinnte Judges, maschinell prüfbare Antworten überall dort,
wo eine Aufgabe sie zulässt, und die Per-Execution-Rohdaten committet in
diesem Repository
(**[vollständiger Report](reports/experiments/AILIN-COLLECTIVE-FRONTIER-BENCHMARK-2026-07.md)** ·
[rohe CSVs + Skripte](reports/experiments/) ·
[jede Tabelle selbst regenerieren](docs/experiments/REPRODUCING_THE_BENCHMARK.md)).

**✅ Validiert — das Kollektiv schlägt jedes Frontier-Flaggschiff bei
verifizierbaren Aufgaben.** Consensus, bewaffnet mit einem
deterministischen Antwort-Verifier, erzielte **97% objektive Genauigkeit
(37/38)** gegenüber **68–82%** für GPT-5.5-pro, Claude Opus 4.8, Gemini
3.1 Pro und Grok 4.3, gepoolt über alle drei Läufe — und in jedem
einzelnen Lauf hat **der Verifier nie eine objektiv falsche Antwort
ausgewählt**. Ein Pool von Sub-Frontier-Open-Weight-Modellen, gut
koordiniert, hat auf denselben Aufgaben besser geantwortet als jedes
Flaggschiff
([Leaderboard mit jedem n und jedem Vorbehalt, §3](reports/experiments/AILIN-COLLECTIVE-FRONTIER-BENCHMARK-2026-07.md)).

**Die aktuelle Frontier der These** — ehrlich gemessen, und sie treibt
die Roadmap:

| Achse | Heute | Was wir daran tun |
|---|---|---|
| Verifizierbare Korrektheit | ✅ **Kollektiv gewinnt** (97% vs 68–82%) | Ausweitung der Verifier-Abdeckung auf mehr Aufgabenformen (Tool-Calling-Kampagne abgeschlossen 2026-07-18) |
| Offene Prosa | Einzelmodelle gewinnen weiterhin bei Creative Writing & Refactoring | Die Decider-Auswahl trennt messbar Gewinner- von Verlierer-Läufen — ein lernbarer Hebel ([§7](reports/experiments/AILIN-COLLECTIVE-FRONTIER-BENCHMARK-2026-07.md)) |
| Kosten | Kollektiv-Aufpreis wie protokolliert — **außer** beim Verifier-Short-Circuit, der ihn ~100× einbrechen lässt, wenn er zündet ([§5](reports/experiments/AILIN-COLLECTIVE-FRONTIER-BENCHMARK-2026-07.md)) | Verbreiterung des Short-Circuit-Pfads; `ailin-auto` wählt per Default die günstigste tragfähige Strategie |
| Latenz | Mehrrunden-Arbitration, bei der jede Strategie ab dem ersten Token Echtzeit-Fortschritt streamt | `ailin-auto` reserviert die tiefsten Strategien für den Fall, dass das Quality-Gate sie tatsächlich verlangt; latenzkritischer Traffic routet by design auf `single` |

Jede Zahl oben ist durch die Rohdaten pro Ausführung und die
reproduzierbaren Skripte belegt, die in diesem Repository committet
sind — führe den Harness selbst aus, auf deinem eigenen Workload, und
halte uns daran fest.

## Zehntausende Modelle, immer an der Frontier

Das Ailin¹-Kollektiv hängt nicht von hartkodierten Modelllisten oder
manuellen Provider-Integrationen ab. Eine kontinuierliche Discovery-Engine
scannt das globale KI-Ökosystem und absorbiert neue Modelle automatisch,
sobald sie veröffentlicht werden.

Das Ergebnis: ein lebendes Kollektiv aus **76,636 Modellen** über [~90
Provider-Integrationen](https://ailin.guide/architecture/provider-ecosystem), das mit dem Ökosystem Schritt hält.
Veröffentlicht eine entdeckte Quelle ein neues Modell, absorbiert die
Discovery-Engine es ohne Codeänderungen, Konfiguration oder Downtime.

### Semantische Discovery, null hartkodierte Modelle

Die Discovery-Engine scannt Dutzende Quellen parallel — native
Provider-APIs, Cloud-Hubs, Modell-Aggregatoren, Open-Model-Repositories
und private Inference-Endpoints. Aber die Quellen selbst sind nicht der
Punkt. Was zählt, ist, wie Modelle ausgewählt werden.

Jedes entdeckte Modell wird analysiert, klassifiziert und indexiert —
nach Capabilities, Performance-Profil, Pricing, Kontextfenster,
Modalitäten und Architektur, automatisch inferiert, ohne manuelles
Mapping oder Konfiguration. Routen sind health-gated: Ein Modell wird
erst beworben, nachdem es live bewiesen wurde.

Die Modellauswahl ist **vollständig semantisch**. Wenn ein Request
eintrifft, wählt das Kollektiv nicht aus einer statischen Liste. Es
stellt das ideale Team von Modellen zusammen — basierend auf den
Anforderungen der Aufgabe, der gewählten Strategie und dem gewünschten
Ergebnisprofil (maximale Qualität, bestes Preis-Leistungs-Verhältnis,
niedrigste Kosten, schnellste Antwort). Die richtigen Modelle werden in
Echtzeit gewählt, für jeden einzelnen Request. Wenn morgen das „beste
Modell aller Zeiten" erscheint, absorbiert das Kollektiv es — statt mit
ihm zu konkurrieren.

### Eigene Modelle in derselben Arena

Die `ailin`-Modellfamilie und ihr Trainings-Flywheel sind Teil des
Designs: Koordinator-Checkpoints, trainiert auf dem eigenen
Koordinationstraffic der Engine, konkurrieren im selben Pool wie jedes
Drittanbieter-Modell — ohne Routing-Privileg. Das Audit-Substrat, das
jede Koordinationsentscheidung erfasst, wird heute ausgeliefert;
produktive Koordinator-Gewichte sind die Kante, an der gerade entwickelt
wird ([ehrlicher Status, immer aktuell](https://ailin.guide)).

### Kollektivstrategien als falsifizierbare Hypothesen

32 registrierte Strategien — Konsens mit Konvergenz-Untergrenzen,
Blind-Debatte, Expertenpanels, Advocatus-Diaboli-Konsens, Kostenkaskade,
Best-of-N mit objektiver Verifikation — jede mit ehrlicher Erreichbarkeit
gelabelt (auto-selektierbar / nur explizit / Roadmap), jede
falsifizierbar durch den Experiment-Harness in diesem Repo. Strategien
verdienen sich ihren Platz mit Evidenz — oder verlieren ihn.

### Multimodal + deterministische Dateigenerierung

Multimodale Generierung — Bilder, Audio, Video — geroutet nach
Capability, plus deterministisches Datei-Rendering (DOCX, XLSX, PDF,
PPTX, ZIP, Code) aus jedem Chat-Modell mit strukturiertem Output,
bewiesen in Produktion.

### Governance, die Unternehmen wirklich brauchen

Vollständige Entscheidungs-Provenienz (`ailin_metadata`: Strategie,
Modelle, finaler Decider, Kosten pro Subcall, Dissens), `max_cost` pro
Request bei der Admission erzwungen, architektonische Mandantenisolation,
AGPL-§13-Endpoints (`/source`, `/license`), von der Engine selbst
ausgeliefert, SLSA/Sigstore-Release-Provenienz mit SPDX SBOM. Der
Audit-Trail, der unsere Behauptungen beweist, ist derselbe, der deinen
Traffic governt — Governance als [First-Class-Prinzip](https://ailin.guide/architecture/principles), nicht als
Overhead.

## Architektur auf einen Blick

Das System, End-to-End — Discovery speist die Team-Zusammenstellung, jeder
Ausführungspfad mündet in denselben, Provenienz erzeugenden
Arbitrationsschritt:

```mermaid
flowchart TB
    SDK[Any OpenAI SDK / curl<br/>base_url swap only] --> GW[OpenAI-compatible API]
    subgraph Engine[Ailin¹ Collective Intelligence]
        GW --> SR[Strategy resolution<br/>ailin-auto conservative cascade]
        SR --> TA[Team assembly<br/>semantic selection over the live catalog]
        TA --> EX[Execution<br/>fallback chains · budget governor]
        EX --> AR[Arbitration<br/>quality gates · deterministic verifier]
        AR --> PV[Provenance<br/>ailin_metadata on every response]
    end
    DISC[Continuous discovery engine<br/>health-gated · zero hardcoded models] --> TA
    EX <--> PROV[~90 provider integrations<br/>frontier APIs · aggregators · self-hosted]
```

## Der Weg eines Requests

Fokussiert auf einen einzelnen Request — welchen der drei oben
beschriebenen Pfade er nimmt, und warum:

```mermaid
flowchart LR
    A[OpenAI-compatible request] --> B{Strategy resolution<br/>ailin-auto cascade}
    B -->|simple| C[Single model<br/>cheapest viable]
    B -->|declared answer_check| D[Consensus + verifier]
    B -->|explicit| E[1 of 32 strategies]
    C --> F[Execution + fallback chains]
    D --> F
    E --> F
    F --> G[Arbitration & quality gate]
    G --> H[Response + ailin_metadata<br/>full decision provenance]
```

Der Verifier wird scharfgeschaltet, wenn der Request über
`ailin_constraints.answer_check` eine maschinell prüfbare Antwort
deklariert. Die Kaskade ist konservativ — die Ökonomie ist so ausgelegt,
dass sie standardmäßig den günstigen Pfad bevorzugt und nur eskaliert,
wenn das Quality-Gating es verlangt. Und weil Koordination nicht gratis
ist, sagen dir die eigenen Docs der Engine unverblümt,
[wann ein einzelnes Modell die richtige Wahl ist](docs/use-cases/when-not-to-use-collective.md)
([auch im Guide](https://ailin.guide/use-cases/when-not-to-use-collective)) — hochvolumiger Low-Stakes-Traffic, enge Latenz-SLAs, Prosa im
Dokumentationsstil. Die Entscheidung ist operativ, nicht philosophisch.

## Quickstart

> Benötigt Docker mit Compose v2, ~8 GB freien RAM, freie Ports
> 3000/5432/6379. Unter Windows den Block unten in **Git Bash oder WSL**
> ausführen (er nutzt ein Heredoc und `openssl`).

```bash
git clone https://github.com/ailinone/collective-intelligence.git
cd collective-intelligence/docker
cat > .env <<EOF
# strong JWT secrets are REQUIRED — the app refuses weak/default values
JWT_SECRET=$(openssl rand -base64 48)
AILIN_SHARED_JWT_SECRET=$(openssl rand -base64 48)
# local-first secrets: skip GCP Secret Manager entirely
SECRETS_PROVIDER_PRIMARY=env
# one provider key is the minimum — any of the ~90 works
OPENAI_API_KEY=sk-...
EOF
```

Bearbeite `.env` und ersetze `sk-...` durch einen echten Key (oder lass
Keys komplett weg — siehe die Ollama-Option unten). Dann:

```bash
docker compose up -d api postgres redis
docker compose logs -f api    # watch first boot: migrations + discovery, ~1-5 min
curl http://localhost:3000/health
# → {"status":"ok","uptime":…,"version":"0.1.0"}
```

(`coord-serving`, die Serving-Oberfläche des Koordinators, baut und
bootet neben der API — das ist erwartet.) Lege ein lokales Konto an und
rufe das Kollektiv auf:

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"pick-a-strong-one","name":"You"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['tokens']['accessToken'])")
```

```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:3000/v1", api_key=TOKEN)

r = client.chat.completions.create(
    model="ailin-auto",   # or ailin-best / ailin-fast / ailin-economy / ailin-consensus
    messages=[{"role": "user", "content": "Why is the sky blue?"}],
)
print(r.choices[0].message.content)
print(r.model_extra["ailin_metadata"])  # strategy, models, costs, dissent — the receipts
```

Gar kein externer API-Key? Setze `OLLAMA_URL=http://host.docker.internal:11434`
in `docker/.env`, und die Engine bootet im degradierten
Self-Hosted-Modus ([Docs](docs/hardening/DEGRADED_BOOT_MODE.md)). Unter
nativem Linux zusätzlich `extra_hosts: ["host.docker.internal:host-gateway"]`
zum api-Service hinzufügen (oder die Bridge-IP verwenden). Vollständiges
lokales Setup: [Installationsanleitung](docs/getting-started/installation.md).
Hosted-API-Quickstart: [ailin.guide/getting-started/quickstart](https://ailin.guide/getting-started/quickstart).

## Was heute ausgeliefert wird vs. was in Entwicklung ist

| Wird heute ausgeliefert | In Entwicklung |
|---|---|
| OpenAI-kompatible API (chat, responses, embeddings, images, files) | Trainierte Koordinator-Gewichte (Design + Audit-Substrat werden heute ausgeliefert) |
| 32 Orchestrierungsstrategien (inkl. Einzelmodell-Baselines) + `ailin-auto`-Kaskade | Produktionsgewichte der proprietären Modellfamilie (Trainings-Flywheel gebaut) |
| Discovery-Engine, health-gated Routing, Fallback-Ketten | Erweiterte Benchmark-Kampagne mit vollständig auditierter Kostenrechnung |
| Vollständige Entscheidungs-Provenienz (`ailin_metadata`) | Schritt-für-Schritt-Kampagnenleitfaden für unabhängige Evaluationen |
| Multimodal + deterministische Dateigenerierung (DOCX/XLSX/PDF/PPTX/ZIP/Code) | |
| AGPL-§13-Endpoints (`/source`, `/license`) + Lizenz-Response-Header | |
| Broadcast-Delivery-Pipeline (Code ausgeliefert hinter `BROADCAST_FEATURE_ENABLED`, standardmäßig aus; noch nicht produktionsvalidiert) | |

Ehrlichkeit über Validierung ist ein Feature — alles, was nicht in der
linken Spalte steht, ist in den Docs genauso gelabelt wie hier.

## Mitwirken — kollektive Intelligenz braucht ein Kollektiv

Die These selbst sagt es voraus: Diverse, unabhängige Mitwirkende, gut
koordiniert, bauen etwas, das keine Solo-Anstrengung schaffen kann.
Code-Beiträge sind willkommen unter dem **DCO** (`git commit -s`, siehe
[DCO.md](DCO.md) und [CONTRIBUTING.md](CONTRIBUTING.md)) —
Provider-Adapter (dünne, in sich geschlossene Module),
Strategie-Implementierungen, objektive Task-Checker, Docs auf
[ailin.guide](https://ailin.guide).

Und dieses Projekt hat eine Beitragsfläche, die die meisten Projekte
nicht haben: **Führe den Benchmark selbst aus und veröffentliche das
Ergebnis — egal, wie es ausgeht.** Starte mit
[REPRODUCING_THE_BENCHMARK.md](docs/experiments/REPRODUCING_THE_BENCHMARK.md):
Jede veröffentlichte Tabelle aus den committeten Rohdaten zu
regenerieren dauert etwa zwei Minuten und braucht nur Pythons stdlib.
Jede unabhängige Replikation — validierend oder invalidierend — macht
das Kollektiv klüger. Genau das ist der Punkt.

Fragen und Ergebnisse: [GitHub Discussions](https://github.com/ailinone/collective-intelligence/discussions).
Sicherheitsmeldungen: **niemals** als öffentliches Issue — siehe [SECURITY.md](SECURITY.md).

## Lizenz & Governance

**AGPL-3.0-or-later.** Wer eine modifizierte Version als Netzwerkdienst
betreibt, muss deren Nutzern nach §13 den korrespondierenden Quellcode
anbieten — die Engine liefert die Endpoints `/source` und `/license` aus
und sendet `X-License`-/`X-Source-Code`-Header mit jeder Response, um
die Compliance einfach zu machen (setze `AGPL_SOURCE_URL` so, dass es
auf *deinen* modifizierten Quellcode zeigt). Siehe
[COMPLIANCE.md](COMPLIANCE.md); kommerzielle Lizenzierung:
licensing@ailin.one.

| | |
|---|---|
| Contributor-Sign-off (DCO 1.1) | [DCO.md](DCO.md) |
| Verhaltenskodex (Contributor Covenant 2.1) | [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) |
| Marken („Ailin", „Ailin One", „ailin.one") | [TRADEMARKS.md](TRADEMARKS.md) |
| Release-Provenienz (SLSA/Sigstore + SPDX SBOM) | [release-provenance.yml](.github/workflows/release-provenance.yml) |
| Sicherheitsrichtlinie | [SECURITY.md](SECURITY.md) |
| Changelog (v0.1.0) | [CHANGELOG.md](CHANGELOG.md) |
| Vollständige Dokumentation | [ailin.guide](https://ailin.guide) |

Betreut von **Ailin One, Inc.** Die AGPL lizenziert den Code, nicht die
Marken.

## Star-Historie & Mitwirkende

[![Star History Chart](https://api.star-history.com/svg?repos=ailinone/collective-intelligence&type=Date&legend=top-left)](https://www.star-history.com/?repos=ailinone%2Fcollective-intelligence&type=date&legend=top-left)

<a href="https://github.com/ailinone/collective-intelligence/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=ailinone/collective-intelligence" alt="Contributors" />
</a>

Wenn die These der kollektiven Intelligenz — öffentlich getestet, Belege
im Repo — etwas ist, das es aus deiner Sicht in der Welt geben sollte,
dann ist ein ⭐ die Art, anderen Entwicklerinnen und Entwicklern zu
sagen, dass es ihre zehn Minuten wert ist.
