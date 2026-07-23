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

> 🌐 El inglés es la versión canónica. Esta traducción sigue el commit 596a94e6 — ante la duda, lee el [README en inglés](README.md).

<p align="center">
  <a href="README.md"><img alt="English" src="https://img.shields.io/badge/English-30363d?style=for-the-badge"></a>
  <a href="README.zh-CN.md"><img alt="简体中文" src="https://img.shields.io/badge/%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-30363d?style=for-the-badge"></a>
  <a href="README.pt-BR.md"><img alt="Português (BR)" src="https://img.shields.io/badge/Portugu%C3%AAs%20(BR)-30363d?style=for-the-badge"></a>
  <a href="README.es.md"><img alt="Español" src="https://img.shields.io/badge/Espa%C3%B1ol-1f6feb?style=for-the-badge"></a>
  <a href="README.ja.md"><img alt="日本語" src="https://img.shields.io/badge/%E6%97%A5%E6%9C%AC%E8%AA%9E-30363d?style=for-the-badge"></a>
  <a href="README.ko.md"><img alt="한국어" src="https://img.shields.io/badge/%ED%95%9C%EA%B5%AD%EC%96%B4-30363d?style=for-the-badge"></a>
  <a href="README.fr.md"><img alt="Français" src="https://img.shields.io/badge/Fran%C3%A7ais-30363d?style=for-the-badge"></a>
  <a href="README.de.md"><img alt="Deutsch" src="https://img.shields.io/badge/Deutsch-30363d?style=for-the-badge"></a>
  <a href="README.ru.md"><img alt="Русский" src="https://img.shields.io/badge/%D0%A0%D1%83%D1%81%D1%81%D0%BA%D0%B8%D0%B9-30363d?style=for-the-badge"></a>
</p>

> **TL;DR** — Ailin¹ hace que **76,636 modelos de IA** colaboren dentro de un único modelo colectivo, coordinados mediante **32 estrategias** en lugar de enrutados a uno solo. Diversidad estructurada, razonamiento independiente y procedencia completa de las decisiones en cada solicitud — más confiable, resiliente y auditable que cualquier integración de modelo único, y [probado contra la frontera, en abierto](#probado-contra-la-frontera--en-abierto).
>
> **→ [Inicio rápido](#inicio-rápido) · [Ver la evidencia](#probado-contra-la-frontera--en-abierto) · [Docs](https://ailin.guide)**

**Miles de modelos de IA se coordinan dentro de un único modelo colectivo.**

Diversidad estructurada, razonamiento independiente y procedencia completa
de las decisiones en cada solicitud — todo diseñado para producir salidas
más confiables, más resilientes y más auditables que una integración de
modelo único. Cada día se lanza un nuevo modelo que afirma ser el mejor.
Esta es la capa donde trabajan juntos. Documentación completa:
**[ailin.guide](https://ailin.guide)**.

[![License: AGPL-3.0-or-later](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue)](LICENSE)
[![CI](https://github.com/ailinone/collective-intelligence/actions/workflows/ci.yml/badge.svg)](https://github.com/ailinone/collective-intelligence/actions/workflows/ci.yml)
[![REUSE compliance](https://github.com/ailinone/collective-intelligence/actions/workflows/license-compliance.yml/badge.svg)](https://github.com/ailinone/collective-intelligence/actions/workflows/license-compliance.yml)
[![DCO](https://img.shields.io/badge/DCO-required-brightgreen)](DCO.md)
[![Providers](https://img.shields.io/badge/provider_integrations-~90-8A2BE2)](https://ailin.guide/architecture/provider-ecosystem)
[![Models indexed](https://img.shields.io/badge/models_indexed-76%2C636-blueviolet)](#decenas-de-miles-de-modelos-siempre-en-la-frontera)
[![Strategies](https://img.shields.io/badge/collective_strategies-32_registered-6A5ACD)](#cómo-fluye-una-solicitud)
[![GitHub stars](https://img.shields.io/github/stars/ailinone/collective-intelligence?style=social)](https://github.com/ailinone/collective-intelligence/stargazers)
[![Discussions](https://img.shields.io/badge/discussions-open-2ea44f?logo=github)](https://github.com/ailinone/collective-intelligence/discussions)

[Inicio rápido](#inicio-rápido) · [La próxima frontera](#inteligencia-colectiva-la-próxima-frontera-de-la-ia) ·
[Por qué un colectivo](#por-qué-un-colectivo-supera-al-modelo-individual-más-grande) ·
[La evidencia](#probado-contra-la-frontera--en-abierto) ·
[Siempre en la frontera](#decenas-de-miles-de-modelos-siempre-en-la-frontera) ·
[Cómo funciona](#la-arquitectura-de-un-vistazo) ·
[Contribuir](#contribuir--la-inteligencia-colectiva-necesita-un-colectivo) · [Docs](https://ailin.guide)

---

## Inteligencia Colectiva: la próxima frontera de la IA

La industria de la IA se ha concentrado en construir modelos individuales
cada vez más grandes. Ailin¹ adopta un enfoque complementario: un colectivo
de **76,636 modelos de IA** (conteo de producción en vivo, 2026-07) que
pueden colaborar, debatir, criticar y sintetizar juntos, aplicando
[diversidad estructurada](https://ailin.guide/architecture/cognitive-diversity) a problemas donde un
modelo único es un punto único de entrenamiento, de arquitectura, de sesgo
y de fallo.

**Esto no es enrutamiento multi-modelo. Esto no es un gateway de API. Esto
es Inteligencia Colectiva**: un sistema donde modelos de todas las grandes
arquitecturas — APIs de frontera, retadores de pesos abiertos y nuestra
propia familia de modelos — se coordinan mediante [docenas de estrategias](https://ailin.guide/architecture/strategy-catalog), con el objetivo de lograr mayor
confiabilidad, una cobertura de evaluación más amplia y una auditabilidad
más completa que las que ofrece cualquier integración de modelo único.

El principio se fundamenta en la investigación sobre inteligencia colectiva
y diversidad cognitiva — el resultado de Hong & Page de que «la diversidad
supera a la habilidad» ("diversity trumps ability") y el trabajo de
Woolley et al. sobre desempeño colectivo (ver la
[Bibliografía](https://ailin.guide/reference/bibliography) pública). Ailin¹ aplica
ese principio como plataforma de ingeniería: un motor de descubrimiento que
indexa 76,636 modelos, docenas de estrategias de coordinación, un
[sustrato de auditoría](https://ailin.guide/architecture/collective-intelligence) que
registra cada decisión de coordinación y un pipeline de entrenamiento de
ciclo cerrado. Algunas de estas capas son de grado de producción hoy y
otras aún están madurando — la documentación lleva insignias de estado para
que siempre sepas qué está disponible y qué está en la hoja de ruta.

## Por qué un colectivo supera al modelo individual más grande

Los modelos de frontera siguen creciendo, y el modelo individual más fuerte
de cada momento es extraordinario. Pero un modelo único es siempre un punto
único de entrenamiento, un punto único de arquitectura, un punto único de
fallo y un punto único de sesgo. Un colectivo bien coordinado aborda cada
uno de esos límites estructurales de una forma que la escala por sí sola no
puede.

- **Resiliencia.** Un modelo único significa una dependencia única. Si su
  proveedor está degradado, con throttling, con límites de tasa o con
  precios mal fijados en un día dado, todas las llamadas se ven afectadas.
  El colectivo enruta esquivando caídas de proveedores, modelos degradados
  y fallos locales sin intervención — la solicitud se completa igualmente,
  con procedencia completa
  ([análisis en profundidad de la resiliencia](https://ailin.guide/architecture/why-collective-resilience)).
- **Diversidad de evaluación.** Modelos distintos se entrenan con datos
  distintos y con objetivos distintos. Preguntar a muchos de ellos y
  comparar sus salidas saca a la luz errores y puntos ciegos que un modelo
  único, por grande que sea, repetiría con total confianza. El colectivo
  convierte el desacuerdo en una señal de calidad, no en un bug.
- **Anti-concentración.** Depender de un solo modelo ata a una organización
  a la hoja de ruta, los precios y las decisiones de política de un único
  proveedor. El colectivo desacopla la capacidad de cualquier proveedor
  individual — la plataforma sigue funcionando mientras la frontera se
  desplaza, y mientras proveedores específicos suben, caen o cambian de
  precio.
- **Menos sesgo de punto único.** Cada modelo carga con los sesgos de sus
  datos de entrenamiento, sus patrones de rechazo y sus preferencias de
  estilo. Un colectivo de modelos arquitectónicamente distintos difumina la
  influencia de los puntos ciegos de cualquier modelo individual,
  especialmente en estrategias de arbitraje que exigen convergencia entre
  razonadores independientes.
- **Especialización dinámica.** Ningún modelo único es el mejor en todo.
  Un colectivo puede asignar el especialista adecuado a la tarea adecuada —
  razonamiento intensivo, código intensivo, visión, contexto largo, baja
  latencia — y enrutar cada solicitud hacia modelos que son fuertes
  exactamente donde la tarea exige fuerza.
- **Gobernanza más sólida.** Las cargas de trabajo empresariales necesitan
  decisiones auditables, costos acotados, aislamiento de tenants y fallback
  confiable. Una integración de modelo único deja al integrador la tarea de
  construir esos controles. El colectivo aplica la gobernanza en la capa de
  plataforma: procedencia de decisiones, topes de costo, aislamiento de
  cuotas y aplicación de políticas rigen cada solicitud, cada estrategia,
  cada modelo.

El efecto es acumulativo. No son seis características independientes — son
seis facetas de una única decisión estructural: coordina bien muchos
modelos, y el resultado es más confiable, más gobernable, más duradero — y,
en el conjunto creciente de tareas donde la corrección puede verificarse
objetivamente, **más preciso, de forma medible, que todos los buques
insignia de frontera que probamos** (97% vs 68–82% — los recibos, más
abajo).

## Probado contra la frontera — en abierto

Ponemos la tesis a prueba contra nosotros mismos, públicamente, con
calificación objetiva: jueces fijados (pinned), respuestas verificables por
máquina siempre que la tarea lo permite, y los datos crudos de cada
ejecución versionados en este repositorio
(**[informe completo](reports/experiments/AILIN-COLLECTIVE-FRONTIER-BENCHMARK-2026-07.md)** ·
[CSVs crudos + scripts](reports/experiments/) ·
[regenera tú mismo cada tabla](docs/experiments/REPRODUCING_THE_BENCHMARK.md)).

**✅ Validado — el colectivo supera a todos los buques insignia de frontera
en tareas verificables.** El consenso armado con un verificador
determinista de respuestas obtuvo **97% de precisión objetiva (37/38)**
frente a **68–82%** de GPT-5.5-pro, Claude Opus 4.8, Gemini 3.1 Pro y
Grok 4.3, agregados a lo largo de las tres ejecuciones — y en todas las
ejecuciones, **el verificador nunca seleccionó una respuesta objetivamente
incorrecta**. Un pool de modelos de pesos abiertos por debajo de la
frontera, bien coordinado, respondió mejor que todos los buques insignia en
las mismas tareas
([tabla de posiciones con cada n y cada salvedad, §3](reports/experiments/AILIN-COLLECTIVE-FRONTIER-BENCHMARK-2026-07.md)).

**La frontera actual de la tesis** — medida con honestidad, guiando la hoja
de ruta:

| Eje | Hoy | Qué estamos haciendo al respecto |
|---|---|---|
| Corrección verificable | ✅ **El colectivo gana** (97% vs 68–82%) | Ampliando la cobertura del verificador a más formas de tarea (campaña de tool-calling completada el 2026-07-18) |
| Prosa abierta | Los modelos individuales aún ganan en escritura creativa y refactorización | La selección del decisor separa de forma medible las ejecuciones ganadoras de las perdedoras — una palanca aprendible ([§7](reports/experiments/AILIN-COLLECTIVE-FRONTIER-BENCHMARK-2026-07.md)) |
| Costo | Prima del colectivo tal como quedó registrada — **excepto** el short-circuit del verificador, que la colapsa ~100× cuando se activa ([§5](reports/experiments/AILIN-COLLECTIVE-FRONTIER-BENCHMARK-2026-07.md)) | Ensanchando la ruta del short-circuit; `ailin-auto` usa por defecto la estrategia viable más barata |
| Latencia | Arbitraje multi-ronda, con cada estrategia transmitiendo el progreso en tiempo real desde el primer token | `ailin-auto` reserva las estrategias más profundas para cuando la compuerta de calidad realmente lo exige; el tráfico crítico en latencia se enruta a `single` por diseño |

Cada número anterior está respaldado por los datos crudos de cada
ejecución y por los scripts reproducibles versionados en este
repositorio — ejecuta tú mismo el arnés de experimentos, con tu propia
carga de trabajo, y tómanos la palabra.

## Decenas de miles de modelos, siempre en la frontera

El colectivo Ailin¹ no depende de listas de modelos hardcodeadas ni de
integraciones manuales de proveedores. Un motor de descubrimiento continuo
escanea el ecosistema global de IA y absorbe automáticamente los nuevos
modelos a medida que se lanzan.

El resultado: un colectivo vivo de **76,636 modelos** a través de [~90
integraciones de proveedores](https://ailin.guide/architecture/provider-ecosystem) que se mantiene al día con el ecosistema. Cuando
una fuente descubierta publica un nuevo modelo, el motor de descubrimiento
lo absorbe sin cambios de código, sin configuración y sin downtime.

### Descubrimiento semántico, cero modelos hardcodeados

El motor de descubrimiento escanea docenas de fuentes en paralelo — APIs
nativas de proveedores, hubs de nube, agregadores de modelos, repositorios
de modelos abiertos y endpoints privados de inferencia. Pero las fuentes en
sí no son el punto. Lo que importa es cómo se seleccionan los modelos.

Cada modelo descubierto se analiza, se clasifica y se indexa por
capacidades, perfil de desempeño, precios, ventana de contexto, modalidades
y arquitectura — todo inferido automáticamente, sin mapeo manual ni
configuración. Las rutas pasan por compuertas de salud (health-gated): un
modelo solo se anuncia después de haberse probado vivo.

La selección de modelos es **totalmente semántica**. Cuando llega una
solicitud, el colectivo no elige de una lista estática. Ensambla el equipo
ideal de modelos según los requisitos de la tarea, la estrategia elegida y
el perfil de resultado deseado (máxima calidad, mejor costo-beneficio,
menor costo, respuesta más rápida). Los modelos correctos se eligen en
tiempo real, para cada solicitud individual. Cuando mañana se lance el
«mejor modelo de la historia», el colectivo lo absorberá — no competirá
con él.

### Modelos propios en la misma arena

La familia de modelos `ailin` y su flywheel de entrenamiento son parte del
diseño: checkpoints coordinadores entrenados sobre el propio tráfico de
coordinación del motor, compitiendo en el mismo pool que cualquier modelo
de terceros — sin privilegio de enrutamiento. El sustrato de auditoría que
captura cada decisión de coordinación se entrega hoy; los pesos de
coordinador de producción son el frente en desarrollo
([estado honesto, siempre actualizado](https://ailin.guide)).

### Estrategias colectivas como hipótesis falsables

32 estrategias registradas — consenso con pisos de convergencia, debate
ciego, paneles de expertos, consenso con abogado del diablo, cascada de
costos, best-of-N con verificación objetiva — cada una etiquetada con su
alcanzabilidad honesta (auto-seleccionable / solo-explícita / hoja de
ruta), cada una falsable por el arnés de experimentos de este repo. Las
estrategias se ganan su lugar con evidencia, o lo pierden.

### Multimodalidad + generación determinista de archivos

Generación multimodal — imágenes, audio, video — enrutada por capacidad,
más renderizado determinista de archivos (DOCX, XLSX, PDF, PPTX, ZIP,
código) desde cualquier modelo de chat con salida estructurada, probado en
producción.

### La gobernanza que las empresas realmente necesitan

Procedencia completa de decisiones (`ailin_metadata`: estrategia, modelos,
decisor final, costo por sub-llamada, disenso), `max_cost` por solicitud
aplicado en la admisión, aislamiento arquitectónico de tenants, endpoints
AGPL §13 (`/source`, `/license`) servidos por el propio motor, procedencia
de releases SLSA/Sigstore con SBOM SPDX. El rastro de auditoría que prueba
nuestras afirmaciones es el mismo que gobierna tu tráfico — la gobernanza
como [principio de primera clase](https://ailin.guide/architecture/principles), no como sobrecarga.

## La arquitectura de un vistazo

El sistema, de principio a fin: el descubrimiento alimenta el ensamblaje de
equipos, y todo camino de ejecución converge en el mismo paso de arbitraje
que genera la procedencia:

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

## Cómo fluye una solicitud

Con zoom sobre una sola solicitud — cuál de los tres caminos anteriores
toma, y por qué:

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

El verificador se arma cuando la solicitud declara una respuesta
verificable por máquina vía `ailin_constraints.answer_check`. La cascada es
conservadora — la economía está diseñada para favorecer por defecto la ruta
barata, escalando solo cuando la compuerta de calidad lo exige. Y como la
coordinación no es gratis, la propia documentación del motor te dice sin
rodeos
[cuándo un modelo único es la decisión correcta](docs/use-cases/when-not-to-use-collective.md)
([también en la guía](https://ailin.guide/use-cases/when-not-to-use-collective)) — tráfico de alto volumen y bajo riesgo, SLAs de latencia
estrictos, prosa estilo documentación. La decisión es operativa, no
filosófica.

## Inicio rápido

> Requiere Docker con Compose v2, ~8 GB de RAM libre y los puertos
> 3000/5432/6379 libres. En Windows, ejecuta el bloque siguiente en
> **Git Bash o WSL** (usa un heredoc y `openssl`).

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

Edita `.env` y reemplaza `sk-...` con una clave real (o prescinde de claves
por completo — mira la opción de Ollama más abajo). Después:

```bash
docker compose up -d api postgres redis
docker compose logs -f api    # watch first boot: migrations + discovery, ~1-5 min
curl http://localhost:3000/health
# → {"status":"ok","uptime":…,"version":"0.1.0"}
```

(`coord-serving`, la superficie de serving del coordinador, se construye y
arranca junto con la API — eso es lo esperado.) Crea una cuenta local y
llama al colectivo:

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

¿Sin ninguna clave de API externa? Configura
`OLLAMA_URL=http://host.docker.internal:11434` en `docker/.env` y el motor
arranca en modo degradado auto-hospedado
([docs](docs/hardening/DEGRADED_BOOT_MODE.md)). En Linux nativo, agrega
además `extra_hosts: ["host.docker.internal:host-gateway"]` al servicio api
(o usa la IP de tu bridge). Instalación local completa:
[guía de instalación](docs/getting-started/installation.md). Inicio rápido
con la API hospedada:
[ailin.guide/getting-started/quickstart](https://ailin.guide/getting-started/quickstart).

## Qué se entrega hoy vs. qué está en desarrollo

| Se entrega hoy | En desarrollo |
|---|---|
| API compatible con OpenAI (chat, responses, embeddings, imágenes, archivos) | Pesos de coordinador entrenados (el diseño + el sustrato de auditoría se entregan ya) |
| 32 estrategias de orquestación (incl. líneas base de modelo único) + cascada `ailin-auto` | Pesos de producción de la familia de modelos propia (flywheel de entrenamiento construido) |
| Motor de descubrimiento, enrutamiento con compuertas de salud, cadenas de fallback | Campaña de benchmark ampliada con contabilidad de costos totalmente auditada |
| Procedencia completa de decisiones (`ailin_metadata`) | Guía paso a paso de campañas para evaluaciones independientes |
| Generación multimodal + determinista de archivos (DOCX/XLSX/PDF/PPTX/ZIP/código) | |
| Endpoints AGPL §13 (`/source`, `/license`) + headers de licencia en las respuestas | |
| Pipeline de entrega broadcast (código entregado detrás de `BROADCAST_FEATURE_ENABLED`, desactivado por defecto; aún no validado en producción) | |

La honestidad sobre la validación es una característica — todo lo que no
está en la columna izquierda está etiquetado en la documentación igual que
aquí.

## Contribuir — la inteligencia colectiva necesita un colectivo

La propia tesis lo predice: contribuidores diversos e independientes, bien
coordinados, construyen algo que ningún esfuerzo en solitario puede. Las
contribuciones de código son bienvenidas bajo el **DCO** (`git commit -s`,
ver [DCO.md](DCO.md) y [CONTRIBUTING.md](CONTRIBUTING.md)) — adaptadores de
proveedores (módulos delgados y autocontenidos), implementaciones de
estrategias, verificadores objetivos de tareas, documentación en
[ailin.guide](https://ailin.guide).

Y este proyecto tiene una superficie de contribución que la mayoría de los
proyectos no tiene: **ejecuta el benchmark tú mismo y publica el resultado
— salga como salga.** Empieza por
[REPRODUCING_THE_BENCHMARK.md](docs/experiments/REPRODUCING_THE_BENCHMARK.md):
regenerar cada tabla publicada a partir de los datos crudos versionados
toma unos dos minutos y la stdlib de Python. Cada replicación independiente
— que valide o que invalide — hace más inteligente al colectivo. Ese es
precisamente el punto.

Preguntas y resultados: [GitHub Discussions](https://github.com/ailinone/collective-intelligence/discussions).
Reportes de seguridad: **nunca** en un issue público — ver [SECURITY.md](SECURITY.md).

## Licencia y gobernanza

**AGPL-3.0-or-later.** Si ejecutas una versión modificada como servicio de
red, el §13 exige ofrecer a sus usuarios el código fuente correspondiente —
el motor sirve los endpoints `/source` y `/license` y envía los headers
`X-License`/`X-Source-Code` en cada respuesta para facilitar el
cumplimiento (configura `AGPL_SOURCE_URL` para que apunte a *tu* código
fuente modificado). Ver [COMPLIANCE.md](COMPLIANCE.md); licenciamiento
comercial: licensing@ailin.one.

| | |
|---|---|
| Firma del contribuidor (DCO 1.1) | [DCO.md](DCO.md) |
| Código de conducta (Contributor Covenant 2.1) | [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) |
| Marcas ("Ailin", "Ailin One", "ailin.one") | [TRADEMARKS.md](TRADEMARKS.md) |
| Procedencia de releases (SLSA/Sigstore + SBOM SPDX) | [release-provenance.yml](.github/workflows/release-provenance.yml) |
| Política de seguridad | [SECURITY.md](SECURITY.md) |
| Changelog (v0.1.0) | [CHANGELOG.md](CHANGELOG.md) |
| Documentación completa | [ailin.guide](https://ailin.guide) |

Mantenido por **Ailin One, Inc.** La AGPL licencia el código, no las marcas.

## Historial de estrellas y contribuidores

[![Star History Chart](https://api.star-history.com/svg?repos=ailinone/collective-intelligence&type=Date)](https://star-history.com/#ailinone/collective-intelligence&Date)

<a href="https://github.com/ailinone/collective-intelligence/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=ailinone/collective-intelligence" alt="Contributors" />
</a>

Si la tesis de la inteligencia colectiva — puesta a prueba en abierto, con
los recibos en el repo — es algo que quieres que exista en el mundo, una ⭐
es la forma de decirles a otros desarrolladores que vale sus diez minutos.
</content>
</StructuredOutput>

