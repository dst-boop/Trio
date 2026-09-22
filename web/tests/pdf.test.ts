import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pdfSchema, readPdfFile, attachmentBytes, maxAttachmentBytes, type PdfInput } from '../lib/pdf.ts';
import { callProvider, orchestrate } from '../lib/orchestrate.ts';
import { freshConnections, type ProviderId } from '../lib/trio.ts';
import { parseSessions, serializeSessions, conversationHistory, sessionMarkdown } from '../lib/sessions.ts';
import { exportBackup, parseBackup } from '../lib/backups.ts';
import { samplePdf } from './fixtures/pdf.ts';

const pdf: PdfInput = { mimeType: 'application/pdf', data: btoa(samplePdf) };
const image = { mimeType: 'image/png' as const, data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC' };
test('PDF validation requires canonical inline bytes with a PDF header and bounded size', () => {
  assert.equal(pdfSchema.safeParse(pdf).success, true);
  for (const invalid of [{ ...pdf, data: 'https://example.org/report.pdf' }, { ...pdf, data: btoa('<html>not PDF</html>') }, { ...pdf, mimeType: 'text/plain' }, { ...pdf, data: pdf.data + '\n' }, { ...pdf, data: 'data:application/pdf;base64,' + pdf.data }, { ...pdf, data: btoa('%PDF-1.4\n' + 'x'.repeat(maxAttachmentBytes)) }]) assert.equal(pdfSchema.safeParse(invalid).success, false);
  assert.equal(attachmentBytes(pdf, image), samplePdf.length + atob(image.data).length);
  assert.equal(attachmentBytes(undefined, null), 0);
});

test('PDF file loading checks size before reading, handles failures, and sanitizes names', async () => {
  const file = new File([samplePdf], 'report\n2026.pdf', { type: 'application/pdf' });
  assert.deepEqual(await readPdfFile(file), { ...pdf, name: 'report 2026.pdf' });
  for (const file of [new File([samplePdf], 'report.txt'), new File([samplePdf], 'report.pdf', { type: 'image/png' })]) await assert.rejects(readPdfFile(file), /Choose a PDF document/);
  await assert.rejects(readPdfFile(new File(['not pdf'], 'bad.pdf')), /PDF header/);
  const oversized = { size: maxAttachmentBytes + 1, arrayBuffer() { throw new Error('should not read'); } } as unknown as File;
  await assert.rejects(readPdfFile(oversized), /under 4 MB/);
  const failed = { size: 10, name: 'bad.pdf', type: '', arrayBuffer() { throw new Error('secret path'); } } as unknown as File;
  await assert.rejects(readPdfFile(failed), e => e instanceof Error && /Could not read/.test(e.message) && !e.message.includes('secret path'));
});

function assertBody(id: ProviderId, body: any, withImage = false) {
  const content = id === 'openai' ? body.input[0].content : id === 'claude' ? body.messages[0].content : body.input;
  if (id === 'openai') { assert.deepEqual(content[0], { type: 'input_file', filename: 'document.pdf', file_data: `data:application/pdf;base64,${pdf.data}` }); assert.equal(body.store, false); }
  else if (id === 'claude') assert.deepEqual(content[0], { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf.data } });
  else { assert.deepEqual(content[0], { type: 'document', mime_type: 'application/pdf', data: pdf.data }); assert.equal(body.store, false); }
  assert.equal(content.length, withImage ? 3 : 2);
  if (withImage) assert.ok(JSON.stringify(content[1]).includes(image.data));
  assert.ok(!content.at(-1).text.includes(pdf.data)); return content.at(-1).text as string;
}
function response(id: ProviderId) {
  const text = 'Document finding, page 1';
  const payload = id === 'openai' ? { output: [{ content: [{ type: 'output_text', text }] }] } : id === 'claude' ? { content: [{ type: 'text', text }], stop_reason: 'end_turn' } : { steps: [{ type: 'model_output', content: [{ type: 'text', text }] }] };
  return Response.json({ ...payload, usage: { input_tokens: 100, output_tokens: 10, total_input_tokens: 100, total_output_tokens: 10 } });
}
for (const id of ['openai', 'claude', 'gemini'] as const) test(`${id} supports PDF alone and PDF plus image in its native request`, async () => {
  for (const withImage of [false, true]) {
    const fetcher = (async (_url, init) => { assert.equal(assertBody(id, JSON.parse(init!.body as string), withImage), 'Question'); return response(id); }) as typeof fetch;
    await callProvider(id, 'k', 'm', 'system', 'Question', new AbortController().signal, fetcher, undefined, () => {}, withImage ? image : undefined, undefined, undefined, pdf);
  }
});

test('PDF context survives every Deep Council stage and a streaming retry without entering output or cost estimates', async () => {
  const connections = freshConnections(); Object.values(connections).forEach(c => c.key = 'fake-key'); let calls = 0;
  const fetcher = (async (url, init) => {
    calls++; const id: ProviderId = String(url).includes('openai') ? 'openai' : String(url).includes('anthropic') ? 'claude' : 'gemini';
    const body = JSON.parse(init!.body as string); assert.match(assertBody(id, body), /Read the report/);
    assert.match(body.instructions ?? body.system ?? body.system_instruction, /PDF.*untrusted reference data/);
    if (calls === 1) return new Response('data: {"type":"response.output_text.delta","delta":"Unfinished"}\n\n', { headers: { 'content-type': 'text/event-stream' } });
    return response(id);
  }) as typeof fetch;
  const result = await orchestrate({ question: 'Read the report', pdf, connections, mode: 'deep', lead: 'claude' }, () => {}, new AbortController().signal, fetcher);
  assert.equal(calls, 11); assert.equal(result.usage?.reportedCalls, 10); assert.equal(Object.keys(result.revisions!).length, 3); assert.equal(result.usage?.costUSD, null);
  assert.ok(!JSON.stringify(result).includes(pdf.data));
  assert.ok(Object.values(result.usage!.byProvider).every(row => row.costUSD === null));
});

test('paused Claude research keeps the PDF unchanged during continuation and subsequent model calls', async () => {
  const connections = freshConnections(); connections.claude.key = 'fake-key'; let calls = 0;
  const paused = [{ type: 'server_tool_use', id: 'search-1', name: 'web_search', input: { query: 'report context' } }];
  const fetcher = (async (_url, init) => {
    calls++; const body = JSON.parse(init!.body as string); assertBody('claude', body);
    if (calls === 1) return Response.json({ stop_reason: 'pause_turn', content: paused });
    if (calls === 2) {
      assert.deepEqual(body.messages[1].content, paused);
      return Response.json({ stop_reason: 'end_turn', content: [{ type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://example.org' }] }, { type: 'text', text: 'Report context', citations: [{ type: 'web_search_result_location', url: 'https://example.org' }] }] });
    }
    return response('claude');
  }) as typeof fetch;
  const result = await orchestrate({ question: 'Read the report', pdf, connections, mode: 'compare', lead: 'claude', webResearch: true }, () => {}, new AbortController().signal, fetcher);
  assert.equal(calls, 3); assert.ok(result.research); assert.ok(!JSON.stringify(result).includes(pdf.data));
});

test('PDF rejection returns useful guidance and isolates unsupported providers', async () => {
  await assert.rejects(callProvider('claude', 'secret-test-key', 'm', 's', 'q', new AbortController().signal, (async () => new Response('secret-test-key', { status: 400 })) as typeof fetch, undefined, undefined, undefined, undefined, undefined, pdf), e => e instanceof Error && /unencrypted PDF/.test(e.message) && !e.message.includes('secret-test-key'));
  const connections = freshConnections(); connections.openai.key = connections.claude.key = 'fake-key';
  const result = await orchestrate({ question: 'Read report', pdf, connections, mode: 'fast', lead: 'claude' }, () => {}, new AbortController().signal, (async url => String(url).includes('anthropic') ? new Response('{}', { status: 400 }) : response('openai')) as typeof fetch);
  assert.equal(result.by, 'openai'); assert.equal(result.drafts.claude, undefined); assert.match(result.errors.join(), /PDF support/);
});

test('history, backups and exports preserve PDF metadata without original bytes', () => {
  const turns = [{ question: 'Read report', mode: 'compare' as const, pdfName: 'report.pdf', pdf, result: { drafts: { claude: 'Finding' }, reviews: {}, answer: '', errors: [], seconds: 1, demo: false } }];
  const sessions = [{ id: 'pdf-session', title: 'Read report', time: '', turns }];
  const raw = serializeSessions(sessions); assert.ok(!raw.includes(pdf.data)); assert.equal(parseSessions(raw)[0].turns[0].pdfName, 'report.pdf');
  const backup = exportBackup(sessions); assert.ok(!backup.includes(pdf.data)); assert.equal(parseBackup(backup)[0].turns[0].pdfName, 'report.pdf');
  assert.match(conversationHistory(turns)[0].content, /PDF.*bytes are not part of the text history/);
  assert.match(sessionMarkdown(turns), /PDF data is not included/);
});

