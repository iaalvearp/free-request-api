// ============================================================
// SELECTOR DE PROVEEDOR: weighted random + cooldown + failover
// ============================================================
import type { AIProvider, ProviderHealth } from './types';
import { log } from './utils';

// Tiempo de cooldown cuando un proveedor devuelve 429 (3 minutos)
const COOLDOWN_MS = 3 * 60 * 1000;

// Tiempo de cooldown cuando un proveedor devuelve 5xx (1 minuto)
const ERROR_COOLDOWN_MS = 60 * 1000;

/**
 * Mapa de salud de los proveedores en esta instancia del Worker.
 * Como los Workers son stateless, este mapa vive solo mientras
 * el Isolate está activo (minutos a horas, dependiendo del tráfico).
 */
const healthMap = new Map<string, ProviderHealth>();

/**
 * Obtiene o inicializa el estado de salud de un proveedor.
 */
function getHealth(providerId: string): ProviderHealth {
	if (!healthMap.has(providerId)) {
		healthMap.set(providerId, { cooldownUntil: 0, consecutiveFailures: 0 });
	}
	return healthMap.get(providerId)!;
}

/**
 * Marca un proveedor como en cooldown tras un 429.
 */
export function markRateLimited(providerId: string): void {
	const health = getHealth(providerId);
	health.cooldownUntil = Date.now() + COOLDOWN_MS;
	health.consecutiveFailures += 1;
	log('WARN', `Proveedor en cooldown por 429`, { providerId, cooldownMs: COOLDOWN_MS });
}

/**
 * Marca un proveedor como en cooldown tras un error 5xx.
 */
export function markError(providerId: string): void {
	const health = getHealth(providerId);
	health.cooldownUntil = Date.now() + ERROR_COOLDOWN_MS;
	health.consecutiveFailures += 1;
	log('WARN', `Proveedor en cooldown por error`, { providerId, cooldownMs: ERROR_COOLDOWN_MS });
}

/**
 * Marca un proveedor como exitoso (resetea fallos).
 */
export function markSuccess(providerId: string): void {
	const health = getHealth(providerId);
	health.cooldownUntil = 0;
	health.consecutiveFailures = 0;
}

/**
 * Verifica si un proveedor está disponible (fuera de cooldown).
 */
function isAvailable(providerId: string): boolean {
	const health = getHealth(providerId);
	return Date.now() >= health.cooldownUntil;
}

/**
 * Selecciona un proveedor usando weighted random entre los disponibles.
 * Si todos están en cooldown, usa todos como fallback (evita quedarse sin opciones).
 *
 * @param providers - lista filtrada de proveedores con key configurada
 * @param exclude   - IDs a excluir en este intento (ya fallaron en este request)
 */
export function selectProvider(providers: AIProvider[], exclude: Set<string> = new Set()): AIProvider | null {
	// Filtra los disponibles (fuera de cooldown y no excluidos en este request)
	let candidates = providers.filter((p) => !exclude.has(p.id) && isAvailable(p.id));

	// Si todos están en cooldown, ignora el cooldown como último recurso
	if (candidates.length === 0) {
		candidates = providers.filter((p) => !exclude.has(p.id));
		if (candidates.length === 0) return null;
		log('WARN', 'Todos los proveedores en cooldown, ignorando cooldown');
	}

	// Weighted random: construye un array "ruleta" donde cada proveedor
	// ocupa tantas posiciones como su peso
	const totalWeight = candidates.reduce((sum, p) => sum + p.weight, 0);
	let random = Math.random() * totalWeight;

	for (const provider of candidates) {
		random -= provider.weight;
		if (random <= 0) {
			return provider;
		}
	}

	// Fallback por precisión numérica
	return candidates[candidates.length - 1];
}
