import { spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { getClaudeConfigDir, getClaudeConfigJsonPath, getHudPluginDir } from './claude-config-dir.js';

// Calibrated from real introspection data (context7: 2 tools/1101 tokens, eraser: 20 tools/6238 tokens).
// Stdio servers that fail to respond are typically smaller utility servers (~2-5 tools).
// HTTP/OAuth servers tend to be enterprise APIs with richer tool catalogs (~10-20 tools).
const MCP_HEURISTIC_STDIO = 1500;
const MCP_HEURISTIC_HTTP = 3000;
const QUERY_TIMEOUT_MS = 15_000;

interface McpServerConfig {
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
}

interface McpToolCacheEntry {
  configHash: string;
  queriedAt: string;
  toolCount: number;
  estimatedTokens: number;
  source: 'introspected' | 'heuristic';
}

export interface McpToolCache {
  version: 1;
  generatedAt: string;
  servers: Record<string, McpToolCacheEntry>;
}

function log(msg: string): void {
  process.stderr.write(`[mcp-introspect] ${msg}\n`);
}

function configHash(config: McpServerConfig): string {
  return crypto.createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 12);
}

function parseMcpServers(obj: Record<string, unknown>): McpServerConfig[] {
  const servers: McpServerConfig[] = [];
  for (const [name, config] of Object.entries(obj)) {
    if (!config || typeof config !== 'object') continue;
    const cfg = config as Record<string, unknown>;
    if (cfg.command && typeof cfg.command === 'string') {
      servers.push({
        name,
        transport: 'stdio',
        command: cfg.command,
        args: Array.isArray(cfg.args) ? cfg.args.filter((a): a is string => typeof a === 'string') : [],
      });
    } else if (cfg.type === 'http' || (cfg.url && typeof cfg.url === 'string')) {
      servers.push({ name, transport: 'http', url: cfg.url as string });
    }
  }
  return servers;
}

function readMcpServersFromSettingsFile(filePath: string): McpServerConfig[] {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(content) as Record<string, unknown>;
    if (data.mcpServers && typeof data.mcpServers === 'object') {
      return parseMcpServers(data.mcpServers as Record<string, unknown>);
    }
    return [];
  } catch {
    return [];
  }
}

function readMcpServersFromMcpJson(filePath: string): McpServerConfig[] {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(content) as Record<string, unknown>;
    // .mcp.json files nest under "mcpServers" or are flat
    const mcpObj = (data.mcpServers && typeof data.mcpServers === 'object')
      ? data.mcpServers as Record<string, unknown>
      : data;
    return parseMcpServers(mcpObj);
  } catch {
    return [];
  }
}

function discoverMcpServers(): McpServerConfig[] {
  const homeDir = os.homedir();
  const claudeDir = getClaudeConfigDir(homeDir);
  const seen = new Set<string>();
  const servers: McpServerConfig[] = [];

  function addUnique(list: McpServerConfig[]): void {
    for (const s of list) {
      if (!seen.has(s.name)) {
        seen.add(s.name);
        servers.push(s);
      }
    }
  }

  // User-scope: settings.json + .claude.json (keyed under mcpServers)
  addUnique(readMcpServersFromSettingsFile(path.join(claudeDir, 'settings.json')));
  addUnique(readMcpServersFromSettingsFile(getClaudeConfigJsonPath(homeDir)));

  // Plugin-scope: enabled plugins with .mcp.json
  const pluginCacheDir = path.join(claudeDir, 'plugins', 'cache');
  try {
    for (const marketplace of fs.readdirSync(pluginCacheDir, { withFileTypes: true })) {
      if (!marketplace.isDirectory()) continue;
      const mktDir = path.join(pluginCacheDir, marketplace.name);
      for (const plugin of fs.readdirSync(mktDir, { withFileTypes: true })) {
        if (!plugin.isDirectory()) continue;
        const pluginDir = path.join(mktDir, plugin.name);
        // Find latest version dir
        const versions = fs.readdirSync(pluginDir, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .map(d => d.name);
        for (const ver of versions) {
          const mcpPath = path.join(pluginDir, ver, '.mcp.json');
          addUnique(readMcpServersFromMcpJson(mcpPath));
        }
      }
    }
  } catch { /* plugin cache may not exist */ }

  return servers;
}

function queryStdioServer(command: string, args: string[]): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { proc.kill(); reject(new Error('timeout')); }, QUERY_TIMEOUT_MS);

    let buffer = '';
    let toolsResolved = false;

    proc.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as { id?: number; result?: { tools?: unknown[] } };
          if (msg.id === 1) {
            // Got initialize response — send initialized + tools/list
            proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
            proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
          }
          if (msg.id === 2 && !toolsResolved) {
            toolsResolved = true;
            clearTimeout(timer);
            proc.kill();
            resolve(msg.result?.tools ?? []);
          }
        } catch { /* ignore non-JSON lines (server logs) */ }
      }
    });

    proc.on('error', (err) => { clearTimeout(timer); reject(err); });
    proc.on('exit', () => {
      if (!toolsResolved) { clearTimeout(timer); reject(new Error('exited before tools/list')); }
    });

    // Send initialize request
    proc.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'claude-hud', version: '1.0.0' },
      },
    }) + '\n');
  });
}

export async function introspectAll(): Promise<McpToolCache> {
  const servers = discoverMcpServers();
  const cache: McpToolCache = { version: 1, generatedAt: new Date().toISOString(), servers: {} };

  for (const server of servers) {
    const hash = configHash(server);

    if (server.transport === 'stdio' && server.command) {
      try {
        log(`${server.name}: querying ${server.command} ${(server.args ?? []).join(' ')}...`);
        const tools = await queryStdioServer(server.command, server.args ?? []);
        const estimatedTokens = Math.round(JSON.stringify(tools).length / 4);
        cache.servers[server.name] = {
          configHash: hash,
          queriedAt: new Date().toISOString(),
          toolCount: tools.length,
          estimatedTokens,
          source: 'introspected',
        };
        log(`${server.name}: ${tools.length} tools, ~${estimatedTokens} tokens (introspected)`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown';
        log(`${server.name}: failed (${msg}), using stdio heuristic`);
        cache.servers[server.name] = {
          configHash: hash,
          queriedAt: new Date().toISOString(),
          toolCount: 0,
          estimatedTokens: MCP_HEURISTIC_STDIO,
          source: 'heuristic',
        };
      }
    } else {
      log(`${server.name}: http/oauth, using http heuristic`);
      cache.servers[server.name] = {
        configHash: hash,
        queriedAt: new Date().toISOString(),
        toolCount: 0,
        estimatedTokens: MCP_HEURISTIC_HTTP,
        source: 'heuristic',
      };
    }
  }

  // Write cache
  const cachePath = path.join(getHudPluginDir(os.homedir()), 'mcp-tool-cache.json');
  try {
    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
    log(`cache written to ${cachePath}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    log(`failed to write cache: ${msg}`);
  }

  return cache;
}

// Run as standalone script
const scriptPath = fileURLToPath(import.meta.url);
const argvPath = process.argv[1];
const isSamePath = (a: string, b: string): boolean => {
  try { return realpathSync(a) === realpathSync(b); } catch { return a === b; }
};
if (argvPath && isSamePath(argvPath, scriptPath)) {
  void introspectAll().then(() => process.exit(0)).catch(() => process.exit(1));
}
