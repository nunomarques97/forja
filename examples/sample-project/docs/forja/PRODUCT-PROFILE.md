# Perfil de produto — sample-project

Atualizado: 2026-09-17 por Product Manager (run R-20260916-ae6a, fecho)

Este ficheiro é lido por todos os agentes antes de qualquer compromisso. Quando duas opções boas
entram em conflito, decide o que está aqui; quando este ficheiro é omisso, escolhe-se a opção mais
segura e reversível e diz-se isso em `Decisões por omissão`.

## Para quem

Uma equipa de 5 pessoas, não técnicas, no mesmo escritório e na mesma rede local, que quer registar
e ver saudações em português. Usam o Windows ou o telemóvel, abrem o endereço do servidor no browser,
e ninguém da equipa sabe (nem tem de saber) o que é um cabeçalho HTTP, um terminal ou um ficheiro JSON.
Uma só pessoa — o Sponsor — arranca o servidor a partir da pasta do projeto seguindo o README.

Segundo público, que não desaparece: o próprio Forja. O `sample-project` continua a ser o repositório
de exemplo onde `forja bootstrap` é validado. A app é aditiva; não pode partir esse papel.

## Fasquia de qualidade

Nos primeiros 10 segundos, uma pessoa da equipa abre o endereço, vê a lista de saudações e o gráfico
por dia, escreve um nome, carrega num botão e vê a saudação nova na lista. Sem instalar nada, sem ler
documentação, sem JavaScript no browser.

Inaceitável:
- Perder uma saudação já gravada, ou reescrever por cima de um ficheiro que o servidor não conseguiu ler.
- Uma mensagem de erro em inglês, com stack trace, ou que não diga o passo seguinte.
- O servidor arrancar sem token e aceitar pedidos de quem quer que seja.
- Um token dentro do código, num URL, num log, num commit ou num relatório.
- Entregar sem testes `node --test` a passar e sem screenshots reais a 1440 e 390 da página nova.

## Prioridades não funcionais (por ordem)

1. **Robustez e durabilidade** — nada do que foi gravado se perde: escrita atómica, uma escrita de cada
   vez, arranque sem ficheiro funciona, ficheiro ilegível nunca é sobrescrito nem apagado.
2. **Simplicidade para quem não é técnico** — arrancar em 3 passos copiáveis; toda a UI e todas as
   mensagens de erro em português simples, a dizer o que aconteceu e o único passo seguinte.
3. **Segurança adequada a uma rede local** — token obrigatório (fail-closed), por omissão só o próprio
   computador ouve (`127.0.0.1`), segredos fora do git, sem token em URLs nem em logs.
4. **Custo e dependências: zero** — $0, só built-ins do Node e HTML/CSS/SVG; nada a instalar.
5. **Acessibilidade e coerência visual** — contraste AA, teclado, sem JavaScript no browser; a página
   nova segue `docs/design/DESIGN.md`.
6. **Rapidez** — para 5 pessoas e alguns milhares de registos, página servida em menos de 1 s; não se
   troca robustez por performance.

## O que nunca fazer

- Token fixo em código, token por omissão, token gerado por um agente, token em query string, em log,
  em notificação ou em relatório. Nenhum agente cria, copia ou escreve credenciais.
- Expor o servidor à internet, fazer deploy, abrir túnel ou publicar seja o que for.
- Apagar, editar ou truncar saudações já gravadas; nenhuma limpeza automática do ficheiro de dados.
- Instalar dependências, usar CDNs, webfonts, analytics ou qualquer pedido `http(s)://` na página.
- Committar dados de execução (ficheiro de saudações, token) ou partir `npm test` / `forja bootstrap`.
- Mostrar ao utilizador stack traces, caminhos internos além do necessário, ou texto em inglês na UI.
- `git push`, git destrutivo, ou tocar em ficheiros fora de `examples/sample-project`.

## Decisões de produto já tomadas

- **D1** — a página segue um `DESIGN.md` mínimo próprio (fundo escuro, sistema, AA, uma coluna, anti-slop).
- **D2** — contrato de `slugify` em `lib/slug.mjs`.
- **D3** — texto de `public/index.html` em inglês (mantém-se; a app nova é em português).
- **D6** — âmbito deste run: servidor + página histórico + testes + README; `index.html` não muda.
- **D7** — token: `GREET_TOKEN` ou ficheiro local ignorado pelo git; sem token o servidor não arranca.
- **D8** — por omissão ouve em `127.0.0.1:8080`; a rede local é opt-in explícito (Q3 na fila).
- **D9** — durabilidade: escrita atómica, escritas em série, nunca sobrescrever ficheiro ilegível.
- **D10** — cada registo guarda id, nome, saudação e data/hora; nada mais (sem IP, sem user-agent).
- **D11** — o browser autentica-se por cookie definido num formulário; a API usa o cabeçalho.
- **D12** — gráfico: barras SVG geradas no servidor, últimos 14 dias, mais tabela de texto.
- **D13** — UI e mensagens em português; README ganha secção "Como usar" em português.
- **D14** — a página histórico reutiliza a direção visual existente, estendida pelo Product Designer.
- **D15** — só built-ins do Node; nenhuma tecnologia nova, logo sem `TECHNOLOGY.md` neste run.
- **D16** — o papel de fixture do `forja bootstrap` mantém-se e é verificado no fim.
- **D17** — fasquia de prova: testes do servidor em porta efémera, testes da página sobre o HTML, screenshots reais.
- **D18** — direção visual A (lista primeiro) para os ecrãs histórico, entrar e erro (Product Designer).
- **D19** — a sessão do browser morre ao fechar o browser, como a página Entrar promete.
- **D20** — a rede local está autorizada (Q3 «Sim») mas continua opt-in por arranque; a omissão é 127.0.0.1.
- **D21** — os 6 findings menores do QA de 2026-09-17 são trabalho futuro proposto, não bloqueadores.

Fila do Sponsor: **Q2** (direção visual de public/index.html) continua aberta com o default aplicado.
**Q3** foi respondida «Sim» (fechada por D20) e **Q4** foi respondida «Decide tu» (fica D18).
Run R-20260916-ae6a fechado a 2026-09-17: relatório em docs/forja/REPORT-2026-09-17.md.
