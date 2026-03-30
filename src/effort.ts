import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getClaudeConfigDir } from './claude-config-dir.js';

export type EffortLevel = 'high' | 'medium' | 'low';

export function getEffortLevel(): EffortLevel | null {
  try {
    const homeDir = os.homedir();
    const settingsPath = path.join(getClaudeConfigDir(homeDir), 'settings.json');
    const content = fs.readFileSync(settingsPath, 'utf-8');
    const settings = JSON.parse(content) as { effortLevel?: unknown };
    const raw = settings.effortLevel;
    if (raw === 'high' || raw === 'medium' || raw === 'low') return raw;
    return null;
  } catch {
    return null;
  }
}
