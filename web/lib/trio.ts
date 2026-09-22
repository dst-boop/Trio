export const providers = [
  { id: 'openai', name: 'ChatGPT', company: 'OpenAI', model: 'gpt-6-astra', color: '#72d7b6', mark: '◎' },
  { id: 'claude', name: 'Claude', company: 'Anthropic', model: 'claude-sonnet-5', color: '#e9a178', mark: '✳' },
  { id: 'gemini', name: 'Gemini', company: 'Google', model: 'gemini-3.8-flash', color: '#94a7ff', mark: '✦' },
] as const;
export type ProviderId = typeof providers[number]['id'];
export type Mode = 'council' | 'deep' | 'fast' | 'compare';
export type Connections = Record<ProviderId, { key: string; model: string; enabled: boolean }>;
export type Result = { drafts: Partial<Record<ProviderId, string>>; reviews: Partial<Record<ProviderId, string>>; revisions?: Partial<Record<ProviderId, string>>; answer: string; by?: ProviderId; errors: string[]; seconds: number; demo: boolean; fallback?: boolean };
export type RunEvent = { type: 'stage' | 'draft' | 'review' | 'revision' | 'error' | 'final'; stage?: string; provider?: ProviderId; text?: string; result?: Result };
export const freshConnections = (): Connections => Object.fromEntries(providers.map(p => [p.id, { key: '', model: p.model, enabled: true }])) as Connections;
