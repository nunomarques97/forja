// Curated synthetic material, never copied from a private run. Changing this
// file changes the frozen suite hash. Oracles never enter provider prompts.
export const contract = 'Implement merge_windows(windows) in Python 3. Input must be a list of two-element lists containing exact integers (booleans are invalid). Reject wrong types/shapes with TypeError and start > end with ValueError. Return sorted intervals merging overlapping or touching endpoints. Empty input returns []. Never mutate the input or alias an input pair. Export the function; no top-level effects. No imports are needed.';
export const reference = `def merge_windows(windows):
    if type(windows) is not list:
        raise TypeError()
    copied = []
    for pair in windows:
        if type(pair) is not list or len(pair) != 2 or any(type(x) is not int for x in pair):
            raise TypeError()
        if pair[0] > pair[1]:
            raise ValueError()
        copied.append(pair[:])
    copied.sort()
    out = []
    for start, end in copied:
        if out and start <= out[-1][1]:
            out[-1][1] = max(out[-1][1], end)
        else:
            out.append([start, end])
    return out
`;
export const mutants = {
  touching: reference.replace('start <= out', 'start < out'),
  boolean: reference.replace('type(x) is not int', 'not isinstance(x, int)'),
  mutation: reference.replace('    copied.sort()', '    windows.sort()\n    copied.sort()'),
  nesting: reference.replace('max(out[-1][1], end)', 'end'),
};
export const oracle = `from candidate import merge_windows as f

def raises(kind, value):
    try:
        f(value)
    except kind:
        return
    raise AssertionError('expected exception')

assert f([]) == []
assert f([[8, 9], [1, 3], [3, 5], [2, 4]]) == [[1, 5], [8, 9]]
assert f([[1, 10], [2, 3], [4, 5]]) == [[1, 10]]
assert f([[-5, -3], [-3, 0], [9, 9]]) == [[-5, 0], [9, 9]]
assert f([[1, 2], [1, 2], [2, 2]]) == [[1, 2]]
original = [[5, 6], [1, 2]]
result = f(original)
assert original == [[5, 6], [1, 2]]
result[0][0] = -100
assert original == [[5, 6], [1, 2]]
for bad in (None, (), 'x', [None], [(1, 2)], [[1]], [[1, 2, 3]], [[True, 2]], [[1, 2.0]], [[1, '2']]):
    raises(TypeError, bad)
raises(ValueError, [[3, 2]])
print('FORJA_ORACLE_PASS_V1')
`;
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const string = { type: 'string' };
export const reviewCases = [
  { id: 'A', source: reference, valid: true },
  { id: 'B', source: mutants.touching, valid: false },
  { id: 'C', source: reference.replaceAll('copied', 'ordered'), valid: true },
  { id: 'D', source: mutants.boolean, valid: false },
  { id: 'E', source: mutants.mutation, valid: false },
  { id: 'F', source: reference.replaceAll('out', 'merged'), valid: true },
  { id: 'G', source: mutants.nesting, valid: false },
  { id: 'H', source: reference.replace('pair[:]', 'list(pair)'), valid: true },
];
export const tasks = {
  implement: {
    prompt: 'Bounded implementation evaluation. All inputs are inline; do not use tools. Return the source as one Python module and a short explanation.\n' + contract,
    schema: object({ source: string, explanation: string }),
  },
  review: {
    prompt: 'Blind review evaluation. All inputs are inline; do not use tools or execute code. For EACH labeled implementation return its id, approve=true if it meets the contract, otherwise false, and one concise reason. Cosmetic differences are not defects.\n' + contract + '\n' + reviewCases.map(({ id, source }) => 'CASE ' + id + '\n' + source).join('\n'),
    schema: object({ verdicts: { type: 'array', items: object({ id: string, approve: { type: 'boolean' }, reason: string }) } }),
  },
  plan: {
    prompt: 'Creative planning evaluation, no implementation or tools. Brief: a landing page for a small workshop that restores mechanical musical instruments. Let scroll reveal how damaged instruments regain their sound. Audience: collectors and curious newcomers. Avoid fabricated testimonials and unsupported claims. Mobile performance, keyboard access, reduced motion and meaningful content without animation are requirements. Propose three substantively different art directions BEFORE choosing technology. For each describe composition, typography, content, interaction and a concrete scroll sequence. Choose one and justify a minimal stack, rejected alternatives and tradeoffs. No preference for a particular library. Return exactly three directions and a decision.',
    schema: object({ directions: { type: 'array', items: object({ concept: string, composition: string, typography: string, content: string, interaction: string, scroll_sequence: string }) },
      decision: object({ chosen: string, stack: string, rejected_alternatives: string, tradeoffs: string, accessibility: string, performance: string }) }),
  },
};
export const creativeRubric = [
  'Three substantively distinct visual and interaction directions, assessed across all repeats rather than by library names.',
  'Specific connection between the workshop story, content hierarchy and scroll sequence; identify generic substitutions.',
  'Feasible technology choice with explicit alternatives, mobile cost, reduced-motion behavior and keyboard access.',
  'Blind assessment using the same anchored rubric for all candidates, with reasons and disagreements retained. Structural completeness is not creative quality.',
];
