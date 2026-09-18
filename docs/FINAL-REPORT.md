# Forja — relatório final da sessão de hardening (16–17 set 2026)

Escrito pelo Lead da sessão para o Sponsor. A Parte A é para ler sem saber programar e tem o tutorial dos teus dois projetos; a Parte B é técnica; a Parte C lista o que só tu podes mudar fora do repositório. Tudo o que aqui está tem evidência em `docs/FORJA-POC-LOG.md` (o diário da sessão), em `docs/dogfood/` e `docs/screenshots/` (imagens) e em `git log` (46 commits desde as 14:00 de 16 set).

---

## Parte A — o que tens agora, em linguagem corrente

### A1. O Forja em três frases

O Forja pega num objetivo escrito por ti («faz X neste projeto»), monta uma equipa de agentes do Claude Code com papéis fixos, e leva o trabalho de ponta a ponta — plano, construção, revisão independente de cada passo, validação final e relatório — sem precisar que decidas o rumo a meio. Acompanhas tudo pelo telemóvel (uma página com os dez papéis, o que cada um está a fazer e há quanto tempo, e um botão para arrancar um run novo) e só és chamado por notificação quando algo precisa mesmo de ti, e mesmo aí o Forja já aplicou a escolha mais segura e continuou. O estado de um run vive sempre em ficheiros no projeto, nunca na memória de uma conversa: fechar o terminal, bater num limite de utilização ou reiniciar o PC não perde nada.

### A2. O que mudou nesta sessão

- **Dez papéis com nomes claros, em inglês.** Núcleo (em todos os runs): Lead, Architect, Frontend Dev, Backend Dev, Reviewer. A pedido (acordam por gatilho, ficam visíveis como «inativo» até lá): Product Manager, Product Designer, Technology Scout, QA, Security Reviewer. Os nomes de forja (Ferreiro, Bigorna…) desapareceram por decisão tua.
- **Runner: o modo sem humano.** Um comando (`forja runner`) arranca uma sessão nova do Claude Code por fase — plano, uma task de cada vez, fecho — e cada sessão lê tudo do disco. Aguenta os limites de utilização (põe o run «em pausa», avisa-te uma vez, espera pela hora e retoma sozinho), mata sessões que se penduram, não deixa dois runners no mesmo projeto, e para quando o Claude Code não arranca em vez de queimar tentativas. É também a resposta à tua pergunta sobre o «handover do orquestrador»: em vez de uma conversa gigante que se passa a si própria, cada fase é uma conversa nova e curta.
- **Níveis de modelos e effort** (pedido teu): **máximo**, **alto** e **económico**, escolhidos por run (`--models`) ou fixados por projeto (`forja models set`). O nível decide o modelo de cada papel e quanto cada sessão «pensa». Em nenhum nível se revê trabalho com um modelo mais fraco do que o que o fez.
- **A tua política de modelos, numa fonte só:** Lead em Opus; Architect em Fable só no plano (Opus se o Fable acabar); Devs nunca em Fable — Sonnet em tasks fáceis ou médias, Opus em difíceis e a partir da segunda tentativa; Reviewer sempre Opus; Product Manager, Product Designer, Technology Scout, QA e Security Reviewer em Opus; ferramentas nativas em Sonnet. Há uma verificação automática (`npm run check`) que impede cópias desencontradas desta tabela.
- **Viewer novo (direção «Oficina»)**, desktop e telemóvel: cena da forja, dez cartões, estado «em pausa», fila de perguntas com campo de resposta, estatística por papel (tempo ligado, sessões, modelo), nível de modelos do run, e a secção **«Novo run»** para arrancar ou relançar um run a partir do telemóvel.
- **Entrada segura no telemóvel:** o link que chega por notificação já não leva o token; colas o token uma vez numa página de entrada e fica guardado nesse telemóvel. O token deixou de aparecer em qualquer saída de comandos ou registo.
- **Perfil de produto e decisões de tecnologia** escritos no arranque de cada run (`docs/forja/PRODUCT-PROFILE.md` pelo Product Manager, `docs/forja/TECHNOLOGY.md` pelo Technology Scout) — é contra eles que todos os agentes fazem trade-offs, e nenhum Dev mete uma tecnologia nova sem decisão registada.
- **Menos tokens por run:** os relatórios de cada task ficam em ficheiros (os agentes recebem um caminho, não páginas de texto), cada task lê só a secção de tecnologia que lhe interessa, e o tempo por task cresce 60 % nas tasks difíceis (a revisão estava a ser cortada a meio pelo relógio).

### A3. Como arrancar um run (o comando exato)

Tudo está em `docs/RUNBOOK-UNATTENDED.md`. O essencial:

1. Uma vez por projeto: na pasta do Forja, `node bin\forja.mjs bootstrap "C:\caminho\do\projeto"` e um commit. **Para o Juniper Hill e o Violet isto já está feito** (ver A3b).
2. Para arrancar pelo PC: um terminal **na pasta do projeto** e

```text
node C:\dev\forja\bin\forja.mjs runner --goal "o que queres que fique feito, em uma a três frases"
```

   Opcional: `--models alto` ou `--models económico` no fim. Deixa o terminal aberto (minimizado). Recebes «Forja: run começou em <projeto>» e podes ir-te embora. Se o terminal se fechar, o mesmo comando **sem** `--goal` retoma o run do disco.

3. **Para arrancar pelo telemóvel:** abre o viewer, secção «Novo run», escolhe o projeto, cola o objetivo, «Arrancar» e confirma. O runner arranca no PC sozinho.

Para retomar **esta** sessão de trabalho no Forja (não um run de projeto), o prompt exato é `continue from docs/FORJA-POC-LOG.md`, numa sessão aberta na pasta do Forja; se o Fable tiver acabado, `claude --model opus` e o mesmo prompt.

### A3b. Tutorial: os teus dois projetos, pelo telemóvel

O bootstrap dos dois já está feito e commitado, com autorização do Sponsor: cada um tem o elenco, as skills, o hook e a pasta `docs\forja\`, e os dois aparecem no menu «Novo run». O PC só tem de estar ligado com o viewer e o túnel a correr (arrancam no login se instalaste o `autostart`; senão, `node C:\dev\forja\bin\forja.mjs up` numa janela PowerShell na pasta do Forja).

**Níveis e effort (já decididos):**

| Projeto | Nível | Onde está | Effort por sessão |
|---|---|---|---|
| Juniper Hill | **alto** | `docs\forja\SETTINGS.json` do projeto (fixado por mim) | plano e fecho `high`; tasks difíceis `high`; fáceis e médias `medium` |
| Violet Pier | **máximo** (por omissão) | sem ficheiro | plano e fecho `max`; tasks difíceis `high`; fáceis e médias `medium` |

Em «máximo» o Architect planeia em Fable (Opus depois de um fallback) e todos os papéis de revisão e apoio correm em Opus. Em «alto» o Architect planeia em Opus, Reviewer, Security Reviewer, Product Manager e Product Designer ficam em Opus, e o QA e o Technology Scout correm em Sonnet (é onde o nível poupa). Devs nunca em Fable em nenhum nível. Não há nada a escolher no telemóvel.

**Projeto 1 — Juniper Hill** (`C:\dev\juniper-hill`; plano em `docs/BLUEPRINT.md`, pontuação e próxima unidade em `docs/PROGRESS.md`, registo em `docs/STATE.md`):

1. Abre o viewer no telemóvel (o endereço chega por ntfy quando o PC arranca; se pedir o token, cola o que guardaste — está em `C:\dev\forja\data\viewer-token.txt` no PC).
2. Desce até «Novo run». Em **Projeto**, escolhe `juniper-hill`.
3. Em **Objetivo**, cola:

   > <objetivo do projeto — omitido na versão pública>

4. **Arrancar** e confirmar no segundo toque. O selo «run a arrancar» dá lugar ao run em segundos. Se aparecer «o runner não arrancou — vê o computador», o motivo está em `data\runner\runner.log` no PC.
5. A partir daí só recebes ntfy: pergunta na fila (respondes na mesma página), pausa por limite (retoma sozinho), run terminado.

**Projeto 2 — Violet Pier** (`C:\dev\violet-pier`):

1. Na mesma secção, em **Projeto** escolhe `violet-pier`.
2. Em **Objetivo**, cola:

   > <objetivo do projeto — omitido na versão pública>

3. **Arrancar** e confirmar. Atenção: o Violet tem **84 ficheiros por commitar**; o primeiro checkpoint do runner commita-os junto com o trabalho dele. Se não quiseres isso, faz tu o commit antes de arrancar. No CLAUDE.md há duas coisas por commitar: as tuas regras novas do overlay (thread do manager, janelas em pool, capabilities) e o bloco `<!-- forja:begin -->` que o bootstrap acrescentou.

**Os dois ao mesmo tempo?** Podem (cada um tem o seu runner e o seu lock), mas partilham a quota: se um bater no limite, ambos pausam e retomam sozinhos. Se preferires um de cada vez, arranca o Violet primeiro (nível máximo, o mais longo).

**Se preferires o PC:** numa janela PowerShell, `cd` para a pasta do projeto e `node C:\dev\forja\bin\forja.mjs runner --goal "<o objetivo acima>"`. O nível vem do projeto.

**O que vais ver:** as duas primeiras sessões de cada run são o Product Manager (perfil, perguntas com default), o Technology Scout (inventário e decisões) e o Architect (plano em tasks com complexidade). Depois, uma sessão por task: Dev → Reviewer → Security Reviewer quando toca em auth, rede ou dependências → checkpoint em git. No fim, QA valida o todo, o Product Manager escreve o relatório do run em `docs\forja\` do projeto, e recebes «run terminado».

### A4. O que vais ver no telemóvel

Dez linhas — primeiro os cinco de núcleo, depois os cinco «a pedido» — cada uma com o estado em palavras (a trabalhar · à espera de review · bloqueado · precisa do Sponsor · sem resposta · morto · terminado · falhou · inativo · em pausa), há quanto tempo, em quê, e «ligado: 1 h 12 min · 3 sessões · opus». No cabeçalho, o piso de modelos e o nível do run («modelos alto»). Por baixo, as tasks, a secção «Novo run», a fila «precisa do Sponsor» (com o default que o Forja já aplicou e um campo para responderes) e a linha do tempo. A tabela das notificações e do que fazer com cada uma está no runbook §4; os cenários do telemóvel no §9.

### A5. O que foi testado a sério (dogfoods)

**Dogfood 1** (sessão interativa, projeto de exemplo `examples/sample-project`, run `R-20260916-8a30`): objetivo em três partes, quatro tasks aprovadas e commitadas, uma bloqueada de propósito. Três falhas injetadas: um subagente morto a meio (o viewer mostrou-o; a task foi refeita e aprovada), uma permissão recusada (a task ficou bloqueada e recebeste a notificação), e uma pergunta só-para-o-Sponsor (foi para a fila com default, respondeste pelo telemóvel, a resposta foi recolhida). Relatório do run em `examples/sample-project/docs/forja/REPORT-2026-09-16.md`.

**Dogfood 2** (runner, mesmo projeto, run `R-20260916-ae6a`, arrancado às 22:21 locais): objetivo desenhado para acordar os cinco papéis a pedido, com um limite de utilização simulado na segunda task e um runner morto à força a meio da primeira. Respondeste «Sim» à pergunta Q3 pelo telemóvel para testar o caminho. O que aconteceu: o plano saiu com oito tasks e complexidade; o crash foi recuperado sem humano (a task reabriu em Opus na 2.ª tentativa); a pausa por limite retomou sozinha sem gastar tentativa; Product Manager, Technology Scout, Security Reviewer e Product Designer acordaram pelos gatilhos certos; as oito tasks fechadas e commitadas (T6 à terceira); o QA no fecho fez um teste de ponta a ponta contra o servidor real e **chumbou o conjunto com dois achados**, o Architect abriu duas tasks novas e o runner continuou sozinho — à hora deste relatório está a trabalhar nelas e vai fechar o run por si. **Defeito real apanhado:** com `--max-task-minutes 25`, a sessão de plano e duas tasks (T4, T6) bateram no relógio com o trabalho a meio — T6 duas vezes — e perderam uma tentativa cada — corrigido nesta sessão (tasks difíceis têm agora 60 % mais tempo; o valor por omissão é 45 min, 72 para difíceis). Detalhe em B5.

### A6. Estatísticas por agente

Tempo ligado e sessões medidos pelo viewer a partir do stream de eventos (`node tools/stats.mjs --run <id>`; «sem modelo registado» = o Claude Code não devolveu o modelo dessa instância).

**Dogfood 2 (run `R-20260916-ae6a`, medido às 03:05 locais, com o run ainda a correr na T9)** — atenção: o runner arrancou a partir da minha sessão interativa antes da correção que limpa o id de sessão, por isso o viewer **fundiu os subagentes da sessão interativa** (Devs, Reviewers e Security Reviewers das tasks T-SEC-1, T-IMP-1, T-UI-5 e o Reviewer deste relatório) com este run. A coluna «só runner» vem do registo do runner (`data/runner/runner.log`: 2 sessões do primeiro processo antes do crash simulado + 14 do processo relançado = 16 sessões `claude -p` até à medição; `RUN.json` lista 16 ids, um dos quais é o da minha sessão interativa — a contaminação descrita acima) e dos veredictos em `TASKS.json`:

| Papel | Modelo(s) no viewer | Tempo ligado (fundido) | Sessões (fundido) | Só runner |
|---|---|---|---|---|
| Lead | opus | 4 h 42 min | 16 | 16 sessões `claude -p` em Opus até à medição (plano, T1–T8 com repetições, fecho, T9) |
| Architect | fable | 14 min | 2 | plano + reabertura pelo QA |
| Frontend Dev | sonnet 31 min, opus 7 min, sem modelo 20 min | 1 h 03 min | 10 | T4 (Sonnet, depois Opus na 2.ª), T5 (Sonnet) |
| Backend Dev | opus, sonnet | 2 h 18 min | 20 | T1 (Opus, 2 tentativas), T2 (Opus), T3, T7 e T8 (Sonnet), T6 (Opus, 3 tentativas), T9 (Opus) |
| Reviewer | opus | 3 h 17 min | 35 | um por tentativa de task, sempre Opus |
| Product Manager (a pedido) | opus | 6 min | 1 | arranque + Q3 |
| Product Designer (a pedido) | opus | 23 min | 3 | T4 (página nova sem DESIGN) |
| Technology Scout (a pedido) | opus | 5 min | 1 | arranque |
| QA (a pedido) | opus | 25 min | 2 | fecho (QA FAIL com 2 achados → T9, T10) |
| Security Reviewer (a pedido) | opus | 56 min | 12 | T1, T2, T6 |

**Esta sessão de hardening (o meu trabalho de orquestração, 14:00 de 16 set até ao fecho):** Lead em Fable 5.1, com effort `max` até à mudança do Sponsor para `high` a meio da sessão. Tasks de implementação com Devs separados e revisão independente de cada uma: fases 0–4 (auditoria, redesenho, pipeline de eventos, viewer, resiliência), T-OPS-1, T-UI-1 a T-UI-5, R-10 (dez papéis + runner), T-API-1, T-MODELS-1, T-SEC-1 e T-IMP-1 — as rondas de revisão de cada uma estão em B3. Devs em Fable até à regra de modelos do Sponsor (a meio da sessão), depois Opus para difíceis e Sonnet para médias; Reviewers em Fable até essa regra, Opus depois; Security Reviewer em Opus (T-API-1, T-SEC-1 três vezes). Baseline medida pela análise de melhorias: o Reviewer gastou mais tempo ligado do que os Devs (2 h 12 contra 1 h 32 à data da medição), e cada run tinha cerca de 473 mil tokens de preâmbulo fixo — foi isso que a passagem final atacou.

### A7. O que ainda depende de ti (todos os itens do `docs/SPONSOR-ROADMAP.md`)

1. **Auto-continuar em limite de utilização** nas sessões interativas — **feito pelo Lead, com autorização explícita do Sponsor** (`autoContinueAtUsageLimit: true`; cópia de segurança em `settings.json.bak-forja-20260917`). O runner não precisa disto.
2. **Tailscale** para um endereço fixo e privado do viewer no telemóvel (15 minutos, PC + telemóvel). Até lá o túnel gratuito funciona; o endereço muda a cada arranque e o token pede-se uma vez por endereço.
3. **Apagar a skill antiga** `%USERPROFILE%\.claude\skills\forja-architect` (1 minuto).
4. **Effort `high` em vez de `max`** nas sessões interativas — **feito pelo Lead, com autorização explícita do Sponsor** (`"effortLevel": "high"`).
5. **Rodar o token do viewer uma vez** (2 minutos): até 17 set 2026 o viewer imprimia o endereço com o token no arranque e o hook gravava essa linha em `data\events.jsonl`; o Security Reviewer encontrou-o lá. A impressão foi corrigida; o token não foi rodado nessa altura porque tinha acabado de ser configurado no telemóvel. Passos: `node C:\dev\forja\bin\forja.mjs token rotate`, depois `down` e `up`, e colar o token novo no telemóvel.

Notas sem ação: o binário `cloudflared` está dentro do repo (`tools/cloudflared/`, ignorado pelo git) para o túnel gratuito sem conta; o atalho de arranque automático está na tua pasta Arranque.

### A8. Limites honestos

- A sessão interativa do Claude Code (como esta) não se transfere sozinha para uma sessão nova: o que existe é o checkpoint em disco + `continue from docs/FORJA-POC-LOG.md` numa sessão nova, ou o runner desde o início. Um contexto novo não repõe o limite de utilização da conta.
- O runner corre em modo automático de permissões com uma lista de comandos proibidos: o que o classificador recusaria fica recusado e a task vai para a tua fila. Um comando destrutivo escrito de forma inesperada pode passar pela lista; a última guarda é a regra do elenco e a revisão.
- Uma task que falha três vezes fecha e o run segue; uma sessão que se pendura é morta ao fim do limite de tempo (45 min por task, 72 nas difíceis, 90 no plano e no fecho).
- O limite semanal de utilização não se testa a pedido: a pausa foi validada com a mensagem simulada e com o parser das horas reais.
- O menu «Novo run» ainda não escolhe o nível de modelos (usa o do projeto ou o máximo) nem prepara projetos novos: isso continua a ser um comando no PC (`bootstrap`). Ficou decidido e desenhado, não construído.
- Num run cheio (pergunta aberta + detalhe longo) o subtítulo do cabeçalho do viewer passa a duas linhas por causa do item «modelos»; nit aberto para o Product Designer.

---

## Parte B — técnica

### B1. Arquitetura (fonte de verdade: `docs/ARCHITECTURE.md`)

- §2 elenco de dez com ferramentas e ficheiro por papel (coluna Modelo aponta para §6); §2b tabela de gatilhos determinística (Product Manager no arranque/pergunta/fecho; Technology Scout no arranque e por capacidade em falta; Product Designer por ecrã sem `DESIGN.md`; Security Reviewer depois do `APPROVE` quando a task toca auth/segredos/rede/dependências/input externo; QA no fecho); prefixos das descrições `P· S· D· X· V· R· Q· T<n>·` que o viewer emparelha.
- §3b runner: uma sessão `claude -p --model <por nível> --effort <por nível/complexidade/tentativa> --permission-mode auto --disallowedTools …` por fase; estado mínimo de continuação em `docs/forja/` (`RUN.json` com `model_level`, `TASKS.json` com `complexity`, `DECISIONS.md`, `SPONSOR-QUEUE.md` + `answers`, `PRODUCT-PROFILE.md`, `TECHNOLOGY.md` com tabela de decisões no topo, `HANDOVER.md`, `reports/T<id>-a<n>-{dev,review}.md`) + `git status`; propriedade (lock por projeto com pid verificado pela linha de comando e batimento a cada minuto), fronteira segura (task `doing`/`review` de uma sessão morta: tentativa falhada em timeout/crash, devolvida sem gastar tentativa em pausa por limite), guarda de arranque (duas sessões sem progresso → sair, run resumível), pausas com hora lida da mensagem e espera de segurança, ciclo limitado, `taskMinutesFor` (hard ×1,6), QA a reabrir o run.
- §6 política de modelos e effort por nível — **fonte: `lib/models.mjs`** (`modelsFor`, `devModelFor`, `effortFor`, `policyText`); `npm run check` falha se aparecer uma cópia da política noutro ficheiro.
- §7b registo de projetos (`data/projects.json`, escrito só pelo `bootstrap`; entradas cuja pasta desapareceu ficam escondidas; `forja projects list|prune`); §9 API do viewer (`GET /projects`, `POST /runs`, `POST /login`, `POST /answers`); §10 túnel e notificações (`sanitizeClick`: o Click nunca leva query, fragmento ou userinfo); §11 autenticação (token em `data/viewer-token.txt`, cookie `HttpOnly; SameSite=Lax`, `Secure` fora de loopback, 30 dias; página de entrada em `/` e `/m`; limitador 5/min partilhado entre `POST /login` e `?k=` errado, com o token validado antes do travão; `Origin: null` aceite só no `/login`).
- Rotação de contexto do orquestrador: investigada contra o stream real desta sessão — 924 eventos próprios, 18 chamadas `Agent` (67 k caracteres de prompts), 21 hand-backs (144 k caracteres), 1 compactação, transcript de 15 MB, limite de utilização atingido. Conclusão em §3b: os subagentes começam sempre limpos; o orquestrador acumula; o runner é a rotação; um contexto novo não repõe a quota.

### B2. O que foi construído ou alterado (ficheiros principais)

- Elenco: `.claude/agents/{architect,product-manager,product-designer,technology-scout,frontend-dev,backend-dev,reviewer,qa,security-reviewer}.md`; skills `forja-crew` (relê o CLAUDE.md do disco em sessões longas), `forja-lead` (modo runner §9, gatilhos §1b, hand-backs em ficheiro), `forja-plan` (complexidade), `forja-product`, `forja-design`, `forja-scout` (tabela «Decisões em vigor»), `forja-qa`, `forja-security`, `forja-debug`, `forja-performance`, `forja-release`, `forja-implementer` (DoD com `npm run check`), `forja-review` (passo 2 com `npm run check`), `forja-visual-check`.
- Runner e modelos: `lib/runner.mjs` (prompts das fases com `policyText`, lock, guarda de arranque, pausas, `--no-attempt` na recuperação, limpeza do id de sessão, validação de `--model/--effort/--models`, `levelFromDisk`, `taskMinutesFor`, `runner.session` com `model_level/effort/model/minutes`), `lib/models.mjs` (três níveis, effort por nível/complexidade/tentativa, `policyText`), `test/runner.test.mjs` (21 testes, dois ciclos reais contra um `claude` falso), `test/models.test.mjs` (17).
- CLI: `bin/forja.mjs` (`runner`, `up`, `down`, `token`, `models show|set`, `projects list|prune`, `run start` com arquivo do run anterior e criação de `docs/forja/reports/`, `task add --complexity`, `task show`, `task fail --no-attempt`, `Object.hasOwn` no dispatch, `return await` nos comandos delegados), `lib/state-files.mjs`, `lib/up.mjs`, `lib/serve.mjs`, `lib/bootstrap.mjs` (nove agentes, registo do projeto), `lib/projects.mjs`, `lib/notify.mjs`, `tools/stats.mjs`, `tools/check.mjs` (portão determinístico).
- Viewer: `viewer/server.mjs` (página de entrada, `POST /login`, limitador, cookie), `viewer/runs-api.mjs` (`GET /projects`, `POST /runs` com verificação de Origin, objetivo normalizado e limitado, spawn desligado), `viewer/lib/state.mjs` (dez papéis com `core`, `activeMs`, `sessions`, `models`, `modelLevel`; veredictos `SECURITY-*`; estados do runner e da pausa com prazo), `viewer/assets/*` (secção «Novo run» com máquina de estados `newRunReducer` e selo com prazo de 90 s; nível de modelos no cabeçalho), `viewer/index.html`, `viewer/mobile.html`.
- Docs: `docs/ARCHITECTURE.md`, `docs/design/DESIGN.md` (padrão «Novo run» pelo Product Designer), `docs/RUNBOOK-UNATTENDED.md` (§2 runner e níveis, §4 notificações, §7 token, §9 cenários do telemóvel, §10 tutorial dos dois projetos), `CLAUDE.md`, `docs/forja/TECHNOLOGY.md` (S1: cena em SVG + CSS, sem biblioteca), `docs/SPONSOR-ROADMAP.md` (5 itens), `docs/FORJA-POC-LOG.md`.

### B3. Testes e revisões

- Suite: `npm test` — 12 ficheiros (`bootstrap`, `check`, `cli`, `hook`, `models`, `runner`, `runs-api`, `server`, `spawn-runner`, `state`, `up`, `viewer-page`): **237 testes, 237 pass, 0 fail** (≈60 s). `npm run check`: `check ok — 331 ficheiros versionados, elenco do sample idêntico, política de modelos numa fonte só, 2962 eventos reproduzidos sem linhas más` (03:05 locais).
- Revisões independentes desta fase (sempre por um Reviewer separado do implementador, nunca mais fraco): `forja up/down` — 4 tentativas, APPROVE na 4.ª; conjunto «dez papéis + runner» (R-10) — 6 tentativas (pausa contava como tentativa de fase; nomes antigos no DESIGN; `ReferenceError` engolido no redutor; tabela de modelos desatualizada; runner «a trabalhar» para sempre; pausa sem prazo), APPROVE na 6.ª; viewer dos dez papéis (T-UI-3) — REJECT na 1.ª (cena desalinhada; contradição no DESIGN resolvida pelo Product Designer), APPROVE na 2.ª; T-API-1 — APPROVE na 2.ª (corrupção UTF-8 no `Buffer.concat`); T-MODELS-1 — APPROVE na 2.ª (`SETTINGS.json` ilegível); T-UI-4 — APPROVE na 3.ª (selo a desaparecer; contrato do DESIGN); T-SEC-1 — REJECT na 1.ª (`Origin: null` recusado no próprio formulário), Reviewer APPROVE + **SECURITY-REJECT** na 2.ª (token impresso no arranque e gravado pelo hook), APPROVE + SECURITY-APPROVE na 3.ª; T-IMP-1 — REJECT na 1.ª (o verificador de invisíveis continha os próprios invisíveis em literal), APPROVE na 2.ª; T-UI-5 — APPROVE na 1.ª + passagem de nits confirmada.
- Cada REJECT está no diário com o que foi corrigido e o teste que passou a cobrir o caso.

### B4. Defeitos encontrados nesta sessão (e corrigidos)

Parser da hora de reposição («já passou» ≠ «amanhã»); `spawnSync` sem timeout a pendurar a suite; campo `kind` no payload a sobrepor o tipo do evento; pid reutilizado pelo Windows a fazer um lock parecer vivo; batimento do lock parado durante sessões longas; `run start` a herdar as tasks do run anterior; id da sessão que lança o runner a contaminar a atribuição no viewer; pausa por limite a gastar tentativas e a contar como tentativa de plano/fecho; `ReferenceError` no caminho dos veredictos do CLI; `taskkill /PID` convertido em caminho pelo Git Bash; nomes antigos em texto de UI; `Origin: null` do próprio formulário de entrada recusado; token do viewer impresso no arranque e gravado em `data/events.jsonl` pelo hook; testes do `bootstrap` a registar pastas temporárias no registo real (86 entradas fantasma no menu do telemóvel — limpas); verificador de invisíveis com invisíveis em literal; `return delegate()` sem `await` a deixar stacks com caminhos absolutos sair para o hook; limite de 25 min a cortar a revisão de tasks difíceis.

### B5. Dogfood 2 — evidência

Run `R-20260916-ae6a` em `examples/sample-project`, pelo runner (`--max-task-minutes 25`, limite simulado na T2), arrancado às 22:21 (hora local):

- **Plano** (sessão 1, morta pelo relógio aos 25 min com o plano já escrito em disco — a primeira vítima do limite curto): Product Manager em Opus escreveu `PRODUCT-PROFILE.md` e três perguntas para a fila (Q3: expor o servidor à rede local — respondeste «Sim» pelo telemóvel às 22:32, pelo túnel real); Technology Scout em Opus escreveu `TECHNOLOGY.md`; Architect em Fable escreveu oito tasks com complexidade (T1/T2/T6 hard, T4/T5/T7 medium, T3/T8 easy).
- **Crash simulado** (22:48): runner morto à força a meio da T1; relançado sem `--goal`, assumiu o lock do processo morto, registou a T1 como tentativa falhada e reabriu-a em Opus (regra da 2.ª tentativa); Reviewer e Security Reviewer em Opus; `done`.
- **Limite de utilização simulado** (23:06, T2): `run.pause` registado, notificação enviada, retoma às 23:07 sem humano; a T2 voltou à fila **sem gastar tentativa**; depois `done` (Backend Dev, Reviewer e Security Reviewer em Opus — gatilho de segurança por ser autenticação).
- **Política de modelos observada:** T3 (easy) com o Backend Dev em Sonnet; T5 (medium) com o Frontend Dev em Sonnet; tasks difíceis e segundas tentativas em Opus; Reviewer sempre Opus; Architect em Fable.
- **Papéis a pedido:** Product Manager (arranque e Q3), Technology Scout (arranque), Security Reviewer (T1, T2, T6) e Product Designer (T4: a página nova «histórico» acordou-o pelo gatilho «ecrã sem DESIGN.md que o cubra»; deixou a pergunta Q4 na fila com o default aplicado) exercitados pelos gatilhos certos.
- **Relógio das tasks:** a sessão de plano, T4 (medium, com o desvio pelo Product Designer) e T6 (hard, 1.ª e 2.ª tentativas) excederam os 25 min com o trabalho a meio — tentativa perdida de cada vez (a T1 não: a sua 1.ª tentativa foi o crash simulado). É a origem do `taskMinutesFor` (B1) e da subida do valor por omissão para 45/72 min. Este run correu com o código anterior e não beneficia.
- **Desfecho (às 02:58 locais, hora do fecho deste relatório):** T6 fechou na 3.ª tentativa (APPROVE, checkpoint `6732b5d`); T7 e T8 fecharam à primeira, dentro do tempo; os hand-backs destas duas já ficaram em `docs/forja/reports/T7-a1-{dev,review}.md` e `T8-a1-…` (o mecanismo novo da T-IMP-1, apanhado pelo sample no re-bootstrap). Sessão de fecho (13, 30 min): o **QA em Opus** correu a suite (126/126), o `npm run check`, um E2E completo contra o servidor real (login, cookie, histórico, gráfico conferido contra um agrupamento independente, dados estranhos escapados, 5 POST simultâneos sem `.tmp` perdidos, restart sem perda) e deu **QA FAIL com 2 achados**; o Architect abriu T9 (hard: cookie de sessão sem `Max-Age`, como a página promete) e T10 (medium: endereços de rede local com `GREET_HOST=0.0.0.0`, sem a palavra «token» no aviso). O runner **não terminou o run** e seguiu sozinho para a sessão 14 (T9). É o caminho «QA → Architect → o run continua» a funcionar sem humano. **Adenda (03:53 locais):** o run acabou por si — T9 e T10 fechadas à primeira, segundo fecho (sessão 16, QA de novo), `run finished` às 02:53Z com **10/10 tasks aprovadas** e 16 sessões `claude -p`; relatório do Product Manager commitado pelo runner (`c778364`) em `examples/sample-project/docs/forja/`, relatório do QA em `docs/forja/reports/QA-close-1.md`; notificação «run terminou em sample-project — 10/10 tasks aprovadas, há perguntas na fila» enviada pelo runner.
- Estatísticas por papel: tabela em A6 (com a ressalva da fusão de sessões). Screenshots: `docs/dogfood/07-*.png` (telemóvel e desktop durante a T6), `docs/dogfood/ui-*.png` (viewer), `docs/screenshots/t-sec-1-*.png` (página de entrada, incluindo um Chrome real a entrar).

### B6. Limites conhecidos e trabalho deixado

- Nit do `forja up`: janela de ~300 ms em que um `down` concorrente pode deixar um `up.pid` incompleto.
- Uma sessão morta por timeout depois de `task start` gasta uma tentativa (intencional: loop suspeito).
- O runner não valida semanticamente comandos destrutivos fora da lista de recusa.
- `examples/sample-project` é um repo dentro do repo do Forja: os commits dos runs de dogfood entram no histórico do Forja. Um projeto real tem o seu próprio repo.
- Nits aceites e não feitos: cookie sem prefixo `__Host-` (quebraria o loopback em http); limitador de login global atrás do túnel (mitigado por validar o token antes do travão); `forja projects list` imprime caminhos (CLI local); borda do campo da página de entrada a 2,27:1 (padrão do viewer, correção transversal); `.env` fora do varrimento de invisíveis (de propósito).
- **Decidido e não construído:** «Preparar projeto» / «Novo projeto» pelo telemóvel (T-API-2/T-UI-5b: raiz `C:\dev`, nomes saneados, Security Reviewer obrigatório) e o seletor de nível de modelos na secção «Novo run».
- Atribuição no viewer: um run arrancado a partir de uma sessão interativa antes da correção fica fundido com ela (só afeta estatísticas; corrigido para runs futuros).

---

## Parte C — alterações recomendadas ao Playbook e aos ficheiros globais

Toquei em `%USERPROFILE%\.claude\settings.json` uma única vez, com a tua autorização explícita (itens 1 e 4 do roadmap; cópia de segurança ao lado). Nada mais fora do repo foi alterado, além do bootstrap dos dois projetos que autorizaste.

1. `%USERPROFILE%\.claude\CLAUDE.md`, regra de UI («Do not write production UI code until the Sponsor has picked a direction»): acrescentar a exceção dos runs Forja sem humano — o Product Designer escolhe a direção com razões escritas e a escolha vai para a tua fila como pergunta com default aplicado; podes reverter depois.
2. `%USERPROFILE%\.claude\CLAUDE.md`, regras «Never install… wait» e «Ask before anything irreversible»: nota de que em runs Forja o «esperar» é substituído por `BLOCKED` + entrada na fila com default (nada fica parado à espera de um humano).
3. `%USERPROFILE%\.claude\CLAUDE.md`: uma linha «política de modelos dos agentes Forja: ver `docs/ARCHITECTURE.md` §6 do Forja», para uma sessão interativa fora do Forja não voltar a chamar Devs em Fable.
4. `%USERPROFILE%\.claude\skills\forja-architect`: apagar (roadmap item 3).
5. `PLAYBOOK\SCENARIOS.md`: cenário novo «run sem humano com o Forja» a apontar para `docs/RUNBOOK-UNATTENDED.md`; `TOOLING.md`: nada a acrescentar (o Forja não tem dependências).
6. Para a próxima sessão interativa longa (aprendido nesta sessão): arrancar já em `--effort high`; pedir ao Lead que grave os hand-backs em ficheiro desde o início (é o que o runner faz agora); e nunca lançar o runner a partir da sessão interativa sem a limpeza do id de sessão (já está no código).

Fim.
