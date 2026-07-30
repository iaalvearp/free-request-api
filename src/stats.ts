// ============================================================
// CONTADOR DE PETICIONES CON KV
// ============================================================
import type { Env } from './types';
import { log } from './utils';

// Límite diario de Cloudflare Workers (plan gratuito)
const DAILY_CF_LIMIT = 100_000;
// Umbral de alerta (90%)
const ALERT_THRESHOLD = 90_000;

/**
 * Obtiene la clave del día actual en formato YYYY-MM-DD UTC
 * para que el contador se resetee automáticamente cada día.
 */
function getTodayKey(): string {
	return `requests:${new Date().toISOString().slice(0, 10)}`;
}

/**
 * Incrementa el contador de peticiones del día actual.
 * Si supera el umbral de alerta, loguea una advertencia.
 * Se llama con ctx.waitUntil() para no bloquear la respuesta.
 */
export async function incrementRequestCount(env: Env): Promise<void> {
	try {
		const key = getTodayKey();
		const current = await env.PROXY_STATS.get(key);
		const count = current ? parseInt(current) + 1 : 1;

		// Guarda con TTL de 48 horas (se limpia solo)
		await env.PROXY_STATS.put(key, count.toString(), { expirationTtl: 172800 });

		if (count >= ALERT_THRESHOLD) {
			log('WARN', `⚠️ ALERTA: ${count} peticiones hoy. Límite diario de Cloudflare: ${DAILY_CF_LIMIT}`, {
				count,
				limit: DAILY_CF_LIMIT,
				remaining: DAILY_CF_LIMIT - count,
			});
		}
	} catch (err) {
		// No interrumpimos el flujo principal si el contador falla
		log('ERROR', 'Error al actualizar contador KV', { error: String(err) });
	}
}

/**
 * Devuelve las estadísticas del día actual.
 * Se usa en el endpoint /stats.
 */
export async function getTodayStats(env: Env): Promise<{
	date: string;
	requests: number;
	limit: number;
	remaining: number;
	alertThreshold: number;
	alert: boolean;
}> {
	const key = getTodayKey();
	const date = key.replace('requests:', '');
	const current = await env.PROXY_STATS.get(key);
	const requests = current ? parseInt(current) : 0;

	return {
		date,
		requests,
		limit: DAILY_CF_LIMIT,
		remaining: DAILY_CF_LIMIT - requests,
		alertThreshold: ALERT_THRESHOLD,
		alert: requests >= ALERT_THRESHOLD,
	};
}
