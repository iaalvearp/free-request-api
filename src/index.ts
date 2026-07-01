import type { Env, IncomingRequest, ChatMessage, ProviderName, ModelEntry } from './types';
import { getAvailableModels, getModelById, isAltKeyConfigured, getModelAltKeys } from './providers';
import {
	selectWeightedModel,
	selectFallbackModel,
	markSuccess,
	markRateLimited,
	markError,
	checkThrottle,
	updateThrottle,
	getHealthSnapshot,
} from './selector';
import { buildUpstreamRequest, buildProxyResponse } from './transformer';
import { log, errorResponse } from './utils';
import { incrementRequestCount, getTodayStats } from './stats';

const UPSTREAM_TIMEOUT_MS = 25_000;

function isOpenCodeClient(request: Request): boolean {
	const ua = request.headers.get('User-Agent') ?? '';
	return ua.toLowerCase().includes('opencode') || request.headers.has('X-OpenCode-Session');
}

function estimateTokenCount(messages: ChatMessage[]): number {
	const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
	return Math.ceil(totalChars / 4);
}

function checkContextOverflow(
	messages: ChatMessage[],
	contextWindow: number,
): { overflow: true; estimated: number; threshold: number } | { overflow: false } {
	const estimated = estimateTokenCount(messages);
	const threshold = contextWindow <= 131_072 ? 50_000 : Math.floor(contextWindow * 0.8);
	if (estimated > threshold) {
		return { overflow: true, estimated, threshold };
	}
	return { overflow: false };
}

function maskAuthHeader(request: Request): string {
	const auth = request.headers.get('Authorization') ?? '';
	if (auth.startsWith('Bearer ')) {
		const key = auth.slice(7);
		if (key.length > 8) {
			return `Bearer ${key.slice(0, 4)}***${key.slice(-4)}`;
		}
		return 'Bearer ***';
	}
	return auth;
}

interface AttemptRecord {
	model: string;
	provider: ProviderName;
	reason: string;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const startTime = Date.now();
		const url = new URL(request.url);

		// CORS preflight
		if (request.method === 'OPTIONS') {
			return new Response(null, {
				headers: {
					'Access-Control-Allow-Origin': '*',
					'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
					'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-OpenCode-Session',
				},
			});
		}

		// GET /health
		if (request.method === 'GET' && url.pathname === '/health') {
			const snapshot = getHealthSnapshot();
			return new Response(JSON.stringify({ status: 'ok', providers: snapshot }, null, 2), {
				headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
			});
		}

		// GET /stats
		if (request.method === 'GET' && url.pathname === '/stats') {
			const authHeader = request.headers.get('Authorization');
			const expectedAuth = `Bearer ${env.CUSTOM_API_KEY}`;
			if (!authHeader || authHeader !== expectedAuth) {
				return errorResponse('Unauthorized', 401, 'unauthorized');
			}
			const stats = await getTodayStats(env);
			return new Response(JSON.stringify(stats, null, 2), {
				headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
			});
		}

		// Only POST /v1/chat/completions
		if (request.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
			return errorResponse('Usa POST /v1/chat/completions', 404, 'not_found');
		}

		// Auth
		const authHeader = request.headers.get('Authorization');
		const expectedAuth = `Bearer ${env.CUSTOM_API_KEY}`;
		if (!authHeader || authHeader !== expectedAuth) {
			log('WARN', 'Request rechazado: CUSTOM_API_KEY inválida', { maskedAuth: maskAuthHeader(request) });
			return errorResponse('Unauthorized: CUSTOM_API_KEY inválida', 401, 'unauthorized');
		}

		// Parse body
		let incoming: IncomingRequest;
		try {
			incoming = (await request.json()) as IncomingRequest;
		} catch {
			return errorResponse('Body inválido: se esperaba JSON', 400, 'invalid_request');
		}

		if (!incoming.messages || incoming.messages.length === 0) {
			return errorResponse('"messages" es requerido', 400, 'invalid_request');
		}

		// Detect OpenCode client
		const openCode = isOpenCodeClient(request);
		const userRequestedModel = incoming.model && incoming.model.trim().length > 0 ? incoming.model.trim() : null;

		// Get available models
		const availableModels = getAvailableModels(env);
		if (availableModels.length === 0) {
			log('ERROR', 'No hay modelos configurados (ninguna API key válida)');
			return errorResponse('No hay proveedores de IA configurados', 503, 'no_providers');
		}

		// Model selection
		let targetModel: ModelEntry | null = null;
		let useRotation = true;

		if (openCode && userRequestedModel) {
			targetModel = getModelById(userRequestedModel) ?? null;
			if (!targetModel) {
				// If OpenCode requested a model not in our pool, try to use any available model
				log('WARN', `OpenCode solicitó modelo "${userRequestedModel}" no en pool, usando selección automática`);
				targetModel = selectWeightedModel(availableModels);
			} else if (!availableModels.some((m) => m.id === targetModel!.id)) {
				// Model is in pool but its key is not configured
				log('WARN', `OpenCode solicitó modelo "${userRequestedModel}" sin API key configurada, usando selección automática`);
				targetModel = selectWeightedModel(availableModels);
			} else {
				useRotation = false;
			}
		} else {
			targetModel = selectWeightedModel(availableModels);
		}

		if (!targetModel) {
			return errorResponse('No se pudo seleccionar un modelo', 503, 'no_models');
		}

		// Context overflow check
		const overflow = checkContextOverflow(incoming.messages, targetModel.contextWindow);
		if (overflow.overflow) {
			log('WARN', 'Context overflow detectado antes de enviar', {
				model: targetModel.id,
				estimated: overflow.estimated,
				threshold: overflow.threshold,
			});
			return new Response(
				JSON.stringify({
					error: {
						message: `Contexto demasiado grande para ${targetModel.id}: ~${overflow.estimated} tokens estimados, máximo ${overflow.threshold}`,
						type: 'context_too_large',
						code: 'context_too_large',
					},
				}),
				{
					status: 400,
					headers: {
						'Content-Type': 'application/json',
						'Access-Control-Allow-Origin': '*',
						'X-Reason': 'context-too-large-for-model',
						'X-Model-Used': targetModel.id,
						'X-Provider-Used': targetModel.provider,
						'X-Model-Context-Window': String(targetModel.contextWindow),
					},
				},
			);
		}

		// Failover loop
		const errors: AttemptRecord[] = [];
		let fallbackCount = 0;
		let currentModel: ModelEntry | null = targetModel;
		let triedEntries = new Set<string>();

		while (currentModel && errors.length < availableModels.length * 2) {
			const envKeysToTry = [currentModel.envKey];

			// Add alt keys for this provider if configured and available
			const altKeys = getModelAltKeys(currentModel);
			const configuredAltKeys = isAltKeyConfigured(currentModel.provider, env, altKeys);
			envKeysToTry.push(...configuredAltKeys);

			for (const envKey of envKeysToTry) {
				const attemptKey = `${currentModel.id}:${envKey}`;
				if (triedEntries.has(attemptKey)) continue;
				triedEntries.add(attemptKey);

				// Throttle check
				const waitMs = checkThrottle(currentModel.provider);
				if (waitMs !== null) {
					await new Promise((r) => setTimeout(r, waitMs));
				}
				updateThrottle(currentModel.provider);

				const controller = new AbortController();
				const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

				try {
					const upstreamReq = buildUpstreamRequest(currentModel, envKey, incoming, env, controller.signal);
					const response = await fetch(upstreamReq);

					// Rate limited
					if (response.status === 429) {
						markRateLimited(currentModel.provider);
						const reason = `429 rate limited (${currentModel.provider})`;
						errors.push({ model: currentModel.id, provider: currentModel.provider, reason });
						fallbackCount++;
						log('WARN', `429 en ${currentModel.id} (key: ${envKey})`, { provider: currentModel.provider });
						continue;
					}

					// Upstream error
					if (response.status >= 500) {
						markError(currentModel.provider);
						const reason = `${response.status} ${response.statusText} (${currentModel.provider})`;
						errors.push({ model: currentModel.id, provider: currentModel.provider, reason });
						fallbackCount++;
						log('WARN', `Error ${response.status} en ${currentModel.id}`, { provider: currentModel.provider });
						continue;
					}

					// 400 context_length_exceeded
					if (response.status === 400) {
						const body = await response.text();
						const isContextError = body.toLowerCase().includes('context_length') || body.toLowerCase().includes('too large') || body.toLowerCase().includes('maximum context');
						if (isContextError) {
							const reason = `400 context_length_exceeded (${currentModel.provider})`;
							errors.push({ model: currentModel.id, provider: currentModel.provider, reason });
							fallbackCount++;
							log('WARN', `Context length exceeded en ${currentModel.id}`, { provider: currentModel.provider });
							continue;
						}
						// Non-context 400: return to client
						markError(currentModel.provider);
						const proxyResponse = buildProxyResponse(
							new Response(body, { status: 400, headers: { 'Content-Type': 'application/json' } }),
							currentModel.id,
							currentModel.provider,
							currentModel.contextWindow,
							null,
							fallbackCount,
						);
						log('INFO', 'Request completado (400 no-context)', {
							model: currentModel.id,
							provider: currentModel.provider,
							status: 400,
							fallbackCount,
							durationMs: Date.now() - startTime,
						});
						return proxyResponse;
					}

					// Success
					markSuccess(currentModel.provider);
					ctx.waitUntil(incrementRequestCount(env));

					const retryReason = errors.length > 0 ? errors.map((e) => e.reason).join('; ') : null;
					const proxyResponse = buildProxyResponse(
						response,
						currentModel.id,
						currentModel.provider,
						currentModel.contextWindow,
						retryReason,
						fallbackCount,
					);

					log('INFO', 'Request completado', {
						model: currentModel.id,
						provider: currentModel.provider,
						status: response.status,
						openCode,
						fallbackCount,
						durationMs: Date.now() - startTime,
					});

					return proxyResponse;
				} catch (err) {
					const isTimeout = err instanceof DOMException && err.name === 'AbortError';
					const reason = isTimeout
						? `timeout (${currentModel.provider})`
						: `error: ${err instanceof Error ? err.message : 'desconocido'} (${currentModel.provider})`;
					errors.push({ model: currentModel.id, provider: currentModel.provider, reason });
					fallbackCount++;
					markError(currentModel.provider);
					log('WARN', `Fallo en ${currentModel.id}`, { provider: currentModel.provider, error: reason });
				} finally {
					clearTimeout(timeoutId);
				}
			}

			// Move to next model in pool
			if (useRotation) {
				currentModel = selectFallbackModel(currentModel!.id, availableModels);
			} else {
				// OpenCode locked to a model: try to find any other available model
				const otherModels = availableModels.filter((m) => m.id !== currentModel!.id);
				currentModel = selectWeightedModel(otherModels);
				useRotation = true; // After first failure, allow rotation
			}
		}

		// All attempts failed
		const lastErrors = errors.slice(-3).map((e) => `${e.provider}/${e.model}: ${e.reason}`);
		log('ERROR', 'Todos los proveedores fallaron', {
			errors: errors.length,
			lastErrors,
			durationMs: Date.now() - startTime,
		});

		return new Response(
			JSON.stringify({
				error: {
					message: 'Todos los proveedores fallaron',
					type: 'all_providers_failed',
					code: 'all_providers_failed',
					lastErrors,
				},
			}),
			{
				status: 502,
				headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
			},
		);
	},
};
