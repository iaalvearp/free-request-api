export interface ChatMessage {
	role: 'user' | 'assistant' | 'system';
	content: string;
}

export interface IncomingRequest {
	model?: string;
	messages: ChatMessage[];
	stream?: boolean;
	temperature?: number;
	max_tokens?: number;
	tools?: unknown[];
	tool_choice?: unknown;
	[key: string]: unknown;
}

export type ProviderName = 'gemini' | 'deepseek' | 'groq' | 'cerebras';

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
	PROXY_KEY: string;
	ENVIRONMENT: string;
	GEMINI_API_KEY_1: string;
	GEMINI_API_KEY_2: string;
	DEEPSEEK_API_KEY: string;
	GROQ_API_KEY: string;
	CEREBRAS_API_KEY: string;
	PROXY_STATS: KVNamespace;
	[key: string]: unknown;
}
