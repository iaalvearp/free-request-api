// ============================================================
// UTILIDADES: BACKOFF, LOGGING, HELPERS
// ============================================================

/**
 * Espera un tiempo determinado (en milisegundos)
 */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calcula el tiempo de espera para el backoff exponencial con jitter.
 * En el intento 0 espera ~1s, intento 1 ~2s, intento 2 ~4s, etc.
 * El jitter evita que múltiples requests reintenten al mismo tiempo.
 *
 * @param attempt - número de intento (0-based)
 * @param baseMs  - tiempo base en ms (default: 1000)
 * @param maxMs   - techo máximo en ms (default: 10000)
 */
export function calcBackoff(attempt: number, baseMs = 1000, maxMs = 10000): number {
	const exponential = baseMs * Math.pow(2, attempt);
	const jitter = Math.random() * 500;
	return Math.min(exponential + jitter, maxMs);
}

/**
 * Log estructurado. En producción Cloudflare captura estos logs
 * con `wrangler tail`.
 */
export function log(level: 'INFO' | 'WARN' | 'ERROR', message: string, data?: Record<string, unknown>): void {
	const entry = {
		level,
		message,
		timestamp: new Date().toISOString(),
		...(data ?? {}),
	};
	if (level === 'ERROR') {
		console.error(JSON.stringify(entry));
	} else {
		console.log(JSON.stringify(entry));
	}
}

/**
 * Extrae el header Retry-After de una respuesta 429.
 * Devuelve los ms a esperar, o null si no hay header.
 */
export function getRetryAfterMs(response: Response): number | null {
	const retryAfter = response.headers.get('Retry-After');
	if (!retryAfter) return null;
	const seconds = parseFloat(retryAfter);
	if (!isNaN(seconds)) return seconds * 1000;
	return null;
}

/**
 * Construye una respuesta de error en formato JSON compatible con OpenAI.
 * Opencode y VSCode esperan este formato cuando algo falla.
 */
export function errorResponse(message: string, status: number, code = 'proxy_error'): Response {
	return new Response(
		JSON.stringify({
			error: {
				message,
				type: code,
				code,
			},
		}),
		{
			status,
			headers: { 'Content-Type': 'application/json' },
		},
	);
}
