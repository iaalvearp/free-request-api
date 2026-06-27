// ============================================================
// TIPOS GLOBALES DEL PROXY
// ============================================================

/**
 * Formato de mensaje compatible con OpenAI (lo que manda Opencode)
 */
export interface ChatMessage {
	role: 'user' | 'assistant' | 'system';
	content: string;
}

/**
 * El body que llega desde Opencode/VSCode al proxy
 */
export interface IncomingRequest {
	model?: string;
	messages: ChatMessage[];
	stream?: boolean;
	temperature?: number;
	max_tokens?: number;
	[key: string]: unknown;
}

/**
 * Formatos de API que soporta el proxy.
 * - openai: formato estándar (NVIDIA NIM, Groq, OpenRouter, OVHcloud)
 * - google: formato nativo de Gemini (distinto al de OpenAI)
 */
export type ProviderFormat = 'openai' | 'google';

/**
 * Estado de salud de un proveedor en esta instancia del Worker
 */
export interface ProviderHealth {
	cooldownUntil: number; // timestamp en ms; 0 = disponible
	consecutiveFailures: number;
}

/**
 * Definición de un proveedor en el pool
 */
export interface AIProvider {
	id: string; // identificador único, ej: "nvidia-deepseek-flash"
	name: string; // nombre legible, ej: "NVIDIA DeepSeek V4 Flash"
	endpoint: string; // URL completa del endpoint
	apiKeyEnvVar: string; // nombre de la variable de entorno con la API key
	modelId: string; // el model ID que espera el proveedor
	format: ProviderFormat; // formato de la API
	weight: number; // peso para weighted random (mayor = más probabilidad)
	requiresApiKey: boolean; // false para OVHcloud anónimo
}

/**
 * Variables de entorno disponibles en el Worker.
 * Cada API key se inyecta como secreto en Cloudflare.
 */
export interface Env {
	CUSTOM_API_KEY: string; // tu clave personal para proteger el proxy
	ENVIRONMENT: string;

	// NVIDIA NIM (puedes tener múltiples cuentas)
	NVIDIA_API_KEY_1: string;
	NVIDIA_API_KEY_2: string;
	NVIDIA_API_KEY_3: string;

	// Groq
	GROQ_API_KEY: string;

	// Google AI Studio
	GOOGLE_API_KEY: string;

	// OpenRouter
	OPENROUTER_API_KEY: string;

	// OVHcloud (no necesita key, pero la interfaz lo requiere)
	PROXY_STATS: KVNamespace;
	[key: string]: unknown;
}

/**
 * Resultado de intentar llamar a un proveedor
 */
export interface ProxyAttempt {
	provider: AIProvider;
	response: Response | null;
	error: string | null;
}
