# DESIGN — sample-project (página estática)

Rege `public/index.html`: uma página, um ficheiro, CSS inline, sem JS, sem pedidos externos (D1, D3).
Fundo escuro, tipografia de sistema, uma coluna. Se uma regra daqui não couber num caso novo,
a decisão vai a Bigorna; não se inventa aqui.

## Paleta (contraste calculado com a fórmula WCAG 2.x de luminância relativa)

| Token | Hex | Uso | Contraste em `--bg` |
|---|---|---|---|
| `--bg` | `#14171c` | fundo da página (único fundo; sem superfícies, sem cartões) | — |
| `--text` | `#e6e8eb` | texto corrido, h1 | 14.63:1 |
| `--muted` | `#a3aab4` | texto secundário (rodapé, notas) | 7.67:1 |
| `--accent` | `#6fb3f2` | um só acento: links e `:focus-visible` (sem barras nem traços decorativos) | 8.05:1 |
| `--line` | `#2a2f37` | divisórias de 1 px (decorativo, não transporta texto) | 1.33:1 |

Mínimo para qualquer texto: 4.5:1 (AA). Todos os pares acima passam com folga; não se acrescentam cores.
Nada tem significado só pela cor: um link é sublinhado, o foco tem contorno.

## Tipografia (sistema, sem webfonts, sem `@import`)

- `font-family: system-ui, -apple-system, "Segoe UI", Roboto, Ubuntu, Cantarell, sans-serif;`
- Código (se aparecer): `ui-monospace, "Cascadia Mono", Consolas, Menlo, monospace`.
- Escala: h1 `2rem` (390: `1.5rem`), corpo `1.125rem`, secundário `0.9375rem`; `line-height` 1.2 no h1, 1.6 no corpo.
- `font-weight` 600 no h1, 400 no resto; sem itálico decorativo; sem `letter-spacing` negativo.
- Largura de linha alvo: 60–70 caracteres (garantida pela largura máxima abaixo).

## Layout e espaçamento

- Uma coluna centrada: `max-width: 40rem` (640 px), `margin-inline: auto`, `padding-inline: var(--s-4)`.
- Escala de espaçamento (4 px base): `--s-1: 0.25rem`, `--s-2: 0.5rem`, `--s-3: 1rem`, `--s-4: 1.5rem`, `--s-5: 2.5rem`, `--s-6: 4rem`.
- Ritmo vertical: `padding-block` da página `--s-6` (390: `--s-5`); h1 → descrição `--s-3`; blocos entre si `--s-5`.
- Sem `border-radius` acima de `2px`, sem sombras, sem bordas a envolver texto (um só nível: a página).
- `box-sizing: border-box` em tudo; `img, pre { max-width: 100% }` caso apareçam.

## Responsive (obrigatório a 390)

- `<meta name="viewport" content="width=device-width, initial-scale=1">`.
- Sem scroll horizontal a 390: nenhuma largura fixa em px (tudo o que tiver largura usa `max-width: 100%`); `overflow-wrap: anywhere` no corpo.
- Um único breakpoint: `@media (max-width: 480px)` reduz o h1 e o `padding-block` como indicado acima. Nada mais muda.
- O layout é o mesmo a 1440 e a 390 (uma coluna); só o tamanho de tipo e o respiro encolhem.

## Anti-slop (proibido)

- Gradientes decorativos (fundo, texto, botões), glassmorphism, sombras coloridas.
- Emoji, ícones como decoração, ilustrações stock, imagens de herói.
- Animações e transições de qualquer tipo (também sem `:hover` animado); `prefers-reduced-motion` fica trivialmente respeitado.
- JavaScript, webfonts, CDNs, analytics, qualquer `http://`/`https://` em `src`, `href` ou `@import`.
- Cartões dentro de cartões, "badges", pills, lorem ipsum, texto de marketing que o README não diz.

## Acessibilidade mínima

- `lang="en"`, `<title>`, um único `<h1>`, `<main>` como raiz do conteúdo.
- `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px }`; nunca `outline: none` sem substituto.
- Links sublinhados (`text-decoration-thickness: 1px`, `text-underline-offset: 0.15em`); alvos de toque ≥ 44 px em altura.

## Verificação (definição de feito para qualquer alteração à página)

1. Renderizar a página real e fotografar com o helper do Forja, em ambas as larguras:
   `node "C:/dev/forja/tools/shot.mjs" "file:///C:/dev/forja/examples/sample-project/public/index.html" docs/screenshots/index-1440.png --width 1440 --height 1000`
   `node "C:/dev/forja/tools/shot.mjs" "file:///C:/dev/forja/examples/sample-project/public/index.html" docs/screenshots/index-390.png --width 390 --height 844 --mobile`
2. Abrir os PNG e criticar contra este ficheiro e a lista anti-slop; corrigir; refotografar até não haver nada a corrigir.
3. Os screenshots vivem em `docs/screenshots/` com o nome `index-<largura>.png` e são substituídos a cada alteração.
4. Um relatório sem os dois caminhos de screenshot (1440 e 390) não é um relatório.

---

# Ecrãs servidos pela aplicação — histórico, entrar, erro

Escrito pelo Product Designer em 2026-09-16 (D14, run `R-20260916-ae6a`), depois de três direções
completas em mocks reais: `docs/design/mocks/` (as razões da escolha estão no `README.md` de lá, os
PNG em `docs/design/mocks/shots/`). **Direção escolhida: A — lista primeiro.** A escolha é reversível
e está na fila do Sponsor (`Q4`); enquanto ele não disser o contrário, é isto que se constrói.

**Âmbito.** Esta parte rege as páginas geradas em `lib/pages.mjs` e o gráfico de `lib/chart.mjs`
(T4, T5, T6). **Tudo o que está acima continua a valer, sem exceção**, para `public/index.html` e
também para estas páginas: paleta de cinco tokens, tipografia de sistema, escala de espaçamento,
uma coluna de `40rem`, breakpoint único a 480 px, lista anti-slop, `:focus-visible`, links
sublinhados, alvos de 44 px. Nada aqui abre a porta a uma cor, a um tipo de letra, a uma biblioteca,
a JavaScript no browser ou a um `http(s)://`.

Três — e só três — desvios, válidos apenas nestas páginas novas:

| Desvio | Regra acima | Aqui | Porquê |
|---|---|---|---|
| Idioma | `lang="en"` | `lang="pt"`, todo o texto em português | D13: a app é da equipa, `index.html` mantém-se em inglês (D3) |
| Contorno de um controlo (campo de texto) | filetes em `--line` | `1px solid var(--muted)` | `--line` sobre `--bg` dá 1.33:1; o limite de um controlo precisa de 3:1 (WCAG 1.4.11). `--muted` dá 7.67:1 e não acrescenta cor |
| Filete de um lado só | «sem bordas a envolver texto» | mensagem de erro com `border-left: 2px solid var(--accent)` | um filete lateral não envolve nem cria um segundo nível; é a única forma de marcar um erro sem inventar uma cor |

## 1. Escala de tipo e blocos comuns a todas as páginas novas

Acrescenta-se um nível à escala já existente (h1 `2rem`/600, corpo `1.125rem`, secundário `0.9375rem`):

- `h2`: `1.25rem`, peso 600, `line-height` 1.3, margem inferior `--s-3`. Um `h1` por página, `h2` para
  cada bloco. Não há `h3`.
- Linha de apoio sob o `h1` (classe `lead`): `1rem`, `--muted`, margem inferior `--s-4`.
- Blocos entre si: `margin-top: var(--s-5)` (regra de ritmo já existente).
- Texto secundário (total, ajuda, código do erro, legenda da tabela): `0.9375rem` em `--muted`.

CSS inline a copiar tal e qual (é o dos mocks `escolhida-*`, já fotografado nas duas larguras; os
tokens `--bg/--text/--muted/--accent/--line` e `--s-1…--s-6` são os do topo deste ficheiro):

```css
h2 { margin: 0 0 var(--s-3); font-size: 1.25rem; font-weight: 600; line-height: 1.3; }
.lead { color: var(--muted); font-size: 1rem; margin-bottom: var(--s-4); }
.bloco { margin-top: var(--s-5); }
label { display: block; font-size: 0.9375rem; color: var(--muted); margin-bottom: var(--s-1); }
input[type="text"], input[type="password"] {
  display: block; width: 100%; max-width: 100%; min-height: 44px;
  padding: var(--s-2) var(--s-3); font: inherit; font-size: 1.125rem;
  color: var(--text); background: var(--bg); border: 1px solid var(--muted); border-radius: 2px;
}
input::placeholder { color: var(--muted); opacity: 1; }
input[aria-invalid="true"] { border-color: var(--accent); }
button {
  min-height: 44px; margin-top: var(--s-3); padding: var(--s-2) var(--s-4);
  font: inherit; font-size: 1.125rem; font-weight: 600; color: var(--bg);
  background: var(--accent); border: 1px solid var(--accent); border-radius: 2px; cursor: pointer;
}
.erro-campo { margin: 0 0 var(--s-3); padding-left: var(--s-3);
  border-left: 2px solid var(--accent); font-size: 1rem; }
.erro-campo strong { font-weight: 600; }
.ajuda { margin-top: var(--s-2); color: var(--muted); font-size: 0.9375rem; }
a.acao { display: inline-block; min-height: 44px; padding-block: var(--s-2); }
```

Regras destes blocos:

- **Formulário**: sempre `<label for>` visível por cima do campo (nunca só `placeholder`, nunca
  `aria-label` sozinho). Ordem vertical fixa: `label` → mensagem de erro (se houver) → campo → botão
  → ajuda (se houver). Um único botão por formulário, alinhado à esquerda, largura do conteúdo.
- **Mensagem de erro de um formulário**: `<p class="erro-campo" id="erro-<campo>">` com
  `<strong>` a dizer o que falhou e, na mesma frase, o passo seguinte; o campo leva
  `aria-invalid="true"` e `aria-describedby="erro-<campo>"`. A cor nunca é o único sinal: o texto
  diz tudo e o filete só reforça.
- **Ligação que é uma ação** (ex.: «Ir para a página de entrada»): `<a class="acao">` sublinhado, em
  `--accent`, com 44 px de altura de toque. Nunca um `<a>` com fundo a fingir-se de botão.
- **Nada de hover animado, nada de transições, nada de `:hover` que mude a geometria.**

## 2. Ecrã «histórico» (`GET /historico`)

Ordem de leitura, de cima para baixo — é a decisão central da direção A e não se troca:

1. `<h1>Saudações</h1>`
2. `lead`: «Escreva um nome, carregue no botão e a saudação fica guardada para toda a equipa.»
3. **Formulário** `POST /saudacoes` — `label for="nome"`: «Nome de quem quer cumprimentar»;
   `<input id="nome" name="nome" type="text" maxlength="80" required autocomplete="off"
   placeholder="Ana Sofia">`; `<button type="submit">Guardar saudação</button>`.
4. **Bloco «Saudações guardadas»** (`h2`) — linha de total + lista, ou estado vazio.
5. **Bloco «Saudações por dia»** (`h2`) — SVG + tabela (§3). Fica sempre em último: as 14 linhas da
   tabela nunca podem empurrar a lista para fora do primeiro ecrã.

A saudação acabada de guardar é o **primeiro item da lista**, logo por baixo do botão que a pessoa
carregou. É este o momento-assinatura da página; nada mais se mexe para o assinalar (sem destaque,
sem cor, sem animação).

**Linha de total** (`<p class="total">`, `0.9375rem`, `--muted`, margem inferior `--s-2`):
- até 100 registos: «N saudações no total, M de hoje. As mais recentes primeiro.»
- acima de 100: «N saudações no total, M de hoje. A mostrar as 100 mais recentes.»
- singular quando N = 1: «1 saudação no total, …».

**Item da lista** — duas linhas, sem marcador, separados por filete:

```css
.lista { list-style: none; margin: 0; padding: 0; }
.lista li { padding: var(--s-3) 0; border-bottom: 1px solid var(--line); }
.lista li:first-child { border-top: 1px solid var(--line); }
.lista .saudacao { display: block; font-size: 1.125rem; }          /* --text */
.lista .quando { display: block; color: var(--muted); font-size: 0.9375rem; }
.total { color: var(--muted); font-size: 0.9375rem; margin-bottom: var(--s-2); }
```

Linha 1: a saudação inteira («Olá, Ana Sofia!»), escapada. Linha 2: data e hora por extenso,
`Intl.DateTimeFormat('pt-PT', { timeZone: 'Europe/Lisbon', day: 'numeric', month: 'long',
year: 'numeric', hour: '2-digit', minute: '2-digit' })` → «16 de setembro de 2026 às 15:56». Nunca
mono, nunca alinhado à direita, nunca em duas colunas: um nome de 80 caracteres tem de poder ocupar
três linhas sem partir nada (`overflow-wrap: anywhere` já está no `body`).

**Estado vazio** — substitui a linha de total e a lista (o bloco do gráfico mantém-se):

```html
<p class="vazio">Ainda não há saudações guardadas. Escreva o primeiro nome aqui em cima e carregue
em «Guardar saudação»: aparece já a seguir.</p>
```
```css
.vazio { margin-top: var(--s-3); padding-top: var(--s-3); border-top: 1px solid var(--line);
  color: var(--muted); font-size: 1rem; }
```

**Erro do formulário** (nome vazio, só espaços, ou acima de 80 caracteres): o campo volta vazio e por
cima dele aparece
`<p class="erro-campo" id="erro-nome"><strong>Não foi possível guardar.</strong> Escreva um nome com
1 a 80 caracteres.</p>`. O resto da página (total, lista, gráfico) continua lá, intacto.

## 3. Gráfico dos 14 dias + tabela (contrato exato)

Um só desenho, usado tal e qual pelas duas tarefas. Unidades = unidades do `viewBox`; a régua de
conversão é a largura do conteúdo: **592 px a 1440** (`40rem − 2×--s-4`) e **342 px a 390**
(`390 − 2×--s-4`), logo escala ×1.084 e ×0.626.

| Item | Valor |
|---|---|
| Elemento | `<svg class="grafico" viewBox="0 0 546 240" role="img" width="100%" style="max-width:100%" aria-labelledby="grafico-titulo">` |
| `<title id="grafico-titulo">` | «Saudações por dia, de 3 de setembro a 16 de setembro. Máximo num dia: 6. Total: 31 saudações. Os mesmos números estão na tabela a seguir.» |
| Largura total | `546 = 14 × 39`; passo de coluna 39; centro da coluna *i* = `39·i + 19.5` |
| Barra | `width="24"`, `x = centro − 12`, cor `var(--accent)` |
| Linha de base | `y = 190` (as barras crescem para cima); **não há linha de base contínua** — senão os dias a zero deixam de se ver |
| Topo útil | `y = 28`; altura máxima de barra `162` |
| Altura da barra | `count === 0` → `2` (cor `var(--line)`, ≈1.3 px a 390 e ≈2.2 px a 1440); senão `Math.max(8, Math.round(162 * count / max))` |
| Número por cima | `<text y="<topoDaBarra> − 8" text-anchor="middle" font-size="18">`, `var(--text)`; quando `count === 0`, o «0» fica em `var(--muted)` |
| Data por baixo, linha 1 (dia) | `y = 212`, `font-size="19"`, `var(--muted)`, sem zero à esquerda («3», «16») |
| Data por baixo, linha 2 (mês) | `y = 230`, `font-size="15"`, `var(--muted)`, abreviatura pt de 3 letras: jan fev mar abr mai jun jul ago set out nov dez |
| Janela toda a zero | `viewBox="0 0 546 100"`, base a `y = 50`, rótulos a `72` e `90`; `<title>`: «… nenhuma saudação guardada nestes 14 dias. …». Continuam a existir 14 `<rect>` |

Tamanhos realmente renderizados (medidos nos PNG): número 19.5 px / 11.3 px, dia 20.6 px / 11.9 px,
mês 16.3 px / 9.4 px, altura do bloco 260 px / 150 px (1440 / 390). O mês a 9.4 px é o mais pequeno
da página e é deliberado: o rótulo do eixo é apoio, quem precisa do valor exato lê a tabela, que está
logo a seguir em `0.9375rem`.

Proibido dentro do SVG: `width`/`height` em px, `<animate>`, `<foreignObject>`, gradientes, filtros,
`<style>` com `@import`, tooltips, `title` de hover, `<script>`, qualquer cor fora dos cinco tokens.

**Tabela** (obrigatória, logo a seguir ao SVG, sempre visível — nunca dentro de `<details>`):

```css
.numeros { width: 100%; border-collapse: collapse; margin-top: var(--s-3); font-size: 0.9375rem; }
.numeros caption { text-align: left; color: var(--muted); font-size: 0.9375rem; margin-bottom: var(--s-2); }
.numeros th, .numeros td { padding: var(--s-2) 0; border-bottom: 1px solid var(--line);
  text-align: left; font-weight: 400; }
.numeros thead th { color: var(--muted); }
.numeros td { text-align: right; font-variant-numeric: tabular-nums; }
```

`<caption>`: «Saudações por dia, os mesmos números do gráfico.» Cabeçalho `<th scope="col">Dia</th>`
e `<th scope="col">Saudações</th>`; uma linha por dia com `<th scope="row">` na data
(`Intl.DateTimeFormat('pt-PT', { weekday: 'short', day: 'numeric', month: 'long' })` → «quinta, 3 de
setembro») e `<td>` com o número. Mesma ordem do gráfico: mais antigo em cima, hoje em baixo. Sem
zebra, sem totais, sem células vazias — um dia sem saudações tem `0`.

## 4. Ecrã «entrar» (`GET /entrar`)

1. `<h1>Entrar</h1>`
2. `lead`: «As saudações da equipa estão protegidas por uma palavra-passe, igual para toda a gente.
   Peça-a a quem arrancou o servidor.»
3. Formulário `POST /entrar`: `label for="token"` → «Palavra-passe»;
   `<input id="token" name="token" type="password" autocomplete="off" required>`;
   `<button type="submit">Entrar</button>`.
4. `<p class="ajuda">Fica guardada neste browser até o fechar e nunca sai desta rede.</p>`

Na UI diz-se sempre **palavra-passe**, nunca «token» (o público não é técnico); o campo continua a
chamar-se `token` no HTML, que é o que o servidor lê. Regras que não se negoceiam:

- O valor **nunca** aparece: sem `value=`, sem eco na página, sem o mostrar no erro, sem o pôr no URL.
- A página é igual haja ou não haja palavra-passe configurada, e igual para a primeira tentativa e
  para a décima: **nada na UI diz se existe, quanto falhou ou quão perto esteve**.
- Erro (`401`): `<p class="erro-campo" id="erro-token"><strong>Não foi possível entrar.</strong> A
  palavra-passe não está certa. Confirme-a com quem arrancou o servidor e tente outra vez.</p>`, com
  `aria-invalid="true"` e `aria-describedby` no campo, e o campo vazio.
- Nenhuma ligação para o histórico nesta página (não há nada a mostrar a quem não entrou).

## 5. Ecrã «erro» (401, 404, 413, 500)

Uma só forma para os quatro: `h1` = o que aconteceu, em português corrente e sem número; um `<p>` =
o passo seguinte **numa frase**; depois, quando se aplica, uma ligação de ação; por fim, a linha
discreta `<p class="codigo">Código NNN.</p>` (`0.9375rem`, `--muted`), que existe só para a pessoa
poder dizer ao Sponsor o que viu. Sem stack traces, sem inglês, sem nomes de módulos, sem o URL que
falhou, sem ícone, sem página a piscar.

| Estado | `<h1>` | Passo seguinte (uma frase) | Ligação |
|---|---|---|---|
| 401 | Precisa de entrar | Esta página só abre depois de escrever a palavra-passe da equipa. | «Ir para a página de entrada» → `/entrar` |
| 404 | Esta página não existe | O endereço que abriu não faz parte desta aplicação. Volte às saudações e tente outra vez. | «Voltar às saudações» → `/historico` |
| 413 | O nome que enviou é demasiado grande | Escreva um nome com 80 caracteres ou menos e guarde outra vez. Nada foi gravado. | «Voltar às saudações» → `/historico` |
| 500 | Não foi possível ler as saudações guardadas | Nenhuma saudação se perdeu: o ficheiro ficou exatamente como estava. Peça a quem arrancou o servidor para o verificar e arrancar outra vez. | nenhuma |

Só o 500 mostra um caminho, porque sem ele ninguém consegue arranjar o problema: uma linha
`<p class="codigo">Ficheiro: <code>…</code></p>` antes da linha do código, em `--muted`, com
`code { font-family: ui-monospace, "Cascadia Mono", Consolas, Menlo, monospace; font-size: 0.9375rem }`
e a quebrar (`overflow-wrap: anywhere` do `body`). É o único caminho interno que a UI mostra.
`<title>` da página = o `h1` + « — Saudações».

## 6. Estados que qualquer destas páginas tem de aguentar

| Estado | Como se vê |
|---|---|
| Vazio | §2: frase em `--muted` sob um filete; gráfico colapsado a 100 de altura, com as 14 barras a zero e a tabela toda a `0` |
| Erro de campo | §1: filete `--accent` à esquerda, `<strong>` + passo seguinte, campo com `aria-invalid` |
| Texto longo | nome até 80 caracteres quebra em várias linhas dentro do item; nada de reticências, nada de corte |
| Texto perigoso | `Olá, <script>alert("oi")</script>!` aparece como texto visível e escapado, nunca executado |
| Muitos registos | 100 itens no máximo; a linha de total diz que são os mais recentes de N |
| Carregamento | não existe: a página é servida já pronta, sem JavaScript. Nada pisca, nada roda, nada muda depois de aparecer |

## 7. Do / Don't destes ecrãs

**Do**: português simples em tudo, incluindo `<title>` e mensagens · uma ação por ecrã · dizer sempre
o passo seguinte · `label` visível em cada campo · filete de 1 px em `--line` como única divisória ·
`--accent` só em links, foco, botão principal, barras do gráfico e no filete do erro · fotografar a
1440 e a 390 antes de dizer que está feito.

**Don't** (além da lista anti-slop acima, que continua inteira): inventar uma cor para o erro ou para
o sucesso · usar monoespaçado para a lista de saudações · alinhar datas à direita numa segunda coluna ·
pôr a tabela do gráfico dentro de `<details>` ou escondê-la com CSS · mostrar, ecoar ou insinuar a
palavra-passe · escrever «token», «cookie», «header», «JSON» ou «erro 500» num texto para a equipa ·
fixar larguras ou alturas em px no SVG · pôr o gráfico antes da lista · marcar a saudação nova com
destaque, badge ou animação.

## 8. Verificação destes ecrãs (definição de feito)

Igual à do topo do ficheiro, com os nomes desta parte: HTML gerado para uma pasta temporária e
fotografado por `file://` com `node "C:/dev/forja/tools/shot.mjs" <url>
docs/screenshots/<nome>-<largura>.png --width 1440 --height 1000` e `--width 390 --height 844
--mobile`. Obrigatórios: `grafico-1440` e `grafico-390` (T4); `historico-1440`, `historico-390`,
`historico-vazio-390`, `entrar-1440`, `entrar-390` (T5). Abrir cada PNG, criticar contra esta secção
(ordem dos blocos, tamanhos, filetes, alvos de 44 px, sem scroll horizontal a 390) e refotografar até
não haver nada a corrigir. Referência visual: `docs/design/mocks/shots/escolhida-*.png`.
