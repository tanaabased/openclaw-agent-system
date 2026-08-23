import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), label);
  return value as Record<string, unknown>;
}

function requireStringArray(value: unknown, label: string): string[] {
  assert.ok(Array.isArray(value) && value.every((entry) => typeof entry === 'string'), label);
  return value;
}

function readJsonObject(path: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(join(projectDir, path), 'utf8'));
  return requireRecord(value, `${path} must contain a json object`);
}

function devguardWatchPaths(): string[] {
  const config = readJsonObject('devguard.json');
  const plugin = requireRecord(config.plugin, 'devguard.json plugin must be an object');
  return requireStringArray(plugin.watch, 'devguard.json plugin.watch must be a string array');
}

function typescriptSourceOwners(): string[] {
  const config = readJsonObject('tsconfig.json');
  const includes = requireStringArray(
    config.include,
    'tsconfig.json include must be a string array',
  );
  return [...new Set(includes.map((pattern) => pattern.split('/')[0]))].filter(
    (owner): owner is string => owner !== undefined,
  );
}

describe('devguard/config', () => {
  it('should watch only existing project paths', () => {
    const missing = devguardWatchPaths().filter((path) => !existsSync(join(projectDir, path)));

    assert.deepEqual(missing, []);
  });

  it('should watch every root typescript source owner', () => {
    const watched = new Set(devguardWatchPaths());
    const missing = typescriptSourceOwners().filter((owner) => !watched.has(owner));

    assert.deepEqual(missing, []);
  });
});
