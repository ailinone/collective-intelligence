<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Análise de Gap: Teorias de Inteligência Coletiva vs Implementação Real da CI API
## Revisão Completa — 50+ Teorias × 23 Strategies × Dados Parciais (64 execuções)

---

## Dados Parciais do Experiment Definitivo (5cf023a1)

| Arm | n | OK | AvgQ | Obs |
|-----|---|----|------|-----|
| single-model | 30 | 30 | 0.615 | 100% success, quality mediana |
| collective (5 strategies) | 22 | 20 | 0.759 | debate melhor (0.814), war-room pior (0.650) |
| single-budget | 8 | 8 | 0.600 | Budget modelos baseline |
| adaptive | 3 | 2 | 0.900 | Pouco dado, mas collaborative/parallel resolução alta |

**Insight preliminar:** CI real (0.759) supera single Tier 1 (0.615) por +14.4pp neste dataset parcial.

---

# I. FUNDAMENTOS MATEMÁTICOS E LÓGICOS

## 1. Teorema de Arrow
| Aspecto | Status |
|---------|--------|
| **Teoria** | Nenhum sistema de agregação com 3+ alternativas é perfeito |
| **Implementado na API?** | ⚠️ PARCIAL — debate e consensus usam single synthesizer (viola não-ditadura) |
| **O que falta** | Multi-synthesizer com meta-adjudicator. blind-debate mitiga parcialmente (adjudicator independente) |
| **Strategy que endereça** | `blind-debate` (adjudicator vê todas respostas blind), `devil-advocate-consensus` (critic force dissent) |
| **Gap residual** | ❌ Nenhuma strategy usa múltiplos synthesizers + votação entre syntheses |

## 2. Teorema de Gibbard-Satterthwaite
| Aspecto | Status |
|---------|--------|
| **Teoria** | Sistemas de votação são suscetíveis a manipulação estratégica |
| **Implementado?** | ⚠️ PARCIAL — debate sequential permite "sycophancy" (modelo posterior concorda com anterior) |
| **O que falta** | Garantia formal de independência entre votantes |
| **Strategy que endereça** | `blind-debate` (parallel blind = independência), `diversity-ensemble` (providers diferentes) |
| **Gap residual** | ❌ Consensus e debate original ainda vulneráveis. Nenhum mecanismo de detecção de conformismo |

## 3. Lei de Metcalfe
| Aspecto | Status |
|---------|--------|
| **Teoria** | Valor da rede cresce com N² de participantes |
| **Implementado?** | ✅ SIM — API integra 1251 modelos de 15+ providers. Valor cresce com cada provider novo |
| **Gap residual** | ❌ Mas o engine tende a usar poucos modelos budget. A "rede" tem 1251 nodes mas usa ~20 |

## 4. Lei de Reed
| Aspecto | Status |
|---------|--------|
| **Teoria** | Valor de redes com subgrupos cresce exponencialmente |
| **Implementado?** | ❌ NÃO — strategies não formam subgrupos dinâmicos. Não há "specialist teams" que se auto-organizam |
| **O que falta** | Strategy que forma equipes ad-hoc baseadas em capabilities complementares |
| **Nova implementação necessária** | `specialist-team-formation` — engine analisa task, identifica capabilities necessárias, forma subgrupo otimizado |

## 5. Paradoxo de Condorcet
| Aspecto | Status |
|---------|--------|
| **Teoria** | Preferências coletivas podem ser cíclicas |
| **Implementado?** | ❌ NÃO — consensus usa votação simples sem detecção de ciclos |
| **O que falta** | Método de Borda count ou Copeland para detectar/resolver ciclos |
| **Gap residual** | ❌ Se 3 modelos produzem rankings contraditórios (A>B>C, B>C>A, C>A>B), o synthesizer recebe inputs incoerentes |

## 6. Efeito Flynn
| Aspecto | Status |
|---------|--------|
| **Teoria** | Pontuações médias sobem ao longo do tempo |
| **Implementado?** | ⚠️ PARCIAL — Thompson Sampling aprende e melhora decisões ao longo do tempo. MAP-Elites archive preserva melhores configurações |
| **Gap residual** | ❌ Nenhuma métrica de "melhoria ao longo do tempo" é trackeada explicitamente. Falta trending analysis |

## 7. Teoria dos Jogos / Equilíbrio de Nash
| Aspecto | Status |
|---------|--------|
| **Teoria** | Agentes em interdependência convergem para equilíbrio (possivelmente subótimo) |
| **Implementado?** | ❌ NÃO — modelos não são tratados como "jogadores estratégicos". Não há payoff structure |
| **O que falta** | Incentive design: prompts que recompensem diversidade ("your response will be scored HIGHER if it brings unique perspective not covered by others") |
| **Gap residual** | ❌ Nenhum mecanismo anti-equilíbrio-subótimo (todos convergem para resposta "safe") |

## 8. Teorema de May
| Aspecto | Status |
|---------|--------|
| **Teoria** | Regra da maioria é ótima para decisões binárias |
| **Implementado?** | ✅ SIM — `safety-quorum` usa majority vote para decisões safety (binary: allow/refuse) |
| **Gap residual** | ❌ Mas May só se aplica a decisões binárias. Para tasks abertas, consensus usa síntese (não votação) |

## 9. Identidade de Mirkin
| Aspecto | Status |
|---------|--------|
| **Teoria** | Modelar distância entre rankings individuais e consenso do grupo |
| **Implementado?** | ❌ NÃO — nenhuma métrica de distância/disagreement entre respostas dos modelos |
| **O que falta** | Medir disagreement ANTES de sintetizar. Se alto disagreement → escalar mais modelos (dynamic quorum) |
| **Gap residual** | ❌ `adaptive` faz quorum escalation baseado em confidence do bandit, mas não em disagreement real entre respostas |

## 10. Modelo de Cascata de Informação
| Aspecto | Status |
|---------|--------|
| **Teoria** | Agentes ignoram evidências próprias em favor do comportamento do grupo |
| **Implementado?** | ✅ SIM (mitigação) — `blind-debate` preserva independência via parallel blind execution |
| **Gap residual** | ❌ Debate original e collaborative AINDA são sequential — cascade não mitigado nessas strategies |

---

# II. BIOLOGIA E SISTEMAS NATURAIS

## 11. Superorganismo
| Aspecto | Status |
|---------|--------|
| **Teoria** | Colônia age como entidade com inteligência emergente |
| **Implementado?** | ⚠️ PARCIAL — o orchestration engine + 23 strategies + bandit + archive = "superorganismo" computacional |
| **Gap residual** | ❌ Falta feedback loop entre strategies. Debate não aprende com erros de consensus |

## 12. Quorum Sensing
| Aspecto | Status |
|---------|--------|
| **Teoria** | Coordenar resposta quando threshold de sinais atingido |
| **Implementado?** | ✅ SIM — `safety-quorum` (majority vote), adaptive dynamic quorum (escalation) |
| **Gap residual** | ❌ Quorum não é baseado em DISAGREEMENT real entre respostas, apenas em confidence do bandit |

## 13. Trofalaxia
| Aspecto | Status |
|---------|--------|
| **Teoria** | Troca de fluidos e informações em insetos sociais |
| **Implementado?** | ⚠️ PARCIAL — `stigmergic-refinement` implementa passagem de artefatos entre modelos (draft → refine → critique) |
| **Gap residual** | ❌ Troca é unidirecional (A→B→C→D). Não há troca bidirecional (A↔B) como na trofalaxia real |

## 14. Enxameação (Swarm Intelligence)
| Aspecto | Status |
|---------|--------|
| **Teoria** | Comportamento coletivo descentralizado e auto-organizado |
| **Implementado?** | ✅ SIM — `swarm-explore` implementa exploração paralela multi-ângulo com agregação |
| **Gap residual** | ❌ Exploradores não compartilham discoveries em tempo real (apenas no final). Falta "stigmergic workspace" durante exploração |

## 15. Auto-organização
| Aspecto | Status |
|---------|--------|
| **Teoria** | Ordem global emerge de interações locais sem coordenador central |
| **Implementado?** | ❌ NÃO — orchestration engine é coordenador central. Strategies não se auto-organizam |
| **O que falta** | Self-organizing strategy: modelos decidem seus papéis baseados em capabilities, sem assignment central |

## 16. Morfogênese Social
| Aspecto | Status |
|---------|--------|
| **Teoria** | Estruturas sociais surgem e se transformam |
| **Implementado?** | ⚠️ PARCIAL — Thompson Sampling evolui preferências de strategy ao longo do tempo |
| **Gap residual** | ❌ A "estrutura" (quais strategies existem) é fixa. Não há emergência de novas strategies |

## 17. Seleção de Grupo
| Aspecto | Status |
|---------|--------|
| **Teoria** | Evolução atua sobre grupos, não apenas indivíduos |
| **Implementado?** | ⚠️ PARCIAL — bandit avalia strategies (grupos de modelos), não modelos individuais |
| **Gap residual** | ❌ Mas a composição do "grupo" (quais modelos compõem cada strategy) é fixa ou aleatória |

## 18. Hipótese do Cérebro Social
| Aspecto | Status |
|---------|--------|
| **Teoria** | Inteligência evoluiu para gerenciar relações sociais complexas |
| **Implementado?** | ❌ NÃO — modelos não têm "modelo mental" dos outros modelos. Não sabem pontos fortes/fracos uns dos outros |
| **O que falta** | Model profile system: track quais modelos são bons em quê, usar para specialist assignment |

---

# III. PSICOLOGIA E COMPORTAMENTO SOCIAL

## 19. Facilitação Social
| Aspecto | Status |
|---------|--------|
| **Teoria** | Performance melhora quando observado por outros |
| **Implementado?** | ❌ NÃO — nenhum prompt informa modelos que serão revisados |
| **O que falta** | Adicionar ao prompt de strategies coletivas: "Your response will be reviewed by expert peers and scored. Provide your absolute best work." |
| **Implementação necessária** | Prompt enhancement em TODAS collective strategies |

## 20. Inibição Social / Efeito Espectador
| Aspecto | Status |
|---------|--------|
| **Teoria** | Responsabilidade individual reduz em grupos grandes |
| **Implementado?** | ⚠️ PARCIAL — expert-panel agora detecta Social Loafing (effort verification) |
| **Gap residual** | ❌ Detecção é por comprimento de resposta (heurística). Não avalia qualidade individual |

## 21. Groupthink
| Aspecto | Status |
|---------|--------|
| **Teoria** | Desejo de harmonia suprime análise crítica |
| **Implementado?** | ✅ SIM — `devil-advocate-consensus` força dissent explícito |
| **Gap residual** | ❌ Consensus e debate originais NÃO têm mecanismo anti-groupthink |

## 22. Polarização de Grupo
| Aspecto | Status |
|---------|--------|
| **Teoria** | Grupos tendem a decisões mais extremas |
| **Implementado?** | ❌ NÃO — nenhum mecanismo limita rounds de debate nem detecta polarização |
| **O que falta** | Detecção de polarização: se posições divergem mais a cada round (em vez de convergir), parar debate |

## 23. Teoria da Identidade Social
| Aspecto | Status |
|---------|--------|
| **Teoria** | Pertencimento a grupo molda percepção |
| **Implementado?** | ❌ NÃO — modelos não têm "identidade de grupo". Não há team identity |
| **Relevância** | Baixa para LLMs — mais relevante para human-in-the-loop |

## 24. Dilema do Prisioneiro (Coletivo)
| Aspecto | Status |
|---------|--------|
| **Teoria** | Cooperação gera melhor resultado global mas traição individual gera melhor resultado local |
| **Implementado?** | ❌ NÃO — nenhum mecanismo de "cooperação vs traição" entre modelos |
| **Relevância** | Média — modelos não "trapaceiam" conscientemente, mas podem produzir respostas genéricas (low-effort cooperation) |

## 25. Folga Social (Social Loafing)
| Aspecto | Status |
|---------|--------|
| **Teoria** | Indivíduos se esforçam menos em tarefas coletivas |
| **Implementado?** | ✅ SIM — expert-panel detecta respostas curtas vs peers (effort ratio check) |
| **Gap residual** | ❌ Apenas detecta, não CORRIGE. Modelo com resposta curta não é re-executado |

## 26. Modelo de Estágios de Tuckman
| Aspecto | Status |
|---------|--------|
| **Teoria** | Formação → Conflito → Normatização → Desempenho → Dissolução |
| **Implementado?** | ✅ SIM — war-room implementa: Commander(formação) → Specialists(conflito) → Critic(normatização) → Synthesizer(desempenho). stigmergic-refinement similar |
| **Gap residual** | ❌ Falta "Dissolução" — strategies não fazem post-mortem para aprender |

## 27. Teoria da Troca Social
| Aspecto | Status |
|---------|--------|
| **Teoria** | Relações baseadas em custo-benefício |
| **Implementado?** | ✅ SIM — cost-cascade strategy seleciona modelos por custo-benefício |
| **Gap residual** | Nenhum significativo |

## 28. Teoria dos Laços Fracos (Granovetter)
| Aspecto | Status |
|---------|--------|
| **Teoria** | Contatos distantes trazem informação nova |
| **Implementado?** | ✅ SIM — `diversity-ensemble` maximiza cross-provider diversity (laços fracos entre providers) |
| **Gap residual** | ❌ Mas a seleção de diversidade é por PROVIDER, não por ARQUITETURA. Dois modelos Llama de providers diferentes NÃO são "laços fracos" |

---

# IV. GESTÃO E COLABORAÇÃO DIGITAL

## 29. Lei de Linus
| Aspecto | Status |
|---------|--------|
| **Teoria** | "Com olhos suficientes, todos os erros são triviais" |
| **Implementado?** | ✅ SIM — quality-multipass (N revisores), expert-panel (N especialistas), blind-debate (N independentes) |
| **Gap residual** | ❌ Nenhuma strategy tem N>5 revisores. Para code-review/debugging, N=7-10 encontraria mais bugs |

## 30. Arquitetura da Participação
| Aspecto | Status |
|---------|--------|
| **Teoria** | Design que convida à colaboração espontânea |
| **Implementado?** | ⚠️ PARCIAL — API aceita strategy='auto' que permite participação automática de múltiplos modelos |
| **Gap residual** | ❌ Modelos não "escolhem" participar — são designados pelo engine. Falta voluntarismo |

## 31. Crowdsourcing
| Aspecto | Status |
|---------|--------|
| **Teoria** | Obter ideias de grupo grande e aberto |
| **Implementado?** | ✅ SIM — `swarm-explore` explora N ângulos em paralelo. Pool de 1251 modelos |
| **Gap residual** | ❌ Mas tipicamente usa 3-5 modelos, não "crowd" real |

## 32. Mercados de Previsão
| Aspecto | Status |
|---------|--------|
| **Teoria** | Usar apostas para agregar julgamento |
| **Implementado?** | ✅ SIM — Thompson Sampling É um mercado de previsão (strategies ganham/perdem credibilidade) |
| **Gap residual** | ❌ Granularidade é por strategy, não por modelo individual. Model-level credibility tracking não existe |

## 33. Cognição Distribuída
| Aspecto | Status |
|---------|--------|
| **Teoria** | Conhecimento distribuído entre agentes e ferramentas |
| **Implementado?** | ⚠️ PARCIAL — tool calling é suportado. Strategies passam tools para modelos |
| **Gap residual** | ❌ Tool selection não é adaptativa. Engine não decide QUAIS tools cada specialist precisa |

## 34. Sociocracia / Holocracia
| Aspecto | Status |
|---------|--------|
| **Teoria** | Decisão por consentimento, sem hierarquia |
| **Implementado?** | ❌ NÃO — todas strategies têm hierarquia (moderator, synthesizer, commander) |
| **O que falta** | Flat consensus strategy onde nenhum modelo tem papel privilegiado |

---

# V. SOCIOLOGIA E FILOSOFIA

## 35. Noosfera / Cibercultura
| Aspecto | Status |
|---------|--------|
| **Teoria** | Esfera do pensamento humano / catalisador de IC |
| **Implementado?** | ✅ SIM (narrativa) — API orquestra múltiplas "compressões da noosfera" |

## 36. Tragédia dos Comuns
| Aspecto | Status |
|---------|--------|
| **Teoria** | Recursos compartilhados esgotados por interesse individual |
| **Implementado?** | ✅ SIM — budget control (maxBudgetUsd), cost-cascade, adaptive escala compute |
| **Gap residual** | ❌ Budget é global, não per-strategy. War-room pode consumir budget desproporcional |

## 37. Capital Social
| Aspecto | Status |
|---------|--------|
| **Teoria** | Valor das redes de confiança |
| **Implementado?** | ⚠️ PARCIAL — bandit tracks strategy reputation. Model performance tracker exists |
| **Gap residual** | ❌ "Confiança" entre modelos não é tracked. Model A não sabe que Model B é confiável para code tasks |

## 38. Memética
| Aspecto | Status |
|---------|--------|
| **Teoria** | Como unidades de informação se propagam na cultura |
| **Implementado?** | ❌ NÃO — respostas não "propagam" entre execuções. Cada request é independente |
| **O que falta** | Cross-request learning: insights de uma request informam a seguinte (beyond cache) |

---

# VI. GAPS NÃO COBERTOS POR NENHUMA IMPLEMENTAÇÃO

| # | Teoria/Conceito | Gap | Impacto | Implementação Necessária |
|---|-----------------|-----|---------|--------------------------|
| 1 | **Detecção de Disagreement** (Mirkin) | Nenhuma medição de concordância/discordância entre respostas ANTES da síntese | ALTO | Calcular similarity/divergence entre N respostas. Se alta divergência → mais modelos. Se consenso natural → aceitar direto |
| 2 | **Facilitação Social** (prompts) | Modelos não sabem que serão revisados | MÉDIO | Adicionar "Your work will be peer-reviewed" a todos os prompts de collective strategies |
| 3 | **Model Competence Profiles** (Cérebro Social) | Engine não sabe quais modelos são bons em quê especificamente | ALTO | Per-model, per-task-type quality tracking → specialist assignment baseado em dados |
| 4 | **Polarization Detection** | Debate não detecta se posições estão divergindo em vez de convergir | MÉDIO | Medir distância entre posições entre rounds. Se crescendo → stop + synthesize |
| 5 | **Per-Budget Strategy Allocation** (Tragédia dos Comuns) | Budget é global, war-room pode consumir tudo | BAIXO | Budget partitioning por strategy/task type |
| 6 | **Flat Consensus** (Sociocracia) | Todas strategies têm hierarquia | BAIXO | Strategy sem roles privilegiados — pure voting |
| 7 | **Cross-Request Learning** (Memética) | Requests são independentes | ALTO | Session-level context: insights propagam entre requests |
| 8 | **Dynamic Team Formation** (Reed's Law) | Subgrupos são fixos por strategy | MÉDIO | Engine forma equipes ad-hoc por capability match |
| 9 | **Auto-organização** | Coordenação é central | BAIXO (long-term) | Strategies se auto-organizam sem engine central |
| 10 | **Social Loafing Correction** | Detecta mas não corrige | MÉDIO | Re-executar modelo com effort abaixo do threshold com prompt mais assertivo |

---

# VII. RESUMO DE COBERTURA

## Totais por status

| Status | Contagem |
|--------|----------|
| ✅ Implementado e funcional | 15 |
| ⚠️ Parcialmente implementado | 12 |
| ❌ Não implementado | 11 |
| N/A (não aplicável a LLMs) | 2 |

## Top 5 gaps de MAIOR IMPACTO para melhorar CI vs Single:

1. **Model Competence Profiles** — saber quais modelos são bons em quê permite specialist assignment inteligente
2. **Disagreement Detection** — medir concordância permite escalar compute onde há incerteza real
3. **Facilitação Social via Prompts** — informar modelos que serão revisados melhora qualidade individual
4. **Cross-Request Learning** — propagação de insights entre requests cria "memória coletiva"
5. **Social Loafing Correction** — re-executar modelos com baixo esforço garante qualidade mínima de cada participante
