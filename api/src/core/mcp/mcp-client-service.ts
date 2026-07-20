// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * MCP Client Service
 *
 * Connects to external MCP servers, discovers their tools, and registers
 * them in the Ailin Tool Registry so ALL 30 strategies can use them.
 *
 * Supports two transports:
 * - stdio: spawns MCP server as child process (like Claude Desktop)
 * - sse: connects to remote MCP server via Server-Sent Events
 *
 * Configuration via environment variable MCP_SERVERS_CONFIG (JSON) or
 * config file at api/src/config/mcp-servers.json.
 *
 * Architecture:
 *   Config → McpClientService.initialize() → connect to each server
 *   → discover tools → register in toolRegistry → strategies use them
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
// SSE transport imported dynamically when needed
import { toolRegistry, type ToolHandler } from '@/core/tools/tool-registry';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'mcp-client-service' });

/** Configuration for a single MCP server. */
export interface McpServerConfig {
  /** Unique name for this server (used as tool prefix) */
  name: string;
  /** Transport type */
  transport: 'stdio' | 'sse';
  /** For stdio: command to spawn */
  command?: string;
  /** For stdio: command arguments */
  args?: string[];
  /** For stdio: environment variables */
  env?: Record<string, string>;
  /** For sse: URL of the MCP server */
  url?: string;
  /** Whether tools from this server are safe for strategy execution */
  safeForStrategies?: boolean;
  /** Tool category for registry */
  category?: 'web' | 'search' | 'code' | 'file' | 'analysis' | 'general';
}

/** Active MCP connection with client and metadata. */
interface McpConnection {
  config: McpServerConfig;
  client: Client;
  transport: StdioClientTransport | unknown;
  tools: string[];
  connected: boolean;
}

/**
 * MCP Client Service — manages connections to MCP servers and bridges
 * their tools to the Ailin Tool Registry.
 */
class McpClientServiceImpl {
  private connections = new Map<string, McpConnection>();
  private initialized = false;

  /**
   * Initialize: load config, connect to servers, register tools.
   * Call once at startup after Tool Registry is initialized.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    const configs = this.loadConfig();
    if (configs.length === 0) {
      log.info('No MCP servers configured');
      this.initialized = true;
      return;
    }

    log.info({ serverCount: configs.length }, 'Initializing MCP connections');

    for (const config of configs) {
      try {
        await this.connectServer(config);
      } catch (err) {
        log.warn(
          { server: config.name, error: err instanceof Error ? err.message : String(err) },
          'Failed to connect MCP server (non-fatal)',
        );
      }
    }

    const totalTools = [...this.connections.values()].reduce((sum, c) => sum + c.tools.length, 0);
    log.info(
      {
        servers: this.connections.size,
        totalTools,
        serverNames: [...this.connections.keys()],
      },
      'MCP client service initialized',
    );

    this.initialized = true;
  }

  /**
   * Connect to a single MCP server, discover tools, register in Tool Registry.
   */
  private async connectServer(config: McpServerConfig): Promise<void> {
    const client = new Client({
      name: `ailin-ci-${config.name}`,
      version: '1.0.0',
    });

    let transport: StdioClientTransport | unknown;

    if (config.transport === 'stdio') {
      if (!config.command) throw new Error(`MCP server ${config.name}: stdio transport requires 'command'`);

      transport = new StdioClientTransport({
        command: config.command,
        args: config.args || [],
        env: { ...process.env, ...(config.env || {}) } as Record<string, string>,
      });
    } else if (config.transport === 'sse') {
      if (!config.url) throw new Error(`MCP server ${config.name}: sse transport requires 'url'`);

      // Dynamic import for SSE transport
      const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');
      transport = new SSEClientTransport(new URL(config.url));
    } else {
      throw new Error(`MCP server ${config.name}: unknown transport '${config.transport}'`);
    }

    // Connect
    await client.connect(transport as Parameters<typeof client.connect>[0]);
    log.info({ server: config.name, transport: config.transport }, 'MCP server connected');

    // Discover tools
    const toolsResult = await client.listTools();
    const tools = toolsResult.tools || [];
    const toolNames: string[] = [];

    log.info({ server: config.name, toolCount: tools.length }, 'MCP tools discovered');

    // Register each tool in Tool Registry
    for (const tool of tools) {
      const toolName = `mcp_${config.name}_${tool.name}`;
      const handler = this.createToolHandler(client, tool.name);

      toolRegistry.register({
        name: toolName,
        aliases: [tool.name], // Allow direct name access too
        description: tool.description || `MCP tool: ${tool.name} (${config.name})`,
        category: config.category || 'general',
        safeForStrategies: config.safeForStrategies !== false,
        handler,
        parameters: tool.inputSchema as Record<string, unknown> | undefined,
      });

      toolNames.push(toolName);
      log.debug({ server: config.name, tool: toolName }, 'MCP tool registered');
    }

    this.connections.set(config.name, {
      config,
      client,
      transport,
      tools: toolNames,
      connected: true,
    });
  }

  /**
   * Create a Tool Registry handler that delegates to the MCP client.
   */
  private createToolHandler(client: Client, toolName: string): ToolHandler {
    return async (args, toolCallId, _context) => {
      try {
        const result = await client.callTool({
          name: toolName,
          arguments: args,
        });

        // MCP returns content array — extract text
        const textContent = (result.content as Array<{ type: string; text?: string }>)
          .filter(c => c.type === 'text')
          .map(c => c.text || '')
          .join('\n');

        return {
          tool_call_id: toolCallId,
          success: !result.isError,
          output: textContent || JSON.stringify(result.content),
          error: result.isError ? textContent : undefined,
        };
      } catch (err) {
        return {
          tool_call_id: toolCallId,
          success: false,
          error: `MCP tool '${toolName}' failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    };
  }

  /**
   * Load MCP server configuration from env var or config file.
   */
  private loadConfig(): McpServerConfig[] {
    // Priority 1: MCP_SERVERS_CONFIG env var (JSON string)
    const envConfig = process.env.MCP_SERVERS_CONFIG;
    if (envConfig) {
      try {
        const parsed: unknown = JSON.parse(envConfig);
        if (Array.isArray(parsed)) return parsed as McpServerConfig[];
        if (typeof parsed === 'object' && parsed !== null) {
          const servers = (parsed as { servers?: unknown }).servers;
          if (Array.isArray(servers)) return servers as McpServerConfig[];
        }
        return [];
      } catch (err) {
        log.warn({ error: String(err) }, 'Failed to parse MCP_SERVERS_CONFIG env var');
      }
    }

    // Priority 2: Individual MCP_SERVER_* env vars
    // Pattern: MCP_SERVER_<NAME>_COMMAND, MCP_SERVER_<NAME>_ARGS, MCP_SERVER_<NAME>_URL
    const servers: McpServerConfig[] = [];
    const serverNames = new Set<string>();

    for (const [key, value] of Object.entries(process.env)) {
      const match = key.match(/^MCP_SERVER_([A-Z0-9_]+)_(COMMAND|ARGS|URL|TRANSPORT)$/);
      if (match && value) {
        serverNames.add(match[1]);
      }
    }

    for (const name of serverNames) {
      const command = process.env[`MCP_SERVER_${name}_COMMAND`];
      const url = process.env[`MCP_SERVER_${name}_URL`];
      const transport = (process.env[`MCP_SERVER_${name}_TRANSPORT`] || (url ? 'sse' : 'stdio')) as 'stdio' | 'sse';
      const argsStr = process.env[`MCP_SERVER_${name}_ARGS`];

      servers.push({
        name: name.toLowerCase().replace(/_/g, '-'),
        transport,
        command: command || undefined,
        args: argsStr ? argsStr.split(' ') : undefined,
        url: url || undefined,
        safeForStrategies: process.env[`MCP_SERVER_${name}_SAFE`] !== 'false',
        category: 'general',
      });
    }

    if (servers.length > 0) return servers;

    // Priority 3: Config file at api/src/config/mcp-servers.json
    try {
      const configPath = resolve(__dirname, '../../config/mcp-servers.json');
      const raw = readFileSync(configPath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      const fileServers: McpServerConfig[] = Array.isArray(parsed)
        ? (parsed as McpServerConfig[])
        : (typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { servers?: unknown }).servers)
            ? ((parsed as { servers: McpServerConfig[] }).servers)
            : []);
      if (fileServers.length > 0) {
        log.info({ path: configPath, count: fileServers.length }, 'Loaded MCP config from file');
        return fileServers;
      }
    } catch {
      // Config file not found or invalid — that's fine
    }

    return [];
  }

  /**
   * Disconnect all MCP servers gracefully.
   */
  async shutdown(): Promise<void> {
    for (const [name, conn] of this.connections) {
      try {
        await conn.client.close();
        log.info({ server: name }, 'MCP server disconnected');
      } catch (err) {
        log.warn({ server: name, error: String(err) }, 'Error disconnecting MCP server');
      }
    }
    this.connections.clear();
  }

  /** Get list of connected servers. */
  getConnectedServers(): Array<{ name: string; tools: string[]; connected: boolean }> {
    return [...this.connections.values()].map(c => ({
      name: c.config.name,
      tools: c.tools,
      connected: c.connected,
    }));
  }

  /** Check if any MCP servers are configured. */
  hasServers(): boolean {
    return this.connections.size > 0;
  }
}

/** Singleton instance. */
export const mcpClientService = new McpClientServiceImpl();
