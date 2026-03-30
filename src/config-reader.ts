import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createDebug } from './debug.js';
import { getClaudeConfigDir, getClaudeConfigJsonPath } from './claude-config-dir.js';

const debug = createDebug('config');

export interface ConfigCounts {
  claudeMdCount: number;
  claudeMdBytes: number;
  rulesCount: number;
  rulesBytes: number;
  mcpCount: number;
  hooksCount: number;
}

// Valid keys for disabled MCP arrays in config files
type DisabledMcpKey = 'disabledMcpServers' | 'disabledMcpjsonServers';

function getMcpServerNames(filePath: string): Set<string> {
  if (!fs.existsSync(filePath)) return new Set();
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const config = JSON.parse(content);
    if (config.mcpServers && typeof config.mcpServers === 'object') {
      return new Set(Object.keys(config.mcpServers));
    }
  } catch (error) {
    debug(`Failed to read MCP servers from ${filePath}:`, error);
  }
  return new Set();
}

function getDisabledMcpServers(filePath: string, key: DisabledMcpKey): Set<string> {
  if (!fs.existsSync(filePath)) return new Set();
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const config = JSON.parse(content);
    if (Array.isArray(config[key])) {
      const validNames = config[key].filter((s: unknown) => typeof s === 'string');
      if (validNames.length !== config[key].length) {
        debug(`${key} in ${filePath} contains non-string values, ignoring them`);
      }
      return new Set(validNames);
    }
  } catch (error) {
    debug(`Failed to read ${key} from ${filePath}:`, error);
  }
  return new Set();
}

function countMcpServersInFile(filePath: string, excludeFrom?: string): number {
  const servers = getMcpServerNames(filePath);
  if (excludeFrom) {
    const exclude = getMcpServerNames(excludeFrom);
    for (const name of exclude) {
      servers.delete(name);
    }
  }
  return servers.size;
}

function countHooksInFile(filePath: string): number {
  if (!fs.existsSync(filePath)) return 0;
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const config = JSON.parse(content);
    if (config.hooks && typeof config.hooks === 'object') {
      return Object.keys(config.hooks).length;
    }
  } catch (error) {
    debug(`Failed to read hooks from ${filePath}:`, error);
  }
  return 0;
}

function readFileBytes(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function countRulesInDir(rulesDir: string): { count: number; bytes: number } {
  if (!fs.existsSync(rulesDir)) return { count: 0, bytes: 0 };
  let count = 0;
  let bytes = 0;
  try {
    const entries = fs.readdirSync(rulesDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(rulesDir, entry.name);
      if (entry.isDirectory()) {
        const sub = countRulesInDir(fullPath);
        count += sub.count;
        bytes += sub.bytes;
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        count++;
        bytes += readFileBytes(fullPath);
      }
    }
  } catch (error) {
    debug(`Failed to read rules from ${rulesDir}:`, error);
  }
  return { count, bytes };
}

function normalizePathForComparison(inputPath: string): string {
  let normalized = path.normalize(path.resolve(inputPath));
  const root = path.parse(normalized).root;
  while (normalized.length > root.length && normalized.endsWith(path.sep)) {
    normalized = normalized.slice(0, -1);
  }
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function pathsReferToSameLocation(pathA: string, pathB: string): boolean {
  if (normalizePathForComparison(pathA) === normalizePathForComparison(pathB)) {
    return true;
  }

  if (!fs.existsSync(pathA) || !fs.existsSync(pathB)) {
    return false;
  }

  try {
    const realPathA = fs.realpathSync.native(pathA);
    const realPathB = fs.realpathSync.native(pathB);
    return normalizePathForComparison(realPathA) === normalizePathForComparison(realPathB);
  } catch {
    return false;
  }
}

export async function countConfigs(cwd?: string): Promise<ConfigCounts> {
  let claudeMdCount = 0;
  let claudeMdBytes = 0;
  let rulesCount = 0;
  let rulesBytes = 0;
  let hooksCount = 0;

  const homeDir = os.homedir();
  const claudeDir = getClaudeConfigDir(homeDir);

  // Collect all MCP servers across scopes, then subtract disabled ones
  const userMcpServers = new Set<string>();
  const projectMcpServers = new Set<string>();

  // === USER SCOPE ===

  // ~/.claude/CLAUDE.md
  const userClaudeMdPath = path.join(claudeDir, 'CLAUDE.md');
  if (fs.existsSync(userClaudeMdPath)) {
    claudeMdCount++;
    claudeMdBytes += readFileBytes(userClaudeMdPath);
  }

  // ~/.claude/rules/*.md
  const userRules = countRulesInDir(path.join(claudeDir, 'rules'));
  rulesCount += userRules.count;
  rulesBytes += userRules.bytes;

  // ~/.claude/settings.json (MCPs and hooks)
  const userSettings = path.join(claudeDir, 'settings.json');
  for (const name of getMcpServerNames(userSettings)) {
    userMcpServers.add(name);
  }
  hooksCount += countHooksInFile(userSettings);

  // {CLAUDE_CONFIG_DIR}.json (additional user-scope MCPs)
  const userClaudeJson = getClaudeConfigJsonPath(homeDir);
  for (const name of getMcpServerNames(userClaudeJson)) {
    userMcpServers.add(name);
  }

  // Get disabled user-scope MCPs from ~/.claude.json
  const disabledUserMcps = getDisabledMcpServers(userClaudeJson, 'disabledMcpServers');
  for (const name of disabledUserMcps) {
    userMcpServers.delete(name);
  }

  // === PLUGIN SCOPE ===
  // Scan enabled plugins' .mcp.json files in the plugin cache.
  // Plugin .mcp.json can use flat format {"name": {config}} or wrapped {"mcpServers": {"name": {config}}}.
  const pluginCacheDir = path.join(claudeDir, 'plugins', 'cache');
  try {
    for (const marketplace of fs.readdirSync(pluginCacheDir, { withFileTypes: true })) {
      if (!marketplace.isDirectory()) continue;
      for (const plugin of fs.readdirSync(path.join(pluginCacheDir, marketplace.name), { withFileTypes: true })) {
        if (!plugin.isDirectory()) continue;
        const pluginDir = path.join(pluginCacheDir, marketplace.name, plugin.name);
        for (const ver of fs.readdirSync(pluginDir, { withFileTypes: true })) {
          if (!ver.isDirectory()) continue;
          const mcpJson = path.join(pluginDir, ver.name, '.mcp.json');
          if (!fs.existsSync(mcpJson)) continue;
          try {
            const content = fs.readFileSync(mcpJson, 'utf8');
            const data = JSON.parse(content);
            const mcpObj = (data.mcpServers && typeof data.mcpServers === 'object')
              ? data.mcpServers
              : data;
            for (const name of Object.keys(mcpObj)) {
              const cfg = mcpObj[name];
              if (cfg && typeof cfg === 'object' && (cfg.command || cfg.type || cfg.url)) {
                userMcpServers.add(name);
              }
            }
          } catch {
            debug(`Failed to read plugin MCP config from ${mcpJson}`);
          }
        }
      }
    }
  } catch {
    debug('Failed to scan plugin cache for MCP servers');
  }

  // === PROJECT SCOPE ===

  // Avoid double-counting when project .claude directory is the same location as user scope.
  const projectClaudeDir = cwd ? path.join(cwd, '.claude') : null;
  const projectClaudeOverlapsUserScope = projectClaudeDir
    ? pathsReferToSameLocation(projectClaudeDir, claudeDir)
    : false;

  if (cwd) {
    // {cwd}/CLAUDE.md
    const cwdClaudeMd = path.join(cwd, 'CLAUDE.md');
    if (fs.existsSync(cwdClaudeMd)) {
      claudeMdCount++;
      claudeMdBytes += readFileBytes(cwdClaudeMd);
    }

    // {cwd}/CLAUDE.local.md
    const cwdClaudeMdLocal = path.join(cwd, 'CLAUDE.local.md');
    if (fs.existsSync(cwdClaudeMdLocal)) {
      claudeMdCount++;
      claudeMdBytes += readFileBytes(cwdClaudeMdLocal);
    }

    // {cwd}/.claude/CLAUDE.md (alternative location, skip when it is user scope)
    const cwdDotClaudeMd = path.join(cwd, '.claude', 'CLAUDE.md');
    if (!projectClaudeOverlapsUserScope && fs.existsSync(cwdDotClaudeMd)) {
      claudeMdCount++;
      claudeMdBytes += readFileBytes(cwdDotClaudeMd);
    }

    // {cwd}/.claude/CLAUDE.local.md
    const cwdDotClaudeMdLocal = path.join(cwd, '.claude', 'CLAUDE.local.md');
    if (fs.existsSync(cwdDotClaudeMdLocal)) {
      claudeMdCount++;
      claudeMdBytes += readFileBytes(cwdDotClaudeMdLocal);
    }

    // {cwd}/.claude/rules/*.md (recursive)
    // Skip when it overlaps with user-scope rules.
    if (!projectClaudeOverlapsUserScope) {
      const projectRules = countRulesInDir(path.join(cwd, '.claude', 'rules'));
      rulesCount += projectRules.count;
      rulesBytes += projectRules.bytes;
    }

    // {cwd}/.mcp.json (project MCP config) - tracked separately for disabled filtering
    const mcpJsonServers = getMcpServerNames(path.join(cwd, '.mcp.json'));

    // {cwd}/.claude/settings.json (project settings)
    // Skip when it overlaps with user-scope settings.
    const projectSettings = path.join(cwd, '.claude', 'settings.json');
    if (!projectClaudeOverlapsUserScope) {
      for (const name of getMcpServerNames(projectSettings)) {
        projectMcpServers.add(name);
      }
      hooksCount += countHooksInFile(projectSettings);
    }

    // {cwd}/.claude/settings.local.json (local project settings)
    const localSettings = path.join(cwd, '.claude', 'settings.local.json');
    for (const name of getMcpServerNames(localSettings)) {
      projectMcpServers.add(name);
    }
    hooksCount += countHooksInFile(localSettings);

    // Get disabled .mcp.json servers from settings.local.json
    const disabledMcpJsonServers = getDisabledMcpServers(localSettings, 'disabledMcpjsonServers');
    for (const name of disabledMcpJsonServers) {
      mcpJsonServers.delete(name);
    }

    // Add remaining .mcp.json servers to project set
    for (const name of mcpJsonServers) {
      projectMcpServers.add(name);
    }
  }

  // Total MCP count = user servers + project servers
  // Note: Deduplication only occurs within each scope, not across scopes.
  // A server with the same name in both user and project scope counts as 2 (separate configs).
  const mcpCount = userMcpServers.size + projectMcpServers.size;

  return { claudeMdCount, claudeMdBytes, rulesCount, rulesBytes, mcpCount, hooksCount };
}
