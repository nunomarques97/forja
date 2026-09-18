# sample-project

sample-project is two things at once: the fixture Forja uses to validate `forja bootstrap` against
something real, and a small Node app a non-technical team uses to record and browse greetings in
Portuguese. It has grown past "one module, one test" — see the file list below — but stays
dependency-free and is still tested only with `node --test`.

## Como usar

Para quem só quer usar a aplicação, sem saber programar. Os comandos são para o Command Prompt do
Windows (`cmd.exe`); copie-os tal como estão.

### 1. Criar a palavra-passe (só da primeira vez)

Abra uma janela de terminal nesta pasta (a pasta onde está este ficheiro `README.md`) e escreva:

```
node -e "console.log(require('node:crypto').randomBytes(24).toString('base64url'))"
```

Aparece uma linha de texto — essa é a palavra-passe. Copie-a e cole-a, sozinha, dentro de um
ficheiro novo chamado `token.local.txt`, guardado nesta mesma pasta. Feche o ficheiro. Essa
palavra-passe é a que toda a equipa vai usar para entrar; não a partilhe fora da equipa e não a
escreva em nenhum outro lado (email, chat, etc.).

### 2. Arrancar o servidor

```
npm start
```

O terminal mostra o endereço a abrir, por exemplo `http://127.0.0.1:8080/`. Deixe esta janela
aberta — é ela que mantém o servidor a funcionar.

### 3. Abrir a página e entrar

Abra esse endereço num browser. Cole a palavra-passe do `token.local.txt` na página «Entrar» e
carregue no botão.

### 4. Registar uma saudação

Escreva um nome no campo e carregue em «Guardar saudação». A saudação nova aparece logo a seguir,
no topo da lista.

### 5. Parar o servidor

Volte à janela do terminal onde correu `npm start` e prima `Ctrl+C`.

### Onde ficam as saudações

Todas as saudações ficam guardadas no ficheiro `data/greetings.json`, dentro desta pasta. **Nunca
apague este ficheiro.** Se quiser um backup, copie-o (não o mova) para outro sítio de vez em
quando.

### Abrir à equipa toda, na mesma rede local

Por omissão, só o computador onde correu `npm start` consegue abrir a página. Para que os colegas
na mesma rede (o mesmo Wi-Fi do escritório, por exemplo) também consigam, arranque assim:

```
set GREET_HOST=0.0.0.0 && npm start
```

A partir daqui, o terminal passa a mostrar mais uma linha por cada endereço deste computador, por
exemplo:

```
Para os colegas na mesma rede: http://192.168.1.23:8080/
```

É esse endereço — não o `127.0.0.1` de cima — que se dá aos colegas: eles abrem-no no browser
deles e colam lá a palavra-passe, tal como no computador onde o servidor está a correr. Se houver
mais do que um endereço, aparece uma linha por cada um; qualquer um deles serve. Este endereço pode
mudar quando o computador muda de rede (outro Wi-Fi, outro escritório) — nesse caso volte a ver o
que o terminal mostra da próxima vez que arrancar o servidor.

Se em vez disso aparecer a frase «Não encontrei nenhum endereço de rede local neste computador»,
corra `ipconfig` numa outra janela de terminal e procure a linha «Endereço IPv4»; é esse o endereço
a dar aos colegas, na mesma forma `http://<esse endereço>:8080/`.

**Aviso:** com isto, qualquer pessoa na mesma rede que tenha a palavra-passe consegue entrar. Só
faça isto numa rede de confiança.

### Mudar a porta

Se a porta 8080 já estiver ocupada por outro programa, escolha outra porta:

```
set GREET_PORT=8090 && npm start
```

### Se aparecer esta mensagem

Cada mensagem já diz o passo seguinte; esta lista só ajuda a encontrar a mensagem certa.

- **Sem palavra-passe, ou demasiado curta, ao arrancar o servidor** — no terminal aparece uma frase
  como:
  > Não há token de acesso: a variável GREET_TOKEN não está definida e o ficheiro do token não
  > existe. Passo seguinte: crie o ficheiro token.local.txt na raiz do projeto (…) com um token de
  > pelo menos 16 caracteres, como explica o README, e arranque o servidor outra vez.

  ou, se o ficheiro já existir mas tiver poucos caracteres:
  > O token de acesso no ficheiro do token é demasiado curto: precisa de pelo menos 16 caracteres.
  > Passo seguinte: escreva um token de pelo menos 16 caracteres no ficheiro token.local.txt na
  > raiz do projeto (…), como explica o README, e arranque o servidor outra vez.

  Passo seguinte: siga a secção 1 acima e crie (ou reescreva) `token.local.txt` com uma linha só,
  de pelo menos 16 caracteres.

- **Ficheiro de dados ilegível, ao arrancar o servidor** — no terminal:
  > O ficheiro de dados não pôde ser lido: … Motivo: … . O ficheiro ficou intacto e nada foi
  > gravado. Passo seguinte: guarde uma cópia do ficheiro, corrija-o para ser uma lista JSON (por
  > exemplo `[]`) ou mude-o de sítio, e tente outra vez.

  O mesmo problema, já com o servidor a correr, aparece na página como:
  > Nenhuma saudação se perdeu: o ficheiro ficou exatamente como estava. Peça a quem arrancou o
  > servidor para verificar o ficheiro … e arrancar outra vez.

  Passo seguinte: nada foi apagado nem escrito por cima — copie `data/greetings.json` para outro
  sítio antes de o corrigir, e só depois arranque outra vez.

- **Porta ocupada, ao arrancar o servidor** — no terminal:
  > A porta 8080 já está a ser usada por outro programa. Passo seguinte: escolha outra porta com a
  > variável GREET_PORT e arranque o servidor outra vez.

  Passo seguinte: use o comando da secção «Mudar a porta» acima com outro número.

- **401 na página («Precisa de entrar»)** — ao tentar abrir uma página sem ter entrado (ou depois
  de a sessão ter saído do browser):
  > Esta página só abre depois de escrever a palavra-passe da equipa.

  Ou, ao entrar com a palavra-passe errada:
  > Não foi possível entrar. A palavra-passe não está certa. Confirme-a com quem arrancou o
  > servidor e tente outra vez.

  Passo seguinte: carregue em «Ir para a página de entrada» (ou abra `/entrar`) e volte a colar a
  palavra-passe certa.

- **403 («o pedido não veio desta aplicação»)** — ao carregar em «Entrar» ou em «Guardar saudação»
  vindo de uma página aberta há muito tempo ou de outro sítio:
  > O pedido não veio da página desta aplicação. Abra outra vez a página de entrada e tente de
  > novo.

  Passo seguinte: abra `/entrar` de novo (ou recarregue a página) e repita a ação.

- **413 ou 400 no formulário («o nome que enviou é demasiado grande» / campo por preencher)** — ao
  tentar guardar um nome vazio ou com mais de 80 caracteres:
  > Escreva um nome com 80 caracteres ou menos e guarde outra vez. Nada foi gravado.

  ou, mostrado junto ao próprio campo:
  > Não foi possível guardar. Escreva um nome com 1 a 80 caracteres.

  Passo seguinte: escreva um nome com 1 a 80 caracteres e carregue outra vez em «Guardar
  saudação».

## Files

- `server.mjs` — entry point (`npm start`): validates the token and the data file before
  listening, then prints the address to open and how to stop.
- `lib/greet.mjs` — `greet(name)` / `greetAll(names)`.
- `lib/slug.mjs` — `slugify(text)`, a URL-friendly slug helper (see below).
- `lib/store.mjs` — durable JSON store: atomic writes (temp file + fsync + rename), retried on
  Windows file locks, an unreadable file is never overwritten.
- `lib/auth.mjs` — the access token: loading it (env or `token.local.txt`), constant-time
  comparison, and the session cookie parsed/written by hand.
- `lib/stats.mjs` — greetings-per-day counts, grouped in `Europe/Lisbon`, last 14 days.
- `lib/html.mjs` — `escapeHtml(s)`, used everywhere user-supplied text reaches an HTML page.
- `lib/chart.mjs` — the 14-day SVG bar chart plus its text table.
- `lib/pages.mjs` — the three pages served by the app: histórico, entrar, erro.
- `lib/app.mjs` — `createApp()`, the HTTP routes (`/`, `/entrar`, `/historico`, `/saudacoes`).
- `test/greet.test.mjs`, `test/slug.test.mjs`, `test/store.test.mjs`, `test/auth.test.mjs`,
  `test/stats.test.mjs`, `test/chart.test.mjs`, `test/pages.test.mjs`, `test/app.test.mjs`,
  `test/server.test.mjs` — run with `npm test` (`node --test`).
- `public/index.html` — the static page: one file, inline CSS, no JavaScript (see below).
- `docs/design/DESIGN.md` — the design rules for the static page and for the app's own pages, and
  the exact screenshot commands.
- `docs/screenshots/` — real screenshots at 1440 and 390 for the static page and for the app's
  pages (histórico, entrar, gráfico, and the error states), re-taken on every visual change.
- `CLAUDE.md` — two rules of its own; the bootstrap must leave them untouched and only manage the
  block between `<!-- forja:begin -->` and `<!-- forja:end -->`.
- `.claude/` and `docs/forja/` — what `node <forja>/bin/forja.mjs bootstrap examples/sample-project`
  produces (committed as the example). Running it again reports everything `unchanged`.

## slugify and the static page

### `slugify(text)` — `lib/slug.mjs`

A named export with no imports (decision D2 in `docs/forja/DECISIONS.md`). It turns any value into a slug by applying these steps, in this order:

1. `String(text ?? "")` — `null` and `undefined` become `""`; anything else is stringified.
2. Lower case.
3. Unicode NFD normalisation, then every combining mark is removed (`á` → `a`, `ç` → `c`).
4. Every run of characters outside `[a-z0-9]` — spaces, punctuation, symbols, anything non-ASCII left after step 3 — becomes a single hyphen.
5. Leading and trailing hyphens are dropped.

So `""`, `null`, `undefined`, and inputs made only of spaces or punctuation all return `""`.

```js
import { slugify } from './lib/slug.mjs';

slugify('Olá, São Paulo!');          // 'ola-sao-paulo'
slugify('  Versão 2.0 -- final!! '); // 'versao-2-0-final'
slugify(null);                       // ''
```

To check one value from the project root:

```
node -e "import('./lib/slug.mjs').then(({ slugify }) => console.log(slugify('Olá, São Paulo!')))"
```

prints `ola-sao-paulo`.

### Running the tests

```
npm test
```

runs `node --test`, which picks up every `test/*.test.mjs` file. Nothing to install.

### The static page — `public/index.html`

A single HTML file with inline CSS, no JavaScript and no external requests: the project name and a one-sentence description on a dark background. It follows `docs/design/DESIGN.md` (palette, type scale, spacing, the anti-slop list). It is meant to be opened locally, not served or published.

To open it, double-click `public/index.html` or, from the project root on Windows:

```
start public/index.html
```

Whenever the page changes, re-take both screenshots with the Forja helper (`tools/shot.mjs` in the Forja repo listed in `CLAUDE.md`; it drives the local Chrome headless, nothing to install). Run these from the project root so `docs/screenshots/` resolves — they are the exact commands from the "Verificação" section of `docs/design/DESIGN.md`:

```
node "C:/dev/forja/tools/shot.mjs" "file:///C:/dev/forja/examples/sample-project/public/index.html" docs/screenshots/index-1440.png --width 1440 --height 1000
node "C:/dev/forja/tools/shot.mjs" "file:///C:/dev/forja/examples/sample-project/public/index.html" docs/screenshots/index-390.png --width 390 --height 844 --mobile
```

Then open both PNGs and check them against `DESIGN.md`; the 390 one must show no horizontal scroll. The screenshots are committed, so a change to the page always comes with new `index-1440.png` and `index-390.png`.
