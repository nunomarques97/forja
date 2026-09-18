# Runbook — pôr o Forja a trabalhar num projeto sem estares presente

Para o Sponsor. Um caminho só, passo a passo. Se alguma coisa não bater certo com o que está aqui, pára e cola numa sessão nova do Claude Code, na pasta do Forja: `Lê docs/RUNBOOK-UNATTENDED.md e docs/FORJA-POC-LOG.md e diz-me o que se passa.`

Pasta do Forja: `C:\dev\forja`. Tudo o que é "correr um comando" é num terminal (PowerShell) nessa pasta, a não ser que diga o contrário.

O modo sem humano é o **runner**: um programa pequeno que arranca uma sessão nova do Claude Code por fase (plano · uma task de cada vez · fecho), guarda tudo em disco, aguenta os limites de utilização sozinho e nunca depende de uma conversa "lembrar-se" do que fez. Não precisas de abrir o `claude` à mão para runs sem ti.

## 0. Uma vez por máquina (confirmar em 30 s)

1. Abre um terminal na pasta do Forja e corre `npm test`. Tem de acabar com `fail 0`.
2. Corre `node bin\forja.mjs autostart install`. Deve responder `"ok": true` e listar quatro ficheiros escritos: `forja-up.vbs` e `forja-guard.vbs` na tua pasta Arranque do Windows, e os dois `.cmd` deles em `data\autostart`. A partir daqui, sempre que fizeres login no Windows, arrancam sozinhos, sem janela e independentes um do outro, **o viewer com o túnel** (recebes no telemóvel a notificação "Forja — telemóvel" com o link, cerca de um minuto depois do login) e **a guarda dos runners**, que de minuto a minuto verifica se algum run em curso ficou sem runner e o relança. Este passo dá-se uma vez; para confirmar a qualquer momento que a guarda está a ver os teus projetos: `node bin\forja.mjs guard status` (só mostra o que faria, não lança nada).
3. Opcional, só para sessões interativas do `claude` (não para o runner): o item 1 de `docs/SPONSOR-ROADMAP.md` liga o auto-continuar em limite de quota nas tuas settings de utilizador.

## 1. Preparar um projeto (uma vez por projeto, 1 minuto)

1. Na pasta do Forja: `node bin\forja.mjs bootstrap "C:\caminho\para\o\projeto"`.
2. Lê o resumo que imprime: `created` / `updated` / `unchanged` / `removed` (o `removed` só aparece se o projeto tinha ficheiros de uma versão antiga do Forja) e `registry` (o projeto fica na lista da secção «Novo run» do telemóvel). O `CLAUDE.md` do projeto só ganha um bloco `## Forja` no fim; o resto fica como estava.
3. Entra na pasta do projeto e faz commit disso (`git add -A` e `git commit -m "Forja: bootstrap"`). É a única vez que fazes git à mão.

Preparar o projeto não arranca nada. Quem executa cada run escolhe-se depois, run a run (secção 2b).

## 2. Arrancar um run (2 minutos, depois deixa-o correr)

1. Confirma no telemóvel que tens a notificação "Forja — telemóvel" de hoje. Se não tiveres: na pasta do Forja corre `node bin\forja.mjs up` num terminal que fica aberto; a notificação chega em menos de um minuto. **Da primeira vez que abrires um link novo** (o endereço muda em cada arranque) o viewer pede-te o token: abre `data\viewer-token.txt` na pasta do Forja, copia a linha toda, cola-a no campo «Token» e toca em «Entrar». Fica guardado nesse telemóvel para esse endereço; só voltas a colá-lo quando o link mudar. O link que chega por notificação já não leva o token — é de propósito, o tópico das notificações é público.
2. Abre um terminal **na pasta do projeto** e corre, trocando só o texto entre aspas (o objetivo é o que o projeto tem no roadmap ou o que tu queres; uma a três frases chegam):

```text
node C:\dev\forja\bin\forja.mjs runner --goal "o que queres que fique feito, em uma a três frases"
```

**Se o trabalho for menos exigente (ou quiseres gastar menos quota):** acrescenta `--forjalvl alto` ou `--forjalvl económico` ao fim do mesmo comando. São os três forjalvl (o nível de modelos): **máximo** (o normal: o melhor modelo em quase todos os papéis), **alto** (poupa na pesquisa de tecnologia e na validação final) e **económico** (só o Reviewer e o Security Reviewer ficam no modelo forte). Em nenhum forjalvl se revê trabalho com um modelo mais fraco do que o que o fez. O forjalvl manda também no tempo que cada sessão pensa: no máximo, o planeamento e o fecho pensam o máximo possível; no alto, pensam muito; no económico, pensam o normal e as tarefas pequenas pensam pouco. O forjalvl escolhe-se ao arrancar o run e não muda a meio.

Para não escreveres isso todas as vezes, fixa o forjalvl do projeto: na pasta do projeto, `node C:\dev\forja\bin\forja.mjs forjalvl set económico` (e `forjalvl show` para ver qual está a valer). Vale para os próximos runs desse projeto; um run a correr mantém o forjalvl com que arrancou. Se algum dia um destes comandos responder `SETTINGS.json ilegível`, é porque o ficheiro de definições do projeto (dentro da pasta `docs`, subpasta `forja`) ficou a meio: abre-o e corrige-o, ou apaga-o e o forjalvl volta a ser o máximo. O Forja recusa-se a arrancar às cegas ou a escrever por cima dele.

**Autonomia: quanto o Forja decide sem te perguntar.** Por omissão (`normal`) uma dependência nova — mesmo gratuita —, uma direção de design e qualquer escolha de produto reservada a ti vão para a fila com o default aplicado: é a tua regra de sempre («nada se instala sem mim»), e foi o que encheu a fila com oito perguntas na primeira hora de 17 de setembro. Se preferires não ver essas perguntas, põe o projeto em **autonomia total**: na pasta do projeto, `node C:\dev\forja\bin\forja.mjs autonomy set total` (ou `--autonomy total` ao fim do comando do runner, só para esse run; `autonomy show` diz o que está a valer). Em autonomia total o run decide e regista sozinho: dependências gratuitas, sem conta e com licença permissiva (o Technology Scout escolhe, o Dev instala no ambiente do projeto) e escolhas de produto e de design com um default razoável — tudo escrito em `docs\forja\DECISIONS.md` com a marca «decidido em autonomia total», que é o que lês se quiseres reverter. **Continuam sempre a ir à fila, também em total:** dinheiro teu (compras, licenças, subscrições, certificados pagos), criar contas em teu nome, enviar seja o que for a terceiros, apagar dados, e publicar/deploy/push. Uma pergunta de dinheiro leva sempre o default «não gasto; alternativa gratuita» e o run segue; se ficares sem lhe responder até ao fim, ela aparece no `docs\forja\SPONSOR-ROADMAP.md` do projeto e numa secção **«Para decidires agora que estás aqui»** do relatório final — decides dinheiro no fim, de uma vez, com o produto à frente.

**Ver as sessões na app do Claude (opcional).** Acrescenta `--visivel` ao fim do mesmo comando do runner. A partir daí cada fase (plano, cada task, fecho) abre como **sessão de fundo** na tua conta: aparece na app do Claude, com o nome `forja <id do run> <fase>`, enquanto está a trabalhar, e desaparece de lá quando a fase acaba (o Forja fecha-a). Serve para **espreitares** o que o Lead está a fazer sem estares no PC. O que **não** deves fazer: escrever nessa sessão pelo telemóvel — uma mensagem tua entra na conversa no fim do turno e desvia a fase do que o runner lhe mandou fazer; **desde 17 set 2026 nem sequer chega a ser lida**, porque o runner fecha a sessão assim que o turno acaba (é assim que a fase termina, ver `docs/ARCHITECTURE.md` §3b). Perguntas para o Forja respondem-se na fila do viewer (§5), que é o canal que o run vai buscar sozinho. Também não a pares nem a apagues na app: o runner trata disso e, se a parares tu, a task conta uma tentativa falhada. Se uma sessão ficar à espera de ti dentro da app (uma permissão, por exemplo), recebes «a sessão visível … ficou à espera de ti na app do Claude», o Forja pára-a e segue para a tentativa seguinte. Sem `--visivel` nada disto muda: é o modo normal, o que já correu todos os runs até hoje. Nota: com sessões visíveis o teu histórico de conversa da fase fica guardado na tua conta Anthropic (é o que o Remote Control faz, como nas sessões que abres à mão); no modo normal também podes abrir a conversa de uma fase depois de ela acabar, com `claude --resume <id>` (os ids estão em `docs\forja\RUN.json` e no registo do runner).

3. Deixa esse terminal aberto (podes minimizá-lo). Espera pela notificação "Forja: run começou em <projeto>" (menos de um minuto). Podes ir-te embora.

**Ou pelo telemóvel (sem PC à frente):** abre o link do viewer, vai à secção **«Novo run»** (logo a seguir ao elenco), escolhe o projeto na lista (só aparecem os projetos preparados pelo bootstrap do passo 1), escreve o objetivo, toca em «Arrancar» e depois em «Confirmar». O runner arranca no PC (o viewer e o túnel têm de estar a correr — é o que o arranque automático do §0 garante). Se um run ficou a meio porque o runner parou, a mesma secção mostra «Relançar o runner» para esse projeto — só para runs do runner: um run de uma conversa, ou de responsável desconhecido, é recusado (secção 2b). Nunca aparecem caminhos nem tokens nessa página.

O que o runner faz sozinho: perfil de produto e enquadramento (Product Manager), inventário de tecnologia (Technology Scout), plano em tasks pequenas (Architect); depois, task a task, o Dev certo constrói, o Reviewer aprova ou recusa, o Security Reviewer entra quando a task toca em rede/segredos/dependências, e cada task aprovada fica commitada; no fim o QA valida o todo, o Product Manager escreve o relatório e o run fecha. Cada task tem até 45 minutos (`--max-task-minutes`, que é o tempo das tasks fáceis e médias; uma task marcada `hard` recebe 60 % mais — 72 minutos com o valor por omissão — porque a revisão ainda ia a meio quando o relógio tocava); três tentativas falhadas fecham-na e o run segue. Se o Claude Code disser "You've hit your session limit, resets at …", o runner põe o run **em pausa**, avisa-te uma vez, espera pela hora indicada e retoma sozinho.

Se o terminal do runner se fechar (PC reiniciou, fechaste sem querer): abre outro na pasta do projeto e corre o mesmo comando **sem** `--goal`. Ele retoma o run do disco; a task que estava a meio volta à fila (uma pausa por limite não gasta tentativa; um crash ou um tempo excedido gasta) e é refeita. Um segundo runner na mesma pasta recusa arrancar enquanto o primeiro estiver vivo.

## 2b. Conversa ou autónomo: quem conduz o run

Cada run tem um só responsável, escrito no próprio run (`docs\forja\RUN.json`, campo `driver`):

- **Numa conversa** (a extensão do Claude Code no VS Code, com o Lead a trabalhar à tua frente): pede ao Lead o objetivo; ele faz `forja run start` e o run fica **da conversa**. A guarda nunca lança um runner por cima dele, nem depois de reiniciares o PC. Se fechares a conversa, o run fica parado até o retomares numa conversa nova (`run resume`) ou o passares ao runner.
- **Autónomo** (secção 2): o comando `runner` ou o botão «Novo run» do telemóvel. O run fica **do runner**, e a guarda relança-o se o runner morrer, como sempre.

Para ver de quem é um run: na pasta do projeto, `node C:\dev\forja\bin\forja.mjs run driver show`.

Para passar um run de um lado para o outro, sempre de propósito:
- Da conversa para o runner: a task em curso tem de estar fechada (ou devolvida à fila); depois `… forja.mjs run driver set runner`. Isto não lança nada: lança o runner com o comando da secção 2 **sem** `--goal` (ou deixa a guarda lançá-lo, uns 2 minutos depois).
- Do runner para a conversa: `… forja.mjs run driver set interactive`. Se o runner estiver vivo, fica um pedido: ele termina a sessão em curso, escreve um checkpoint e sai. Confirma com `run driver show` antes de continuares na conversa.

Runs antigos, de antes de 18 de setembro, não têm este campo. Os que foram feitos pelo runner são reconhecidos pelos registos do próprio runner e continuam a ser recuperados; os outros aparecem como **desconhecidos** e nada os executa sozinho até disseres de quem são (`run driver set …`).

## 3. O que vais ver

**No telemóvel (link da notificação "Forja — telemóvel"; guarda-o nos favoritos, muda quando o PC reinicia e recebes outro — em cada link novo colas o token de `data\viewer-token.txt` uma vez, como no §2):** o elenco em dez linhas — primeiro os cinco de núcleo (Lead, Architect, Frontend Dev, Backend Dev, Reviewer), depois os cinco a pedido (Product Manager, Product Designer, Technology Scout, QA, Security Reviewer, marcados «a pedido» e `inativo` até serem precisos) — cada um com o estado em palavras (a trabalhar · à espera de review · bloqueado · precisa do Sponsor · sem resposta · morto · terminado · falhou · inativo · em pausa), há quanto tempo, em quê, e a linha «ligado: …» com o tempo total que esse papel esteve a trabalhar no run (só estatística). Por baixo: as tasks do run e a fila "precisa do Sponsor" (com um campo para responderes). A página abre no separador **Eventos** (o feed de todos os projetos); o elenco está no separador **Modelos e ligações**.

**No PC (`http://127.0.0.1:4317/?k=<token>` — o link está no terminal do `forja up` e em `data\viewer-token.txt`):** a mesma informação com mais detalhe (cena da forja, instâncias em paralelo, resultados de review, ferramentas nativas); abre no separador **Eventos**, e o atalho **Forja** no ambiente de trabalho leva-te lá sem token no link (README.md §Viewer).

**Sinais de vida:** "a trabalhar" com um contador a andar é vivo. "silêncio há 3 min" a âmbar é normal (está a pensar). "sem resposta" (5 min sem sinal num agente, 10 min na sessão principal ou no runner) é para olhar. "morto" (30 min) já foi notificado. "em pausa: limite de utilização, retoma às HH:MM" é esperado — não faças nada.

## 4. Notificações — o que significam e o que fazer

| Notificação | Significa | O que fazes |
|---|---|---|
| Forja: run começou em … | o run arrancou | nada |
| Forja — telemóvel (link) | o viewer está acessível pelo telemóvel; o link mudou | abre o link, guarda-o nos favoritos |
| Forja precisa de ti (…) Q<n>: … — entretanto: … | uma pergunta que só tu podes responder; o Forja aplicou o default indicado e continuou | quando puderes: abre o link, responde na fila. Se não responderes, o default fica |
| Forja: run em … em pausa — limite de utilização … Retoma sozinho às HH:MM | o Claude Code bateu no limite de utilização da conta; o runner espera e retoma sozinho | nada |
| Forja: runner em … parou — o Claude Code não arranca | duas sessões seguidas não chegaram a correr (o `claude` não abre, login caducado, comando partido) | no PC: abre um terminal na pasta do projeto, corre `claude` à mão e vê o erro; resolve; depois `node …\forja\bin\forja.mjs runner` sem `--goal` |
| Forja: confirmar dependência … / confirmar direção … | o Technology Scout ou o Product Designer escolheram algo que te está reservado; o run continua com a escolha deles como default | nada agora; se discordares, responde na fila e o Forja replaneia |
| Forja: <Papel> em … morto (só em sessões interativas do `claude`; com o runner não acontece) | um membro do elenco ficou 30 min sem sinal | nada de imediato; o Lead relança uma vez e depois bloqueia a task |
| Forja precisa de ti (…): o runner parou (…) — relançar | o runner saiu sem fechar o run (limite de sessões, fecho falhado, lock perdido, Claude Code sem arrancar) ou o PC reiniciou | no PC: terminal na pasta do projeto, `node C:\dev\forja\bin\forja.mjs runner` sem `--goal` |
| Forja: a sessão visível do run em … ficou à espera de ti na app do Claude | só com `--visivel`: a sessão dessa fase parou à espera de uma pessoa (uma permissão, uma pergunta) dentro da app; o Forja parou-a e segue para a tentativa seguinte | nada; se quiseres perceber o que pedia, abre o registo da sessão no viewer. Não respondas dentro da app: desvia a fase |
| Forja: o runner de … morreu a meio do run — relancei-o (tentativa N de 3) | a guarda dos runners deu por ele morto (mais de 2 min sem sinal) e arrancou outro, que continua do disco | nada. Se aparecer várias vezes no mesmo dia, olha o run no telemóvel: alguma coisa está a matar os runners |
| Forja: desisti de relançar o runner de … — 3 tentativas seguidas não pegaram | o run está mesmo parado: três relançamentos, 15 min de intervalo, nenhum pegou. A guarda não volta a tentar este run e não te volta a avisar | no PC: terminal na pasta do projeto, `node C:\dev\forja\bin\forja.mjs runner` sem `--goal`, e vê o erro que aparecer. A guarda volta a tomar conta dele assim que o runner novo viver 30 min |
| Forja: o viewer morreu — relancei (tentativa N de 3) | a guarda deu pelo `forja up` morto (mais de 2 min sem sinal) e arrancou outro. O viewer volta na porta por omissão e com túnel, por isso **o link do telemóvel muda**: recebes logo a seguir a notificação "Forja — telemóvel" com o novo | abre o link novo. Se aparecer várias vezes no mesmo dia, alguma coisa está a matar o viewer |
| Forja: a guarda dos runners morreu — relancei (tentativa N de 3) | o viewer deu pela guarda morta (mais de 2 min sem batimento) e arrancou outra, que assume o lock e continua a vigiar os runs | nada |
| Forja: desisti de relançar o viewer / a guarda dos runners — 3 tentativas seguidas não pegaram | três tentativas, 15 min de intervalo, nenhuma pegou; quem vigia não volta a tentar nem a avisar | no PC, na pasta do Forja: `node bin\forja.mjs up` (ou `node bin\forja.mjs guard run`) num terminal, e vê o erro que aparecer. A vigia volta a tomar conta assim que o processo novo viver 30 min |
| Forja: fallback de modelo … | ficou sem quota Fable nesse papel; passou a Opus até ao fim do run | nada; fica registado no relatório |
| Forja: task T<n> falhou 3 vezes | a task fechou sem sucesso, com a evidência gravada | nada agora; lê o relatório do run depois |
| Forja: task T<n> bloqueada | precisa de ti (permissão recusada, dependência que não há a custo zero, …) | lê o motivo no viewer; quando estiveres no PC, responde/decide e retoma com `runner` sem `--goal` |
| Forja: run terminou em … | acabou; há relatório | lê `docs\forja\REPORT-<data>.md` no projeto e a fila |
| Forja: run FALHOU / BLOQUEADO em … | parou sem conseguir continuar | lê o motivo no viewer; no PC decide e retoma com `runner` sem `--goal` |
| Forja precisa de ti (…): permissão pendente / terminou o turno com o run em curso | só acontece em sessões interativas do `claude` (não com o runner) | no PC, no terminal dessa sessão: aprova/recusa, ou cola o prompt de `node …\forja\bin\forja.mjs resume` |

**Reiniciar o viewer não pára os runs.** Parar o viewer (`forja down`), voltar a arrancá-lo (`forja up`) ou vê-lo ir abaixo sozinho não mexe nos runs: um run arrancado pelo telemóvel corre fora da árvore do viewer e o `down` diz na saída quantos poupou («poupados: N runners»). O que pára é o link do telemóvel, até `forja up` outra vez. Parar um run é outra coisa e faz-se no PC (§7).

## 5. Responder às perguntas do Forja

Onde estão: no viewer (secção "precisa do Sponsor") e no ficheiro `docs\forja\SPONSOR-QUEUE.md` do projeto. Cada pergunta diz o default que foi aplicado.

Pelo telemóvel: abre a pergunta, escreve a resposta, "Enviar". A resposta fica guardada no PC; o runner entrega-a ao Lead no início da sessão seguinte (a task seguinte) e o plano ajusta-se. Se a tua resposta contraria uma decisão já tomada, a decisão fica marcada como substituída e as tasks afetadas são replaneadas pelo Architect.

Sem viewer: abre `docs\forja\SPONSOR-QUEUE.md` no projeto e escreve a resposta na linha `Resposta:` da pergunta. Na sessão seguinte o Lead apanha-a.

## 6. Ver decisões e o relatório

- `docs\forja\PRODUCT-PROFILE.md` — para quem é o produto, a fasquia de qualidade e as prioridades que todos os agentes usam nos trade-offs (Product Manager).
- `docs\forja\TECHNOLOGY.md` — cada escolha de tecnologia, com as opções comparadas e o porquê (Technology Scout).
- `docs\forja\DECISIONS.md` — cada decisão de produto ou de design tomada, com o porquê e se é reversível.
- `docs\forja\REPORT-<data>.md` — o relatório do run, escrito no fim: o que foi feito, decisões, perguntas, o veredicto do QA, o que ficou por fazer e porquê, evidência.
- `docs\forja\HANDOVER.md` — o estado atual e a próxima ação exata (é o que cada sessão nova lê).

## 7. Parar tudo em segurança

1. No terminal do runner: `Ctrl+C`. O estado está sempre em disco (`docs\forja\`), não se perde nada; o que a task a meio já tinha escrito fica no working tree e é aproveitado na tentativa seguinte. Retomar depois: na pasta do projeto, `node …\forja\bin\forja.mjs runner` sem `--goal`.
   **Run arrancado pelo telemóvel (sem terminal nenhum):** não há comando para o parar — o `forja down` já não lhe toca de propósito. No PC, um passo: abre `C:\dev\forja\data\runner\lock-<projeto>.json`, lê o campo `pid` e corre `taskkill /PID <pid> /T /F` (mata o runner e a sessão `claude` que ele tem a correr). O run fica retomável na mesma, com o comando da linha de cima.
2. Para desligar o viewer e o túnel (tenham arrancado num terminal ou sozinhos no login, sem janela): na pasta do Forja, `node bin\forja.mjs down`. Responde com `"ok": true` e a lista `killed` dos processos que fechou; o link do telemóvel deixa de funcionar nesse momento e nada volta a arrancar sozinho até ao próximo login. Para também não voltarem a arrancar no login: `node bin\forja.mjs autostart remove` (faz o mesmo que o `down`, tira os quatro ficheiros de arranque automático e pede à guarda dos runners que pare). Para parar só a guarda e deixar o viewer a andar: `node bin\forja.mjs guard stop` — ela sai na volta seguinte (até um minuto) e não mata runner nenhum; volta no próximo login, ou com `node bin\forja.mjs guard run`.
   **Parado continua a querer dizer parado.** Desde que o viewer e a guarda se vigiam um ao outro (`docs\ARCHITECTURE.md` §12), podias perguntar se o `down` ainda serve de alguma coisa: serve, e é por desenho. O `down` escreve `data\up.stop`, e enquanto esse ficheiro existir a guarda **nunca** relança o viewer (vê-se em `data\guard\guard.log`: «o viewer está parado a pedido … não relanço»); o `guard stop` escreve `data\guard\guard.stop`, e enquanto esse existir o viewer **nunca** relança a guarda. Nada volta sozinho até ao próximo login ou até tu arrancares outra vez à mão — e um `forja up` novo apaga o `up.stop` sozinho, pelo que a vigia recomeça sem teres de fazer mais nada.
3. Se alguma vez suspeitares que o link do telemóvel foi parar a alguém: na pasta do Forja, `node bin\forja.mjs token rotate` e reinicia o `forja up` (ou o PC). O token antigo deixa de servir (o telemóvel volta a pedi-lo) e recebes um link novo; cola lá o token novo de `data\viewer-token.txt`. **É a única forma de revogar um token** — não há sessões para fechar nem cookies para apagar à distância: o cookie de quem já entrou passa a não valer assim que o token muda.
4. **Faz essa rotação uma vez, hoje** (não é urgente, é higiene): até esta correção o viewer imprimia no arranque um link com o token dentro, e essa linha ficou gravada nos ficheiros de eventos (`data\events.jsonl` e os rodados `data\events.*.jsonl`) — ficheiros locais, fora do git, mas onde o token antigo continua legível. Depois de `token rotate` e de reiniciar o `forja up`, esses tokens deixam de abrir seja o que for.

## 8. Go / no-go — resultado dos dogfoods (fase 6 desta sessão)

| Verificação | Resultado |
|---|---|
| Bootstrap num projeto de exemplo, duas vezes, sem tocar no que não é do Forja | ✅ dogfood 1 e 2 (`examples/sample-project`); segunda passagem só reporta `unchanged` + remoção dos ficheiros antigos do próprio Forja; testes `bootstrap.test.mjs` |
| Run completo em sessão interativa: plano, especialistas construíram, revisor aprovou, commits feitos | ✅ dogfood 1, run `R-20260916-8a30`: T1, T3, T4, T5 aprovadas e commitadas, T2 bloqueada de propósito, relatório `examples/sample-project/docs/forja/REPORT-2026-09-16.md` |
| Falha injetada: subagente morto a meio → o viewer mostrou-o e o run seguiu | ✅ dogfood 1 (injeção A: T1 com a primeira tentativa cancelada; segunda tentativa aprovada) |
| Falha injetada: permissão negada → task bloqueada, notificação recebida | ✅ dogfood 1 (injeção B: `rm -rf` recusado; T2 `blocked`; o Sponsor recebeu a notificação e perguntou se era a sério) |
| Pergunta só-para-o-Sponsor → fila, default aplicado, notificação recebida, run continuou | ✅ dogfood 1 (injeção C: pergunta na fila com default; resposta enviada pelo viewer e recolhida por `forja answers`) |
| Viewer no telemóvel pelo túnel, com token | ✅ fase 3 (túnel Cloudflare: sem token 403, com token 302 + cookie, depois 200); dogfood 2: o Sponsor respondeu à pergunta Q3 a partir do telemóvel, pelo túnel do `forja up` real (22:32) |
| Relatório do run e handover escritos; `git status` limpo no fim | ⚠️ dogfood 1: relatório e handover escritos; o commit de T5 arrastou 5 renomeações de ficheiros que outra sessão tinha em staging fora do projeto (o Lead tentou corrigir com `git reset --soft`, recusado pelas permissões, e parou — correto). Lição: nunca correr o dogfood no mesmo repo git onde outra sessão está a trabalhar |
| Run completo pelo **runner** (uma sessão nova por fase), com pausa simulada por limite de utilização e retoma sem humano | ✅ pausa (23:06) e retoma (23:07) sem humano na T2, que voltou à fila sem gastar tentativa e ficou `done`; fecho do run: (em curso) |
| Runner interrompido a meio de uma task e relançado: a task conta como tentativa falhada, o trabalho em disco é aproveitado, o run continua | ✅ dogfood 2 (22:48): runner morto à força durante a T1; relançado sem `--goal`, assumiu o lock do processo morto, registou a T1 como tentativa falhada e abriu a T1 tentativa 2 em Opus, que passou pelo Reviewer e pelo Security Reviewer |
| Segundo runner na mesma pasta recusa arrancar | ✅ `runner.test.mjs` (código 3, lock) — a confirmar no dogfood 2 |
| Os cinco papéis a pedido chamados pelo menos uma vez pelo gatilho certo | Product Manager (arranque + Q3), Technology Scout (arranque), Security Reviewer (T1 dados, T2 auth), Product Designer (T4, página nova «histórico», 23:36) ✅; QA (fecho): (em curso) |

## 9. Cenários pelo telemóvel (para guardar)

Pelo telemóvel fazes duas coisas: arrancar ou relançar runs («Novo run») e responder a perguntas («Precisa do Sponsor»). Preparar um projeto (bootstrap) e criar projetos novos exige o PC, uma vez por projeto (§1).

1. **Projeto já preparado, trabalho novo:** «Novo run» → projeto → objetivo → «Arrancar» → «Confirmar». Modelos de objetivo: funcionalidade — `Adicionar <o quê> em <onde>, para <quem>. Tem de funcionar: <critério>. Qualidade: simples e robusto.`; bug — `Corrigir: <sintoma> quando <passos>. Esperado: <comportamento>. Não mudar mais nada.`; ideia vaga — `Quero <ideia> para <público>. Decide o âmbito mínimo útil e faz.`; manutenção — `Atualizar <x>. Testes verdes, sem dependências novas.`
2. **Run a meio com o runner parado** (notificação "o runner parou"): «Novo run» → o projeto aparece como «run em curso, runner parado» → «Relançar o runner» → «Confirmar».
3. **Pergunta do Forja** (notificação "precisa de ti"): abre o bilhete, responde, «Enviar»; sem resposta fica o default já aplicado.
4. **Em pausa por limite de utilização:** nada a fazer.
5. **Projeto ainda não preparado:** só no PC (§1); depois aparece na lista.
6. **Run seguinte no mesmo projeto:** como o 1; o anterior fica arquivado.

## 10. Exemplo real (17 set 2026): dois projetos pelo telemóvel, com o PC ligado

**Para pores os dois projetos em autonomia total** (recomendado, §2): na pasta de cada um, corre uma vez `node C:\dev\forja\bin\forja.mjs autonomy set total`. A partir daí as dependências gratuitas e as escolhas de produto e de design decidem-se dentro do run e ficam em `DECISIONS.md`, e a tua fila fica só com dinheiro teu, contas em teu nome, envios a terceiros, apagar dados e publicar/push (`docs/ARCHITECTURE.md` §6b). Um run já a correr mantém a autonomia com que arrancou: o `set` vale para os próximos. O bootstrap dos dois projetos já está feito e commitado (na noite de 16 para 17 set, com a tua autorização): cada um tem o elenco, as skills, o hook e a pasta `docs\forja\`, e os dois aparecem no menu «Novo run» do viewer. O PC só tem de estar ligado, com o viewer e o túnel a correr (arrancam sozinhos no login se instalaste o `autostart`; senão, `node C:\dev\forja\bin\forja.mjs up` numa janela do PowerShell). Tudo o que precisar de ti fica na fila de cada projeto com o default aplicado; o run nunca espera por ti.

### forjalvl e effort (já decididos, não precisas de escolher nada)

| Projeto | forjalvl | Onde está | Effort por sessão |
|---|---|---|---|
| Juniper Hill | **alto** | `docs\forja\SETTINGS.json` do projeto (`forja forjalvl set alto`, feito pelo Lead) | plano e fecho `high`; tasks difíceis `high`; fáceis e médias `medium` |
| Violet Pier | **máximo** (por omissão) | sem ficheiro: é o forjalvl por omissão | plano e fecho `max`; tasks difíceis `high`; fáceis e médias `medium` |

Em «máximo», o Architect planeia em Fable (Opus depois de um fallback) e todos os papéis de revisão e apoio correm em Opus. Em «alto», o Architect planeia em Opus; Reviewer, Security Reviewer, Product Manager e Product Designer ficam em Opus; QA e Technology Scout correm em Sonnet (é onde o nível poupa). Devs nunca em Fable: Sonnet nas tasks fáceis e médias, Opus nas difíceis e a partir da 2.ª tentativa. O effort de cada sessão do runner é calculado pelo nível, pela complexidade da task e pela tentativa (tabela em `docs/ARCHITECTURE.md` §6). Não há nada a escolher no telemóvel.

### Projeto 1 — Juniper Hill (pelo telemóvel)

1. Abre o viewer no telemóvel (o endereço chega por ntfy quando o PC arranca; se pedir o token, cola o que guardaste — está em `C:\dev\forja\data\viewer-token.txt` no PC).
2. Desce até «Novo run». Em **Projeto**, escolhe `juniper-hill`.
3. Em **Objetivo**, cola este texto:

   > <objetivo do projeto — omitido na versão pública>

4. Toca em **Arrancar** e confirma no segundo toque. O selo «run a arrancar» dá lugar ao run assim que o runner responde (segundos). Se aparecer «o runner não arrancou — vê o computador», o motivo está em `data\runner\runner.log` no PC.
5. A partir daí só recebes ntfy: pergunta na fila (respondes na mesma página), pausa por limite (retoma sozinho), run terminado.

### Projeto 2 — Violet Pier (pelo telemóvel)

1. Na mesma secção «Novo run», em **Projeto** escolhe `violet-pier`.
2. Em **Objetivo**, cola este texto:

   > <objetivo do projeto — omitido na versão pública>

3. **Arrancar** e confirmar. O Violet tem alterações tuas por commitar; o primeiro checkpoint do runner commita-as junto com o trabalho dele — se não quiseres isso, faz tu o commit antes de arrancar.

### Os dois ao mesmo tempo?

Podem correr em paralelo (cada um tem o seu runner e o seu lock), mas partilham a quota da conta: se um bater no limite, ambos pausam e retomam sozinhos quando a janela reabre. Se preferires um de cada vez, arranca o Violet primeiro (é o de nível máximo e o mais longo).

### Se preferires o PC (o mesmo resultado, uma linha por projeto)

Numa janela PowerShell, na pasta do projeto:

- Juniper Hill: `cd C:\dev\juniper-hill` e depois `node C:\dev\forja\bin\forja.mjs runner --goal "<o objetivo do passo 3 acima>"` (o forjalvl alto vem do `SETTINGS.json`; `--forjalvl alto` é redundante mas inofensivo).
- Violet: `cd C:\dev\violet-pier` e depois `node C:\dev\forja\bin\forja.mjs runner --goal "<o objetivo do passo 2 acima>"`.

### O que vais ver e o que fazer

- Primeiras duas sessões de cada run: Product Manager (perfil do produto, perguntas com default), Technology Scout (inventário e decisões) e Architect (plano em `docs\forja\TASKS.json`, com complexidade por task). Depois, uma sessão por task: Dev → Reviewer → (Security Reviewer quando toca em auth, rede ou dependências) → checkpoint em git.
- Perguntas na fila: cada uma tem um default já aplicado. Responder muda o rumo a partir daí; não responder não bloqueia nada.
- No fim: QA valida o conjunto, o Product Manager escreve o relatório do run em `docs\forja\` do projeto, e recebes «run terminado» por ntfy.

### Projeto 3 — Granite (`C:\granite`, pelo PC)

Atenção: o repo tem na raiz ficheiros de credenciais de publicação — o elenco nunca lhes toca, e o objetivo repete-o. Numa janela PowerShell:

1. `node C:\dev\forja\bin\forja.mjs bootstrap "C:\granite"` · `cd C:\granite` · `git add .claude docs\forja CLAUDE.md` · `git commit -m "Forja: bootstrap"`
2. `node C:\dev\forja\bin\forja.mjs forjalvl set alto` · `node C:\dev\forja\bin\forja.mjs autonomy set total` · `git add docs\forja\SETTINGS.json` · `git commit -m "Forja: forjalvl alto, autonomia total"`
3. `node C:\dev\forja\bin\forja.mjs runner --goal "<objetivo do projeto — omitido na versão pública>"`

O objetivo excede os 600 caracteres do campo do telemóvel, por isso este run arranca pelo PC; relançar (sem `--goal`) já pode ser pelo telemóvel.
