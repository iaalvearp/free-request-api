#!/usr/bin/env node
// ============================================================
// NVIDIA Model Validation Script
// Tests NVIDIA NIM models sequentially with local .dev.vars
// ============================================================

import { readFileSync } from 'fs';
import { resolve } from 'path';

const DEV_VARS_PATH = resolve(process.cwd(), '.dev.vars');

function loadEnvFile() {
  const content = readFileSync(DEV_VARS_PATH, 'utf-8');
  const env = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [key, ...rest] = trimmed.split('=');
    if (key && rest.length > 0) {
      env[key.trim()] = rest.join('=').trim();
    }
  }
  return env;
}

async function testModel(modelId, apiKey) {
  const url = 'https://integrate.api.nvidia.com/v1/chat/completions';
  const body = {
    model: modelId,
    messages: [{ role: 'user', content: 'Responde únicamente con OK' }],
    stream: false,
    max_tokens: 50,
    temperature: 0,
  };

  const start = Date.now();
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const duration = Date.now() - start;
    const text = await response.text();

    let available = false;
    let errorMsg = '';

    if (response.ok) {
      available = true;
    } else if (response.status === 404) {
      errorMsg = `404 Not Found - ${text.slice(0, 200)}`;
    } else if (response.status === 401 || response.status === 403) {
      errorMsg = `${response.status} Auth Error - ${text.slice(0, 200)}`;
    } else if (response.status === 429) {
      errorMsg = `429 Rate Limited - ${text.slice(0, 200)}`;
      available = 'rate_limited';
    } else {
      errorMsg = `${response.status} ${response.statusText} - ${text.slice(0, 200)}`;
    }

    return { model: modelId, http: response.status, durationMs: duration, available, error: errorMsg };
  } catch (err) {
    return { model: modelId, http: 'ERR', durationMs: Date.now() - start, available: false, error: String(err).slice(0, 200) };
  }
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  const env = loadEnvFile();
  const apiKey = env.NVIDIA_API_KEY;

  if (!apiKey) {
    console.error('ERROR: NVIDIA_API_KEY not found in .dev.vars');
    process.exit(1);
  }

  const models = [
    { id: 'deepseek-ai/deepseek-v4-flash', purpose: 'programación rápida, agentes y tareas frecuentes' },
    { id: 'z-ai/glm-5.2', purpose: 'programación compleja, depuración y sesiones largas' },
    { id: 'nvidia/nemotron-3-super-120b-a12b', purpose: 'agente, herramientas y respaldo general' },
    { id: 'nvidia/nemotron-3-nano-30b-a3b', purpose: 'respuestas rápidas, tareas internas, alpes-small' },
  ];

  console.log('┌─────────────────────────────────────────────────────────────────────────────────────────────┐');
  console.log('│ NVIDIA Model Validation                                                                      │');
  console.log('├─────────────────────────────────────────────────────────────────────────────────────────────┤');
  console.log('│ Endpoint: https://integrate.api.nvidia.com/v1/chat/completions                              │');
  console.log('│ Test: "Responde únicamente con OK" | stream=false | max_tokens=50                          │');
  console.log('└─────────────────────────────────────────────────────────────────────────────────────────────┘');
  console.log('');

  const results = [];

  for (let i = 0; i < models.length; i++) {
    const m = models[i];
    console.log(`[${i + 1}/${models.length}] Testing ${m.id}...`);

    const result = await testModel(m.id, apiKey);
    results.push({ ...result, purpose: m.purpose });

    const status = result.available === true ? '✅ DISPONIBLE' :
                   result.available === 'rate_limited' ? '⚠️  RATE LIMITED (modelo existe)' :
                   '❌ NO DISPONIBLE';

    console.log(`    HTTP: ${result.http} | Duration: ${result.durationMs}ms | ${status}`);
    if (result.error) console.log(`    Error: ${result.error}`);
    console.log('');

    if (i < models.length - 1) {
      await sleep(1000);
    }
  }

  // Summary table
  console.log('┌────────────────────────────────────┬───────┬──────────┬────────────┬────────────────────────────────────┐');
  console.log('│ Modelo                             │ HTTP  │ Latencia │ Estado     │ Finalidad                          │');
  console.log('├────────────────────────────────────┼───────┼──────────┼────────────┼────────────────────────────────────┤');

  let anyAvailable = false;
  let authError = false;

  for (const r of results) {
    const status = r.available === true ? 'ACTIVO' :
                   r.available === 'rate_limited' ? 'RATE LIMIT' : 'DESCARTADO';
    if (r.available === true || r.available === 'rate_limited') anyAvailable = true;
    if (r.http === 401 || r.http === 403) authError = true;

    const modelShort = r.model.length > 34 ? r.model.slice(0, 31) + '...' : r.model.padEnd(34);
    const httpStr = String(r.http).padStart(5);
    const latStr = `${r.durationMs}ms`.padStart(8);
    const purpShort = r.purpose.length > 34 ? r.purpose.slice(0, 31) + '...' : r.purpose.padEnd(34);

    console.log(`│ ${modelShort} │ ${httpStr} │ ${latStr} │ ${status.padEnd(10)} │ ${purpShort} │`);
  }

  console.log('└────────────────────────────────────┴───────┴──────────┴────────────┴────────────────────────────────────┘');
  console.log('');

  if (authError) {
    console.log('❌ ERROR DE AUTENTICACIÓN (401/403): La NVIDIA_API_KEY no tiene permisos o es inválida.');
    console.log('   No se pueden validar modelos. Deteniendo pruebas.');
    process.exit(1);
  }

  if (!anyAvailable) {
    console.log('❌ NINGÚN MODELO DISPONIBLE: Todos los modelos devolvieron error o no existen.');
    process.exit(1);
  }

  console.log('✅ Validación completada. Modelos disponibles listados arriba.');
  process.exit(0);
}

main().catch(err => {
  console.error('Error fatal:', err);
  process.exit(1);
});