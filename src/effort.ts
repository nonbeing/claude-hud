import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getClaudeConfigDir } from './claude-config-dir.js';

export type EffortLevel = 'high' | 'medium' | 'low';

type Settings = {
  effortLevel?: unknown;
  modelSettings?: Record<string, { effortLevel?: unknown } | undefined>;
};

function coerce(raw: unknown): EffortLevel | null {
  return raw === 'high' || raw === 'medium' || raw === 'low' ? raw : null;
}

export function getEffortLevel(modelId?: string): EffortLevel | null {
  try {
    const homeDir = os.homedir();
    const settingsPath = path.join(getClaudeConfigDir(homeDir), 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Settings;
    // Per-model effort overrides the global default (matches Claude Code's own precedence).
    const perModel = modelId ? coerce(settings.modelSettings?.[modelId]?.effortLevel) : null;
    return perModel ?? coerce(settings.effortLevel);
  } catch {
    return null;
  }
}
