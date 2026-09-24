# Core specialist methods

Core keeps planning, development, controller checks and independent review. Specialization changes the method and context used within those sessions. It does not create a permanent team, add mandatory model calls or change provider/model routing.

## Responsibilities and context

| Method | Consult when | Required context and evidence |
|---|---|---|
| Planner | Planning the requested outcome | Goal, accepted decisions, relevant interfaces and checks. Keep cohesive work together; justify independent tasks. |
| Design | Establishing or materially changing visual direction | Audience, real content, available assets and existing design. Render the proposed composition and inspect desktop/mobile before claiming visual approval. |
| Frontend | Browser UI, interaction or client state | Accepted design, components, state ownership and interface contract. Check meaningful transitions, accessibility and actual narrow-width rendering. |
| Backend | Server, data, CLI or non-UI behavior | Public contract, authoritative state and side-effect boundaries. Check validation, concurrent operations, failures and recovery where applicable. |
| Security | A task crosses or changes a trust boundary | Attacker control, protected resource and the enforcement point. Verify concrete adverse cases; do not impose an unrelated security audit on every task. |
| Reviewer | Independent acceptance review | Delivered source and executed evidence against the original criteria. Reject concrete defects; distinguish missing required evidence from cosmetic preference. |

A small API/UI change may use frontend and backend methods in one development session. A supplied visual design does not trigger another design kickoff. An open visual brief may require design work before implementation; the planner decides the smallest justified task boundary. Uncertainty about one technology does not justify loading every specialist method or creating a new agent.

## Instruction delivery

The canonical methods are the six `.claude/skills/forja-core-*/SKILL.md` files shipped with FORJA. The `forja-core-` prefix separates them from legacy crew skills. These are methods for Core workers, not a replacement legacy roster or native subagent configuration.

New runs preserve their method files under their own `.forja` run directory, with versioned metadata and SHA-256 integrity checks. Core supplies references and consultation conditions in the phase context. The worker must explicitly read the required phase method and applicable domain methods. It must not infer that a skill loaded merely because its name appeared in a catalog.

Explicit reads work with the restricted Claude adapter, whose safe mode disables automatic `CLAUDE.md`, skill and agent discovery. Project instructions still apply; methods cannot override the user, project contract, tool permissions or controller checks. The controller's method references are separate from retrieved project knowledge. Existing `KNOWLEDGE.json` policies and user-owned instructions are preserved.

Runs created before specialist metadata existed retain their original behavior. A missing or modified run-local method is an integrity failure; the controller does not silently replace it with the latest installed version. Native worker traces can show actual resource reads; the catalog alone proves only availability.

## Keeping context useful

Shared instructions carry execution boundaries and evidence requirements. Methods carry the few domain decisions that materially affect work. Task packets carry the actual brief, accepted design, interface and acceptance criteria. Avoid repeating all three in each skill.

Detailed references belong behind a concrete consultation condition. Do not import a complete handbook into `CLAUDE.md` for organization alone: an imported body still consumes context. Do not preload every skill on a native subagent. Claude's [memory documentation](https://code.claude.com/docs/en/memory), [skill documentation](https://code.claude.com/docs/en/skills) and [subagent documentation](https://code.claude.com/docs/en/sub-agents) distinguish always-loaded instructions, conditional skill bodies and explicitly preloaded skills. Core's restricted execution uses explicit file reads rather than depending on native discovery; see the [CLI reference](https://code.claude.com/docs/en/cli-reference).

No universal palette, font, framework or layout blacklist establishes originality. The design method evaluates composition, hierarchy, content and rendered evidence. A good brief or a passing DOM check cannot certify artistic quality. The method permits rejection of every proposed direction.

## Evaluation and maintenance

Compare a method change on equivalent tasks with the same model, effort, tools, assets and acceptance contract. Keep positive controls as well as defective cases so a stricter reviewer does not win by rejecting everything. Record actual consulted paths, input/output/cache usage and failures. Treat latency measured under concurrent load as descriptive, not a causal speed ranking.

Promote concise reusable lessons, never raw conversations, private screenshots or benchmark transcripts. A single successful task does not prove a skill improves every task in its domain. Keep model selection, method selection and approval of the resulting artifact separate.
