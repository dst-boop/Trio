export const providers = [
  { id: 'openai', name: 'ChatGPT', company: 'OpenAI', model: 'gpt-6-astra', color: '#72d7b6', mark: '◎' },
  { id: 'claude', name: 'Claude', company: 'Anthropic', model: 'claude-sonnet-5', color: '#e9a178', mark: '✳' },
  { id: 'gemini', name: 'Gemini', company: 'Google', model: 'gemini-3.8-flash', color: '#94a7ff', mark: '✦' },
] as const;
export type ProviderId = typeof providers[number]['id'];
export type Mode = 'council' | 'deep' | 'fast' | 'compare';
export type Connections = Record<ProviderId, { key: string; model: string; enabled: boolean }>;
export type ProviderUsage = { model: string; calls: number; reportedCalls: number; inputTokens: number; outputTokens: number; costUSD: number | null };
export type Usage = { calls: number; reportedCalls: number; inputTokens: number; outputTokens: number; costUSD: number | null; byProvider: Partial<Record<ProviderId, ProviderUsage>> };
export type Result = { drafts: Partial<Record<ProviderId, string>>; reviews: Partial<Record<ProviderId, string>>; revisions?: Partial<Record<ProviderId, string>>; answer: string; by?: ProviderId; errors: string[]; seconds: number; demo: boolean; fallback?: boolean; usage?: Usage; researchRequested?: boolean; researchBy?: 'openai' | 'claude'; research?: import('./research.ts').Research };
export type Phase = 'research' | 'draft' | 'review' | 'revision' | 'synthesis';
export type RunEvent = { type: 'stage' | 'research' | 'draft' | 'review' | 'revision' | 'error' | 'final' | 'usage' | 'contribution_start' | 'contribution_delta'; stage?: string; phase?: Phase; provider?: ProviderId; text?: string; result?: Result; usage?: Usage; research?: import('./research.ts').Research };
export const freshConnections = (): Connections => Object.fromEntries(providers.map(p => [p.id, { key: '', model: p.model, enabled: true }])) as Connections;
