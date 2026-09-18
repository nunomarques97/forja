# Roadmap do Sponsor — coisas que só o Sponsor pode fazer

Cada item: porque é preciso, o que acontece até o fazeres (o default que o Forja aplicou), e o caminho exato, passo a passo, sem alternativas. Quando fizeres um item, marca-o `[feito]`.

## 1. [feito pelo Lead em 17 set 2026, com autorização do Sponsor] Ligar o auto-continuar em limite de utilização

**Porquê:** quando a sessão principal do Claude Code chega a um limite de utilização do claude.ai, esta chave faz a sessão esperar e retomar sozinha quando o limite repõe, em vez de parar. É uma chave de âmbito **utilizador** — o Forja não a consegue pôr nas settings do projeto, e esta sessão não edita os teus ficheiros globais.

**Até fazeres:** um run que bata no limite pára com uma notificação "Forja parou: sem quota"; retomas colando o prompt de `node bin/forja.mjs resume` (ver `docs/RUNBOOK-UNATTENDED.md`).

**Passos:**
1. Abre o ficheiro `%USERPROFILE%\.claude\settings.json` no Bloco de Notas.
2. Encontra a linha que diz `"model":` e acrescenta, na linha imediatamente acima dela, esta linha (com a vírgula no fim):
   ```
   "autoContinueAtUsageLimit": true,
   ```
3. Guarda o ficheiro. Fecha e volta a abrir o Claude Code. Se o Claude Code se queixar do ficheiro ao arrancar, apaga a linha que acrescentaste e diz-me numa sessão: "o roadmap item 1 deu erro".

## 2. Tailscale — acesso permanente e privado ao viewer pelo telemóvel (15 minutos, PC + telemóvel)

**Porquê:** hoje o viewer chega ao telemóvel por um túnel público gratuito (URL aleatória, enviada por ntfy sempre que muda; desde 17 set 2026 o link já não leva o token — colas o token na página de entrada). Funciona, mas quem souber o tópico do ntfy fica a saber a URL, e a URL muda em cada arranque, o que te obriga a colar o token outra vez. O Tailscale cria uma rede privada só tua, sem túnel público, com endereço fixo. Exige conta e instalação nos dois lados — só tu o podes fazer.

**Até fazeres:** o túnel gratuito continua a funcionar; o link que recebes por notificação já não leva o token (quem souber o tópico vê o endereço, mas não entra), e por isso colas o token de `data\viewer-token.txt` uma vez em cada link novo do túnel — com o Tailscale o endereço passa a ser fixo e nunca mais o voltas a colar. O token roda com `node bin/forja.mjs token rotate` se alguma vez suspeitares de fuga.

**Passos:**
1. No PC, abre https://tailscale.com/download/windows, descarrega e instala. Inicia sessão com a tua conta Google (a mesma que vais usar no telemóvel).
2. No telemóvel (Android), instala "Tailscale" da Play Store e inicia sessão com a mesma conta.
3. No PC, abre o Tailscale (ícone na barra), clica no nome da máquina e copia o endereço `100.x.y.z`.
4. No telemóvel, abre `http://100.x.y.z:4317/m?k=<token>` — o token está em `C:\dev\forja\data\viewer-token.txt`. Guarda esse link nos favoritos.
5. Diz numa sessão do Forja: "Tailscale instalado, desliga o túnel público" — o Lead muda `forja up` para não abrir túnel.

## 3. Apagar a skill antiga a nível de utilizador (1 minuto)

**Porquê:** `%USERPROFILE%\.claude\skills\forja-architect\SKILL.md` era uma versão antiga das regras de escolha de tecnologia, ativa em **todos** os projetos. As regras vivem agora dentro do Forja (`.claude/skills/forja-product`), instaladas por projeto pelo bootstrap. A cópia antiga só confunde.

**Até fazeres:** nada parte; duas versões parecidas das mesmas regras podem carregar ao mesmo tempo num projeto Forja.

**Passos:**
1. Abre a pasta `%USERPROFILE%\.claude\skills\`.
2. Apaga a pasta `forja-architect`. Feito.

## Notas (decisões desta sessão que te dizem respeito, sem ação necessária)

- **Binário `cloudflared` dentro do repo.** A tua regra global diz "nunca instalar nada"; a instrução escrita desta sessão pediu um túnel gratuito sem conta. Conciliação: o binário do Cloudflare quick tunnel foi descarregado para `C:\dev\forja\tools\cloudflared\` (pasta ignorada pelo git), sem instalação de sistema, sem PATH, sem registo. Apagar essa pasta desfaz tudo. O item 2 (Tailscale) substitui isto de vez.
- **Arranque automático no login do Windows.** `forja autostart install` põe um atalho na tua pasta de Arranque (`shell:startup`) para o viewer e o túnel arrancarem quando fazes login. `forja autostart remove` tira-o.

## 4. [feito pelo Lead em 17 set 2026, com autorização do Sponsor] Baixar o effort das sessões interativas de `max` para `high`

**Porquê:** nesta sessão de hardening o orquestrador correu em Fable 5.1 com effort `max`, e todos os subagentes herdam o effort da sessão (a ferramenta que os abre não tem esse parâmetro) — foi a combinação mais cara possível e explica a quota a esvaziar depressa. Para runs pelo runner não é preciso: cada sessão leva o seu `--effort` calculado por nível e complexidade.

**Até fazeres:** as sessões interativas continuam em `max` (mais caras, ligeiramente mais cuidadosas).

**Passos:**
1. Abre `%USERPROFILE%\.claude\settings.json` no Bloco de Notas.
2. Encontra a linha `"effortLevel": "max"` e muda para `"effortLevel": "high"`. Guarda.
3. Em alternativa, sem mexer no ficheiro: arranca a sessão com `claude --effort high`.

## 5. Rodar o token do viewer uma vez (2 minutos, PC + telemóvel)

**Porquê:** até 17 set 2026 o viewer imprimia o endereço com o token no arranque e o hook do Claude Code gravava essa linha em `data\events.jsonl` (ficheiro local, ignorado pelo git, mas que segue em transcrições e colagens). O Security Reviewer encontrou o token atual lá. O Lead corrigiu a impressão, mas não rodou o token nessa altura porque tinha acabado de ser guardado no telemóvel; gerar credenciais é ação tua.

**Até fazeres:** o token atual continua válido e fica em texto claro nos registos do PC. Nota: o token já foi rodado uma vez às 01:11 de 17 set por um agente durante a correção de segurança (o Lead entregou o novo por mensagem), mas o Lead leu-o com um comando para o enviar e o hook gravou essa linha em `data\events.jsonl` — por isso este item continua a valer: roda-o tu, uma vez, sem o imprimir (o comando abaixo não o mostra). Risco baixo (ficheiro local), mas real se partilhares um `events.jsonl` com alguém.

**Passos:**
1. No PC, numa janela de comandos: `node C:\dev\forja\bin\forja.mjs token rotate`
2. Depois: `node C:\dev\forja\bin\forja.mjs down` e a seguir `node C:\dev\forja\bin\forja.mjs up` (o viewer só lê o token novo ao arrancar).
3. No telemóvel, abre o endereço novo que chega por ntfy e cola o token novo (está em `C:\dev\forja\data\viewer-token.txt`).

## 6. Acompanhar os runs do runner na app do Claude — **feito (opt-in)**

**Pedido (17 set, 05:00):** ver as sessões dos runs também na app do Claude Code, não só no viewer.

**Feito (17 set 2026, task T-VIS-1):** acrescenta `--visivel` ao comando do runner e cada fase passa a correr como sessão de fundo, que aparece na app enquanto trabalha:

```text
node C:\dev\forja\bin\forja.mjs runner --goal "o que queres que fique feito" --visivel
```

Fica desligado por omissão (é o `--visivel` que o liga, run a run). O que vês na app: uma entrada por fase, chamada `forja <id do run> <fase>`, que desaparece quando a fase acaba. O que **não** deves fazer: escrever nessa sessão pelo telemóvel (a tua mensagem entra no fim do turno e desvia a fase — as perguntas para o Forja respondem-se na fila do viewer) nem pará-la à mão (gasta uma tentativa da task). Detalhes e avisos: `docs/RUNBOOK-UNATTENDED.md` §2, parágrafo «Ver as sessões na app do Claude». Porque não é o modo por omissão: a resposta do modelo passa a ser lida de um ficheiro interno do Claude Code em vez do stdout, e o comportamento em pedidos de permissão e em limite de utilização muda — o Technology Scout (decisão S2) pediu um run inteiro em dogfood antes de se pensar em trocar o modo por omissão. Uma coisa fica por confirmar e só tu a podes ver, num toque: **como fica a entrada na app ao vivo e depois de a fase acabar** — se ficar estranha, diz e ajusta-se o nome ou a limpeza.

**Facto (documentação oficial do Claude Code 2.1.x), que continua a valer no modo normal:** as sessões que o runner abre sem `--visivel` são `claude -p` (sem janela) e por desenho não aparecem no seletor de sessões, na app nem em claude.ai/code; o Remote Control (`claude --rc`, `/rc`) só funciona em sessões interativas ou de fundo (`--bg`). Não há flag que junte `-p` e a app.

**O que já dava sem código (e continua a dar no modo normal):**
1. **Depois de cada sessão acabar**, abrir a conversa dela como se fosse normal: no PC, numa janela PowerShell na pasta do projeto, `claude --resume <id>` — os ids completos estão em `docs\forja\RUN.json` do projeto (lista `sessions`, por ordem). Aí podes ler tudo o que o Lead dessa fase fez e disse.
2. **Modo acompanhado em vez de runner:** abrir tu uma sessão interativa na pasta do projeto (`claude` no PowerShell, com o Remote Control já ligado nas tuas definições — `remoteControlAtStartup: true`) e colar o prompt de Lead interativo do runbook §2. Segues a sessão pelo telemóvel na app. Perdes o que o runner dá: rotação de contexto por fase, pausa e retoma por limite sem ti, guarda de sessões penduradas. Serve para um run curto que queres ver de perto, não para deixar a correr sozinho.

**O que continua a ser código por fazer (só se pedires):** o viewer mostrar, por sessão terminada, o comando `claude --resume <id>` pronto a copiar; ou um botão «abrir no PC» que lança a sessão resumida numa janela.

**Nota:** hoje os dois runners escrevem no mesmo `data\runner\runner.log` (as linhas dizem o projeto no nome do ficheiro da sessão); um registo por projeto é uma melhoria pequena, também só se pedires.
