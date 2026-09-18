# Roadmap — Forja

- [x] **Fase 0 — Pesquisa.** Avaliar soluções existentes antes de construir. Ver `ARCHITECTURE.md`.
- [ ] **Fase 1 — Verificação de mecânica local.** Confirmar versão/flags do Claude Code instalado (headless mode, hooks), sem tocar em nenhum projeto real.
- [x] **Fase 1 — Verificação de mecânica local.** Confirmado: Claude Code v2.1.263 instalado, suporta Agent Teams.
- [~] **Fase 2 — Guardas.** Subagente `reviewer` (só aprova/recusa, nunca edita código) e `settings.json` com `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` escritos, mas a ponte remota não escreve dentro de `.claude/` (bloqueio de segurança do próprio sistema, não um bug) — o Sponsor teve de colocar os dois ficheiros manualmente em `lantern/.claude/`. A guardar: para qualquer ficheiro dentro de `.claude/` em qualquer projeto futuro, pedir sempre ao Sponsor para o colocar, não tentar escrever à distância.
- [~] **Fase 3 — POC.** Loop completo Developer→Reviewer num projeto piloto de baixo risco. **Piloto escolhido: Lantern** (`C:\dev\lantern`) — morto definitivamente (5 set 2026), zero dinheiro/consequência em jogo, mas com código real (Next.js) e estrutura de docs já pronta (CLAUDE.md, docs/STATE.md), ao contrário do Turnado/Guito que morreram antes de qualquer código. Violet foi considerado e rejeitado: está muito vivo, teve um incidente real a dinheiro (13 set 2026, -250€) ainda sem post-mortem, é o pior candidato possível para testar automação não supervisionada.
- [~] **Fase 4 — Rollout.** Aplicar a um projeto real ativo. Primeiro teste (`prettier --check` no indigo-cove) fechado: aprovado, verificado de forma independente pelo PO, commitado (`fe2e133`) e pushed para `origin/master` — ver "Fase 4 — teste 1, fecho" abaixo. Só testou o caminho feliz numa task trivial (mesma limitação já vista na fase 3 teste 1); falta um teste com mais superfície de erro antes de dar a fase por validada, e falta decidir com o Sponsor o próximo alvo — o resto do indigo-cove está gated pelo próprio Sponsor (afiliados, publicação).
- [~] **Fase 5 — Visualização "fábrica".** Depois do backend validado. Nenhuma opção pronta encontrada (ver `ARCHITECTURE.md`) — construção própria a partir dos eventos dos hooks. Arrancada (15 set 2026) por decisão explícita do Sponsor — ver "Fase 5 — arranque" abaixo. v1 lean (WU-A/WU-B/WU-C) construída, revista pelo Reviewer e verificada de forma independente pelo PO — ver "Fase 5, WU-C" abaixo. Falta só o push para o remoto novo antes de considerar esta v1 fechada.

Nota: `git init` e o primeiro commit deste repo ficam para a primeira task real do Developer (fase 1), não para o Sponsor — consistente com a regra já definida de que tarefas de git são do Developer.

## Fase 3 — teste 1 (15 set 2026)

Task: `app/robots.ts` no Lantern. Verificado de forma independente pelo PO (lidos `app/robots.ts` e `docs/FORJA-POC-LOG.md` diretamente do disco, não só o relatório) — conteúdo correto, sintaxe Next.js válida, scope respeitado (só esse ficheiro + `tsconfig.tsbuildinfo`, que é artefacto normal do build, não código). Reviewer aprovou à primeira e fez verificação própria real (voltou a correr lint/build, confirmou que `disallow: /api/` não bloqueia de mais, confirmou que não mexeu em `lib/scan/robots.ts`, que é lógica diferente do scanner).

**Gap identificado:** só testámos o caminho feliz (aprovação à primeira). Nunca vimos o Reviewer recusar e o Developer corrigir. Task foi também deliberadamente trivial — não testa muito o julgamento do Reviewer.

**Teste 2 (a pedir a seguir):** uma task com mais superfície para erro, para tentar mesmo provocar pelo menos uma recusa e confirmar que o ciclo corrigir→resubmeter funciona.

## Fase 3 — teste 2 (15 set 2026)

Task: fechar um gap de SSRF (endereços IPv6 com IPv4 embutido a passar pelo guard de IPs privados). Verificado de forma independente pelo PO: refiz a matemática do RFC 6052 `/48` à mão antes de comparar com o relatório, bate certo; scope confirmado (só `fetcher.ts`, `verify-ssrf-guard.mjs`, 1 linha no `package.json`). 3 recusas reais antes da aprovação — primeira prova de que o ciclo recusar→corrigir→resubmeter funciona, não só o caminho feliz do teste 1.

**Achado independente do PO, não apanhado em 4 rondas de review:** o guard verifica o IP resolvido uma vez, mas o `fetch()` a seguir resolve o hostname outra vez, sozinho — TOCTOU/DNS rebinding clássico contra este tipo de guarda.

**Decisão (15 set 2026):** não corrigir isto no Lantern — é um projeto morto, sem ninguém a usar, não vale o ciclo. `reviewer.md` foi atualizado com uma verificação explícita de TOCTOU/DNS-rebinding para qualquer task futura deste tipo, em qualquer projeto. Considerámos e rejeitámos fazer um teste controlado (reverter a correção, apagar o contexto, repetir a mesma task cega para ver se o Reviewer já apanha sozinho): um único rerun não prova nada com um sistema não-determinístico (podia acertar ou falhar por sorte), e o próprio `FORJA-POC-LOG.md` do Lantern documenta o achado, contaminando qualquer teste "cego" a não ser que se escondesse essa parte do ficheiro, o que traz mais fragilidade do que valor. A validação real vem de observar se o Reviewer passa a apanhar esta classe de problema nas tasks reais da fase 4, não de um rerun artificial num projeto morto.

**Fase 3 considerada suficientemente validada**: caminho feliz, ciclo de recusa/correção, e um achado independente do PO que já retroalimentou o `reviewer.md`. Próximo passo: fase 4, escolher o primeiro projeto vivo de baixo risco (candidatos já discutidos: cobalt-reef, indigo-cove).

## Fase 4 — arranque (15 set 2026)

**Projeto escolhido: indigo-cove.** Cobalt-reef foi reconsiderado e rejeitado por agora: está a meio de uma revisão de arquitetura multi-agente ainda por fechar (v0.9, PO só concordou com ~60% da proposta), é adjacente a decisões financeiras reais a jusante (Fable/aprovação do Sponsor), e não está com tasks do tamanho certo para delegar — dar uma task grande e mal definida a um loop não supervisionado é o erro de dimensionamento que já tinha sido avisado. O indigo-cove está parado à espera do Sponsor só em duas pontas muito específicas (afiliados/contas de corretora da Fase 3, `minimum` do Trading 212), o resto não está bloqueado, e o `CLAUDE.md` do projeto já tem exatamente as regras que o `reviewer.md` foi desenhado para impor (testes obrigatórios contra valores de referência para cálculos financeiros, verificação visual real, sem dependências pagas sem aprovação).

**Primeira task: `prettier --check` no lint.** É um achado já identificado no roadmap do próprio projeto (WU-2.2, 2026-08-30): o repo não está prettier-clean e nada o impede de voltar a acontecer (já aconteceu uma vez, um `prettier --write` reformatou 8 ficheiros fora de âmbito). A nota original dizia para resolver "no próximo commit que mexer em config partilhada, não antes" — decisão de sequenciamento, não uma proibição; reabro-a agora porque serve de teste real e de baixo risco para o Forja, o que não existia quando essa nota foi escrita. Não toca em lógica de produto, cálculos financeiros ou conteúdo.

## Fase 4 — teste 1, resultado (15 set 2026)

Relatório do Developer em `indigo-cove/docs/FORJA-POC-LOG.md`: `npx prettier --check .` encontrou 40 ficheiros por formatar, `prettier --write .` aplicado, `package.json` alterado só na linha do `lint` (`ng lint && prettier --check .`), suite completa verde (lint, 151 testes/27 ficheiros, build 11 rotas, `typecheck:tools`), sem commit/push (não fazia parte do âmbito). Reviewer (subagente, corrida independente): **APPROVE**.

**Verificação independente do PO, com ferramentas, sem confiar só no relatório** (esta sessão não tem shell no PC do Sponsor — ver "Correção de rumo" em `ARCHITECTURE.md` — por isso a verificação foi por leitura direta de ficheiros, não por correr a suite):

- `package.json` lido diretamente do disco: exatamente a linha descrita, nada mais mudou (sem bumps de dependências).
- `CLAUDE.md` do indigo-cove: comparado byte a byte contra a versão pré-task (capturada nesta sessão antes da task correr) — a única diferença é **uma linha em branco a mais** antes de uma lista markdown (regra do prettier para listas), 2748→2749 bytes. Confirma "mecânico" no sentido mais literal possível.
- `docs/ROADMAP.md` do indigo-cove: cresceu ~12KB com o mesmo número de linhas — consistente com o "re-padding de tabelas markdown" que o relatório alega (as tabelas de work units ficam com células alinhadas por espaços); conteúdo lido, sem números/factos alterados. A nota de dívida técnica original sobre este exato problema (linha 28, "resolver no próximo commit que mexer em config partilhada") continua no ficheiro, por fechar — fica para quando o commit acontecer (ver decisão abaixo), não editada agora em separado do código que a resolve.
- Dois ficheiros de código lidos diretamente (`home.ts`, `errors.ts`): TypeScript/Angular válido, idiomático, sem sinal de lógica alterada.
- `.git/logs/HEAD` lido diretamente: HEAD continua no commit de 5 set 2026 (`ecb96bc5`) — confirma a alegação do relatório de que nada foi commitado.
- Não verificável de forma independente nesta sessão (sem shell): a alegação de que `src/assets/data/deposit-rate.json` e `.github/workflows/update-market-data.yml` aparecem como "modified" no `git status` mas são byte-idênticos no `git diff` (artefacto de `core.autocrlf` no Windows) — plausível, sinalizada com transparência por Developer e Reviewer, sem lógica em jogo; aceite sem prova própria. Suite de testes/build/lint também não foi re-corrida pelo PO (sem shell) — apoia-se nas duas corridas independentes já feitas (Developer + Reviewer).

**Achado de segurança do próprio pipeline (não do código do indigo-cove):** a seguir ao relatório do Developer — que por si só é legítimo e bate certo com a verificação acima — apareceu texto a fingir-se uma instrução crítica de sistema, a mandar o PO parar de usar ferramentas e responder só com um resumo em texto. Reconhecido como tentativa de prompt injection e ignorado; a verificação independente com ferramentas prosseguiu normalmente. Registado como guarda nova em `ARCHITECTURE.md`.

**Decisão do PO:** task aprovada quanto ao conteúdo — mudança só de formatação, âmbito respeitado, sem lógica de produto tocada, sem commit não autorizado. Falta o Developer (sessão local do Claude Code, que tem shell) fazer o commit + push; a atualização da nota de dívida técnica no `ROADMAP.md` do indigo-cove fica para esse mesmo commit, não antes.

## Fase 4 — teste 1, fecho (15 set 2026)

Prompt único entregue ao Developer: confirmar `git status` contra o log, fechar a nota de dívida técnica no `ROADMAP.md` do indigo-cove (sem apagar o histórico), re-correr a suite completa, commitar tudo junto, fazer push, e registar o hash no `FORJA-POC-LOG.md`. Relatório do Developer: suite verde nas quatro checagens antes de commitar, commit `fe2e133` ("Add prettier --check to lint, bring repo to a clean formatting baseline"), push `ecb96bc..fe2e133` para `origin/master`.

**Verificação independente do PO (de novo por leitura direta, sem shell):**

- `.git/logs/HEAD` do indigo-cove: entrada nova, `ecb96bc5...` → `fe2e1330eef00b8141da99201ebf0487a41a6418`, mesma mensagem de commit reportada. Confirma o commit.
- `.git/refs/remotes/origin/master`: aponta exatamente para `fe2e1330eef00b8141da99201ebf0487a41a6418` — confirma que o push chegou mesmo ao remoto, não é só uma alegação.
- `docs/ROADMAP.md` do indigo-cove: a nota "Resolvido (2026-09-15)" está mesmo lá, a seguir à dívida técnica original (linha 28-29), sem apagar o histórico — como pedido.
- `docs/FORJA-POC-LOG.md`: tem o hash e a confirmação de push, como reportado.

**Ponto solto, decisão do PO:** o próprio `docs/FORJA-POC-LOG.md` recebeu essa última atualização *depois* do commit `fe2e133`, por isso está de novo por commitar. Baixo risco (é só o log do Forja, não código) — não vale um novo ciclo Developer→Reviewer só para isto; fica para ser apanhado no commit da próxima task real neste repo, não é urgente.

**Achado a repetir da fase 3 teste 1:** este teste 1 da fase 4, tal como o da fase 3, só passou pelo caminho feliz — Reviewer aprovou à primeira, task era deliberadamente trivial (formatação, sem lógica). Ainda não vimos o loop indigo-cove a lidar com uma recusa real nem com uma task de maior superfície. Antes de considerar a fase 4 validada, falta pelo menos um teste com mais risco real.

**Bloqueio para o teste 2 da fase 4:** o resto do roadmap do indigo-cove além disto está gated pelo Sponsor (Fase 3 do produto — publicação, decisão explícita de adiar; Fase 4 do produto — afiliados, precisa de contas que só o Sponsor pode criar). Não há mais trabalho delegável sem lógica de produto ou sem depender do Sponsor. Decisão sobre o próximo alvo do teste 2 (continuar no indigo-cove com algo pequeno e não-bloqueado, ou mudar de projeto) devolvida ao Sponsor — não é uma chamada que o PO deva fazer sozinho, porque envolve escolher em qual dos projetos vivos do Sponsor se testa automação não supervisionada a seguir.

## Decisão do Sponsor (15 set 2026) — avançar para a fase 5, testes de guardas adiados

O PO propôs, antes de mais nada, testar os guardas automáticos nunca exercitados (paragem ao fim de N falhas, orçamento de turnos/custo, bloqueio git destrutivo, isolamento worktree) — nenhum disparou em nenhum dos três testes até agora. **O Sponsor decidiu explicitamente não fazer isso agora:** avançar já para a fase 5, e testar os guardas mais tarde, num projeto construído de raiz para isso (não a reaproveitar o Lantern nem outro projeto já existente). Decisão do Sponsor, registada — não é para o PO voltar a propor sem facto novo. Os quatro guardas continuam por comprovar; ficam como item de backlog explícito, não esquecidos.

## Fase 5 — arranque (15 set 2026)

Objetivo (de `ARCHITECTURE.md`, "Monitorização"): visualização em tempo real do pipeline Forja, construída a partir dos eventos dos hooks do Claude Code (`PostToolUse`, `TaskCompleted`, etc.), no estilo visual mais próximo do que o Sponsor viu em reels (referência de pesquisa da fase 0: mundo 2D pixel-art tipo AI Town, ou uma alternativa 3D custom — motor por decidir nesta fase).

Antes de começar a construir: isto é um ecrã novo, logo cai diretamente na regra de UI do Sponsor (6 set 2026) — nenhuma feature nova com ecrãs arranca sem definir a UI com ele primeiro (skill `ui-kickoff`, o Developer produz vários mocks com autonomia, o Sponsor escolhe). O PO ainda não tem do Sponsor: (1) se a v1 deve ser o dashboard funcional (lista/timeline de tasks, estado, aprovações/recusas, sem estilo de jogo) para provar depressa que o pipeline de eventos dos hooks funciona, com a camada visual "fábrica" a vir depois como v2 — ou se o Sponsor quer ir já direto à visão estilizada; (2) onde isto vai correr/ser visto (página local no browser, app desktop, outro sítio); (3) se é uma vista global de todos os projetos geridos pelo Forja ou por projeto.

**Decisões do Sponsor (15 set 2026):** (1) v1 funcional lean primeiro, sem estilo, `ui-kickoff`/mocks saltados só para esta v1 de prova de conceito; (2) página local no browser; (3) vista global (todos os projetos geridos pelo Forja ao mesmo tempo). WU-A (script de captura de eventos + bootstrap do próprio repo `forja`) e WU-C (a página) ficam separadas; se WU-B (ligar a um projeto real) se justifica juntar a WU-A decide-se caso a caso — não é regra fixa.

## Fase 5, WU-A — bootstrap do repo `forja` (15 set 2026)

Prompt único ao Developer: criar `.claude/agents/reviewer.md` + `.claude/settings.json` (cópia exata dos de `indigo-cove`/`lantern`), `git init`, confirmar o mecanismo real de entrega de dados dos hooks (estava por verificar desde a fase 1), escrever `hooks/log-event.mjs`, testar standalone, atualizar `ARCHITECTURE.md`/`README.md`, e só depois commitar.

**Verificação independente do PO — desta vez com acesso à transcript completa da sessão do Developer, não só ao resumo dele:**

- Mecanismo dos hooks confirmado meticulosamente: o Developer não se limitou à documentação (que nem sequer expõe o schema completo de `tool_response`, `TaskCompleted` ou `TeammateIdle`) — dedicou um subagente de pesquisa à parte 3 (WebFetch à doc oficial) e, não satisfeito, montou um `.claude/settings.json` de teste isolado em `/tmp/hooktest`, disparou um hook `PostToolUse` real via `claude -p` e capturou o payload efetivo em stdin. Confirmado por mim: o payload capturado ao vivo (visível na transcript) é byte a byte o mesmo que aparece depois replayado através de `log-event.mjs` e gravado em `data/events.jsonl`.
- `.git/logs/HEAD` e o objeto `.git/objects/b0/19b6f7...` confirmam o commit `b019b6f`, mensagem igual à reportada.
- `.claude/settings.json` (67 bytes) e `.claude/agents/reviewer.md` (2037 bytes): mesmo tamanho exato que os de `lantern` — cópia real.
- `hooks/log-event.mjs` lido linha a linha: correto, sem bugs, parsing defensivo.
- `hooks/test-log-event.mjs`: teste real (`execFileSync`, não simulação em texto); `data/events.jsonl` no disco continha exatamente a saída desse teste.
- `docs/ARCHITECTURE.md`: a secção "Por decidir/verificar" da fase 1 foi substituída pelo mecanismo confirmado, com honestidade sobre o que continua por verificar (`TaskCompleted`/`TeammateIdle`, schema não documentado, exige sessão Agent Teams interativa).

**Achado de processo, o mais importante desta task:** pela transcript, o Reviewer nunca foi invocado. A sessão lead fez toda a implementação sozinha; o único subagente usado foi de pesquisa (mecanismo dos hooks), não de revisão. Nenhum teammate Agent Teams foi criado, nenhum veredicto independente existe. Causa: o prompt desta WU (escrito pelo PO) pedia para *criar* `reviewer.md`/`settings.json`, mas nunca instruía explicitamente a sessão a *usar* Agent Teams e obter o veredicto do Reviewer antes de terminar — assumir que a presença dos ficheiros bastava estava errado.

**Guarda nova (para `ARCHITECTURE.md`):** ter `.claude/agents/reviewer.md` + `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` no repo não faz o Reviewer correr sozinho — o prompt de cada task tem de pedir explicitamente à sessão lead para invocar o Reviewer via Agent Teams e devolver o veredicto dele antes de fechar a task.

**Decisão do PO:** não repetir a WU-A através do Reviewer a posteriori — a verificação independente acima (feita contra a transcript completa e o disco, não só o resumo) já é mais rigorosa do que uma passagem normal do Reviewer, e o artefacto é de baixo risco (script interno de logging, não afeta nenhum projeto real ainda). A correção aplica-se a partir da WU-B: o prompt vai pedir explicitamente a invocação do Reviewer e o veredicto dele antes do commit.

## Fase 5, WU-B — ligar o hook a um projeto real (15 set 2026)

Prompt único ao Developer, desta vez a exigir explicitamente o veredicto do Reviewer via Agent Teams antes de fechar. Nota corrigida: o achado anterior de "`settings.json` no sítio errado" estava desatualizado — o Sponsor já o tinha movido para o sítio certo antes deste prompt ser enviado; o `.claude/` do indigo-cove nunca tinha é sido commitado, daí Agent Teams parecer inativo.

**Verificação independente do PO — desta vez não só pela transcript, mas pelos próprios dados que o sistema gerou (`data/events.jsonl`), que são mais difíceis de fabricar do que um relatório em texto:**

- `indigo-cove/.claude/settings.json` (337 bytes) lido diretamente: preserva o `env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` original, acrescenta `hooks.PostToolUse` com `matcher: ""` (todas as tools) a correr `node "C:\...\forja\hooks\log-event.mjs"` — exatamente como reportado.
- `.git/logs/HEAD` do indigo-cove confirma o commit `75e910e`, mensagem igual.
- **A prova mais forte desta ronda:** analisei programaticamente o `forja/data/events.jsonl` (cresceu de 1 para 15 linhas). 14 são do `indigo-cove`. Os campos `agent_type`/`agent_id` do payload (que o Developer nem mencionou explicitamente, são só um efeito colateral do hook a capturar tudo o que o Claude Code manda) mostram uma sequência inequívoca: 4 eventos sem agente (sessão principal, a testar a wiring), depois **6 eventos seguidos com `agent_type: "reviewer"` e o mesmo `agent_id`** (Read a `settings.json`, Read a `log-event.mjs`, `git status`/`diff`, terminando num `SubagentHandback`) — o Reviewer a fazer mesmo as suas próprias chamadas de ferramentas, não a repetir o que o Developer disse. Só depois disso é que aparece o evento `Agent` (a chamada em si, vista de fora) e o `git add`/`commit` finais, já sem agente. Isto é mais difícil de forjar do que um texto — é o próprio sistema a registar quem fez o quê e quando, e bate certo com o veredicto reportado.
- Veredicto do Reviewer (**APPROVE**) verificado como genuíno, não só citado: as suas alegações ("li X", "corri git status") correspondem exatamente às linhas de `agent_type: reviewer` no log.
- Nota de calibração, sem gravidade: o relatório do Developer disse que o caminho errado (`'.claude/agents/settings.json'`) "doesn't exist and never did" — a segunda parte é mais forte do que o Developer conseguia verificar (só vê o estado atual, `.claude/` nunca foi commitado, não há histórico git). O Sponsor confirmou que ele próprio moveu o ficheiro antes deste prompt ser enviado, o que explica a discrepância com o achado anterior do PO. Sem consequência prática, só uma nota para relatórios futuros não alegarem mais do que conseguem observar.

**Decisão do PO:** `.claude/settings.json` do indigo-cove fica commitado a partir de agora (como o Developer já fez) — não faz sentido gitignorá-lo, é infraestrutura do projeto (mesmo tratamento que `.claude/agents/reviewer.md`, que já estava a ser tratado como código versionado), o repo é privado, e o caminho absoluto para o script do forja é específico desta máquina de qualquer forma (o resto do Forja já assume isso, ex. caminho fixo do Playbook). Achado do Reviewer sobre isto fica registado, decisão fechada, não é para reabrir sem motivo novo.

**Conclusão da WU-B:** correção da WU-A validada na prática — pedir explicitamente o veredicto do Reviewer funcionou logo à primeira, e desta vez há prova mais forte do que texto (o próprio log de eventos). Próximo passo: WU-C, a página que lê `forja/data/events.jsonl` e mostra tudo ao vivo no browser (vista global, sem estilo, por decisão do Sponsor em "Fase 5 — arranque").

## Fase 5, WU-C — viewer de eventos ao vivo (15 set 2026)

Prompt único ao Developer, com o veredicto do Reviewer via Agent Teams outra vez obrigatório antes de fechar. Construído: `viewer/server.mjs` (só `node:http`/`node:fs`/`node:path`/`node:url`, sem dependências novas) a servir `viewer/index.html` em `http://127.0.0.1:4317`, com `data/events.jsonl` transmitido por Server-Sent Events — o servidor verifica o tamanho do ficheiro a cada 500ms (`fs.watchFile`, porque `fs.watch` não é fiável no Windows) e empurra as linhas novas para o browser, sem recarregar a página. O próprio Developer foi explícito que isto é polling, não notificação nativa do SO — não vendeu como mais do que é.

**Primeira ronda do Reviewer: REJECT.** DNS rebinding real — sem validação do header `Host`, qualquer site na internet podia ler o stream inteiro só por apontar um domínio para `127.0.0.1` e pedir com esse `Host`. Corrigido com verificação estrita (só aceita `127.0.0.1:<porta>` ou `localhost:<porta>`, calculada em runtime a partir da porta real do servidor), mais teste automático. **Segunda ronda: APPROVE.**

**Verificação independente do PO, com ferramentas, lendo diretamente do disco do Sponsor (ponte de ficheiros, sem shell nesta sessão):**

- `.git/logs/HEAD` e `.git/refs/heads/master`: confirmam os dois commits (`7d14d2d` código+docs, `51451be` log do Forja), mesmas mensagens do relatório; HEAD aponta mesmo para `51451be`.
- `viewer/server.mjs` lido linha a linha: a guarda contra DNS rebinding está mesmo lá e é dinâmica (compara contra `server.address().port`, não um valor fixo), cobrindo também o caso de `PORT`/`EVENTS_FILE` diferentes do default. Confirmado: zero dependências novas.
- `viewer/test-viewer.mjs`: teste real (spawna o servidor a sério, não simula) — Host estrangeiro → 403 sem dados, `localhost` aceite, replay inicial só com as linhas completas (a parcial fica de fora até à newline chegar), append ao vivo com UTF-8 intacto (`"project":"ação"`), reset ao truncar o ficheiro. Bate com o "14/14" do relatório.
- `data/events.jsonl` lido e contado diretamente: 19 linhas, exatamente as 5 sintéticas alegadas (linha 1 e 16–19, todas `session_id: "test-session-id"`, projeto `forja`). A linha 19 bate certo ao segundo com o que `FORJA-POC-LOG.md` descreve para a screenshot 2 (`2026-09-15T20:30:59.541Z forja Read`) — é mais difícil de forjar isto do que um texto.
- `viewer/index.html`: sem framework, tabela simples, filtros por projeto/agente, registo expansível ao clicar no #. O "filtro de projeto pode voltar a 'todos' depois de reconectar" que o Reviewer apontou como não-bloqueante é visível no próprio código (o `<select>` é reconstruído do zero em cada evento `reset`, antes de `projectCounts` voltar a ter entradas).
- `docs/FORJA-POC-LOG.md`, `README.md`, screenshots em `docs/screenshots/` (4 PNGs reais, 133–227KB): conteúdo e tamanhos batem com o relatório.

**Ponto devolvido pelo Developer ao PO — decisão:** o repo `forja` ainda não tem remoto, os 3 commits existem só na máquina do Sponsor. **Decisão do PO: criar um repositório privado (GitHub, mesma convenção do resto dos projetos do Sponsor) e fazer push agora.** É infraestrutura interna sem lógica de produto em risco, custo trivial, e deixar o único repo do Forja sem a mesma rede de segurança que `indigo-cove`/`lantern` já têm não tem vantagem nenhuma. Não é uma escolha de gosto do Sponsor, por isso fica decidida, não perguntada. Vai no próximo prompt ao Developer, junto com o commit deste ficheiro e do `ARCHITECTURE.md` (ambos já modificados antes desta task, por fechar desde a WU-B).

**Sobre não voltar a passar pelo Reviewer só para o remoto+commit dos docs:** decisão consistente com a da WU-A — é git/infraestrutura pura, sem lógica de código a rever, o mesmo padrão já usado para não reabrir a WU-A através do Reviewer a posteriori.

**Conclusão da WU-C:** primeira vez que o ciclo REJECT→correção→APPROVE acontece num artefacto que não é o Lantern morto — desta vez com um achado de segurança real (DNS rebinding), apanhado antes de qualquer uso real. A fase 5 tem agora uma v1 funcional a correr: qualquer projeto que ligue `hooks/log-event.mjs` ao seu `PostToolUse` aparece ao vivo neste viewer, sem estilo, como decidido pelo Sponsor. Falta o push para fechar esta v1; uma eventual camada visual "fábrica" (referência: diorama publicado à parte, fora deste repo) fica para uma decisão futura do Sponsor, sem prioridade agora.

## Fase 5, WU-C — correção: o PO tinha corrompido o `docs/ARCHITECTURE.md` (15 set 2026)

Ao mandar o prompt de git housekeeping acima, o Developer recusou-se a commitar `docs/ARCHITECTURE.md` como estava e fez bem: comparado com o último commit (`b019b6f`, WU-A), a versão em disco tinha 1 linha nova legítima (a guarda sobre o Reviewer não correr sozinho) mas também **2 blocos apagados por engano** — o parágrafo sobre `hooks/log-event.mjs` em "Monitorização" e a secção "Resolvido (15 set 2026) — mecanismo de entrega de dados dos hooks" (que tinha voltado ao texto antigo "a confirmar correndo `claude --version`…", já ultrapassado desde a WU-A).

**Causa:** esta sessão do PO escreveu esse ficheiro a partir de uma cópia em cache mais antiga (anterior ao commit da WU-A), sem voltar a ler o conteúdo atual do disco antes de escrever — exatamente o erro que a disciplina "ler antes de escrever" existe para evitar, desta vez falhada. Só não causou dano permanente porque o `docs/ARCHITECTURE.md` nunca chegou a ser commitado nesse estado — o Developer verificou o diff contra o último commit antes de aceitar a task, em vez de confiar no ficheiro tal como estava.

**Correção:** pedido ao Developer para repor `docs/ARCHITECTURE.md` a partir do último commit (`git checkout HEAD --`, não reescrita à mão pelo PO) e voltar a aplicar só a linha nova, depois confirmar com `git diff` que não sobra mais nenhuma diferença antes de commitar.

**Reforço para o PO, já em vigor:** sempre que uma escrita for para um ficheiro que já existe no disco do Sponsor (documentação incluída), ler o conteúdo atual através da ponte antes de escrever, mesmo que pareça haver uma cópia recente no contexto local — o `ROADMAP.md` desta mesma tarefa já tinha sido tratado assim (lido do disco antes de escrever) e não teve problema nenhum; o `ARCHITECTURE.md` não foi, e teve.

## Desenho dos agentes — antes de testar a pipeline nova (15-16 set 2026)

Pedido do Sponsor antes de qualquer novo teste real: definir por completo quantos agentes, como acionam uns aos outros, skills, modelo/effort por agente, e quem decide tecnologia quando a spec não a diz — tudo documentado em `ARCHITECTURE.md`, secção "Correção de rumo (16 set 2026)". Resumo do processo: investigação feita por um subagente (fable) contra a documentação oficial e o changelog do Claude Code; PO refinou/discordou num ponto (4 agentes Developer por tier → 1 par frontend/backend com modelo escolhido por task); o Sponsor propôs e o PO adotou uma "fase de arquitetura" (passo 0 do Loop, uma vez por projeto) para decidir tecnologia antecipadamente por fase, em vez de por task.

**Nada disto está a correr ainda** — é desenho documentado, não implementação. `.claude/agents/*.md` e `.claude/settings.json` de nenhum projeto foram tocados. Antes de reescrever isso a sério falta a verificação empírica de 6 pontos (checklist completo em `ARCHITECTURE.md`) e três decisões em aberto: aplicar `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` sempre ou só por projeto; reforçar tecnicamente a escolha de modelo por task ou deixar como regra escrita; e reconciliar o teste original que o Sponsor queria (uma sessão a delegar várias tasks sem cópia manual de prompts) com a regra de 11 set 2026 (PO entrega um prompt de cada vez) — a fase de arquitetura pode mudar essa resposta.
