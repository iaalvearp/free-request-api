// ============================================================
// POOL DE PROVEEDORES
// ============================================================
import type { AIProvider, Env } from './types';

/**
 * Lista completa de proveedores disponibles.
 *
 * PESOS (weight):
 *   10 = prioridad alta (rápido + capaz para código)
 *   7  = prioridad media
 *   4  = fallback de calidad
 *   1  = último recurso (lento o sin key)
 *
 * Puedes agregar más proveedores copiando el patrón de cualquier entrada.
 */
export const PROVIDER_POOL: AIProvider[] = [
	// ─── NVIDIA NIM — Cuenta 1 ───────────────────────────────
	{
		id: 'nvidia-deepseek-flash-1',
		name: 'NVIDIA DeepSeek V4 Flash (cuenta 1)',
		endpoint: 'https://integrate.api.nvidia.com/v1/chat/completions',
		apiKeyEnvVar: 'NVIDIA_API_KEY_1',
		modelId: 'deepseek-ai/deepseek-v4-flash',
		format: 'openai',
		weight: 10,
		requiresApiKey: true,
	},
	{
		id: 'nvidia-nemotron-super-1',
		name: 'NVIDIA Nemotron Super 120B (cuenta 1)',
		endpoint: 'https://integrate.api.nvidia.com/v1/chat/completions',
		apiKeyEnvVar: 'NVIDIA_API_KEY_1',
		modelId: 'nvidia/nemotron-3-super-120b-a12b',
		format: 'openai',
		weight: 9,
		requiresApiKey: true,
	},
	{
		id: 'nvidia-kimi-k2-1',
		name: 'NVIDIA Kimi K2.6 (cuenta 1)',
		endpoint: 'https://integrate.api.nvidia.com/v1/chat/completions',
		apiKeyEnvVar: 'NVIDIA_API_KEY_1',
		modelId: 'moonshotai/kimi-k2.6',
		format: 'openai',
		weight: 9,
		requiresApiKey: true,
	},
	{
		id: 'nvidia-qwen-1',
		name: 'NVIDIA Qwen 3.5 122B (cuenta 1)',
		endpoint: 'https://integrate.api.nvidia.com/v1/chat/completions',
		apiKeyEnvVar: 'NVIDIA_API_KEY_1',
		modelId: 'qwen/qwen3.5-122b-a10b',
		format: 'openai',
		weight: 8,
		requiresApiKey: true,
	},
	{
		id: 'nvidia-deepseek-pro-1',
		name: 'NVIDIA DeepSeek V4 Pro (cuenta 1)',
		endpoint: 'https://integrate.api.nvidia.com/v1/chat/completions',
		apiKeyEnvVar: 'NVIDIA_API_KEY_1',
		modelId: 'deepseek-ai/deepseek-v4-pro',
		format: 'openai',
		weight: 8,
		requiresApiKey: true,
	},

	// ─── NVIDIA NIM — Cuenta 2 ───────────────────────────────
	{
		id: 'nvidia-deepseek-flash-2',
		name: 'NVIDIA DeepSeek V4 Flash (cuenta 2)',
		endpoint: 'https://integrate.api.nvidia.com/v1/chat/completions',
		apiKeyEnvVar: 'NVIDIA_API_KEY_2',
		modelId: 'deepseek-ai/deepseek-v4-flash',
		format: 'openai',
		weight: 10,
		requiresApiKey: true,
	},
	{
		id: 'nvidia-nemotron-super-2',
		name: 'NVIDIA Nemotron Super 120B (cuenta 2)',
		endpoint: 'https://integrate.api.nvidia.com/v1/chat/completions',
		apiKeyEnvVar: 'NVIDIA_API_KEY_2',
		modelId: 'nvidia/nemotron-3-super-120b-a12b',
		format: 'openai',
		weight: 9,
		requiresApiKey: true,
	},
	{
		id: 'nvidia-kimi-k2-2',
		name: 'NVIDIA Kimi K2.6 (cuenta 2)',
		endpoint: 'https://integrate.api.nvidia.com/v1/chat/completions',
		apiKeyEnvVar: 'NVIDIA_API_KEY_2',
		modelId: 'moonshotai/kimi-k2.6',
		format: 'openai',
		weight: 9,
		requiresApiKey: true,
	},

	// ─── NVIDIA NIM — Cuenta 3 ───────────────────────────────
	{
		id: 'nvidia-deepseek-flash-3',
		name: 'NVIDIA DeepSeek V4 Flash (cuenta 3)',
		endpoint: 'https://integrate.api.nvidia.com/v1/chat/completions',
		apiKeyEnvVar: 'NVIDIA_API_KEY_3',
		modelId: 'deepseek-ai/deepseek-v4-flash',
		format: 'openai',
		weight: 10,
		requiresApiKey: true,
	},
	{
		id: 'nvidia-nemotron-super-3',
		name: 'NVIDIA Nemotron Super 120B (cuenta 3)',
		endpoint: 'https://integrate.api.nvidia.com/v1/chat/completions',
		apiKeyEnvVar: 'NVIDIA_API_KEY_3',
		modelId: 'nvidia/nemotron-3-super-120b-a12b',
		format: 'openai',
		weight: 9,
		requiresApiKey: true,
	},

	// ─── GROQ ─────────────────────────────────────────────────
	{
		id: 'groq-llama70b',
		name: 'Groq Llama 3.3 70B',
		endpoint: 'https://api.groq.com/openai/v1/chat/completions',
		apiKeyEnvVar: 'GROQ_API_KEY',
		modelId: 'llama-3.3-70b-versatile',
		format: 'openai',
		weight: 8,
		requiresApiKey: true,
	},
	{
		id: 'groq-deepseek-r1',
		name: 'Groq DeepSeek R1 Distill 70B',
		endpoint: 'https://api.groq.com/openai/v1/chat/completions',
		apiKeyEnvVar: 'GROQ_API_KEY',
		modelId: 'deepseek-r1-distill-llama-70b',
		format: 'openai',
		weight: 7,
		requiresApiKey: true,
	},

	// ─── GOOGLE AI STUDIO ─────────────────────────────────────
	{
		id: 'google-gemini-flash',
		name: 'Google Gemini 2.5 Flash',
		// La URL incluye el modelo y la key como query param (se inyecta en transformer)
		endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
		apiKeyEnvVar: 'GOOGLE_API_KEY',
		modelId: 'gemini-2.5-flash',
		format: 'google',
		weight: 6,
		requiresApiKey: true,
	},

	// ─── OPENROUTER ───────────────────────────────────────────
	{
		id: 'openrouter-deepseek-flash',
		name: 'OpenRouter DeepSeek V4 Flash',
		endpoint: 'https://openrouter.ai/api/v1/chat/completions',
		apiKeyEnvVar: 'OPENROUTER_API_KEY',
		modelId: 'deepseek/deepseek-v4-flash',
		format: 'openai',
		weight: 5,
		requiresApiKey: true,
	},
	{
		id: 'openrouter-kimi',
		name: 'OpenRouter Kimi K2.6',
		endpoint: 'https://openrouter.ai/api/v1/chat/completions',
		apiKeyEnvVar: 'OPENROUTER_API_KEY',
		modelId: 'moonshotai/kimi-k2.6',
		format: 'openai',
		weight: 5,
		requiresApiKey: true,
	},

	// ─── OVHCLOUD (sin registro, último recurso) ──────────────
	{
		id: 'ovh-llama70b',
		name: 'OVHcloud Llama 3.3 70B (anónimo)',
		endpoint: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions',
		apiKeyEnvVar: '',
		modelId: 'meta-llama/Meta-Llama-3.3-70B-Instruct',
		format: 'openai',
		weight: 1,
		requiresApiKey: false,
	},
];

/**
 * Devuelve el pool filtrado: solo proveedores que tienen
 * su API key configurada en el entorno actual.
 * Los proveedores sin key (OVHcloud) siempre se incluyen.
 */
export function getAvailableProviders(env: Env): AIProvider[] {
	return PROVIDER_POOL.filter((p) => {
		if (!p.requiresApiKey) return true;
		const key = env[p.apiKeyEnvVar];
		return typeof key === 'string' && key.trim().length > 0;
	});
}
