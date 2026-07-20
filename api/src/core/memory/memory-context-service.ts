// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Memory Context Service
 *
 * Integrates Semantic Memory with orchestration strategies
 * to provide contextual memory for AI interactions.
 *
 * Features:
 * - Retrieve relevant memories for requests
 * - Store conversation outcomes as memories
 * - Build enhanced context with historical knowledge
 * - Memory-aware prompt enrichment
 */

import pino from 'pino';
import { getSemanticMemoryStore, type MemoryEntry } from './semantic-memory-store';
import type { ChatRequest } from '@/types';
import { getErrorMessage } from '@/utils/type-guards';

const logger = pino({ name: 'memory-context-service' });

export interface MemoryContext {
  /** Relevant memories for the current request */
  memories: MemoryEntry[];
  /** Combined context text from memories */
  contextText: string;
  /** Whether memory context was successfully retrieved */
  hasContext: boolean;
  /** Source of memories used */
  memorySources: Array<{
    id: string;
    type: string;
    similarity: number;
  }>;
}

export interface MemoryContextOptions {
  /** Maximum number of memories to retrieve */
  maxMemories?: number;
  /** Minimum similarity threshold */
  minSimilarity?: number;
  /** Types of memories to include */
  memoryTypes?: Array<'episodic' | 'semantic' | 'procedural'>;
  /** Include system context */
  includeSystemContext?: boolean;
}

const DEFAULT_OPTIONS: Required<MemoryContextOptions> = {
  maxMemories: 5,
  minSimilarity: 0.7,
  memoryTypes: ['semantic', 'procedural'],
  includeSystemContext: true,
};

/**
 * Memory Context Service
 * Provides memory-enhanced context for AI interactions
 */
export class MemoryContextService {
  private log = logger.child({ component: 'MemoryContextService' });

  /**
   * Build enhanced context with relevant memories
   */
  async buildContext(
    request: ChatRequest,
    organizationId: string,
    userId?: string,
    options: MemoryContextOptions = {}
  ): Promise<MemoryContext> {
    const opts = { ...DEFAULT_OPTIONS, ...options };

    try {
      const memoryStore = getSemanticMemoryStore();

      // Extract query from user messages
      const query = this.extractQueryFromRequest(request);

      if (!query) {
        return this.emptyContext();
      }

      // Search for relevant memories across specified types
      const memories: MemoryEntry[] = [];
      const memorySources: MemoryContext['memorySources'] = [];

      for (const memoryType of opts.memoryTypes) {
        try {
          const results = await memoryStore.search({
            organizationId,
            userId,
            query,
            type: memoryType,
            limit: Math.ceil(opts.maxMemories / opts.memoryTypes.length),
            minSimilarity: opts.minSimilarity,
          });

          for (const result of results) {
            memories.push(result.entry);
            memorySources.push({
              id: result.entry.id,
              type: memoryType,
              similarity: result.similarity,
            });
          }
        } catch (searchError) {
          this.log.warn(
            { error: getErrorMessage(searchError), memoryType },
            'Failed to search memories of type'
          );
        }
      }

      // Sort by similarity (descending) and limit
      const sortedSources = [...memorySources].sort((a, b) => b.similarity - a.similarity);
      const topSources = sortedSources.slice(0, opts.maxMemories);
      const topMemoryIds = new Set(topSources.map((s) => s.id));

      // Filter memories to match top sources
      const topMemories = memories.filter((m) => topMemoryIds.has(m.id)).slice(0, opts.maxMemories);

      // Build context text from memories
      const contextText = this.buildContextText(topMemories, opts.includeSystemContext);

      this.log.info(
        {
          memoriesFound: topMemories.length,
          organizationId,
          queryLength: query.length,
        },
        'Built memory context'
      );

      return {
        memories: topMemories,
        contextText,
        hasContext: topMemories.length > 0,
        memorySources: topSources,
      };
    } catch (error) {
      this.log.error(
        { error: getErrorMessage(error) },
        'Failed to build memory context'
      );
      return this.emptyContext();
    }
  }

  /**
   * Store a conversation outcome as a memory
   */
  async storeOutcome(params: {
    organizationId: string;
    userId?: string;
    content: string;
    type: 'episodic' | 'semantic' | 'procedural';
    importance?: number;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    try {
      const memoryStore = getSemanticMemoryStore();

      await memoryStore.store({
        organizationId: params.organizationId,
        userId: params.userId,
        content: params.content,
        type: params.type,
        importance: params.importance || 0.5,
        metadata: params.metadata,
      });

      this.log.info(
        {
          organizationId: params.organizationId,
          type: params.type,
          contentLength: params.content.length,
        },
        'Stored conversation outcome as memory'
      );
    } catch (error) {
      this.log.error(
        { error: getErrorMessage(error) },
        'Failed to store conversation outcome'
      );
    }
  }

  /**
   * Enrich a request with memory context
   */
  enrichRequest(
    request: ChatRequest,
    memoryContext: MemoryContext
  ): ChatRequest {
    if (!memoryContext.hasContext || !memoryContext.contextText) {
      return request;
    }

    // Find or create system message
    const messages = [...request.messages];
    const systemIndex = messages.findIndex((m) => m.role === 'system');

    const memoryNote = `\n\n[Relevant Context from Memory]\n${memoryContext.contextText}`;

    if (systemIndex >= 0) {
      const systemMessage = messages[systemIndex];
      const currentContent =
        typeof systemMessage.content === 'string'
          ? systemMessage.content
          : '';

      messages[systemIndex] = {
        ...systemMessage,
        content: currentContent + memoryNote,
      };
    } else {
      // Prepend a system message with memory context
      messages.unshift({
        role: 'system',
        content: `You have access to the following relevant context from memory:${memoryNote}`,
      });
    }

    return {
      ...request,
      messages,
    };
  }

  /**
   * Extract query text from request messages
   */
  private extractQueryFromRequest(request: ChatRequest): string {
    // Get the last user message
    for (let i = request.messages.length - 1; i >= 0; i--) {
      const message = request.messages[i];
      if (message.role === 'user') {
        if (typeof message.content === 'string') {
          return message.content;
        }
        // Handle array content (multimodal)
        if (Array.isArray(message.content)) {
          const textParts = message.content
            .filter((part): part is { type: 'text'; text: string } => 
              part.type === 'text' && 'text' in part
            )
            .map((part) => part.text);
          return textParts.join(' ');
        }
      }
    }
    return '';
  }

  /**
   * Build context text from memories
   */
  private buildContextText(
    memories: MemoryEntry[],
    includeSystemContext: boolean
  ): string {
    if (memories.length === 0) {
      return '';
    }

    const sections: string[] = [];

    // Group by type
    const byType = new Map<string, MemoryEntry[]>();
    for (const memory of memories) {
      const type = memory.type || 'general';
      const existing = byType.get(type) || [];
      existing.push(memory);
      byType.set(type, existing);
    }

    // Build sections
    for (const [type, typeMemories] of byType) {
      const typeLabel = this.getTypeLabel(type);
      const items = typeMemories
        .map((m) => `- ${m.content}`)
        .join('\n');

      if (includeSystemContext) {
        sections.push(`**${typeLabel}:**\n${items}`);
      } else {
        sections.push(items);
      }
    }

    return sections.join('\n\n');
  }

  /**
   * Get human-readable label for memory type
   */
  private getTypeLabel(type: string): string {
    switch (type) {
      case 'episodic':
        return 'Previous Conversations';
      case 'semantic':
        return 'Known Facts';
      case 'procedural':
        return 'Known Procedures';
      default:
        return 'Related Context';
    }
  }

  /**
   * Create empty context
   */
  private emptyContext(): MemoryContext {
    return {
      memories: [],
      contextText: '',
      hasContext: false,
      memorySources: [],
    };
  }
}

// Singleton instance
let memoryContextService: MemoryContextService | null = null;

/**
 * Get the Memory Context Service instance
 */
export function getMemoryContextService(): MemoryContextService {
  if (!memoryContextService) {
    memoryContextService = new MemoryContextService();
  }
  return memoryContextService;
}

/**
 * Initialize the Memory Context Service
 */
export function initializeMemoryContextService(): MemoryContextService {
  memoryContextService = new MemoryContextService();
  return memoryContextService;
}

