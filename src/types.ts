export interface ChatMessage {
	role: string;
	content: string;
	reasoning_content?: unknown;
	reasoning?: unknown;
	thinking?: unknown;
	tool_calls?: unknown[];
	tool_call_id?: string;
	function_call?: Record<string, unknown>;
	[key: string]: unknown;
}

export interface IncomingRequest {
	model?: string;
	messages: ChatMessage[];
	stream?: boolean;
	temperature?: number;
	top_p?: number;
	max_tokens?: number;
	tools?: unknown[];
	tool_choice?: unknown;
	[key: string]: unknown;
}

export type ProviderName = 'gemini' | 'nvidia' | 'groq' | 'cerebras';

export type VirtualRoute = 'alpes-auto' | 'alpes-agent' | 'alpes-small';

export interface AffinityEntry {
	modelId: string;
	provider: ProviderName;
	timestamp: number;
}

export interface ModelEntry {
	id: string;
	weight: number;
	provider: ProviderName;
	envKey: string;
	contextWindow: number;
}

export interface ProviderConfig {
	url: string;
}

export interface ProviderHealth {
	lastSuccess: number;
	last429: number;
	lastError: number;
	successCount: number;
	failureCount: number;
	cooldownUntil: number;
	consecutiveFailures: number;
}

export interface Env {
	CUSTOM_API_KEY: string;
	ENVIRONMENT: string;
	GOOGLE_API_KEY: string;
	NVIDIA_API_KEY: string;
	GROQ_API_KEY: string;
	CEREBRAS_API_KEY: string;
	PROXY_STATS: KVNamespace;
	MODEL_ANALYTICS: AnalyticsEngineDataset;
	[key: string]: unknown;
}
