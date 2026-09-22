// Bounded decision data, not another mandatory agent phase.
const text = (maxLength) => ({ type: 'string', minLength: 1, maxLength });
export const TECHNOLOGY_SCHEMA = {
  type: 'array', maxItems: 3,
  description: 'NEW unresolved technology choices only. Return [] when using or confirming a recorded choice from context. Never repeat previously assessed alternatives; report confirmation in summary instead.',
  items: {
    type: 'object', additionalProperties: false,
    required: ['capability', 'constraints', 'options', 'recommended', 'rationale'],
    properties: {
      capability: text(160), constraints: text(800),
      recommended: { ...text(40), pattern: '^[A-Za-z][A-Za-z0-9_-]{0,39}$', description: 'Exact id of one listed option, never its display name or explanatory prose.' },
      rationale: text(1000),
      options: { type: 'array', minItems: 2, maxItems: 3, items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'name', 'cost', 'cost_basis', 'tradeoffs', 'evidence'],
        properties: {
          id: { ...text(40), pattern: '^[A-Za-z][A-Za-z0-9_-]{0,39}$' }, name: text(120), cost: { type: 'string', enum: ['free', 'paid', 'unknown'] },
          cost_basis: text(600), tradeoffs: text(800),
          evidence: { type: 'array', minItems: 1, maxItems: 3, items: text(600) },
        },
      } },
    },
  },
};
const bounded = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
export function validateTechnology(items = [], maxItems = 3) {
  if (!Array.isArray(items) || items.length > maxItems || JSON.stringify(items).length > 16000)
    throw Error('Technology assessments exceed their bounded context budget.');
  for (const d of items) {
    if (!d || !bounded(d.capability, 160) || !bounded(d.constraints, 800) || !bounded(d.rationale, 1000) ||
      !Array.isArray(d.options) || d.options.length < 2 || d.options.length > 3)
      throw Error('Technology decisions need constraints and two or three evidenced alternatives.');
    const ids = new Set();
    for (const o of d.options) {
      if (!o || !/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(o.id) || ids.has(o.id) || !bounded(o.name, 120) ||
        !['free', 'paid', 'unknown'].includes(o.cost) || !bounded(o.cost_basis, 600) || !bounded(o.tradeoffs, 800) ||
        !Array.isArray(o.evidence) || !o.evidence.length || o.evidence.length > 3 || o.evidence.some(e => !bounded(e, 600)))
        throw Error('Invalid technology alternative or missing cost/evidence.');
      ids.add(o.id);
    }
    if (!ids.has(d.recommended)) throw Error('Technology recommendation must identify a listed alternative.');
  }
  return items;
}
export const needsSponsor = d => d.options.some(o => o.cost !== 'free');
export const pendingTechnology = run => (run.technology || []).filter(d => !d.selection);
export function validateTechnologyState(run) {
  if (run.technology === undefined) return; // Existing runs stay readable.
  validateTechnology(run.technology, 8);
  const ids = new Set();
  for (const d of run.technology) {
    if (!/^D[1-8]$/.test(d.id) || ids.has(d.id)) throw Error('Invalid technology decision identity.');
    ids.add(d.id);
    if (d.selection && (!d.options.some(o => o.id === d.selection.option) ||
      !['automatic', 'sponsor'].includes(d.selection.by) || !bounded(d.selection.reason, 1000) ||
      (needsSponsor(d) && d.selection.by !== 'sponsor')))
      throw Error('Paid or uncertain technology needs an explicit Sponsor decision.');
  }
}
export function addTechnology(run, items = [], task = null) {
  validateTechnology(items);
  const existing = run.technology || [], names = new Set(existing.map(d => d.capability.toLowerCase()));
  const additions = items.map((d, i) => {
    const name = d.capability.toLowerCase();
    if (names.has(name)) throw Error('Technology already assessed; use the recorded decision or report a changed constraint.');
    names.add(name);
    // Copy only declared data. Worker output can never supply a Sponsor answer.
    return { id: `D${existing.length + i + 1}`, task: task?.id || null,
      capability: d.capability, constraints: d.constraints, recommended: d.recommended, rationale: d.rationale,
      options: d.options.map(o => ({ id: o.id, name: o.name, cost: o.cost, cost_basis: o.cost_basis, tradeoffs: o.tradeoffs, evidence: [...o.evidence] })),
      selection: needsSponsor(d) ? null : { option: d.recommended, by: 'automatic', reason: d.rationale, at: new Date().toISOString() },
    };
  });
  const combined = [...existing, ...additions];
  validateTechnologyState({ technology: combined });
  run.technology = combined;
  return additions;
}
export function technologyContext(run) {
  return (run.technology || []).map(d => ({
    id: d.id, capability: d.capability, constraints: d.constraints,
    selected: d.selection ? d.options.find(o => o.id === d.selection.option) : null,
    decision: d.selection, rationale: d.rationale,
  }));
}
export function technologyGuidance(phase) {
  if (phase === 'plan') return ' Assess technology only for a new capability, material dependency or consequential unresolved choice; routine work using an accepted stack returns technology=[]. Do not reassess the already configured execution provider or approved project costs. Within this planning session compare 2-3 viable options, including the existing stack when viable, against project constraints; cite inspected local evidence or current primary sources for costs and tradeoffs. Use at most three primary references per choice, not an open-ended survey; if evidence or pricing is uncertain label cost unknown. Any relevant paid or unknown-cost option requires Sponsor choice, even if you recommend a free option. The controller obtains and records that answer before work: never create a task to ask, wait for, confirm or record the Sponsor decision. Tasks deliver implementation and acceptance evidence. Do not purchase, subscribe, provision or use a paid service. A free tier counts as free only with evidence it covers the stated requirements. Do not schedule a separate research agent/task merely to fill this field.';
  return ' Honor recorded technology choices in context. The technology output contains NEW unresolved choices only, never a recap: when using or confirming an existing decision, return technology=[] and mention confirmation only in summary if needed. If a material new technology choice or paid/uncertain cost is discovered, stop before adoption or paid use and return blocked with NEW alternatives/evidence; never infer Sponsor approval or reissue a recorded decision. Report changed constraints for an existing decision as blocked with an explanation, not a replacement assessment. Reviewer must reject unauthorized technology/cost changes. Sponsor selection authorizes the recorded implementation choice, never a purchase, subscription or credential access.';
}
