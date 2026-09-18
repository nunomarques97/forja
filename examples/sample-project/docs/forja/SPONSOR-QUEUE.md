# Fila para o Sponsor

Perguntas que só o Sponsor pode responder. Cada uma tem o default que o Forja aplicou para não parar. Para responder: pelo viewer (telemóvel ou desktop), ou escreve a resposta na secção da pergunta abaixo (linha "Resposta:") e o Ferreiro recolhe-a com `forja answers`.

## Q1 — should the page be published to a public URL?
Estado: respondida (2026-09-16 20:24)
Aberta em: 2026-09-16 20:23
Run: R-20260916-8a30
Default aplicado: não publicar: public/index.html fica só no repo, aberta localmente
Porquê só o Sponsor: Publicar para fora do repo é categoria 3 (deploy externo, possível custo e exposição); só o Sponsor decide
Resposta: Não publicar. Fica só no repositório.

## Q2 — confirmar a direção visual da página public/index.html: fundo escuro, tipografia de sistema, uma coluna, contraste AA, sem decoração (DESIGN.md mínimo em docs/design/, task T3)
Estado: aberta
Aberta em: 2026-09-16 20:23
Run: R-20260916-8a30
Default aplicado: seguir essa direção; o run constrói a página com ela (D1)
Porquê só o Sponsor: A direção visual é escolha de gosto reservada ao Sponsor (regra global); se preferir outra, T3/T4 são re-planeadas e o trabalho revertido por commit
Resposta:

## Q3 — Pode o servidor de saudações passar a ouvir na rede local (GREET_HOST=0.0.0.0), ficando visível para qualquer aparelho ligado ao mesmo Wi-Fi que tenha o token?
Estado: respondida (2026-09-16 22:32)
Aberta em: 2026-09-16 22:28
Run: R-20260916-ae6a
Default aplicado: Não. O servidor ouve só em 127.0.0.1 (o próprio computador). Tudo o que a equipa vê funciona; para abrir à rede basta arrancar com GREET_HOST=0.0.0.0, passo já documentado no README. Nada tem de ser re-planeado.
Porquê só o Sponsor: Expor um serviço à rede local é exposição de rede e categoria 3: depende do Wi-Fi onde isto vai correr (escritório, casa, rede de convidados) e de quem mais lá está, coisa que só o Sponsor sabe. É reversível numa variável, mas ligar por omissão seria decidir por ele.
Resposta: Sim

## Q4 — confirmar a direcao visual A (lista primeiro) para os ecras novos: historico (formulario no topo, lista a seguir, grafico e tabela no fim), entrar e erro - mocks em docs/design/mocks/shots/
Estado: respondida (2026-09-17 01:07)
Aberta em: 2026-09-16 23:49
Run: R-20260916-ae6a
Default aplicado: direcao A (lista primeiro); D18 e a seccao nova de docs/design/DESIGN.md ja escritas, T4 e T5 constroem com ela
Porquê só o Sponsor: Escolha de gosto visual, reservada ao Sponsor pela regra global. As alternativas B (numeros/grafico primeiro) e C (formulario grande, lista em monoespacado) estao construidas e fotografadas ao lado, para comparar. Se preferir outra, o Lead re-planeia T4/T5 e o trabalho reverte-se: e codigo, nao e tinta. O run avanca em A
Resposta: Decide tu

