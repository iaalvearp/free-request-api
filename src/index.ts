import type { Env, IncomingRequest, ChatMessage, ProviderName, ModelEntry, VirtualRoute } from './types';
import { getAvailableModels, getModelById, isAltKeyConfigured, getModelAltKeys, filterModelsByRoute, getVirtualContextWindow, ROUTE_WEIGHTS } from './providers';
import {
	selectWeightedModel,
	markSuccess,
	markRateLimited,
	markError,
	markResourceExhausted,
	markRetired,
	isRetired,
	checkThrottle,
	updateThrottle,
	getHealthSnapshot,
	filterAvailableModels,
	selectFallbackModel,
	selectNextUntriedModel,
	selectModelForRoute,
	updateAffinity,
} from './selector';
import { buildUpstreamRequest, buildProxyResponse, normalizeMessagesForModel } from './transformer';
import { log, errorResponse } from './utils';
import { logModelHealthEvent } from './telemetry';
import { incrementRequestCount, getTodayStats } from './stats';

const UPSTREAM_TIMEOUT_MS = 25_000;

const VIRTUAL_MODELS: VirtualRoute[] = ['alpes-auto', 'alpes-agent', 'alpes-small'];

function isVirtualModel(model: string): model is VirtualRoute {
	return VIRTUAL_MODELS.includes(model as VirtualRoute);
}

function isOpenCodeClient(request: Request): boolean {
	const ua = request.headers.get('User-Agent') ?? '';
	return ua.toLowerCase().includes('opencode') || request.headers.has('X-OpenCode-Session');
}

function getSessionId(request: Request): string | null {
	return request.headers.get('X-OpenCode-Session');
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

function isResourceExhausted(status: number, bodyText: string): boolean {
	if (status === 429 || status === 502 || status === 503) {
		const lower = bodyText.toLowerCase();
		return (
			lower.includes('resourceexhausted') ||
			lower.includes('resource exhausted') ||
			lower.includes('worker local total request limit reached') ||
			lower.includes('total request limit reached') ||
			lower.includes('quota exhausted') ||
			lower.includes('capacity exhausted')
		);
	}
	return false;
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

		// Detect OpenCode client and session
		const openCode = isOpenCodeClient(request);
		const sessionId = getSessionId(request);
		const userRequestedModel = incoming.model && incoming.model.trim().length > 0 ? incoming.model.trim() : null;

		// Determine virtual route
		let virtualRoute: VirtualRoute | null = null;
		if (userRequestedModel && isVirtualModel(userRequestedModel)) {
			virtualRoute = userRequestedModel;
		}

		// Get available models
		const allAvailableModels = getAvailableModels(env);
		if (allAvailableModels.length === 0) {
			log('ERROR', 'No hay modelos configurados (ninguna API key válida)');
			return errorResponse('No hay proveedores de IA configurados', 503, 'no_providers');
		}

		// Filter models by virtual route (and exclude retired models)
		const routeModels = (virtualRoute
			? filterModelsByRoute(allAvailableModels, virtualRoute)
			: allAvailableModels
		).filter((m) => !isRetired(m.provider, m.id));

		if (routeModels.length === 0) {
			log('ERROR', `Ningún modelo disponible para ruta ${virtualRoute}`);
			return errorResponse(`No hay modelos disponibles para ${virtualRoute}`, 503, 'no_models_for_route');
		}

		// Model selection
		let targetModel: ModelEntry | null = null;
		let triedEntries = new Set<string>();
		let triedModelIds = new Set<string>();
		let fallbackCount = 0;
		const errors: AttemptRecord[] = [];
		const streaming = incoming.stream ?? false;
		let attemptStart = Date.now();

		const logAttempt = (
			model: ModelEntry,
			result: 'success' | 'failure',
			errorType?: string,
			httpStatus?: number,
		) => {
			logModelHealthEvent(env, {
				model: model.id,
				provider: model.provider,
				route: virtualRoute ?? 'direct',
				result,
				errorType,
				httpStatus,
				durationMs: Date.now() - attemptStart,
				fallbackIndex: fallbackCount,
				streaming,
			});
		};

		if (userRequestedModel && isVirtualModel(userRequestedModel)) {
			// Virtual route: select with affinity and route-specific weights
			const routeWeights = virtualRoute ? ROUTE_WEIGHTS[virtualRoute] : undefined;
			targetModel = selectModelForRoute(routeModels, virtualRoute, sessionId, triedEntries, routeWeights);
			if (!targetModel) {
				return errorResponse('No se pudo seleccionar un modelo', 503, 'no_models');
			}
		} else if (userRequestedModel) {
			// Explicit model requested
			targetModel = getModelById(userRequestedModel) ?? null;
			if (!targetModel || !allAvailableModels.some((m) => m.id === targetModel!.id)) {
				log('WARN', `Modelo "${userRequestedModel}" no disponible, selección automática`);
				targetModel = selectWeightedModel(routeModels);
			} else if (isRetired(targetModel.provider, targetModel.id)) {
				log('WARN', `Modelo "${userRequestedModel}" retirado (410), selección automática`);
				targetModel = selectWeightedModel(routeModels);
			}
		} else {
			// No model specified
			targetModel = selectWeightedModel(routeModels);
		}

		if (!targetModel) {
			return errorResponse('No se pudo seleccionar un modelo', 503, 'no_models');
		}

		// Compute context window for overflow check
		const overflowCheckWindow = virtualRoute
			? getVirtualContextWindow(allAvailableModels, virtualRoute)
			: targetModel.contextWindow;

		// Context overflow check
		const overflow = checkContextOverflow(incoming.messages, overflowCheckWindow);
		if (overflow.overflow) {
			log('WARN', 'Context overflow detectado antes de enviar', {
				route: virtualRoute,
				model: targetModel.id,
				estimated: overflow.estimated,
				threshold: overflow.threshold,
				contextWindow: overflowCheckWindow,
			});
			return new Response(
				JSON.stringify({
					error: {
						message: `Contexto demasiado grande: ~${overflow.estimated} tokens estimados, máximo ${overflow.threshold} para contexto ${overflowCheckWindow}`,
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
						'X-Model-Context-Window': String(overflowCheckWindow),
					},
				},
			);
		}

		// Failover loop — max one attempt per model
		while (targetModel && triedModelIds.size < routeModels.length) {
			if (triedModelIds.has(targetModel.id)) {
				targetModel = selectNextUntriedModel(targetModel.id, routeModels, triedModelIds);
				continue;
			}

			const envKeysToTry = [targetModel.envKey];
			const altKeys = getModelAltKeys(targetModel);
			const configuredAltKeys = isAltKeyConfigured(targetModel.provider, env, altKeys);
			envKeysToTry.push(...configuredAltKeys);

			for (const envKey of envKeysToTry) {
				const attemptKey = `${targetModel.id}:${envKey}`;
				if (triedEntries.has(attemptKey)) continue;
				triedEntries.add(attemptKey);

				// Throttle check (per provider)
				const waitMs = checkThrottle(targetModel.provider);
				if (waitMs !== null) {
					await new Promise((r) => setTimeout(r, waitMs));
				}
				updateThrottle(targetModel.provider);

				const controller = new AbortController();
				const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

				try {
					attemptStart = Date.now();
					const normalizedMessages = normalizeMessagesForModel(incoming.messages);
					const normalizedIncoming = { ...incoming, messages: normalizedMessages };
					const upstreamReq = buildUpstreamRequest(targetModel, envKey, normalizedIncoming, env, controller.signal);
					const response = await fetch(upstreamReq);

					const isStreaming = incoming.stream ?? false;

					// If streaming, mark success before returning the ReadableStream
					if (isStreaming && response.status === 200 && response.body !== null) {
						logAttempt(targetModel, 'success', undefined, response.status);
						markSuccess(targetModel.provider, targetModel.id);
						ctx.waitUntil(incrementRequestCount(env));
						if (virtualRoute && sessionId) {
							updateAffinity(sessionId, virtualRoute, targetModel.id, targetModel.provider);
						}
					}

					// If streaming, return the ReadableStream directly
					if (isStreaming && response.status === 200 && response.body !== null) {
						const retryReason = errors.length > 0 ? errors.map((e) => e.reason).join('; ') : null;
						log('INFO', 'Request completado (streaming)', {
							route: virtualRoute,
							model: targetModel.id,
							provider: targetModel.provider,
							status: response.status,
							openCode,
							fallbackCount,
							durationMs: Date.now() - startTime,
						});
						return buildProxyResponse(
							response,
							targetModel.id,
							targetModel.provider,
							targetModel.contextWindow,
							retryReason,
							fallbackCount,
							true // isStreaming
						);
					}

					const responseBody = await response.text();

					// ResourceExhausted
					if (isResourceExhausted(response.status, responseBody)) {
						logAttempt(targetModel, 'failure', 'resource_exhausted', response.status);
						markResourceExhausted(targetModel.provider, targetModel.id);
						const reason = `ResourceExhausted (${targetModel.provider}/${targetModel.id})`;
						errors.push({ model: targetModel.id, provider: targetModel.provider, reason });
						fallbackCount++;
						log('WARN', `ResourceExhausted en ${targetModel.id}`, { provider: targetModel.provider });
						continue;
					}

					// Rate limited
					if (response.status === 429) {
						logAttempt(targetModel, 'failure', 'rate_limit', 429);
						markRateLimited(targetModel.provider, targetModel.id);
						const reason = `429 rate limited (${targetModel.provider}/${targetModel.id})`;
						errors.push({ model: targetModel.id, provider: targetModel.provider, reason });
						fallbackCount++;
						log('WARN', `429 en ${targetModel.id} (key: ${envKey})`, { provider: targetModel.provider });
						continue;
					}

					// Modelo retirado (HTTP 410 Gone): no devolver al cliente si hay otros modelos elegibles
					if (response.status === 410) {
						logAttempt(targetModel, 'failure', 'retired', 410);
						markRetired(targetModel.provider, targetModel.id);
						const reason = `410 gone (${targetModel.provider}/${targetModel.id})`;
						errors.push({ model: targetModel.id, provider: targetModel.provider, reason });
						fallbackCount++;
						log('WARN', `Modelo retirado (410) en ${targetModel.id}`, { provider: targetModel.provider });
						continue;
					}

					// Upstream error (500+ or 404 Not Found)
					if (response.status >= 500 || response.status === 404 || response.body === null) { // Added response.body === null
						logAttempt(targetModel, 'failure', 'http_error', response.status);
						markError(targetModel.provider, targetModel.id);
						const reason = `${response.status} ${response.statusText} (${targetModel.provider}/${targetModel.id})`;
						errors.push({ model: targetModel.id, provider: targetModel.provider, reason });
						fallbackCount++;
						log('WARN', `Error ${response.status} en ${targetModel.id} o body nulo`, { provider: targetModel.provider, status: response.status, bodyIsNull: response.body === null });
						continue;
					}

					// 400 context_length_exceeded or Model Not Found
					if (response.status === 400) {
						const bodyLower = responseBody.toLowerCase();
						const isContextError =
							bodyLower.includes('context_length') || bodyLower.includes('too large') || bodyLower.includes('maximum context');
						const isModelError = bodyLower.includes('does not exist') || bodyLower.includes('not found') || bodyLower.includes('model');
						const isReasoningError =
							bodyLower.includes('reasoning_content') || bodyLower.includes('reasoning content');

						if (isContextError || isModelError || isReasoningError) {
							logAttempt(
								targetModel,
								'failure',
								isContextError ? 'context_error' : 'http_error',
								400,
							);
							const reason = isReasoningError
								? `400 reasoning_content (${targetModel.provider}/${targetModel.id})`
								: `400 ${isContextError ? 'context_length_exceeded' : 'model_not_found'} (${targetModel.provider}/${targetModel.id})`;
							errors.push({ model: targetModel.id, provider: targetModel.provider, reason });
							fallbackCount++;
							if (isModelError || isReasoningError) {
								markError(targetModel.provider, targetModel.id);
							}
							log('WARN', `Error 400 en ${targetModel.id}`, { provider: targetModel.provider });
							continue;
						}

						// Non-context 400: return to client
						logAttempt(targetModel, 'failure', 'http_error', 400);
						markError(targetModel.provider, targetModel.id);
						const proxyResponse = buildProxyResponse(
							new Response(responseBody, { status: 400, headers: { 'Content-Type': 'application/json' } }),
							targetModel.id,
							targetModel.provider,
							targetModel.contextWindow,
							null,
							fallbackCount,
							false, // isStreaming
						);
						log('INFO', 'Request completado (400 no-context)', {
							model: targetModel.id,
							provider: targetModel.provider,
							status: 400,
							fallbackCount,
							durationMs: Date.now() - startTime,
						});
						return proxyResponse;
					}

					// This block is for non-streaming, successful responses
					logAttempt(targetModel, 'success', undefined, response.status);
					markSuccess(targetModel.provider, targetModel.id); // Already marked above for streaming, but safe to re-mark for non-streaming
					ctx.waitUntil(incrementRequestCount(env));

					if (virtualRoute && sessionId) {
						updateAffinity(sessionId, virtualRoute, targetModel.id, targetModel.provider);
					}

					const retryReason = errors.length > 0 ? errors.map((e) => e.reason).join('; ') : null;
					const proxyResponse = buildProxyResponse(
new Response(responseBody, { status: response.status, statusText: response.statusText, headers: response.headers }),
							targetModel.id,
							targetModel.provider,
							targetModel.contextWindow,
							retryReason,
							fallbackCount,
							false, // isStreaming
					);

					log('INFO', 'Request completado', {
						route: virtualRoute,
						model: targetModel.id,
						provider: targetModel.provider,
						status: response.status,
						openCode,
						fallbackCount,
						durationMs: Date.now() - startTime,
					});

					return proxyResponse;
				} catch (err) {
					const isTimeout = err instanceof DOMException && err.name === 'AbortError';
					logAttempt(targetModel, 'failure', isTimeout ? 'timeout' : 'network_error');
					const reason = isTimeout
						? `timeout (${targetModel.provider}/${targetModel.id})`
						: `error: ${err instanceof Error ? err.message : 'desconocido'} (${targetModel.provider}/${targetModel.id})`;
					errors.push({ model: targetModel.id, provider: targetModel.provider, reason });
					fallbackCount++;
					markError(targetModel.provider, targetModel.id);
					log('WARN', `Fallo en ${targetModel.id}`, { provider: targetModel.provider, error: reason });
				} finally {
					clearTimeout(timeoutId);
				}
			}

			// Mark model as tried and move to next eligible
			triedModelIds.add(targetModel.id);
			triedEntries.add(targetModel.id);
			targetModel = selectNextUntriedModel(targetModel.id, routeModels, triedModelIds);
		}

		// All attempts failed
		const lastErrors = errors.slice(-3).map((e) => `${e.provider}/${e.model}: ${e.reason}`);
		log('ERROR', 'Todos los proveedores fallaron', {
			route: virtualRoute,
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
