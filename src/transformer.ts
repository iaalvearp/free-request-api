// ============================================================
// TRANSFORMER: adapta requests y responses entre formatos
// ============================================================
import type { AIProvider, IncomingRequest, Env } from './types';

/**
 * Construye el fetch Request listo para enviar al proveedor.
 * Maneja las diferencias entre formato OpenAI y Google Gemini.
 */
export function buildProviderRequest(provider: AIProvider, incoming: IncomingRequest, env: Env): Request {
	if (provider.format === 'google') {
		return buildGoogleRequest(provider, incoming, env);
	}
	return buildOpenAIRequest(provider, incoming, env);
}

// ── Formato OpenAI (NVIDIA, Groq, OpenRouter, OVHcloud) ──────

function buildOpenAIRequest(provider: AIProvider, incoming: IncomingRequest, env: Env): Request {
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
	};

	if (provider.requiresApiKey) {
		headers['Authorization'] = `Bearer ${env[provider.apiKeyEnvVar]}`;
	}

	// OpenRouter requiere headers adicionales de identificación
	if (provider.id.startsWith('openrouter-')) {
		headers['HTTP-Referer'] = 'https://my-ai-proxy.workers.dev';
		headers['X-Title'] = 'AI Proxy';
	}

	const body = {
		model: provider.modelId,
		messages: incoming.messages,
		stream: incoming.stream ?? false,
		temperature: incoming.temperature ?? 0.7,
		max_tokens: incoming.max_tokens ?? 4096,
	};

	return new Request(provider.endpoint, {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
	});
}

// ── Formato Google Gemini ─────────────────────────────────────

function buildGoogleRequest(provider: AIProvider, incoming: IncomingRequest, env: Env): Request {
	const apiKey = env[provider.apiKeyEnvVar];
	// Google recibe la key como query param
	const url = `${provider.endpoint}?key=${apiKey}`;

	// Convierte el formato OpenAI de mensajes al formato de Google
	const contents = incoming.messages
		.filter((m) => m.role !== 'system')
		.map((m) => ({
			role: m.role === 'assistant' ? 'model' : 'user',
			parts: [{ text: m.content }],
		}));

	// El system prompt va aparte en Google
	const systemMessage = incoming.messages.find((m) => m.role === 'system');
	const systemInstruction = systemMessage ? { parts: [{ text: systemMessage.content }] } : undefined;

	const body: Record<string, unknown> = {
		contents,
		generationConfig: {
			temperature: incoming.temperature ?? 0.7,
			maxOutputTokens: incoming.max_tokens ?? 4096,
		},
	};

	if (systemInstruction) {
		body.systemInstruction = systemInstruction;
	}

	return new Request(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
}

/**
 * Convierte la respuesta de Google Gemini al formato OpenAI.
 * NVIDIA, Groq, OpenRouter y OVHcloud ya devuelven formato OpenAI,
 * así que esos pasan directo sin transformación.
 */
export async function normalizeResponse(provider: AIProvider, response: Response): Promise<Response> {
	if (provider.format !== 'google') {
		// Pasa directo, solo añadimos el header de diagnóstico
		return new Response(response.body, {
			status: response.status,
			headers: buildResponseHeaders(provider, response),
		});
	}

	// Para Google: leemos el body, lo convertimos, devolvemos formato OpenAI
	try {
		const googleData = (await response.json()) as Record<string, unknown>;
		const openAIData = convertGoogleToOpenAI(googleData);

		return new Response(JSON.stringify(openAIData), {
			status: response.status,
			headers: {
				'Content-Type': 'application/json',
				'X-Proxy-Provider': provider.name,
			},
		});
	} catch {
		return new Response(JSON.stringify({ error: { message: 'Error al convertir respuesta de Google', type: 'proxy_error' } }), {
			status: 502,
			headers: { 'Content-Type': 'application/json' },
		});
	}
}

function buildResponseHeaders(provider: AIProvider, upstream: Response): HeadersInit {
	const headers: Record<string, string> = {
		'X-Proxy-Provider': provider.name,
		'X-Proxy-Model': provider.modelId,
	};

	// Preserva headers de streaming si los hay
	const contentType = upstream.headers.get('Content-Type');
	if (contentType) headers['Content-Type'] = contentType;

	if (upstream.headers.get('Transfer-Encoding')) {
		headers['Transfer-Encoding'] = 'chunked';
	}

	return headers;
}

function convertGoogleToOpenAI(data: Record<string, unknown>): Record<string, unknown> {
	const candidates = data.candidates as Array<Record<string, unknown>> | undefined;
	const firstCandidate = candidates?.[0];
	const content = firstCandidate?.content as Record<string, unknown> | undefined;
	const parts = content?.parts as Array<Record<string, unknown>> | undefined;
	const text = (parts?.[0]?.text as string) ?? '';

	return {
		id: `chatcmpl-google-${Date.now()}`,
		object: 'chat.completion',
		created: Math.floor(Date.now() / 1000),
		model: 'gemini-2.5-flash',
		choices: [
			{
				index: 0,
				message: {
					role: 'assistant',
					content: text,
				},
				finish_reason: 'stop',
			},
		],
		usage: data.usageMetadata ?? {},
	};
}
