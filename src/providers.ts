import type { ModelEntry, ProviderName, ProviderConfig, Env, VirtualRoute } from './types';

// En providers.ts
export const MODEL_POOL: ModelEntry[] = [
	{ id: 'gemini-2.5-flash', weight: 4, provider: 'gemini', envKey: 'GOOGLE_API_KEY', contextWindow: 1_048_576 },
	{ id: 'deepseek-ai/deepseek-v4-flash', weight: 5, provider: 'nvidia', envKey: 'NVIDIA_API_KEY', contextWindow: 1_000_000 },
	{ id: 'z-ai/glm-5.2', weight: 4, provider: 'nvidia', envKey: 'NVIDIA_API_KEY', contextWindow: 1_000_000 },
	{ id: 'nvidia/nemotron-3-super-120b-a12b', weight: 3, provider: 'nvidia', envKey: 'NVIDIA_API_KEY', contextWindow: 1_000_000 },
	{ id: 'nvidia/nemotron-3-nano-30b-a3b', weight: 3, provider: 'nvidia', envKey: 'NVIDIA_API_KEY', contextWindow: 1_000_000 },
	{ id: 'llama-3.3-70b-versatile', weight: 3, provider: 'groq', envKey: 'GROQ_API_KEY', contextWindow: 131_072 },
	{ id: 'gpt-oss-120b', weight: 3, provider: 'cerebras', envKey: 'CEREBRAS_API_KEY', contextWindow: 131_072 },
	{ id: 'openai/gpt-oss-120b', weight: 2, provider: 'groq', envKey: 'GROQ_API_KEY', contextWindow: 131_072 },
];

export const PROVIDERS: Record<ProviderName, ProviderConfig> = {
	gemini: { url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions' },
	nvidia: { url: 'https://integrate.api.nvidia.com/v1/chat/completions' },
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

export const ROUTE_WEIGHTS: Partial<Record<VirtualRoute, Record<string, number>>> = {
	'alpes-small': {
		'nvidia/nemotron-3-nano-30b-a3b': 10,
		'gpt-oss-120b': 3,
		'llama-3.3-70b-versatile': 1,
		'openai/gpt-oss-120b': 1,
	},
};

export function filterModelsByRoute(models: ModelEntry[], route: VirtualRoute): ModelEntry[] {
	switch (route) {
		case 'alpes-agent':
			return models.filter((m) => m.contextWindow >= 1_000_000 && m.id !== 'nvidia/nemotron-3-nano-30b-a3b');
		case 'alpes-small': {
			const smallOrder: string[] = [
				'nvidia/nemotron-3-nano-30b-a3b',
				'gpt-oss-120b',
				'llama-3.3-70b-versatile',
				'openai/gpt-oss-120b',
			];
			return smallOrder
				.map((id) => models.find((m) => m.id === id))
				.filter((m): m is ModelEntry => m !== undefined);
		}
		case 'alpes-auto':
		default:
			return [...models];
	}
}

export function getVirtualContextWindow(models: ModelEntry[], route: VirtualRoute): number {
	const routeModels = filterModelsByRoute(models, route);
	if (routeModels.length === 0) return 131_072;
	return Math.min(...routeModels.map((m) => m.contextWindow));
}

export function getRouteDisplayName(route: VirtualRoute): string {
	return route;
}
