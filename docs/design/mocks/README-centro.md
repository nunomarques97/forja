# Centro de controlo do viewer — três direções, uma escolha

> **Public release note.** The `centro-*` screenshots showed the author's private projects and were removed from this public copy; open the three `centro-*.html` mocks in a browser to see the directions (their data file uses placeholder project names).

18 set 2026, Product Designer. Encomenda do Sponsor: «a UI atual é confusa».
O que ele não consegue responder de relance hoje: que projetos estão a
trabalhar, quem da equipa está vivo, quem está à espera, quem morreu, o que o
Lead está à espera, e por onde anda o trabalho — tudo isso só se lê nos painéis
de texto por baixo do grafo, e isso não serve.

**A regra que manda:** abrir a página e responder em menos de 3 segundos a
«que projetos estão a trabalhar · quem está a trabalhar, à espera e parado ·
o que o Lead está à espera · por onde anda o trabalho». Se uma direção não
responde, falhou — por mais bonita que seja.

## Brief (cinco linhas)

- **Quem usa:** o Sponsor, sozinho, sem ninguém a explicar; do PC ao fim
  do dia e do telemóvel a meio do dia. Não é programador e não quer ser.
- **Trabalho do ecrã:** dizer o estado de todos os trabalhos automáticos a
  correr nos vários projetos dele, ao mesmo tempo, sem tocar em nada.
- **Tom:** centro de operações · calmo · em português de pessoas.
- **O que evitar** (`CLAUDE.md`, correção do Sponsor de 18 set): identificadores
  de run e de sessão, texto de prompt, nomes de ficheiro, jargão de linha de
  comandos, contadores técnicos como manchete. «Quanto mais informativo, menos
  ruído visual.»
- **O que tem de ler em 5 segundos:** por projeto — a palavra de estado, quantos
  membros estão a trabalhar/à espera/parados, e de quem o Lead está à espera.

Não existe `docs/forja/PRODUCT-PROFILE.md` neste repositório (o Forja é a
ferramenta, não um projeto arrancado por ela): o brief vem do `CLAUDE.md` e do
`docs/ARCHITECTURE.md`, como nas outras sessões deste repositório.

## Os dados são reais

Instantâneo do redutor (`viewer/lib/state.mjs`) sobre o `data/events.jsonl`
desta máquina, em dois momentos verdadeiros:

| Cena | Momento | O que mostra |
|---|---|---|
| `?cena=agora` (por omissão) | 17 set 2026, 19:12 | **juniper-hill** e **violet-pier** a trabalhar ao mesmo tempo; no juniper-hill o Backend Dev entregou e está à espera de revisão (amarelo real) |
| `?cena=parado` | 18 set 2026, 00:16 | **violet-pier sem sinal há 3 h 49 min** (o runner morreu e ninguém avisou — vermelho real), **juniper-hill** a trabalhar com três pessoas, **granite** fechado |

### Linguagem: o que foi reescrito

O redutor entrega verdade em língua de programador. Os mocks mostram a mesma
verdade em português de pessoas — e essa tradução é parte da direção, não
enfeite:

| O que o sistema tem hoje | O que a página mostra |
|---|---|
| `R-20260917-5e1d`, `14e73f16-…` | *(nada — o identificador vive no painel de detalhe, nunca na vista principal)* |
| `T7b: renderer DOCX em services/render/docx.py, ligado ao ramo elif fmt` | «Gerar o relatório em Word» |
| `a correr: Inspect docx metadata parts` | «a verificar os dados escondidos dentro do ficheiro Word» |
| `a procurar reqwest\|http::\|TcpStream\|hyper\|ureq` | «a procurar ligações à internet no código» |
| `modelo claude-opus-5[1m] · piso fable · forjalvl alto` | «Modelo forte (o mais capaz)» — e só no painel de detalhe |
| `sem resposta · 3766 eventos · 8 erros` | «Sem sinal nenhum há 3 h 49 min» |

## As três direções

Ficheiros: `centro-dados.js` (dados e geometria, partilhados) +
`centro-a-sala.html` · `centro-b-mapa.html` · `centro-c-linha.html`.
Servir com um servidor estático e abrir; `?cena=parado` mostra a segunda cena,
`?detalhe=1` (direções A e B) abre o painel de detalhe.

### A — «Sala» *(escolhida)*
Uma mesa por projeto, painéis iguais lado a lado, e dentro de cada painel a
equipa como constelação com o Lead ao centro. Assinatura: a **lombada** — a
faixa grossa no topo do painel, na cor do estado do projeto.
Tipos: Barlow Condensed + Barlow. Paleta: a casa (castanho escuro) + as cores de sinal.
Provas: `screenshots/centro-a-1440.png` · `centro-a-390.png` ·
`centro-a-parado-1440.png` · `centro-a-detalhe-1440.png`.

### B — «Mapa»
Um único plano que se arrasta e se aproxima; cada projeto é uma **ilha**.
Assinatura: o **anel da ilha** — dez riscos à volta do projeto, um por membro
da equipa, na cor do sinal, legível quando os nomes já não se leem.
Tipos: Space Grotesk + IBM Plex Sans. Paleta: grafite frio.
Provas: `screenshots/centro-b-1440.png` · `centro-b-390.png` · `centro-b-parado-1440.png`.

### C — «Linha»
Sem grafo: cada projeto é uma linha de montagem horizontal e todas as linhas
partilham as mesmas quatro etapas nas mesmas colunas (Planear · Construir ·
Rever · Fechar). Assinatura: o **cursor de etapa** — o bloco aceso que diz onde
o trabalho está agora e que se alinha na vertical entre projetos.
Tipos: Archivo + Public Sans. Paleta: grafite neutro.
Provas: `screenshots/centro-c-1440.png` · `centro-c-390.png` · `centro-c-parado-1440.png`.

## A escolha: **A — Sala**

Julgadas primeiro pela pergunta dos 3 segundos, depois pelos sete requisitos do
Sponsor, depois pela lista de *slop*.

| | A — Sala | B — Mapa | C — Linha |
|---|---|---|---|
| Ver dois projetos ao mesmo tempo, a 1440 | sim, painéis iguais | sim | sim, mas duas linhas enchem o ecrã |
| … a 390 | sim (o 1.º inteiro + o 2.º a começar) | **não** — uma ilha de cada vez | uma linha de cada vez |
| … com três projetos | sim (o 3.º entra na grelha) | **colide** com os comandos flutuantes | o 3.º fica cortado |
| Estado no próprio nó | disco cheio, a coisa maior do painel | sim, mas pequeno | não há nós — há pastilhas com texto |
| Quem é quem sem tocar | nome debaixo de cada nó | **só o monograma**; nome só ao aproximar | nome completo em todos |
| Caminho ativo do trabalho | linha acesa com pontos | linha acesa | **não existe** |
| Onde anda o trabalho | frase («à espera do QA») | frase | **coluna acesa** — o melhor dos três |
| Ecrã inteiro / aproximar / arrastar | botões por painel + global | **nativo, o melhor dos três** | botões globais |
| Ruído | baixo | muito baixo | médio-alto (muito texto) |

**Porquê A.** É a única em que as quatro respostas aparecem **ao mesmo tempo,
sem tocar em nada, nos dois tamanhos**: a palavra de estado por projeto, as
contagens verde/amarelo/vermelho, o nó aceso com o nome por baixo e a frase «O
Lead está à espera do Security Reviewer». No telemóvel, o primeiro projeto cabe
inteiro num ecrã — incluindo o grafo — e o segundo começa logo a seguir; é o
ecrã onde o Sponsor mais olha. Com três projetos a grelha cresce sem partir
nada. E a cena continua a ser SVG + CSS, sem biblioteca nenhuma (decisão S1).

**Porque perdeu B.** É a mais bonita e a que melhor faz «mapa» (aproximar,
arrastar, enquadrar) — e é por isso que lhe roubei os comandos. Mas troca
informação por atmosfera: no zoom de ver tudo, quem é quem só se sabe pelo
monograma de duas letras, e o anel de dez riscos precisa de legenda para se
ler. Com três projetos o plano livre passa a colidir com os comandos flutuantes
(está no screenshot `centro-b-parado-1440.png`: a terceira ilha teve de fugir
para um canto). E no telemóvel perde a simultaneidade: mostra um projeto de
cada vez. Isso mata o requisito 1 exatamente no ecrã onde ele mais importa.

**Porque perdeu C.** Responde melhor do que ninguém a «em que etapa vai cada
projeto» — e é por isso que lhe roubei a linha das etapas. Mas o Sponsor pediu
que **o grafo** passasse a dizer o estado, e em C não há grafo: há listas de
pastilhas com texto, o mesmo problema que ele está a tentar resolver (estado
que só se lê a ler). Não tem caminho ativo (requisito 4) e cada projeto custa
420 px de altura, pelo que o terceiro fica sempre por baixo da dobra.

**O que a escolhida leva dos outros dois** (está no `DESIGN.md`):
1. de B, os comandos de mapa a sério — aproximar, arrastar, enquadrar, ecrã
   inteiro, focar um projeto — e o anel de dez riscos como forma **encolhida**
   de um projeto quando há mais de três;
2. de C, a linha das quatro etapas (Planear · Construir · Rever · Fechar) como
   uma linha fina no cabeçalho do painel, a dizer onde o trabalho vai.

## Lista de *slop* — verificada

Sem creme+serifa+terracota · sem verde-ácido sobre preto (o verde é `#45D48A`
sobre castanho escuro, 10,3:1) · sem grelha de jornal · sem gradiente roxo-azul
· sem vidro · sem emoji (os glifos são formas SVG; os comandos usam palavras) ·
sem cartões dentro de cartões (os blocos interiores são blocos com filete, sem
contorno nem raio) · sem *lorem ipsum* (todo o conteúdo é o instantâneo real,
traduzido) · sem texto cortado nem estados indistinguíveis a 390.

Contrastes medidos sobre `--bg #0E0C0B`: verde 10,26:1 · amarelo 10,36:1 ·
vermelho 5,98:1 · cinzento 7,11:1 · texto principal 16,3:1. Texto escuro
`#12100E` sobre os preenchimentos: 9,98 / 10,08 / 5,82:1.

## O que tem de ser decidido pelo Sponsor (não decidi por ele)

1. **A escolha da direção.** Fica registada como decisão reversível com A por
   omissão (`forja decide` + `forja ask`): gosto visual é dele.
2. **Verde deixa de querer dizer «terminado».** Até hoje, no viewer,
   `--patina` (verde) queria dizer *terminado* e `--ember` (laranja) *a
   trabalhar*. O pedido dele — «GREEN = a trabalhar» — obriga a trocar: verde
   passa a ser *a trabalhar agora* e *terminado* passa a cinzento. É uma
   mudança de vocabulário, não de gosto, mas muda o que ele já aprendeu a ler.
3. **As cores de identidade saem dos nós.** Cada papel tinha a sua cor
   (Reviewer aço, Architect ardósia…). Com o estado a mandar na cor do nó, a
   identidade passa a ser só o nome e o monograma. Ganha-se um sinal
   inequívoco, perde-se a cor por pessoa.
4. **As ligações passam a mudar com o estado.** O `DESIGN.md` proibia-o
   expressamente («uma aresta não é evidência de nada»). O requisito 4 dele
   manda acender o caminho ativo. Acendemos **uma** ligação — a que liga o Lead
   a quem ele está mesmo à espera, e a entrega que acabou de acontecer —, nunca
   ligações inventadas.
5. **Quatro bandas, não três.** Verde/amarelo/vermelho são as dominantes, como
   ele pediu, mas «já entregou» e «ainda não foi preciso» ficam em **cinzento
   neutro**: se um Reviewer que aprovou e um QA que ainda não foi chamado
   ficassem vermelhos, um run terminado com sucesso apareceria em alarme e o
   vermelho deixava de querer dizer «vai lá ver». Proposta com cuidado, como
   ele pediu; é reversível numa linha.
6. **Mapa a sério (arrastar e aproximar de verdade) precisa do Technology
   Scout?** Não: mexer o `viewBox` de um `<svg>` com eventos de ponteiro é
   plataforma pura e cabe na decisão S1 (sem biblioteca). O que **fica fora**
   da S1 é layout automático por forças/física — e o `DESIGN.md` continua a
   proibi-lo: as posições são fixas e estão escritas.
