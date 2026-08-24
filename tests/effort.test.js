import { test, expect } from 'bun:test';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getEffortLevel } from '../src/effort.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-effort-'));
process.env.CLAUDE_CONFIG_DIR = dir;
fs.writeFileSync(
  path.join(dir, 'settings.json'),
  JSON.stringify({ effortLevel: 'high', modelSettings: { 'claude-opus-5': { effortLevel: 'medium' } } }),
);

test('per-model effort wins over the global default', () => {
  expect(getEffortLevel('claude-opus-5')).toBe('medium');
});

test('falls back to the global default', () => {
  expect(getEffortLevel('claude-sonnet-5')).toBe('high');
  expect(getEffortLevel()).toBe('high');
});
