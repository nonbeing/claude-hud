import { readStdin, getUsageFromStdin } from './stdin.js';
import { parseTranscript } from './transcript.js';
import { render } from './render/index.js';
import { countConfigs } from './config-reader.js';
import { getGitStatus } from './git.js';
import { loadConfig } from './config.js';
import { parseExtraCmdArg, runExtraCmd } from './extra-cmd.js';
import { getClaudeCodeVersion } from './version.js';
import { getMemoryUsage } from './memory.js';
import { getEffortLevel } from './effort.js';
import type { RenderContext } from './types.js';
import type { McpToolCache } from './mcp-introspect.js';
import { fileURLToPath } from 'node:url';
import { realpathSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getHudPluginDir } from './claude-config-dir.js';

export type MainDeps = {
  readStdin: typeof readStdin;
  getUsageFromStdin: typeof getUsageFromStdin;
  parseTranscript: typeof parseTranscript;
  countConfigs: typeof countConfigs;
  getGitStatus: typeof getGitStatus;
  loadConfig: typeof loadConfig;
  parseExtraCmdArg: typeof parseExtraCmdArg;
  runExtraCmd: typeof runExtraCmd;
  getClaudeCodeVersion: typeof getClaudeCodeVersion;
  getMemoryUsage: typeof getMemoryUsage;
  getEffortLevel: typeof getEffortLevel;
  render: typeof render;
  now: () => number;
  log: (...args: unknown[]) => void;
};

// Fallback when cache is missing entirely (introspection never ran).
// Average of real data: (1101 + 6238) / 2 ≈ 2000 tokens/server.
const MCP_FALLBACK_TOKENS_PER_SERVER = 2000;

function readMcpTokenCache(mcpCount: number): number {
  try {
    const cachePath = path.join(getHudPluginDir(os.homedir()), 'mcp-tool-cache.json');
    const raw = readFileSync(cachePath, 'utf-8');
    const cache = JSON.parse(raw) as McpToolCache;
    if (cache.version !== 1 || !cache.servers) return mcpCount * MCP_FALLBACK_TOKENS_PER_SERVER;
    let total = 0;
    for (const entry of Object.values(cache.servers)) {
      total += entry.estimatedTokens ?? MCP_FALLBACK_TOKENS_PER_SERVER;
    }
    return total || mcpCount * MCP_FALLBACK_TOKENS_PER_SERVER;
  } catch {
    return mcpCount * MCP_FALLBACK_TOKENS_PER_SERVER;
  }
}

export async function main(overrides: Partial<MainDeps> = {}): Promise<void> {
  const deps: MainDeps = {
    readStdin,
    getUsageFromStdin,
    parseTranscript,
    countConfigs,
    getGitStatus,
    loadConfig,
    parseExtraCmdArg,
    runExtraCmd,
    getClaudeCodeVersion,
    getMemoryUsage,
    getEffortLevel,
    render,
    now: () => Date.now(),
    log: console.log,
    ...overrides,
  };

  try {
    const stdin = await deps.readStdin();

    if (!stdin) {
      // Running without stdin - this happens during setup verification
      const isMacOS = process.platform === 'darwin';
      deps.log('[claude-hud] Initializing...');
      if (isMacOS) {
        deps.log('[claude-hud] Note: On macOS, you may need to restart Claude Code for the HUD to appear.');
      }
      return;
    }

    const transcriptPath = stdin.transcript_path ?? '';
    const transcript = await deps.parseTranscript(transcriptPath);

    const { claudeMdCount, claudeMdBytes, rulesCount, rulesBytes, mcpCount, hooksCount } = await deps.countConfigs(stdin.cwd);

    const config = await deps.loadConfig();
    const gitStatus = config.gitStatus.enabled
      ? await deps.getGitStatus(stdin.cwd)
      : null;

    // Usage comes only from Claude Code's official stdin rate_limits fields.
    let usageData: RenderContext['usageData'] = null;
    if (config.display.showUsage !== false) {
      usageData = deps.getUsageFromStdin(stdin);
    }

    const extraCmd = deps.parseExtraCmdArg();
    const extraLabel = extraCmd ? await deps.runExtraCmd(extraCmd) : null;

    const sessionDuration = formatSessionDuration(transcript.sessionStart, deps.now);
    const claudeCodeVersion = config.display.showClaudeCodeVersion
      ? await deps.getClaudeCodeVersion()
      : undefined;
    const memoryUsage = config.display.showMemoryUsage && config.lineLayout === 'expanded'
      ? await deps.getMemoryUsage()
      : null;
    const effortLevel = config.display.showEffort !== false
      ? deps.getEffortLevel()
      : null;

    const ctx: RenderContext = {
      stdin,
      transcript,
      claudeMdCount,
      claudeMdBytes,
      rulesCount,
      rulesBytes,
      mcpCount,
      mcpEstimatedTokens: readMcpTokenCache(mcpCount),
      hooksCount,
      sessionDuration,
      gitStatus,
      usageData,
      memoryUsage,
      config,
      extraLabel,
      claudeCodeVersion,
      effortLevel,
    };

    deps.render(ctx);
  } catch (error) {
    deps.log('[claude-hud] Error:', error instanceof Error ? error.message : 'Unknown error');
  }
}

export function formatSessionDuration(sessionStart?: Date, now: () => number = () => Date.now()): string {
  if (!sessionStart) {
    return '';
  }

  const ms = now() - sessionStart.getTime();
  const mins = Math.floor(ms / 60000);

  if (mins < 1) return '<1m';
  if (mins < 60) return `${mins}m`;

  const hours = Math.floor(mins / 60);
  const remainingMins = mins % 60;
  return `${hours}h ${remainingMins}m`;
}

const scriptPath = fileURLToPath(import.meta.url);
const argvPath = process.argv[1];
const isSamePath = (a: string, b: string): boolean => {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return a === b;
  }
};
if (argvPath && isSamePath(argvPath, scriptPath)) {
  void main();
}
