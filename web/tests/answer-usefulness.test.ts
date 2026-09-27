import test from 'node:test';
import assert from 'node:assert/strict';
import { orchestrate } from '../lib/orchestrate.ts';
import { freshConnections } from '../lib/trio.ts';
import { answerFormatRules, answerUsefulnessRules } from '../lib/quality-policy.ts';

test('all answer stages prioritize useful deliverables while keeping exact-format requirements authoritative', async () => {
  const connections = freshConnections();
  Object.values(connections).forEach(connection => { connection.key = 'synthetic-key'; });
  const prompts: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body));
    prompts.push(body.instructions ?? body.system ?? body.system_instruction);
    const text = '{"answer":42}';
    return Response.json(String(url).includes('openai') ? { output: [{ content: [{ type: 'output_text', text }] }] }
      : String(url).includes('anthropic') ? { content: [{ type: 'text', text }] }
      : { steps: [{ type: 'model_output', content: [{ type: 'text', text }] }] });
  };
  await orchestrate({ question: 'Return only JSON with the answer.', instructions: 'No commentary.', mode: 'deep', lead: 'openai', connections }, () => {}, new AbortController().signal, fetcher);
  const answers = prompts.filter(prompt => !prompt.startsWith('Review'));
  assert.equal(answers.length, 7);
  for (const prompt of answers) {
    assert.ok(prompt.includes(answerUsefulnessRules));
    assert.ok(prompt.endsWith(answerFormatRules), 'Exact output remains the final presentation instruction');
  }
  const reviews = prompts.filter(prompt => prompt.startsWith('Review'));
  assert.equal(reviews.length, 3);
  assert.ok(reviews.every(prompt => prompt.includes('unless material errors require more explanation')));
});
