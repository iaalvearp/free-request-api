// ============================================================
// ENTRY POINT DEL PROXY
// ============================================================
import type { Env, IncomingRequest } from './types';
import { getAvailableProviders } from './providers';
import { selectProvider, markRateLimited, markError, markSuccess } from './selector';
import { buildProviderRequest, normalizeResponse } from './transformer';
import { log, errorResponse, getRetryAfterMs, sleep, calcBackoff } from './utils';
import { incrementRequestCount, getTodayStats } from './stats';

// Máximo de intentos antes de rendirse (recorre el pool)
const MAX_ATTEMPTS = 5;

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		// ── CORS preflight (para VSCode extension) ─────────────
		if (request.method === 'OPTIONS') {
			return new Response(null, {
				headers: {
					'Access-Control-Allow-Origin': '*',
					'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
					'Access-Control-Allow-Headers': 'Content-Type, Authorization',
				},
			});
		}

		const url = new URL(request.url);

		// ── Endpoint de estadísticas ────────────────────────────
		if (request.method === 'GET' && url.pathname === '/stats') {
			const authHeader = request.headers.get('Authorization');
			const expectedAuth = `Bearer ${env.CUSTOM_API_KEY}`;
			if (!authHeader || authHeader !== expectedAuth) {
				return errorResponse('Unauthorized', 401, 'unauthorized');
			}
			const stats = await getTodayStats(env);
			return new Response(JSON.stringify(stats, null, 2), {
				headers: { 'Content-Type': 'application/json' },
			});
		}

		// ── Solo aceptamos POST a /v1/chat/completions ──────────
		if (request.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
			return errorResponse('Endpoint no encontrado. Usa POST /v1/chat/completions', 404, 'not_found');
		}

		// ── Validación de autenticación ─────────────────────────
		const authHeader = request.headers.get('Authorization');
		const expectedAuth = `Bearer ${env.CUSTOM_API_KEY}`;
		if (!authHeader || authHeader !== expectedAuth) {
			log('WARN', 'Request rechazado: API key inválida');
			return errorResponse('Unauthorized: API key inválida', 401, 'unauthorized');
		}

		// ── Parseo del body ─────────────────────────────────────
		let incoming: IncomingRequest;
		try {
			incoming = (await request.json()) as IncomingRequest;
		} catch {
			return errorResponse('Body inválido: se esperaba JSON', 400, 'invalid_request');
		}

		if (!incoming.messages || incoming.messages.length === 0) {
			return errorResponse('El campo "messages" es requerido y no puede estar vacío', 400, 'invalid_request');
		}

		// ── Obtener proveedores disponibles ─────────────────────
		const providers = getAvailableProviders(env);
		if (providers.length === 0) {
			log('ERROR', 'No hay proveedores configurados');
			return errorResponse('No hay proveedores de IA configurados', 503, 'no_providers');
		}

		// ── Loop de intentos con failover ───────────────────────
		const triedProviders = new Set<string>();
		let lastError = '';

		for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
			const provider = selectProvider(providers, triedProviders);
			if (!provider) {
				log('ERROR', 'Pool agotado, no quedan proveedores');
				break;
			}

			triedProviders.add(provider.id);
			log('INFO', `Intento ${attempt + 1}: usando ${provider.name}`, { attempt, providerId: provider.id });

			try {
				const providerRequest = buildProviderRequest(provider, incoming, env);
				const response = await fetch(providerRequest);

				// ── 429: rate limited ───────────────────────────────
				if (response.status === 429) {
					markRateLimited(provider.id);
					const retryAfterMs = getRetryAfterMs(response);
					const waitMs = retryAfterMs ?? calcBackoff(attempt);
					log('WARN', `429 en ${provider.name}, esperando ${waitMs}ms antes de reintentar`);
					await sleep(Math.min(waitMs, 5000)); // máximo 5s de espera en Workers
					continue;
				}

				// ── Error del servidor upstream ─────────────────────
				if (response.status >= 500) {
					markError(provider.id);
					lastError = `${provider.name} devolvió ${response.status}`;
					log('WARN', `Error ${response.status} en ${provider.name}`);
					continue;
				}

				// ── Éxito ───────────────────────────────────────────
				if (response.ok) {
					markSuccess(provider.id);
					log('INFO', `Éxito con ${provider.name}`);
					ctx.waitUntil(incrementRequestCount(env));
					const normalized = await normalizeResponse(provider, response, incoming.stream === true);
					// Añade headers CORS a la respuesta final
					const finalHeaders = new Headers(normalized.headers);
					finalHeaders.set('Access-Control-Allow-Origin', '*');
					return new Response(normalized.body, {
						status: normalized.status,
						headers: finalHeaders,
					});
				}

				// ── Otros errores (4xx que no son 429) ──────────────
				lastError = `${provider.name} devolvió ${response.status}`;
				log('WARN', `Error ${response.status} en ${provider.name}, saltando al siguiente`);
				markError(provider.id);
			} catch (err) {
				lastError = err instanceof Error ? err.message : 'Error desconocido';
				log('ERROR', `Excepción con ${provider.name}`, { error: lastError });
				markError(provider.id);
			}
		}

		// ── Todos los intentos fallaron ─────────────────────────
		log('ERROR', 'Todos los proveedores fallaron', { lastError });
		return errorResponse(`Todos los proveedores fallaron. Último error: ${lastError}`, 502, 'all_providers_failed');
	},
};
