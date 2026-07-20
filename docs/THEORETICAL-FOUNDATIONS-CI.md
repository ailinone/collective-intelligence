<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Fundamentação Teórica da Collective Intelligence
## Mapeamento de Teorias para Arquitetura de Orquestração Multi-Modelo

---

# I. Fundamentos Matemáticos e Teoria da Decisão

## 1. Teorema do Júri de Condorcet (1785)

**Princípio:** Se cada votante (modelo) tem probabilidade >50% de acertar, a probabilidade do grupo acertar converge para 100% conforme o grupo cresce. Se <50%, converge para 0%.

**Implicação para a API:**
- **Consensus strategy** é teoricamente forte quando cada modelo tem competência mínima (>50% chance de resposta correta)
- **Risco:** Se modelos budget têm <50% accuracy em tasks difíceis (reasoning, math), consensus PIORA o resultado — confirmado nos dados experimentais (reasoning: CI 0.635 vs Single 0.910)
- **Hipótese testável:** "Consensus com modelos que individualmente superam 60% accuracy deve superar o melhor single model"
- **Design implication:** A API deveria filtrar modelos por competência mínima ANTES de usar consensus. Modelos com accuracy <50% em determinado task type deveriam ser excluídos do pool de votantes

## 2. Teorema da Diversidade > Habilidade (Scott Page)

**Princípio:** A performance coletiva depende de: `Erro_coletivo = Erro_médio - Diversidade`. Diversidade cognitiva reduz erro coletivo mesmo com agentes individualmente medianos.

**Implicação para a API:**
- **Dado experimental:** CI real (0.908) usa 20+ modelos diversos e supera a média dos singles (0.788). O ganho de orquestração (+38.5% sobre budget singles) é explicável por diversidade, não habilidade
- **Risco:** Se todos os modelos no pool são do mesmo provider/arquitetura (ex: todos Llama variants), a diversidade real é baixa e o ganho desaparece
- **Design implication:** O model selector deveria maximizar diversidade de arquitetura (GPT vs Claude vs Gemini vs Llama vs Qwen) ao compor ensembles, não apenas minimizar custo
- **Nova strategy proposta:** `diversity-ensemble` — seleciona N modelos maximizando distância arquitetural entre eles

## 3. Teorema de Arrow (1951)

**Princípio:** Nenhum sistema de votação com 3+ alternativas satisfaz simultaneamente: unanimidade, independência de alternativas irrelevantes, e não-ditadura. Toda agregação tem trade-offs.

**Implicação para a API:**
- **Consensus e debate** são sistemas de votação/agregação. Arrow garante que nenhum método de síntese é "perfeito"
- **Risco real:** O moderator/synthesizer no debate é um "ditador" — sua síntese pode ignorar pontos válidos dos debatedores. Isso viola o princípio de não-ditadura
- **Design implication:** Usar múltiplos mecanismos de agregação em paralelo (votação + síntese + adjudicação) e compará-los. Não depender de um único synthesizer
- **Hipótese testável:** "Debate com 2 synthesizers independentes + meta-adjudicator produz qualidade superior a debate com 1 synthesizer"

## 4. Paradoxo de Condorcet

**Princípio:** Preferências coletivas podem ser cíclicas (A>B, B>C, C>A) mesmo que individuais sejam transitivas.

**Implicação para a API:**
- Quando 3+ modelos "votam" em abordagens diferentes, o ranking coletivo pode ser intransitivo
- **Risco:** O synthesizer pode receber inputs contraditórios e produzir resposta incoerente
- **Design implication:** Usar mecanismos anti-ciclo (Borda count, Copeland method) em vez de votação simples por maioria

## 5. Teorema de Gibbard-Satterthwaite

**Princípio:** Sistemas de votação são suscetíveis a manipulação estratégica.

**Implicação para a API:**
- Modelos LLM não "manipulam" conscientemente, mas exibem **conformismo** (tendency to agree with previous outputs) que funciona como manipulação involuntária
- **Risco:** Em debate, modelos posteriores podem ser influenciados pelos anteriores (cascata informacional)
- **Design implication:** Garantir independência entre modelos — execução paralela sem ver outputs dos outros. Consolidação apenas na fase de síntese

## 6. Teorema de May (1952)

**Princípio:** A regra da maioria é o único sistema que satisfaz anonimato, neutralidade, monotonia e decisividade para escolhas binárias.

**Implicação para a API:**
- Para tarefas com resposta binária (sim/não, correto/incorreto, seguro/inseguro), votação por maioria simples é matematicamente ótima
- **Design implication:** Usar votação por maioria para guardrails/safety, factual-QA com resposta objetiva. Usar síntese elaborada apenas para tarefas abertas

## 7. Modelo de Cascata de Informação

**Princípio:** Agentes ignoram suas próprias evidências em favor do comportamento observado dos outros, levando a herding behavior.

**Implicação para a API:**
- **Risco REAL e observado:** Em debate, modelos que veem a posição do debatedor anterior tendem a concordar (sycophancy). Isso reduz diversidade efetiva
- **Design implication:** Debate rounds devem ser BLIND — cada modelo argumenta sem ver as posições dos outros. Apenas o moderator vê todos os argumentos
- **Hipótese testável:** "Debate blind (parallel) supera debate sequential em tasks de reasoning"

## 8. Identidade de Mirkin

**Princípio:** Modelagem matemática da distância entre rankings individuais e consenso do grupo.

**Implicação para a API:**
- Quantificar quão "longe" cada modelo está do consenso. Modelos consistentemente outliers podem ser mais valiosos (diversidade) ou ruins (incompetência)
- **Design implication:** Ponderar votos por historical agreement com o grupo — modelos que frequentemente discordam E estão certos devem ter peso maior

---

# II. Teoria dos Jogos

## 9. Equilíbrio de Nash

**Princípio:** Estado onde nenhum jogador melhora unilateralmente mudando de estratégia.

**Implicação para a API:**
- Se modelos são "jogadores" que maximizam seus scores, o equilíbrio pode ser subótimo (todos dão resposta safe/genérica em vez de arriscar resposta inovadora)
- **Design implication:** Criar payoff structures que recompensem diversidade e penalizem conformismo. Ex: bonus para respostas que divergem do consenso E são corretas

## 10. Dilema do Prisioneiro (versão coletiva)

**Princípio:** Cooperação gera melhor resultado global, mas traição individual gera melhor resultado local.

**Implicação para a API:**
- Em expert-panel, um modelo "trapaceiro" que produz resposta genérica rápida (economizando compute) prejudica o coletivo
- **Design implication:** Verificar qualidade de cada subcall individualmente (critic por participante, não só do resultado final). Penalizar respostas de baixo esforço

## 11. Payoff Structures

**Implicação para a API:**
- **Competitive payoff:** Modelos competem — melhor resposta vence (parallel strategy)
- **Cooperative payoff:** Modelos cooperam — resultado coletivo melhor que qualquer individual (consensus, debate)
- **Mixed payoff:** Competição para gerar diversidade, cooperação para sintetizar (war-room: specialists competem, synthesizer coopera)
- **Design implication:** Diferentes tasks requerem diferentes payoff structures. Code-generation = competitive (melhor código vence). Analysis = cooperative (perspectivas complementares)

---

# III. Biologia e Sistemas Naturais

## 12. Estigmergia

**Princípio:** Coordenação indireta via artefatos no ambiente (formigas marcam trilhas com feromônios).

**Implicação para a API:**
- **Já parcialmente implementado:** O semantic cache é uma forma de estigmergia — responses anteriores influenciam decisões futuras
- **Design implication:** Criar "shared workspace" onde modelos depositam artefatos intermediários (planos, código parcial, análises) que outros modelos consultam e refinam
- **Nova strategy proposta:** `stigmergic-refinement` — modelo 1 produz draft, deposita em workspace. Modelo 2 lê e refina. Modelo 3 critica. Sem comunicação direta, apenas via artefatos
- **Vantagem:** Reduz latência de coordenação — não precisa esperar debate rounds

## 13. Superorganismo

**Princípio:** Colônia age como entidade única com inteligência emergente superior à soma das partes.

**Implicação para a API:**
- O sistema de orquestração É o superorganismo — 17 strategies + bandit + archive + Pareto + triage formam um sistema que "pensa" coletivamente
- **Gap:** Falta feedback loop entre strategies. Debate não aprende com os erros de consensus. War-room não herda insights de expert-panel
- **Design implication:** Memory compartilhada entre strategies — performance de cada strategy por task type informando as outras

## 14. Quorum Sensing

**Princípio:** Bactérias coordenam comportamento quando atingem densidade mínima de sinalização.

**Implicação para a API:**
- **Analogia direta:** Escalar compute proporcionalmente à dificuldade. Tasks fáceis = 1 modelo. Tasks difíceis = N modelos quando "confidence signal" está abaixo do threshold
- **Já parcialmente implementado:** Confidence gating (OI-04) escala para refinement pass quando quality < target
- **Design implication:** Adicionar quorum dinâmico — se 3 de 5 modelos dão respostas divergentes (low consensus), escalar para mais modelos automaticamente. Se 5 de 5 concordam, aceitar imediatamente

## 15. Enxameação (Swarm Intelligence)

**Princípio:** Comportamento coletivo descentralizado produz soluções que nenhum indivíduo poderia encontrar.

**Implicação para a API:**
- **Aplicação em robótica:** Drones coordenados para mapeamento. Análogo: modelos coordenados para pesquisa/análise paralela
- **Nova strategy proposta:** `swarm-explore` — N modelos exploram N abordagens diferentes em paralelo (exploration), resultados são agregados (exploitation). Ideal para tasks de pesquisa, análise de cenários, brainstorming

## 16. Auto-organização

**Princípio:** Ordem global emerge de interações locais sem coordenador central.

**Implicação para a API:**
- Atualmente o orchestration engine é um coordenador central (single point of decision)
- **Design implication para futuro:** Strategies que se auto-organizam — cada modelo decide seu papel com base nas capacidades e no contexto, sem assignment central. Mais resiliente e escalável

---

# IV. Psicologia e Comportamento Social

## 17. Groupthink (Janis, 1972)

**Princípio:** Desejo de harmonia suprime análise crítica, levando a decisões ruins.

**Implicação para a API:**
- **Risco REAL:** Consensus strategy pode produzir groupthink — modelos convergem para resposta "safe" que ninguém discorda, mas que é medíocre
- **Evidência experimental:** Consensus (0.804) é inferior a debate (0.908) — debate força desacordo explícito
- **Design implication:** Toda strategy de consenso deve incluir uma fase obrigatória de "devil's advocate" — ao menos 1 modelo forçado a argumentar contra a posição majoritária

## 18. Polarização de Grupo

**Princípio:** Grupos tendem a decisões mais extremas que os indivíduos.

**Implicação para a API:**
- Em debate, modelos podem se polarizar — posições iniciais se radicalizam nos rounds seguintes
- **Design implication:** Limitar debate a 2-3 rounds (mais rounds = mais polarização). Moderator deve explicitamente buscar posições centrais, não extremas

## 19. Facilitação Social

**Princípio:** Performance individual melhora quando observado por outros (para tarefas simples).

**Implicação para a API:**
- Análogo: Modelos que "sabem" que serão revisados por um critic podem produzir output de maior qualidade
- **Design implication:** Informar no prompt que a resposta será revisada por um critic model. Prompt: "Your response will be reviewed and scored by an expert critic. Provide your best work."

## 20. Folga Social (Social Loafing)

**Princípio:** Indivíduos se esforçam menos em tarefas coletivas.

**Implicação para a API:**
- **Risco real:** Em collective com muitos modelos, cada um pode produzir resposta mais curta/superficial se "sabe" que outros também estão respondendo
- **Design implication:** Atribuir responsabilidade individual clara. Em expert-panel, cada modelo tem uma especialização explícita e sabe que é o ÚNICO responsável por aquela perspectiva
- **Verificação:** Medir comprimento e profundidade de respostas em collective (N=1 vs N=3 vs N=5). Se respostas ficam menores com mais modelos, há social loafing

## 21. Teoria dos Laços Fracos (Granovetter)

**Princípio:** Contatos distantes trazem informações mais novas que contatos próximos.

**Implicação para a API:**
- Modelos de providers diferentes (xAI vs Anthropic vs Google vs Meta) são "laços fracos" entre si — cada um treinou em dados/métodos diferentes
- **Design implication:** Priorizar diversidade cross-provider em ensembles. Um ensemble de GPT-5.4 + Claude Opus + Gemini Pro traz mais diversidade que GPT-5.4 + GPT-4o + GPT-3.5

## 22. Modelo de Estágios de Tuckman

**Princípio:** Grupos passam por Formação → Conflito → Normatização → Desempenho → Dissolução.

**Implicação para a API:**
- War-room já implementa isso parcialmente: Commander (formação) → Specialists (conflito/execução) → Critic (conflito) → Synthesizer (desempenho)
- **Design implication:** Estratégias multi-round devem ter fases explícitas com objetivos diferentes em cada fase

---

# V. Inteligência Coletiva e Performance de Grupos

## 23. Sabedoria das Multidões (Surowiecki)

**Princípio:** Multidões são inteligentes quando têm: (1) diversidade de opinião, (2) independência, (3) descentralização, (4) mecanismo de agregação.

**Implicação para a API — verificação das 4 condições:**
1. **Diversidade:** ✅ 20+ modelos de 10+ providers. Parcial — engine tende a selecionar budget models similares
2. **Independência:** ⚠️ Debate sequential viola independência (cascade information). Parallel strategies preservam
3. **Descentralização:** ✅ Modelos rodam em providers diferentes, sem coordenação durante geração
4. **Agregação:** ⚠️ Synthesizer é single-point aggregator. Poderia ser melhorado com múltiplos aggregators

**Design implication:** A condição mais violada é INDEPENDÊNCIA. Priorizar parallel execution em vez de sequential debate. Debate deveria ser "parallel-then-synthesize", não "sequential-turns"

## 24. Fator "c" (Inteligência Coletiva Geral)

**Princípio:** Grupos têm um fator "c" de inteligência geral (análogo ao fator g individual) que prediz performance em tarefas diversas. Depende de: (1) sensibilidade social, (2) distribuição equitativa de participação, (3) proporção de mulheres no grupo.

**Implicação para a API:**
- O análogo computacional: distribuição equitativa de compute/tokens entre modelos (não 1 modelo dominante), diversidade de "perspectivas" (arquiteturas diferentes)
- **Métrica proposta:** "Fator c da API" = correlação entre performance coletiva em diferentes task types. Se CI ganha em code-gen MAS perde em reasoning, o fator c é baixo (não há inteligência coletiva geral)
- **Design implication:** Otimizar para fator c alto = melhoria transversal em TODOS os task types, não apenas nos fáceis

---

# VI. Gestão e Colaboração Digital

## 25. Lei de Linus

**Princípio:** "Com olhos suficientes, todos os bugs são triviais."

**Implicação para a API:**
- **Aplicação direta:** Quality-multipass e parallel-verification. Quanto mais modelos revisam um output, mais erros são detectados
- **Design implication:** Para tasks de code-review e debugging, usar N>3 revisores em paralelo. Erros encontrados por qualquer um deles são incorporados na resposta final

## 26. Produção de Pares Baseada em Comuns

**Princípio:** Colaboração aberta e voluntária (Wikipedia, Linux) produz artefatos de qualidade superior ao controle centralizado.

**Implicação para a API:**
- Analogia: strategies que permitem contribuição incremental de múltiplos modelos (refinement chains) vs strategies com planner central
- **Nova strategy proposta:** `wiki-refinement` — cada modelo edita/melhora o output anterior, sem destruí-lo. Preserva contribuições parciais de cada participante

## 27. Cognição Distribuída

**Princípio:** Conhecimento não está em um agente, mas distribuído entre agentes e ferramentas.

**Implicação para a API:**
- **Já implementado parcialmente:** Tool calling permite que modelos acessem conhecimento externo (search, code execution, file reading)
- **Gap:** Tools são passados para modelos mas não usados adaptativamente. O orchestrator deveria decidir QUAIS tools cada specialist precisa
- **Design implication:** Tool-aware specialist assignment — o decomposer analisa quais tools são necessários e atribui specialists que sabem usar essas tools

## 28. Mercados de Previsão

**Princípio:** Usar apostas para agregar julgamento. Agentes que erram perdem "capital", agentes que acertam ganham.

**Implicação para a API:**
- **Analogia direta com Thompson Sampling:** O bandit é um mercado de previsão — strategies que performam bem ganham "credibilidade" (alpha), as que falham perdem (beta)
- **Design implication:** Extender o bandit para funcionar por subcall — cada modelo dentro de uma strategy deveria ter um peso de credibilidade. Modelos que contribuem positivamente para a qualidade final ganham peso; os que degradam perdem

---

# VII. Sociologia e Filosofia

## 29. Noosfera (Teilhard de Chardin)

**Princípio:** A esfera do pensamento humano como camada evolutiva.

**Implicação para a API:**
- LLMs são compressões estatísticas da noosfera. A API orquestra múltiplas compressões (cada modelo é um recorte diferente da noosfera)
- **Narrativa para o artigo:** "O sistema de orquestração é uma interface para a noosfera computacional — agregando perspectivas de múltiplas compressões do conhecimento humano para produzir inteligência superior a qualquer compressão individual"

## 30. Cibercultura (Pierre Lévy)

**Princípio:** O ciberespaço como catalisador da inteligência coletiva.

**Implicação para a API:**
- A API É o catalisador — transforma chamadas individuais a modelos em inteligência coletiva via orquestração
- **Narrativa para o artigo:** "A tese de Lévy materializada: não é o modelo que é inteligente, é o sistema de conexões entre modelos"

## 31. Tragédia dos Comuns

**Princípio:** Recursos compartilhados são esgotados quando cada agente maximiza interesse próprio.

**Implicação para a API:**
- O "recurso comum" é o budget/compute. Se o orchestrator não controla alocação, strategies gananciosas (war-room com 7 modelos) consomem todo o budget
- **Design implication:** Budget-aware strategy selection — guerra-room só é ativada se o budget permite. Strategies mais baratas para tasks simples

## 32. Capital Social

**Princípio:** O valor das redes de confiança.

**Implicação para a API:**
- **Analogia:** Modelos que consistentemente produzem boas respostas têm "capital social" alto — deveriam ser preferidos em roles críticos (moderator, synthesizer, judge)
- **Design implication:** Usar historical quality data para atribuir roles — modelo com melhor track record vira moderator/synthesizer

---

# VIII. Aplicações Contemporâneas

## 33. IA Generativa como Compressão da Noosfera

**Princípio:** ChatGPT é a compressão estatística de toda inteligência coletiva escrita da humanidade.

**Implicação para a API:**
- Cada modelo é uma compressão diferente (dados, método, foco). Orquestrar múltiplas compressões = acessar mais da noosfera
- **Argumento para CI:** "Um único modelo acessa ~70% da noosfera relevante para uma task. Três modelos diversos acessam ~90%. O ganho marginal de cada modelo adicional decresce, mas diversidade mantém o valor"

## 34. Detecção de Anomalias via Quorum Sensing

**Princípio:** Sensores em rede detectam ameaças via consenso.

**Implicação para a API:**
- **Aplicação direta para guardrails:** Múltiplos modelos avaliam safety independentemente. Se >50% flagram risco, a resposta é bloqueada. Reduz falsos negativos (1 modelo pode errar) E falsos positivos (precisa consenso para bloquear)
- **Nova strategy proposta:** `safety-quorum` — N modelos avaliam safety em paralelo, decisão por maioria

## 35. Crowdsourcing + IA (Foldit pattern)

**Princípio:** Humanos + IA juntos superam cada um separadamente.

**Implicação para a API:**
- Embora a API não tenha human-in-the-loop, o pattern aplica-se: modelos com diferentes "intuições" (arquiteturas) exploram o espaço de soluções enquanto um modelo mais forte (synthesizer) consolida
- **Design implication:** Usar modelos menores/rápidos para exploração divergente e modelo premium para síntese convergente

---

# IX. Hipóteses Testáveis para o Benchmark

Baseado na fundamentação teórica acima, as seguintes hipóteses podem ser testadas no benchmark:

| # | Hipótese | Teoria Base | Como Testar |
|---|----------|-------------|-------------|
| H1 | Consensus com modelos >60% accuracy supera best single | Condorcet | Filtrar modelos por accuracy no warmup, comparar consensus filtered vs unfiltered |
| H2 | Diversidade de provider melhora quality mais que quantidade | Page, Granovetter | Comparar 3 models cross-provider vs 5 models same-provider |
| H3 | Debate blind (parallel) supera debate sequential | Cascade info, Surowiecki | Implementar parallel debate variant, A/B test |
| H4 | Quality degrada com >5 modelos em collective | Folga Social | Medir quality vs N_modelos (1, 3, 5, 7, 9) |
| H5 | CI ganha mais em tasks decomponíveis | Swarm, Stigmergia | Comparar CI vs Single em tasks com/sem decomposição natural |
| H6 | Tasks de revisão/verificação favorecem CI | Lei de Linus | Comparar por task type: code-review, debugging vs code-generation |
| H7 | Devil's advocate melhora consensus | Anti-Groupthink | Implementar consensus com 1 modelo forçado a discordar |
| H8 | Custo-eficiência cresce até N=3 e depois decresce | Rendimentos marginais | Medir Q/$ por N_modelos |
| H9 | Adaptive com bandit diversificado supera adaptive uniform | Thompson Sampling | Comparar bandit com priors informados vs uniform |
| H10 | Safety quorum (N=3 majority) supera single-model safety | Quorum Sensing, May | Tasks de guardrail: comparar N=1 vs N=3 majority |

---

# X. Propostas de Novas Strategies

Baseado na fundamentação teórica:

## 10.1 `diversity-ensemble`
**Base teórica:** Page (Diversidade > Habilidade), Granovetter (Laços Fracos)
**Mecânica:** Seleciona N modelos maximizando distância arquitetural. Execução paralela. Síntese por weighted voting.
**Custo estimado:** 3-5x single
**Cenários ideais:** Analysis, research, factual-QA

## 10.2 `stigmergic-refinement`
**Base teórica:** Estigmergia, Wiki-refinement
**Mecânica:** Modelo 1 → draft. Modelo 2 → refinement (vê draft). Modelo 3 → critique (vê draft + refinement). Modelo 4 → synthesis.
**Custo estimado:** 4x single
**Cenários ideais:** Documentation, technical writing, scientific synthesis

## 10.3 `blind-debate`
**Base teórica:** Anti-cascade, Surowiecki (independência)
**Mecânica:** N modelos respondem em paralelo (blind). Adjudicator vê todas as respostas e sintetiza.
**Custo estimado:** 3-5x single
**Cenários ideais:** Reasoning, adversarial, factual-QA

## 10.4 `safety-quorum`
**Base teórica:** Quorum Sensing, May (votação majoritária)
**Mecânica:** N modelos avaliam safety independentemente. Decisão por maioria.
**Custo estimado:** 2-3x single
**Cenários ideais:** Guardrails, content moderation, adversarial inputs

## 10.5 `swarm-explore`
**Base teórica:** Swarm Intelligence, Exploration-Exploitation
**Mecânica:** N modelos exploram N abordagens em paralelo. Aggregator seleciona top-K e sintetiza.
**Custo estimado:** 5-10x single
**Cenários ideais:** Complex analysis, scenario planning, creative brainstorming

## 10.6 `devil-advocate-consensus`
**Base teórica:** Anti-Groupthink, Polarização
**Mecânica:** N-1 modelos respondem normalmente. 1 modelo é instruído a encontrar falhas/contra-argumentos. Synthesizer incorpora críticas.
**Custo estimado:** 3-4x single
**Cenários ideais:** Strategic decisions, risk analysis, code review

---

# XI. Mapeamento Teoria → Strategy Existente

| Teoria | Strategy Existente | Gap Identificado |
|--------|-------------------|------------------|
| Condorcet | consensus | Sem filtro de competência mínima |
| Page (Diversidade) | collaborative | Seleção de modelos não maximiza diversidade explicitamente |
| Arrow | debate (synthesizer) | Single synthesizer = ditador |
| Cascade de Informação | debate (sequential) | Modelos veem posições anteriores |
| Groupthink | consensus | Sem devil's advocate |
| Folga Social | expert-panel | Sem verificação de esforço individual |
| Estigmergia | quality-multipass | Já usa refinement iterativo, mas sem workspace compartilhado |
| Quorum Sensing | adaptive (confidence gating) | Escala refinement mas não escala N_modelos |
| Lei de Linus | quality-multipass | Apenas 1-2 reviewers, poderia ser N |
| Tuckman | war-room | Já tem fases, mas sem conflito estruturado |
| Payoff Structures | competitive | Competição sem cooperação posterior |
| Capital Social | bandit | Tracks strategy performance, não individual model performance |

---

# XII. Integração com o Artigo Publicável

O artigo deve incluir uma seção "Theoretical Foundations" que:
1. Apresenta as 4 condições de Surowiecki como framework de análise
2. Usa Condorcet para explicar quando consensus funciona vs falha
3. Usa Page para explicar o ganho de orquestração (+38.5%)
4. Usa Arrow e Groupthink para explicar limitações das strategies atuais
5. Usa Swarm/Estigmergia para justificar novas strategies propostas
6. Apresenta as 10 hipóteses testáveis como "future work"
7. Classifica cada strategy existente pela teoria que a sustenta
8. Documenta qual condição teórica cada task type satisfaz ou viola
