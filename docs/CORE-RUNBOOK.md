# FORJA Core

Manual de referência dos novos runs. [CORE.md](CORE.md) é o contrato curto enviado aos executores; [AGENTS.md](../AGENTS.md) rege o desenvolvimento do FORJA. O viewer tem uma página Core em `/core`; a arquitetura/runbook antigos continuam a documentar a compatibilidade com `runner`.

## Arrancar

Requisitos: Node 24, Git e Claude Code ou Codex instalado e autenticado. Na raiz Git do projeto:

```powershell
$forja = 'C:\tools\forja\bin\forja.mjs'
node $forja start --provider codex --goal "Adicionar pesquisa por nome, mantendo os filtros e testando os casos vazios"
node $forja core status
node $forja core usage
```

Claude só muda `--provider claude`. De outra pasta, acrescenta `--project 'C:\caminho\projeto'`. Com alterações pendentes, revê-as e usa `--allow-dirty` para autorizar a execução nesse estado. Os hashes iniciais não são um backup: o agente tem acesso de escrita e deve preservar trabalho existente. Core não faz commits, publica nem envia notificações.

`core init` é opcional: acrescenta uma referência a CORE.md em blocos geridos de AGENTS/CLAUDE e ignora `.forja/`. Preserva as regras existentes e recusa marcadores inválidos. O arranque direto já envia CORE.md; se dispensares init, acrescenta `.forja/` ao `.gitignore` para não versionar logs privados. Não copies o catálogo antigo de agentes para novos projetos.

## Arquitetura e estado

```mermaid
flowchart LR
  G[Objetivo] --> P[Plano estruturado]
  P --> D[Developer: sessão nova]
  D --> C[Checks executados por Node]
  C --> R[Revisão independente: sessão nova]
  R --> F[Próxima tarefa ou conclusão]
  C -->|falha dentro do orçamento| D
  R -->|rejeita dentro do orçamento| D
```

Node controla dependências, tentativas e transições. Não há Lead a delegar cada tarefa, mínimo de tarefas, PM/Scout/Architect obrigatório ou agentes de relatório. Um plano explícito `--plan plan.json` dispensa o planner. O percurso normal tem uma invocação de planeamento e duas por tarefa; cada invocação pode conter várias chamadas ao modelo.

`.forja/current.json` guarda o estado corrente. `.forja/runs/<id>/state.json` conserva cada run, acompanhado por prompts, schemas, resultados, streams, patches e logs dos checks. `usage.jsonl` mede invocações; `recovery.jsonl` regista intervenções explícitas; `SUMMARY.md` é gerado por código. Os logs podem conter código/dados privados. Runs anteriores ficam preservados.

Há um escritor por projeto. O lock regista controlador e subprocesso; a retoma recusa processos vivos. Recuperação de lock obsoleto é serializada. Estado inválido, paths exteriores/symlinks, alteração do estado pelo worker e commits inesperados interrompem o run. Estas verificações não substituem uma sandbox contra executores maliciosos.

## Contexto e conhecimento

Cada sessão recebe regras comuns estáveis, objetivo, tarefa/critérios, decisões compactas, títulos concluídos, último feedback útil e referências à evidência. O mapa de paths e declarações tem limite de 6.000 caracteres; o pacote tem limite de 48.000. Se não couber, pára para repartir a tarefa em vez de cortar critérios.

O mapa é heurístico, não um AST nem uma prova do comportamento. `.forja/index.json` guarda símbolos/hashes; metadata alterada força releitura. O agente recupera código e instruções hierárquicas quando necessário. O revisor recebe paths alterados, patch contra a base do run, indicação de ficheiros novos e logs. Ficheiros partilhados podem incluir alterações anteriores. Não recebe conversas passadas.

Decisões do plano vivem no estado; decisões duradouras do produto continuam no Markdown pertinente. A pesquisa BM25 seleciona excertos pertinentes com path, linhas e hash, até seis excertos e 6.000 caracteres serializados. O manifesto opcional `docs/forja/KNOWLEDGE.json` pode limitar o corpus e exigir notas curtas completas; notas obrigatórias ausentes, demasiado grandes ou com dependências de código desatualizadas interrompem a execução. Perfis, tecnologia, decisões e design não são colados inteiros por defeito. Obsidian pode apresentar esses Markdown e ligações entre projetos; não reduz tokens por si só. Não se acrescentaram embeddings, SQLite nem MCP de pesquisa sem evidência de que o índice simples seja insuficiente. Cache de prompts pertence ao provider: prefixos estáveis não garantem acertos de cache nem significam tokens eliminados.

## Qualidade, risco e modelos

A configuração opcional `finalChecks` acrescenta checks de aceitação definidos pelo autor do run à última tarefa por concluir, antes da revisão. Não exige que tarefas intermédias já satisfaçam o objetivo inteiro. As rotas `routes`/`providers`, o orçamento `maxCloudSessions` e os presets estão em [Routing e qualidade](ROUTING.md); sem rotas explícitas, mantêm-se os defaults descritos abaixo.

Cada tarefa precisa de critérios e checks (`command` e array `args`, sem concatenação de shell). Node executa-os e grava saída, duração e código. Uma falha volta ao developer dentro do orçamento, sem comprar uma revisão. O revisor inspeciona código/evidência sem editar. No fim, checks anteriores cujo código mudou são repetidos; regressões reabrem tarefas sob os mesmos limites.

O plano marca `security`, `visual` ou `architecture`. Paths/diff acrescentam sinais de segurança (autenticação, dependências, execução, rede, etc.) e UI. Superfícies novas não inspecionáveis elevam segurança. São heurísticas, não deteção completa. Arquitetura orienta plano/modelo; segurança e visual são focos obrigatórios da revisão quando aplicáveis, sem especialista separado por defeito. UI exige evidência real de browser/screenshots, produzida pelo developer e inspecionada pelo revisor. Core não inclui um serviço de browser.

| Condição | Tier |
|---|---|
| Desenvolvimento fácil | fast |
| Planeamento/desenvolvimento médio | normal |
| Difícil, arquitetura, segurança ou nova tentativa | strong |
| Revisão normal | strong |
| Revisão com segurança | critical |

Claude usa Sonnet nos dois primeiros tiers e Opus nos outros. Codex mantém o modelo da configuração do utilizador até mapeares os tiers. Exemplo Claude para `--config forja-config.json`:

```json
{
  "maxSessions": 30,
  "maxAttempts": 2,
  "maxMinutes": 30,
  "maxRotations": 2,
  "maxContextTokens": 120000,
  "provider": {
    "models": { "fast": "sonnet", "normal": "sonnet", "strong": "opus", "critical": "opus" },
    "efforts": { "fast": "medium", "normal": "high", "strong": "high", "critical": "high" }
  }
}
```

Para Codex, usa modelos disponíveis na tua conta ou omite `models`; effort passa a `model_reasoning_effort`. O suporte aos valores depende do modelo/CLI. Omissão conserva o default nativo. `maxMinutes` é por invocação; checks têm teto de 10 minutos. Máximos configuráveis: 30 tarefas, 200 invocações, 5 tentativas por tarefa e 5 rotações.

## Retomar e resolver bloqueios

Ctrl+C durante um subprocesso termina-o e preserva o trabalho. Uma morte abrupta pode deixar um worker vivo, verificado antes da retoma:

```powershell
node $forja core status
node $forja core resume
```

Cada tarefa/revisão usa uma sessão nova. Um resultado `checkpoint` guarda passos restantes e abre outra sessão sem tentativa adicional de implementação, mas consome invocação/rotação. Claude também é interrompido ao emitir uma métrica de contexto que atinge o limiar: a próxima sessão continua pelo diff e critérios. O limite só atua depois de receber a métrica. Codex não expõe contexto por chamada neste protocolo: usa sessões novas, checkpoint explícito e compactação nativa; não há garantia de corte a 120k para Codex.

Falhas de autenticação, quota, timeout ou formato param sem retries automáticos. Corrige a causa e retoma; invocações/tentativas iniciadas continuam contadas. Para uma tarefa `blocked` ou orçamento esgotado:

```powershell
node $forja core retry --task T1 --why "Dependência corrigida" --max-attempts 3
node $forja core resume --max-sessions 40
node $forja core retry --task T1 --validate-only --why "Ambiente de testes corrigido; validar trabalho preservado"
node $forja core abandon --why "Objetivo substituído"
```

`retry` preserva alterações/contadores; recusa tarefas concluídas e limites esgotados sem aumento explícito. `--validate-only` começa nos checks, sem nova implementação, e continua a exigir revisão independente. `abandon` termina como `failed` e permite novo objetivo, mantendo ficheiros/evidência. Código alterado entre checks e revisão invalida a evidência e força nova validação.

Não apagues um lock que indica processo vivo: inspeciona os PIDs em `.forja/lock.json`. Um `takeover.json` deixado por recuperação interrompida exige verificar o PID e lock antes de remover apenas esse guard. `call-N-stream.json` explica erros do provider; `<tarefa>-aN-check-K.log` explica checks; `core usage --details` mostra invocações. A guarda reconhece Core e só retoma runs interrompidos ainda marcados como ativos, com os intervalos e limites existentes; nunca reabre um bloqueio explícito nem compete com um worker vivo.

## Viewer

`node $forja serve` abre o servidor local; usa o endereço apresentado e o caminho `/core`. A autenticação existente aplica-se também ao Core. A página mostra projeto, run, tarefas, sessões, provider/modelo/effort, tentativas, checks/revisão e consumo, incluindo cache e estimativas USD quando disponíveis. Abre os detalhes das sessões para identificar a origem do custo. `core init` e `start` registam o projeto automaticamente.

A página é de consulta; recuperação usa os comandos acima. Reinicia viewer/guarda já em execução para carregarem o código atualizado. O encerramento do viewer preserva os executores Core e os seus subprocessos.

## Providers e extensão

`lib/core/providers.mjs` é a fronteira: prompt em stdin, resultado segundo `PLAN_SCHEMA`/`RESULT_SCHEMA`, exit code, duração, usage quando disponível, sessão e erro. As transições do scheduler são comuns.

- Claude: `-p`, stream JSON/schema; planner/reviewer só têm Read/Grep/Glob, developer tem edição/shell. MCP estrito vazio por defeito; `config.mcp` permite configuração explícita do projeto. Hooks e instruções nativas podem acrescentar comportamento/contexto: init preserva-os, não faz migração destrutiva.
- Codex: `exec --json`, schema/ficheiro de resposta; sandbox `workspace-write` no developer, `read-only` nas outras fases. Mantém AGENTS hierárquicos e configuração nativa. Ferramentas/MCP continuam sob controlo do utilizador. Restrições incompatíveis com um teste bloqueiam com evidência.
- Futuro agente: `--provider custom`, `provider.command` executável e `provider.args` array. `{schema}`/`{result}` são substituídos nos argumentos. O wrapper recebe stdin e emite como última linha JSON `{"result": <objeto conforme schema>, "usage": <métricas opcionais>}`; exit não zero é falha. Usage custom fica no registo original, sem normalização inventada. Ferramentas/sandbox são responsabilidade do wrapper.

Um plano é `{"decisions": [], "tasks": [...]}`. Cada tarefa tem `id`, `title`, `criteria` (array), `files` (paths relativos), `risks` (labels), `complexity` (`easy|medium|hard`), `checks` (`[{"command":"node","args":["--test"]}]`) e `after` (IDs). Resultado: `status`, `summary`, `findings`; developer usa `done|blocked|checkpoint`, revisão usa `approve|reject`. Novos providers normalizam eventos na fronteira; transições/testes pertencem ao Core. Não acrescentes outro catálogo de regras.

## Métricas e compatibilidade

`core usage` agrega por fase/tarefa/provider; `--details` inclui as linhas. Captura modelo pedido/reportado, effort, tentativa, fontes, caracteres, duração, resultado e usage nativo. Claude input total soma entrada não cacheada + criação + leitura de cache; Codex input já inclui cache. Chamadas Claude são IDs assistant únicos observados, diferentes de turnos. Chamadas Codex ficam null quando não expostas.

`characters/4` é proxy do prompt submetido, sem system/tools/instruções nativas e conteúdo recuperado. Totais parciais indicam cobertura; percentagens de input exigem cobertura completa. Não são euros nem fatura. Linhas danificadas são sinalizadas e registos íntegros continuam legíveis. Corrigir duplicados de message ID no histórico Claude é contabilidade, não poupança.

`runner`, `run`, `task`, `status`, `resume`, bootstrap e `forjalvl` continuam no fluxo antigo. Viewer e guarda reconhecem ambos os fluxos. Para Core, usa os comandos deste manual. Os dois fluxos recusam novos runs ativos sobrepostos. Termina/encerra explicitamente o run legado antes de usar `start`; `docs/forja/RUN.json` não é reescrito. A compatibilidade preserva projetos existentes; o Core é a metodologia recomendada para novos runs.


## Conhecimento selecionado

`node $forja core context --query "pagination stale responses"` mostra os trechos que o Core recuperaria. Por omissão, pesquisa Markdown do projeto (até 200 documentos / 2 MB; 128 KB por documento), excluindo instruções nativas e pastas de relatórios/arquivo. O pacote recebe até seis trechos, com orçamento de 6.000 caracteres serializados. Texto sem correspondência não é incluído. O mapa continua limitado a 6.000 caracteres; o pacote completo a 48.000, sem cortar critérios.

Para controlar as fontes, cria `docs/forja/KNOWLEDGE.json` versionado:

```json
{"version":1,"documents":[{"path":"docs/ARCHITECTURE.md"},{"path":"docs/CONVENTIONS.md","required":true}]}
```

Uma nota obrigatória entra inteira; se faltar ou exceder o orçamento, o Core para com uma mensagem concreta. Não marques manuais extensos como obrigatórios: cria uma nota curta de invariantes. Para detetar conhecimento obsoleto, uma entrada pode incluir `source_hashes` com caminhos de fontes e respetivos SHA-256: divergência exclui a nota opcional e bloqueia uma obrigatória. Sem esses hashes, frescura significa apenas que o trecho coincide com o documento atual, não que o documento descreve corretamente o código.

Entradas duplicadas, incluindo aliases como `nota.md` e `./nota.md`, são recusadas: mantém uma única entrada com todas as suas restrições.

Os trechos são dados com caminho, linhas e hash, não instruções superiores ao objetivo. Não se percorre o vault pessoal nem se geram resumos com IA automaticamente. Markdown pode ser aberto no Obsidian; JSON guarda o estado de execução. A seleção é reconstruída em memória; não há instalação de embeddings, servidor MCP ou base de dados adicional. Fontes e duração de recuperação ficam no ledger da sessão.

A estimativa USD nativa é guardada quando exposta pelo executor, com cobertura própria; não é a fatura de uma subscrição. Valores em falta são desconhecidos, nunca zero.
