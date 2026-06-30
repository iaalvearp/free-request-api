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

	const body: Record<string, unknown> = {
		model: provider.modelId,
		messages: incoming.messages,
		stream: incoming.stream ?? false,
		temperature: incoming.temperature ?? 0.7,
		max_tokens: incoming.max_tokens ?? 4096,
	};

	if (incoming.tools) {
		body.tools = incoming.tools;
	}
	if (incoming.tool_choice) {
		body.tool_choice = incoming.tool_choice;
	}

	return new Request(provider.endpoint, {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
	});
}

// ── Formato Google Gemini ─────────────────────────────────────

function buildGoogleRequest(provider: AIProvider, incoming: IncomingRequest, env: Env): Request {
	const apiKey = env[provider.apiKeyEnvVar];
	const url = `${provider.endpoint}?key=${apiKey}`;

	const contents = incoming.messages
		.filter((m) => m.role !== 'system')
		.map((m) => ({
			role: m.role === 'assistant' ? 'model' : 'user',
			parts: [{ text: m.content }],
		}));

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

	// Traduce tools de formato OpenAI a formato Google (functionDeclarations)
	if (incoming.tools && Array.isArray(incoming.tools) && incoming.tools.length > 0) {
		const functionDeclarations = (incoming.tools as Array<Record<string, unknown>>)
			.filter((tool) => tool.type === 'function')
			.map((tool) => {
				const fn = tool.function as Record<string, unknown>;
				return {
					name: fn.name,
					description: fn.description,
					parameters: fn.parameters,
				};
			});

		if (functionDeclarations.length > 0) {
			body.tools = [{ functionDeclarations }];
		}
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
export async function normalizeResponse(provider: AIProvider, response: Response, stream: boolean = false): Promise<Response> {
	if (provider.format !== 'google') {
		// Proveedores OpenAI-compatible: pasan directo
		const headers = buildResponseHeaders(provider, response);
		return new Response(response.body, {
			status: response.status,
			headers,
		});
	}

	// Google no soporta streaming nativo en este formato,
	// convertimos la respuesta completa a formato OpenAI
	try {
		const googleData = (await response.json()) as Record<string, unknown>;
		const openAIData = convertGoogleToOpenAI(googleData);

		if (stream) {
			// Envolvemos la respuesta de Google en un stream SSE falso
			// para que Continue y otros clientes que piden stream no rompan
			const chunk = JSON.stringify({
				id: openAIData.id,
				object: 'chat.completion.chunk',
				created: openAIData.created,
				model: openAIData.model,
				choices: [
					{
						index: 0,
						delta: {
							role: 'assistant',
							content: (openAIData.choices as Array<Record<string, unknown>>)[0]?.message
								? ((openAIData.choices as Array<Record<string, unknown>>)[0].message as Record<string, unknown>).content
								: '',
						},
						finish_reason: null,
					},
				],
			});

			const finalChunk = JSON.stringify({
				id: openAIData.id,
				object: 'chat.completion.chunk',
				created: openAIData.created,
				model: openAIData.model,
				choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
			});

			const sseBody = `data: ${chunk}\n\ndata: ${finalChunk}\n\ndata: [DONE]\n\n`;

			return new Response(sseBody, {
				status: 200,
				headers: {
					'Content-Type': 'text/event-stream',
					'Cache-Control': 'no-cache',
					'X-Proxy-Provider': provider.name,
					'X-Proxy-Model': provider.modelId,
				},
			});
		}

		return new Response(JSON.stringify(openAIData), {
			status: response.status,
			headers: {
				'Content-Type': 'application/json',
				'X-Proxy-Provider': provider.name,
				'X-Proxy-Model': provider.modelId,
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

	// Busca si alguna parte es una function call
	const functionCallPart = parts?.find((p) => p.functionCall);

	if (functionCallPart) {
		const fc = functionCallPart.functionCall as Record<string, unknown>;
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
						content: null,
						tool_calls: [
							{
								id: `call_${Date.now()}`,
								type: 'function',
								function: {
									name: fc.name,
									arguments: JSON.stringify(fc.args ?? {}),
								},
							},
						],
					},
					finish_reason: 'tool_calls',
				},
			],
			usage: data.usageMetadata ?? {},
		};
	}

	// Respuesta de texto normal, sin tool calls
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
