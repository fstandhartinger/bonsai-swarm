/**
 * "Is this really Ternary Bonsai 2 27B?" - the admission check for a provider that
 * relays to its own llama.cpp (or other OpenAI-compatible) server instead of running the
 * model in a browser.
 *
 * The swarm promises one model. A local server could be running anything, so before it
 * gets a stranger's prompt it answers six fixed prompts greedily (temperature 0, 32
 * tokens, thinking off) and the answers are compared with what Bonsai 2 27B itself says.
 *
 * The reference answers were recorded on 19 Sep 2026 on an RTX 2000 Ada:
 *   - llama.cpp (PrismML fork b10709) with the PQ2_0 GGUF and with the PTQ1_0 GGUF -
 *     identical, character for character;
 *   - the in-browser WebGPU runtime with the PTQ1_0 GGUF - identical on five prompts,
 *     one different wording on the lighthouse prompt (kept as a second accepted answer).
 * The parent model, Qwen3.8-27B (unsloth UD-Q2_K_XL), was run through the same check:
 * it starts several answers with the same words ("One surprising fact about octopuses
 * is that **they have three hearts") but diverges well before the end on all six, so it
 * scores 0 of 6. A near-identical opening is therefore not enough: an answer only counts
 * when it matches a reference for at least 90 % of the reference's length.
 *
 * What this does and does not prove: it catches the honest mistake - the wrong GGUF, a
 * different quantisation of the parent model, a server that loaded something else. It
 * cannot stop a provider who modifies the client to replay these strings; that is the
 * same trust model as the browser benchmark (see SECURITY.md), and every real job is still
 * timed by the server.
 */

export const INTEGRITY_MAX_TOKENS = 32;
export const INTEGRITY_REQUIRED = 5;     // of INTEGRITY_PROMPTS.length
export const INTEGRITY_MIN_SHARE = 0.9;  // of the reference's length, as an exact prefix

export const INTEGRITY_PROMPTS = [
  {
    prompt: 'Describe a lighthouse in exactly one sentence.',
    accepted: [
      'A solitary lighthouse stands sentinel on the jagged cliffs, its beam cutting through the fog to guide lost ships toward safety.',
      'A solitary lighthouse stands as a steadfast sentinel on the jagged cliffs, its beam cutting through the fog to guide lost ships toward safety.',
    ],
  },
  {
    prompt: 'Invent a name for a small garden robot and explain the name in one sentence.',
    accepted: [
      '**Name:** Sprout\n\n**Explanation:** The name "Sprout" reflects the robot\'s gentle, nurturing role in helping plants grow and its small, un',
    ],
  },
  {
    prompt: 'Write the first line of a poem about rain on a tin roof.',
    accepted: ['The sky cracks open, and the tin roof sings a silver song.'],
  },
  {
    prompt: 'In one sentence, what is a bonsai tree?',
    accepted: ['A bonsai tree is a miniature tree that is intentionally cultivated and shaped over time to resemble a mature tree in a small pot.'],
  },
  {
    prompt: 'Give one surprising fact about octopuses.',
    accepted: [
      'One surprising fact about octopuses is that **they have three hearts**.\n\nTwo of these hearts pump blood to the gills, while the third pumps it',
    ],
  },
  {
    prompt: 'Suggest a title for a short story about a lost key.',
    accepted: [
      'Here are a few title suggestions for a short story about a lost key, depending on the tone and theme of your story:\n\n**Mysterious & Atmospheric**',
    ],
  },
];

/** Whitespace differences between servers (a trailing newline, \r\n) do not count. */
export function normalise(text) {
  return String(text ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').replace(/\s+/g, ' ').trim();
}

function commonPrefix(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i += 1;
  return i;
}

/** How much of the best-matching reference this answer reproduces exactly, 0..1. */
export function matchShare(answer, accepted) {
  const got = normalise(answer);
  let best = 0;
  for (const ref of accepted) {
    const want = normalise(ref);
    if (!want) continue;
    best = Math.max(best, commonPrefix(got, want) / want.length);
  }
  return best;
}

/**
 * @param {string[]} answers  one answer per INTEGRITY_PROMPTS entry, same order
 * @returns {{ passed: boolean, matched: number, total: number, shares: number[] }}
 */
export function judgeIntegrity(answers) {
  const shares = INTEGRITY_PROMPTS.map((p, i) => matchShare(answers[i] ?? '', p.accepted));
  const matched = shares.filter((s) => s >= INTEGRITY_MIN_SHARE).length;
  return { passed: matched >= INTEGRITY_REQUIRED, matched, total: INTEGRITY_PROMPTS.length, shares };
}

/**
 * The model id a local server reports is only a hint (anybody can name a file anything),
 * but a server that says it is serving "llama-3" is certainly the wrong one, and saying
 * so plainly is kinder than a failed comparison.
 */
export function modelIdLooksRight(id) {
  return /bonsai/i.test(String(id || ''));
}
