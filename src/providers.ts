import type { ModelEntry, ProviderName, ProviderConfig, Env } from './types';

// En providers.ts
export const MODEL_POOL: ModelEntry[] = [
	{ id: 'gemini-2.5-flash', weight: 4, provider: 'gemini', envKey: 'GOOGLE_API_KEY', contextWindow: 1_048_576 },
	{ id: 'deepseek-v4-flash-20260423', weight: 4, provider: 'deepseek', envKey: 'DEEPSEEK_API_KEY', contextWindow: 1_000_000 },
	{ id: 'llama-3.3-70b-versatile', weight: 3, provider: 'groq', envKey: 'GROQ_API_KEY', contextWindow: 131_072 },
	{ id: 'llama3.1-70b', weight: 3, provider: 'cerebras', envKey: 'CEREBRAS_API_KEY', contextWindow: 131_072 },
	{ id: 'openai/gpt-oss-120b', weight: 2, provider: 'groq', envKey: 'GROQ_API_KEY', contextWindow: 131_072 },
];

export const PROVIDERS: Record<ProviderName, ProviderConfig> = {
	gemini: { url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions' },
	deepseek: { url: 'https://api.deepseek.com/v1/chat/completions' },
	groq: { url: 'https://api.groq.com/openai/v1/chat/completions' },
	cerebras: { url: 'https://api.cerebras.ai/v1/chat/completions' },
};

export const ALT_KEYS: Partial<Record<ProviderName, string[]>> = {};

export function getAvailableModels(env: Env): ModelEntry[] {
	return MODEL_POOL.filter((m) => {
		const key = env[m.envKey];
		return typeof key === 'string' && key.trim().length > 0;
	});
}

export function getModelById(modelId: string): ModelEntry | undefined {
	return MODEL_POOL.find((m) => m.id === modelId);
}

export function getModelAltKeys(model: ModelEntry): string[] {
	return ALT_KEYS[model.provider] ?? [];
}

export function isAltKeyConfigured(provider: ProviderName, env: Env, altKeys: string[]): string[] {
	return altKeys.filter((key) => {
		const val = env[key];
		return typeof val === 'string' && val.trim().length > 0;
	});
}
