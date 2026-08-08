import type { ModelEntry, ProviderHealth, ProviderName, VirtualRoute, AffinityEntry } from './types';
import { log } from './utils';

const COOLDOWN_429_MS = 3 * 60 * 1000;
const COOLDOWN_ERROR_MS = 60 * 1000;
const COOLDOWN_RESOURCE_EXHAUSTED_MS = 15 * 60 * 1000;
const THROTTLE_MS = 1000;

const healthMap = new Map<string, ProviderHealth>();
const throttleMap = new Map<string, number>();
const affinityMap = new Map<string, AffinityEntry>();
const retiredModels = new Set<string>();

function getHealthKey(provider: string, modelId?: string): string {
	return modelId ? `${provider}:${modelId}` : provider;
}

function getHealth(providerName: string, modelId?: string): ProviderHealth {
	const key = getHealthKey(providerName, modelId);
	if (!healthMap.has(key)) {
		healthMap.set(key, {
			lastSuccess: 0,
			last429: 0,
			lastError: 0,
			successCount: 0,
			failureCount: 0,
			cooldownUntil: 0,
			consecutiveFailures: 0,
		});
	}
	return healthMap.get(key)!;
}

export function markSuccess(providerName: ProviderName, modelId?: string): void {
	const h = getHealth(providerName, modelId);
	h.lastSuccess = Date.now();
	h.successCount++;
	h.consecutiveFailures = 0;
	h.cooldownUntil = 0;
}

export function markRateLimited(providerName: ProviderName, modelId?: string): void {
	const h = getHealth(providerName, modelId);
	h.last429 = Date.now();
	h.failureCount++;
	h.consecutiveFailures++;
	h.cooldownUntil = Date.now() + COOLDOWN_429_MS;
	log('WARN', `Provider rate limited`, { provider: providerName, model: modelId, cooldownMs: COOLDOWN_429_MS });
}

export function markError(providerName: ProviderName, modelId?: string): void {
	const h = getHealth(providerName, modelId);
	h.lastError = Date.now();
	h.failureCount++;
	h.consecutiveFailures++;
	h.cooldownUntil = Date.now() + COOLDOWN_ERROR_MS;
}

export function markResourceExhausted(providerName: ProviderName, modelId?: string): void {
	const h = getHealth(providerName, modelId);
	h.lastError = Date.now();
	h.failureCount++;
	h.consecutiveFailures++;
	h.cooldownUntil = Date.now() + COOLDOWN_RESOURCE_EXHAUSTED_MS;
	log('WARN', `ResourceExhausted en modelo`, { provider: providerName, model: modelId, cooldownMs: COOLDOWN_RESOURCE_EXHAUSTED_MS });
}

export function markRetired(providerName: ProviderName, modelId?: string): void {
	retiredModels.add(getHealthKey(providerName, modelId));
	const h = getHealth(providerName, modelId);
	h.lastError = Date.now();
	h.failureCount++;
	h.consecutiveFailures++;
	h.cooldownUntil = Number.MAX_SAFE_INTEGER;
	log('WARN', `Modelo marcado como retirado (HTTP 410)`, { provider: providerName, model: modelId });
}

export function isRetired(providerName: string, modelId?: string): boolean {
	return retiredModels.has(getHealthKey(providerName, modelId));
}

export function filterRetiredModels(models: ModelEntry[]): ModelEntry[] {
	return models.filter((m) => !retiredModels.has(getHealthKey(m.provider, m.id)));
}

function isAvailable(providerName: string, modelId?: string): boolean {
	const h = getHealth(providerName, modelId);
	return Date.now() >= h.cooldownUntil;
}

export function checkThrottle(providerName: ProviderName): number | null {
	const now = Date.now();
	const lastCall = throttleMap.get(providerName) ?? 0;
	const elapsed = now - lastCall;
	if (elapsed < THROTTLE_MS) {
		return THROTTLE_MS - elapsed;
	}
	return null;
}

export function updateThrottle(providerName: ProviderName): void {
	throttleMap.set(providerName, Date.now());
}

export function getHealthSnapshot(): Record<string, ProviderHealth> {
	const snapshot: Record<string, ProviderHealth> = {};
	for (const [key, val] of healthMap) {
		snapshot[key] = { ...val };
	}
	return snapshot;
}

export function selectWeightedModel(models: ModelEntry[], weightOverrides?: Record<string, number>): ModelEntry | null {
	if (models.length === 0) return null;
	const totalWeight = models.reduce((sum, m) => sum + (weightOverrides?.[m.id] ?? m.weight), 0);
	if (totalWeight === 0) return models[0] ?? null;

	let rand = Math.random() * totalWeight;
	for (const model of models) {
		rand -= weightOverrides?.[model.id] ?? model.weight;
		if (rand <= 0) return model;
	}
	return models[models.length - 1];
}

export function selectFallbackModel(failedModelId: string, models: ModelEntry[]): ModelEntry | null {
	const idx = models.findIndex((m) => m.id === failedModelId);
	if (idx === -1 || idx >= models.length - 1) return null;
	return models[idx + 1];
}

export function selectNextUntriedModel(failedModelId: string, models: ModelEntry[], triedSet: Set<string>): ModelEntry | null {
	const eligible = models.filter((m) => !triedSet.has(m.id));
	if (eligible.length === 0) return null;
	if (eligible.length === 1) return eligible[0];
	const idx = eligible.findIndex((m) => m.id === failedModelId);
	if (idx === -1 || idx >= eligible.length - 1) return eligible[0];
	return eligible[idx + 1];
}

export function selectModelForRoute(
	models: ModelEntry[],
	route: VirtualRoute | null,
	sessionId: string | null,
	triedSet: Set<string>,
	weightOverrides?: Record<string, number>,
): ModelEntry | null {
	const eligible = models.filter((m) => !triedSet.has(m.id));
	if (eligible.length === 0) return null;

	// Check affinity for this session+route
	if (route && sessionId) {
		const affinityKey = `${sessionId}:${route}`;
		const aff = affinityMap.get(affinityKey);
		if (aff && eligible.some((m) => m.id === aff.modelId) && isAvailable(aff.provider, aff.modelId)) {
			const model = eligible.find((m) => m.id === aff.modelId);
			if (model) return model;
		}
	}

	return selectWeightedModel(eligible, weightOverrides);
}

export function updateAffinity(sessionId: string, route: VirtualRoute, modelId: string, provider: ProviderName): void {
	if (!sessionId || !route) return;
	const key = `${sessionId}:${route}`;
	affinityMap.set(key, { modelId, provider, timestamp: Date.now() });
}

export function getAffinity(sessionId: string, route: VirtualRoute): AffinityEntry | undefined {
	return affinityMap.get(`${sessionId}:${route}`);
}

export function clearAffinity(sessionId: string, route: VirtualRoute): void {
	affinityMap.delete(`${sessionId}:${route}`);
}

export function filterAvailableModels(models: ModelEntry[]): ModelEntry[] {
	return models.filter((m) => isAvailable(m.provider, m.id));
}

export function filterModelsByTried(models: ModelEntry[], triedSet: Set<string>): ModelEntry[] {
	return models.filter((m) => !triedSet.has(m.id));
}

export function resetAllHealth(): void {
	healthMap.clear();
	throttleMap.clear();
	retiredModels.clear();
}

export function getModelHealth(providerName: ProviderName, modelId: string): ProviderHealth {
	return getHealth(providerName, modelId);
}

export function getProviderHealth(providerName: ProviderName): ProviderHealth {
	return getHealth(providerName);
}
