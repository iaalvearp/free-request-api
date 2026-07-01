import type { ModelEntry, ProviderHealth, ProviderName } from './types';
import { log } from './utils';

const COOLDOWN_429_MS = 3 * 60 * 1000;
const COOLDOWN_ERROR_MS = 60 * 1000;
const THROTTLE_MS = 1000;

const healthMap = new Map<string, ProviderHealth>();
const throttleMap = new Map<string, number>();

function getHealth(providerName: string): ProviderHealth {
	if (!healthMap.has(providerName)) {
		healthMap.set(providerName, {
			lastSuccess: 0,
			last429: 0,
			lastError: 0,
			successCount: 0,
			failureCount: 0,
			cooldownUntil: 0,
			consecutiveFailures: 0,
		});
	}
	return healthMap.get(providerName)!;
}

export function markSuccess(providerName: ProviderName): void {
	const h = getHealth(providerName);
	h.lastSuccess = Date.now();
	h.successCount++;
	h.consecutiveFailures = 0;
	h.cooldownUntil = 0;
}

export function markRateLimited(providerName: ProviderName): void {
	const h = getHealth(providerName);
	h.last429 = Date.now();
	h.failureCount++;
	h.consecutiveFailures++;
	h.cooldownUntil = Date.now() + COOLDOWN_429_MS;
	log('WARN', `Provider rate limited`, { provider: providerName, cooldownMs: COOLDOWN_429_MS });
}

export function markError(providerName: ProviderName): void {
	const h = getHealth(providerName);
	h.lastError = Date.now();
	h.failureCount++;
	h.consecutiveFailures++;
	h.cooldownUntil = Date.now() + COOLDOWN_ERROR_MS;
}

function isAvailable(providerName: string): boolean {
	const h = getHealth(providerName);
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

export function selectWeightedModel(models: ModelEntry[]): ModelEntry | null {
	const totalWeight = models.reduce((sum, m) => sum + m.weight, 0);
	if (totalWeight === 0) return models[0] ?? null;

	let rand = Math.random() * totalWeight;
	for (const model of models) {
		rand -= model.weight;
		if (rand <= 0) return model;
	}
	return models[models.length - 1];
}

export function selectFallbackModel(failedModelId: string, models: ModelEntry[]): ModelEntry | null {
	const idx = models.findIndex((m) => m.id === failedModelId);
	if (idx === -1 || idx >= models.length - 1) return null;
	return models[idx + 1];
}

export function filterAvailableModels(models: ModelEntry[]): ModelEntry[] {
	return models.filter((m) => isAvailable(m.provider));
}
