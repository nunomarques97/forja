# FORJA Core 0.1.0

FORJA transforma um objetivo em alterações de código, checks executados e uma revisão independente. O controlador é Node.js; Claude Code e Codex são executores substituíveis. Não precisa de uma conversa permanente, de um catálogo de agentes nem de relatórios escritos por outros agentes.

Na raiz Git do projeto, com Node 24, Git e o CLI escolhido já autenticado:

```powershell
$forja = 'C:\tools\forja\bin\forja.mjs'
node $forja start --provider codex --goal "Implementar <objetivo e condições de sucesso>"
```

Usa `--provider claude` para Claude Code. O projeto deve estar limpo; `--allow-dirty` autoriza trabalhar com alterações existentes, que são inventariadas e devem ser preservadas. O run altera ficheiros e executa os checks do projeto; não faz commits nem publica.

```powershell
node $forja core status
node $forja core usage
node $forja core resume
```

`core init` é opcional: acrescenta uma referência curta às regras comuns em `AGENTS.md` e `CLAUDE.md`, preservando o texto existente. O arranque direto já envia essas regras ao executor. Estado, resultados, logs e métricas ficam em `.forja/` dentro do projeto.

- [Manual do Core](docs/CORE-RUNBOOK.md): arquitetura, configuração, modelos/effort, recuperação, métricas e novos providers.
- [Conhecimento e pesquisa](docs/RESEARCH.md): Markdown, Obsidian e técnicas externas selecionadas.
- [Entrega e privacidade](docs/RELEASE.md): o que versionar, revisão do staging e condições para publicar.
- [Changelog](CHANGELOG.md): versões e alterações verificáveis.

O viewer apresenta os runs Core em `/core`, com tarefas, sessões, tentativas e consumo por provider/modelo. A guarda retoma runs Core interrompidos dentro dos limites existentes; bloqueios explícitos continuam a exigir recuperação pelo CLI. Reinicia serviços já abertos para carregarem estas alterações. O comando antigo `runner` e o bootstrap continuam disponíveis para runs antigos; não há migração automática de um run ativo. A operação anterior está no [runbook legado](docs/RUNBOOK-UNATTENDED.md) e em [viewer/README.md](viewer/README.md).

Para desenvolver o FORJA: `npm test` e `npm run check`. Sem dependências de runtime adicionais.


`core context --query "..."` mostra a seleção de conhecimento; o manifesto opcional `docs/forja/KNOWLEDGE.json` controla as fontes. Só documentação técnica revista pertence ao Git. Prompts, conversas, perguntas/respostas, handovers e evidência bruta ficam em armazenamento local ignorado. Obsidian pode abrir esse Markdown sem se tornar uma dependência do executor.

O agente responsável pela entrega prepara uma lista explícita de ficheiros e revê o conteúdo antes de versionar. `npm run release:check` verifica o staging; `npm run release:check -- --tree` verifica o snapshot completo antes de uma publicação autorizada. Nenhum dos comandos faz commit ou push. Histórico legado com dados de execução exige revisão própria antes de ser publicado.
