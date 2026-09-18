# Kickoff de design — ecrãs novos (histórico, entrar, erro)

Product Designer, 2026-09-16, run `R-20260916-ae6a`, tarefa T4 (secção de design) e T5.
Sem o Sponsor na sala: a escolha está feita, está registada como decisão reversível e ficou na fila
dele para confirmar ou inverter (`Q4`). O run avança na direção A.

## Briefing (de `docs/forja/PRODUCT-PROFILE.md`, não do meu gosto)

- **Quem usa**: 5 pessoas não técnicas, no mesmo escritório e na mesma rede local, em Windows ou no
  telemóvel. Ninguém sabe o que é um cabeçalho HTTP, um terminal ou um ficheiro JSON.
- **O trabalho do ecrã**: escrever um nome, guardar a saudação e ver que ficou guardada — mais o
  contexto de quantas saudações houve por dia.
- **Tom em três palavras**: calmo, direto, honesto (fasquia: 10 segundos até à primeira saudação
  guardada, sem documentação e sem JavaScript no browser).
- **O que o perfil manda evitar**: inglês na UI, stack traces, mensagens sem passo seguinte, cores
  fora da paleta, dependências, webfonts, CDNs, qualquer `http(s)://` na página, mostrar o token.
- **O que tem de ser legível em cinco segundos**: *as saudações da equipa, e onde escrever a próxima.*

Restrições herdadas (não são escolhas minhas): paleta fechada de 5 tokens e tipografia de sistema
(`docs/design/DESIGN.md`), HTML servido pelo servidor com CSS inline e SVG à mão (`TECHNOLOGY.md`
S0.4 e S0.5), gráfico de 14 dias com tabela de texto (D12). Por isso as três direções **não** podem
diferir em paleta nem em tipos de letra: diferem no que vem primeiro, na densidade da lista, no
emparelhamento de tipo (só sans vs sans+mono) e no elemento-assinatura.

## As três direções (mocks reais, com dados reais)

| | A — Lista primeiro | B — Números primeiro | C — Ação primeiro |
|---|---|---|---|
| Ficheiro | `a-lista-primeiro.html` | `b-numeros-primeiro.html` | `c-acao-primeiro.html` |
| Ordem | h1 → formulário → lista → gráfico+tabela | h1 → resumo grande → gráfico+tabela → formulário → lista | h1 → formulário grande entre dois filetes → lista densa → gráfico pequeno |
| Lógica | o registo é o produto; o gráfico é contexto e fica no fim | o resumo é o produto; a app lê-se como um painel | o ato de escrever é o produto; o resto é histórico |
| Tipo | tudo sans; item em duas linhas (saudação 1.125rem / data 0.9375rem em `--muted`) | sans + mono: contagens a 2.5rem em mono, datas da lista em mono | sans nos textos, mono na zona de dados (lista inteira e datas), input a 1.375rem |
| Assinatura | filete de 1 px entre saudações, a página lê-se como um diário | o número grande e as barras como primeira imagem | o campo grande de 56 px e o botão à largura toda |
| Gráfico | `viewBox 546×240`, barras de 24 | `viewBox 546×300`, barras de 26 | `viewBox 546×180`, barras de 16 |
| Dados | os mesmos 31 registos reais gerados por `lib/greet.mjs` e contados por `lib/stats.mjs` (contagens 2,0,3,1,0,4,2,0,5,3,1,0,6,4) | idem | idem |

Nenhuma delas usa gradiente, sombra, cartão, emoji, ícone, pill, animação ou lorem ipsum; nenhuma
introduz cor, tipo de letra, biblioteca ou pedido externo (lista anti-slop do `DESIGN.md`).

## Escolha: **A — Lista primeiro**

Critério 1, a pergunta dos cinco segundos. A é a única em que, a 390 px e sem rolar, se vê ao mesmo
tempo **o que a app é** (saudações da equipa), **onde se escreve** (campo + botão) e **a prova de que
funciona** (as saudações mais recentes). Em B, o primeiro ecrã do telemóvel é ocupado por um número
grande e por catorze barras: quem abre não percebe que pode escrever ali; o formulário está a ~1200 px
do topo no desktop e a dois ecrãs no telemóvel. Em C vê-se o campo, mas o h1 «Nova saudação» esconde
que esta página é também o histórico, e a lista só começa depois do botão.

Critério 2, as prioridades do perfil, por ordem:
- *Simplicidade para quem não é técnico* (prioridade 2): em A, o resultado da ação aparece
  imediatamente por baixo do formulário — depois de `POST /saudacoes` → `303 /historico`, a saudação
  nova é o primeiro item da lista, logo a seguir ao botão que a pessoa acabou de carregar. É o ciclo
  descrito na fasquia de qualidade, sem explicação nenhuma. Em B e C a saudação nova nasce longe do
  botão.
- *Acessibilidade e coerência* (prioridade 5): os itens de A em duas linhas mantêm o corpo a
  1.125rem e a data a 0.9375rem em `--muted`; C põe a lista inteira em monoespaçado a 1rem, que é
  mais difícil de ler para leigos e faz «Olá, Luísa!» parecer saída de um terminal — exatamente o
  contrário do público do perfil. C também alinha a data à direita, o que a 390 px quebra para uma
  segunda linha assim que o nome é longo.
- *Robustez percebida*: em A o bloco do gráfico (SVG + 14 linhas de tabela) fica no fim, por isso a
  tabela obrigatória por D12 nunca empurra a lista para fora do ecrã. Em B a tabela fica entre o
  resumo e o formulário e empurra tudo o resto ~700 px para baixo.

Critério 3, anti-slop: as três passam. Desempate estético: nenhum — A ganha por ordem de leitura, não
por gosto.

**Porque perderam**, numa linha cada: **B** transforma uma app de registo num painel de estatísticas e
enterra a única ação que existe; **C** acerta na ação mas veste os dados de monoespaçado e adia o
histórico, que é o que o perfil diz que a equipa vai ver todos os dias.

Dois ajustes feitos **depois** da escolha, já visíveis nos mocks `escolhida-*` (e nas regras do
`DESIGN.md`), ambos por defeito encontrado na crítica dos PNG:
1. **Contorno dos campos em `--muted`, não em `--line`.** `--line` sobre `--bg` dá 1.33:1; o limite de
   um controlo tem de ter 3:1 (WCAG 1.4.11). `--muted` dá 7.67:1 e não acrescenta cor nenhuma.
2. **Janela toda a zero colapsa o gráfico** para `viewBox 0 0 546 100`: com 14 barras a zero, os 240
   de altura deixavam um retângulo vazio de ~100 px no telemóvel, que parece uma página partida.

## Estados desenhados (mocks `escolhida-*`)

`escolhida-historico.html` (com dados, incluindo um nome de 80 caracteres e um nome com `<script>`
escapado), `escolhida-historico-erro.html` (erro do formulário), `escolhida-historico-vazio.html`
(estado vazio + gráfico todo a zero), `escolhida-entrar.html`, `escolhida-entrar-erro.html`,
`escolhida-erro-401.html`, `escolhida-erro-404.html`, `escolhida-erro-413.html`,
`escolhida-erro-500.html`, `escolhida-grafico.html` (contrato visual do gráfico isolado).

Os PNG estão em `shots/`, a 1440×1000 e a 390×844 (`--mobile`). As regras que saíram daqui estão em
`docs/design/DESIGN.md`, secção «Ecrãs servidos pela aplicação». Os mocks são documentação: não são
importados por nenhum módulo de `lib/` nem servidos pelo servidor.

## Registo

- Decisão (reversível): `direção A (lista primeiro) para histórico/entrar/erro`.
- Fila do Sponsor: `Q4 — confirmar direção A`, com o default já aplicado. Se ele preferir B ou C, o
  Lead re-planeia T4/T5 e o trabalho reverte-se: é código, não é tinta.
