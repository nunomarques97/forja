# Feed de eventos-chave: três direções à espera da escolha do Sponsor

> **Public release note.** `feed-dados.js` was a snapshot of the author's real event stream and is not published, so the three `feed-*.html` mocks render empty until you regenerate it from your own data with `node docs/design/mocks/feed-extrair.mjs`. Their screenshots were removed for the same reason.

18 set 2026, Developer. Encomenda do PO: tirar o ruído do viewer e ficar com **uma vista, de todos os projetos
de `data/projects.json`**, que mostre só oito eventos-chave. Isto está em fase de mocks: não há código de
produção e o `DESIGN.md` não foi alterado.

## Os dados são reais

`feed-extrair.mjs` lê `data/events*.jsonl` deste PC e escreve `feed-dados.js` (é o instantâneo de
18 set 2026, 16:11, das últimas 30 h, com 685 eventos-chave em 4 projetos). Para refazer:
`node docs/design/mocks/feed-extrair.mjs --horas 30`. Os três mocks usam o mesmo instantâneo e o mesmo
tradutor (`feed-comum.js`), e as cores e tipos de letra vêm do `DESIGN.md` em vigor.

## De onde vem cada um dos 8 eventos

| # | Evento | Fonte real hoje | Estado |
|---|---|---|---|
| 1 | Um agente chama um subagente | `PreToolUse` com `tool_name: Agent` (`subagent_type`, `description`) | ✅ existe |
| 2 | Arranque do subagente | `SubagentStart` (`agent_type`, `agent_id`) | ✅ existe |
| 3 | Fim do subagente | `SubagentStop` (primeira linha da mensagem = palavra do hand-back) + `task.fail` do runner para as sessões que caíram | ✅ existe |
| 4 | O controlo volta a quem chamou | Nas chamadas síncronas: `PostToolUse` Agent com `status: completed`. **Nas assíncronas (198 das 382) o `PostToolUse` chega logo com `async_launched`**, antes de o subagente fazer seja o que for, por isso não serve. O regresso é **deduzido**: o primeiro gesto do Lead na mesma sessão depois do `SubagentStop` | ⚠️ existe, mas deduzido. Não há um evento próprio para isto |
| 5 | O que ainda não aconteceu | **Não é um evento, é um estado** calculado sobre os mesmos dados: subagente arrancado e sem fim (só conta se a sessão deu sinal há menos de 15 min), `ask` sem resposta, `run.pause` com `resume_at`, `runner.exit` com o run ainda aberto, e a próxima tarefa `todo` no `TASKS.json` do projeto | ⚠️ deduzido. Nada é inventado, mas depende de regras de vivacidade |
| 6 | Veredito do Reviewer | Runs automáticos: `task.done.verdict` (APPROVE) e `task.fail.why` a começar por `REJECT`. Sessões interativas: primeira linha do `SubagentStop` do reviewer | ⚠️ existe, mas em dois sítios. Ver nota A |
| 7 | Escalada para o Sponsor | Eventos Forja `ask` (pergunta, com o default aplicado) e `task.block` | ✅ existe. Ver nota B |
| 8 | Run terminado e relatório entregue | Evento Forja `run.finish` (e `run.fail`) | ✅ existe para os runs automáticos. Ver nota C |

**Não precisamos de hook novo para ver nenhum dos oito.** Faltas encontradas (são para o PO, não foram corrigidas):

- **A. O veredito deixou de vir na mensagem final do Reviewer.** Nos runs mais recentes (cobalt-reef),
  o `last_assistant_message` diz «I approved T004b and sent the verdict to the Lead» e não traz `APPROVE —`.
  Nos runs automáticos o veredito continua a chegar pelo `task.done`/`task.fail`. Nas sessões interativas pode
  perder-se: das 153 paragens de reviewer, 6 não têm veredito legível. Correção barata: o `forja-review` passar
  a exigir que a mensagem final comece pela palavra do veredito. Isto é uma regra da equipa, não um hook.
- **B. `task.block` mistura dois casos.** Bloqueios verdadeiros («precisa do Sponsor para rm») e bloqueios em
  cascata («dependência T4 está bloqueada»). Hoje saem como três cartões vermelhos seguidos, o que é ruído.
  Os mocks mostram-nos tal como estão. Na versão final, a cascata deve juntar-se num único marco.
- **C. Relatório final só nos runs automáticos.** Numa sessão interativa (Lead à mão) não existe `run.finish`.
  O único sinal é o `Stop`, que dispara a cada turno, e usá-lo seria ruído. Para o 8 aparecer também aí, o Lead
  teria de registar o fecho com a CLI (`forja run finish`), que já existe.
- **D. Os títulos das tarefas estão em língua de programador**, com caminhos e códigos
  (`T022a - radar_v08/domain/integrity.py: …`). O `DESIGN.md` já manda que o viewer mostre o título tal como
  vem e que seja quem planeia a escrevê-lo em português de pessoas. Os mocks mostram-nos como estão.

## As três direções (a escolha é de layout e de interação, não de pele)

| | A — Fio | B — Pistas | C — Voltas |
|---|---|---|---|
| Ficheiro | `feed-a-fio.html` | `feed-b-pistas.html` | `feed-c-voltas.html` |
| Ideia | Um único fio cronológico com todos os projetos misturados. No topo, a faixa «Agora» por projeto | Uma coluna por projeto, lado a lado, cada uma com o seu feed. No topo de cada coluna, o que está para acontecer | Os eventos 1 a 4 de uma delegação passam a **uma** linha, a «volta», com uma régua de 4 passos. 6, 7 e 8 são marcos largos. À direita fica «Agora» |
| Evento 5 | Numa faixa à parte, no topo | No topo de cada coluna | **Dentro da volta**, no passo que falta («à espera que o Backend Dev termine»), e também na coluna «Agora» |
| Linhas para 30 h | 685 | 685, repartidas por coluna | cerca de 200 (voltas + marcos) |
| Telemóvel | O mesmo fio | Separadores, um projeto de cada vez | A coluna «Agora» em cima e as voltas por baixo |
| Ponto fraco | 90 % das linhas são de passagem (1 a 4). Vem com o botão «Só o que importa» | Perde a ordem entre projetos. A 1440 cabem 4 colunas, a 5.ª obriga a rolar para o lado | Uma linha é mais alta (a régua ocupa espaço) e esconde a hora exata de cada passo dentro da volta |

Provas: `screenshots/feed-a-1440.png` · `feed-a-390.png` · `feed-b-1440.png` · `feed-b-390.png` ·
`feed-c-1440.png` · `feed-c-390.png` · `feed-c-aprovado-1440.png` (uma volta aprovada e uma rejeitada).

**Recomendação: C — Voltas.** É a única em que o evento 5 aparece no sítio onde vai acontecer, e não numa
lista à parte. Junta quatro linhas numa só sem esconder nenhum dos oito eventos. E mostra com honestidade o
caso real de agora: as voltas do cobalt-reef que ficaram «interrompidas» quando o runner saiu. A é a
alternativa mais simples. B só compensa se o Sponsor quiser ler um projeto de cada vez.

## Conflito a resolver antes de construir

Há um redesenho por fazer no mesmo ecrã, ainda por fazer commit: o **Centro de controlo, direção «Sala»**
(`README-centro.md`, `DESIGN.md` alterado, decisões D5 a D7 com a confirmação do Sponsor pendente). O pedido
de hoje («uma vista só, só eventos») contradiz a Sala (painéis com a constelação da equipa). É preciso decidir:
**o feed substitui a Sala**, ou **o feed é a coluna de eventos ao lado da Sala**, que é onde a coluna «Agora»
da direção C encaixaria.
