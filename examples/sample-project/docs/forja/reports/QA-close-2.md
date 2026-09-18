QA PASS — o objetivo do run cumpre-se ponta a ponta no produto real (134/134 testes, fluxos, 12 ecrãs a 1440 e 390, robustez e $0); sem bloqueadores nem graves, 6 findings menores.

**Correu** (tudo a partir de `C:\dev\forja\examples\sample-project`)
- `npm test` sem `GREET_TOKEN` no ambiente, no início e no fim → `tests 134 / pass 134 / fail 0`, idêntico nas duas corridas.
- `npm run check` no repo Forja → `check ok — 339 ficheiros versionados, elenco do sample idêntico, política de modelos numa fonte só, 3400 eventos reproduzidos sem linhas más`.
- `node bin/forja.mjs bootstrap examples/sample-project --dry-run` → `created [] updated []`; papel de fixture (D16) intacto.
- Arranque real (`node server.mjs`, token fictício em `GREET_TOKEN`, ficheiro de dados em pasta temporária; nunca criei nem li `token.local.txt`, e o `data/` do projeto está como estava).
- Fail-closed no arranque: sem palavra-passe → frase PT + `exit 1`; 15 caracteres → frase PT + `exit 1`; ficheiro de dados ilegível → frase PT + `exit 1` e md5 igual antes e depois; porta ocupada → frase PT a sugerir `GREET_PORT` + `exit 1`.
- E2E: `GET /` 303 → `/historico` 401 → `/entrar` 200 → palavra-passe errada 401 (sem `Set-Cookie`) → `POST /entrar` sem Origin 403 → entrada correta 303 + `Set-Cookie … HttpOnly; SameSite=Strict; Path=/` → histórico vazio → guardar 303 → `Olá, Ana Sofia!` no topo e no JSON.
- Caminhos de erro: cookie sem Origin 403; `?token=` no URL 401; cabeçalho errado 401; nome só espaços e 81 caracteres 400 com a mensagem no formulário; corpo de 5000 bytes 413 (também no browser real, sem `ECONNRESET`); rota desconhecida e método errado 404; API JSON com `X-Greet-Token` 201.
- Dados estranhos: `<script>alert("oi")</script>`, `Zoé 🙂 مرحبا`, `Joaquim Gonçalves d'Ávila`, nome de 80 caracteres — todos escapados e legíveis; nenhuma página servida contém `<script` nem `http(s)://`; todas com `lang="pt"`, um `<h1>`, `<title>` em português e `charset=utf-8`.
- Persistência: 11 registos → matar o servidor → arrancar outra vez → 11 registos, md5 igual, nova saudação aceite; 5 `POST` simultâneos → 5 registos, ids únicos, zero `.tmp`; ficheiro ilegível a meio → 500 PT e md5 idêntico antes, durante e depois, inclusive numa tentativa de gravação; `GREET_DATA` numa pasta inexistente → pasta e ficheiro criados na primeira saudação.
- **T9 confirmado no browser real**: `Network.getAllCookies` → `{"name":"greet","session":true,"expires":-1,"httpOnly":true,"sameSite":"Strict","secure":false}` — a palavra-passe morre ao fechar o browser, como a página Entrar promete.
- **T10 confirmado ao vivo**: com `GREET_HOST=0.0.0.0` o stdout imprime `Para os colegas na mesma rede: http://192.168.1.189:8153/` (e a segunda interface), o aviso em português, e `grep -ci token` no stdout devolve `0`; `http://192.168.1.189:8153/entrar` → 200.
- Visual, screenshots reais do servidor a correr, a 1440×1000 e 390×844: entrar, entrar-erro, histórico (32 registos, com nome de 80 caracteres), histórico vazio, histórico com 150 registos, gráfico, erro de campo, 401, 403, 404, 413, 500. `scrollWidth == clientWidth` nas duas larguras em todos, alvos de toque 47 px, `pageErrors: []`.
- Gráfico conferido contra o dataset: barras `1,0,4,3,1,1,6,1,1,2,2,4,3,3`, 14 `<rect>`, dia a zero com traço em `--line` e «0» em `--muted`, tabela com os mesmos números, 592×260 a 1440 e 342×150 a 390 — bate com `DESIGN.md` §3.
- Estados: vazio (`viewBox="0 0 546 100"`, 14 barras a zero, tabela toda a `0`), singular («1 saudação no total, 1 de hoje»), >100 («150 saudações no total, 150 de hoje. A mostrar as 100 mais recentes» com 100 itens).
- Acessibilidade: percurso completo só com teclado, duas vezes — `Tab` foca o campo com `outline rgb(111,179,242) solid 2px` e `:focus-visible` verdadeiro, escrever + `Enter` entra e, no histórico, `Tab` + escrever + `Enter` deixa «Olá, Teclado!» no topo. `label for`, `aria-invalid="true"` e `aria-describedby="erro-nome"` presentes no erro de campo, com o campo limpo.
- Performance (mediana de 5 pedidos a `/historico`): 1 000 → 80 ms · 5 000 → 386 ms · 10 000 → 786 ms · 20 000 → 1819 ms; `POST` com 20 000 registos → 257 ms. O orçamento do perfil («alguns milhares … menos de 1 s») cumpre-se.
- Custo e segredos: `node_modules` não existe, nenhum `import` fora de `node:*` e `./*`, nenhum `console.*` em `lib/`, nenhum ficheiro de saída dos servidores contém o valor do token, `git ls-files` sem `data/`, sem `greetings` e sem `token`.

**Findings** (nenhum bloqueador, nenhum grave)

1. **menor — a página 500 não segue o formato de `docs/design/DESIGN.md` §5 para o caminho do ficheiro.** *(já reportado como finding 3 em `docs/forja/reports/QA-close-1.md`, continua aberto)*
   Reproduzir: corromper o ficheiro de dados com o servidor a correr, abrir `/historico`.
   Esperado: `<p>` com o passo seguinte numa frase e, a seguir, uma linha própria `<p class="codigo">Ficheiro: <code>…</code></p>` antes de «Código 500.».
   Observado: `lib/app.mjs:307-312` mete o caminho dentro da frase; a 1440 o passo seguinte ocupa 5 linhas, quatro delas caminho.

2. **menor — fragmento em inglês na mensagem de arranque com ficheiro de dados ilegível.** *(finding 5 de `QA-close-1.md`, continua aberto)*
   Reproduzir: `GREET_DATA` a apontar para JSON inválido → `npm start`.
   Observado: `… Motivo: o conteúdo não é JSON válido (Expected property name or '}' in JSON at position 1 (line 1 column 2)). …`.
   Esperado: o perfil (`Fasquia de qualidade`, «Inaceitável») proíbe mensagens de erro em inglês para este público; o motivo deve ser só em português.

3. **menor — o `<title>` do gráfico contradiz a linha de total quando há registos fora dos 14 dias.** *(finding 6 de `QA-close-1.md`, continua aberto)*
   Reproduzir: ficheiro com 1 000 registos espalhados por 20 dias → `/historico`.
   Observado: a página diz «1000 saudações no total» e o `<title>` do SVG — o que o leitor de ecrã ouve — diz «Total: 696 saudações» (os da janela de 14 dias).
   Esperado: «Total nestes 14 dias: 696 saudações» ou equivalente.

4. **menor — a primeira coisa que um membro da equipa vê é uma página de erro.** *(finding 4 de `QA-close-1.md`, continua aberto)*
   Reproduzir: browser limpo → abrir `http://127.0.0.1:8080/`.
   Observado: `GET /` → 303 `/historico` → 401 «Precisa de entrar» com «Código 401.». Dois ecrãs e um código de erro antes do formulário.
   Esperado (fasquia: «nos primeiros 10 segundos … sem ler documentação»): quem não tem sessão aterra em `/entrar`.

5. **menor — o `<h1>` do 403 não diz o que aconteceu.** *(novo)*
   Reproduzir: `POST /entrar` (ou `POST /saudacoes` autenticado por cookie) sem `Origin`/`Referer` — na prática, submeter um formulário de um separador aberto há muito tempo.
   Observado: `<h1>Ocorreu um erro</h1>` e só depois a frase útil «O pedido não veio da página desta aplicação…». `DESIGN.md` §5 manda que o `h1` seja «o que aconteceu, em português corrente e sem número», mas não tem linha para o 403 — `lib/app.mjs:195-202` assume-o explicitamente.
   Esperado: uma linha de 403 no `DESIGN.md` com um `h1` que diga o que aconteceu (o passo seguinte e a ligação já estão certos).

6. **menor — em `GREET_HOST=0.0.0.0` são impressos endereços de adaptadores virtuais que os colegas não conseguem abrir, e o README diz que «qualquer um deles serve».** *(novo, sobre a correção de T10)*
   Reproduzir: `set GREET_HOST=0.0.0.0 && npm start` nesta máquina.
   Observado: duas linhas — `http://192.168.1.189:8153/` (Wi-Fi, responde 200 de fora) e `http://172.23.96.1:8153/` (adaptador virtual, inalcançável para os colegas). `lib/lan.mjs` filtra bem por IPv4/não-internal, mas não tem forma de distinguir isto; o `README.md` («Abrir à equipa toda, na mesma rede local») afirma «qualquer um deles serve».
   Esperado: ou o README deixa de prometer que qualquer um serve e diz «experimente o primeiro; se o colega não vir a página, experimente o seguinte», ou a lista é reduzida às gamas privadas de rede doméstica.

**Já registado**
- Nenhuma task `failed` ou `blocked`: T1–T10 todas `done` em `docs/forja/TASKS.json`.
- Findings 1 e 2 (graves) de `docs/forja/reports/QA-close-1.md` foram fechados por T9 e T10 e verificados no produto a correr — não voltam aqui.
- **Q2** continua aberta na fila do Sponsor (direção visual de `public/index.html`), com o default aplicado; fora do âmbito do run por D6.
- **Q3** foi respondida «Sim» pelo Sponsor; o default continua `127.0.0.1` com opt-in explícito documentado no README (D8), e T10 pôs a mudança do default fora de âmbito para o Lead encaminhar. Está coerente; só não há decisão escrita a fechar o assunto.
- O nit do Reviewer em T10 (`arguments.length` em `lib/lan.mjs:23` enfraquece um teste do critério 3) está no verdict de T10; a função comporta-se bem em produção e não leva finding.

**Fora de âmbito**
- `public/index.html`, `lib/greet.mjs` e `lib/slug.mjs` não mudaram neste run (D6/D16) — não re-testados a fundo.
- Ficheiro de dados editado à mão com registos malformados (sem `criado_em`, `null`, um elemento que nem é objeto): a página não rebenta e continua a gravar, mas mostra itens vazios. Só acontece se alguém editar o JSON à mão; não conta como finding.
- Não verificado: mudança de hora de verão e passagem da meia-noite com o servidor a correr (só coberto por testes unitários de `lib/stats.mjs`); leitor de ecrã real; browsers que não o Chrome; comportamento com o disco cheio.
- Toda a execução usou `GREET_TOKEN` fictício no processo e ficheiros de dados em pasta temporária; `token.local.txt` não foi criado, lido nem escrito, e o `data/` do projeto está intacto. Todos os servidores arrancados foram parados (`netstat` sem portas 8151–8186 a ouvir).
