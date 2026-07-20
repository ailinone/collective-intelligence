// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Tavily Search Service
 *
 * Provides web search capabilities using the Tavily API.
 * Used as a fallback when no models with native web_search capability are available.
 *
 * Features:
 * - Basic search for quick results
 * - Deep search for comprehensive research
 * - News search for recent events
 * - Context extraction for RAG applications
 */

import { logger } from '@/utils/logger';

// ============================================
// Types
// ============================================

export interface TavilySearchOptions {
  query: string;
  searchDepth?: 'basic' | 'advanced';
  includeImages?: boolean;
  includeAnswer?: boolean;
  includeRawContent?: boolean;
  maxResults?: number;
  includeDomains?: string[];
  excludeDomains?: string[];
  topic?: 'general' | 'news' | 'finance';
}

export interface TavilySearchResult {
  title: string;
  url: string;
  content: string;
  rawContent?: string;
  score: number;
  publishedDate?: string;
}

export interface TavilySearchResponse {
  success: boolean;
  query: string;
  answer?: string;
  results: TavilySearchResult[];
  images?: string[];
  responseTime: number;
  error?: string;
}

export interface TavilyExtractOptions {
  urls: string[];
  includeImages?: boolean;
}

export interface TavilyExtractResult {
  url: string;
  content: string;
  images?: string[];
  error?: string;
}

export interface TavilyExtractResponse {
  success: boolean;
  results: TavilyExtractResult[];
  failedResults: Array<{ url: string; error: string }>;
  responseTime: number;
}

// ============================================
// Tavily Search Service
// ============================================

export class TavilySearchService {
  private log = logger.child({ service: 'tavily-search' });
  private apiKey: string | null = null;
  private baseUrl = 'https://api.tavily.com';

  constructor() {
    // Get API key from environment variable
    this.apiKey = process.env.TAVILY_API_KEY || null;
  }

  /**
   * Check if Tavily is configured and available
   */
  isAvailable(): boolean {
    return this.apiKey !== null && this.apiKey.length > 0;
  }

  /**
   * Get API key, throwing if not configured
   */
  private getApiKey(): string {
    if (!this.apiKey) {
      throw new Error(
        'Tavily API key not configured. Set TAVILY_API_KEY environment variable.'
      );
    }
    return this.apiKey;
  }

  /**
   * Perform a web search
   */
  async search(options: TavilySearchOptions): Promise<TavilySearchResponse> {
    const startTime = Date.now();

    try {
      const apiKey = this.getApiKey();

      const requestBody = {
        api_key: apiKey,
        query: options.query,
        search_depth: options.searchDepth || 'basic',
        include_images: options.includeImages ?? false,
        include_answer: options.includeAnswer ?? true,
        include_raw_content: options.includeRawContent ?? false,
        max_results: options.maxResults ?? 5,
        include_domains: options.includeDomains,
        exclude_domains: options.excludeDomains,
        topic: options.topic || 'general',
      };

      this.log.debug(
        {
          query: options.query,
          searchDepth: requestBody.search_depth,
          maxResults: requestBody.max_results,
        },
        'Executing Tavily search'
      );

      const response = await fetch(`${this.baseUrl}/search`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Tavily API error: ${response.status} - ${errorText}`);
      }

      const data = await response.json() as {
        answer?: string;
        results?: Array<{ title?: string; url?: string; content?: string; raw_content?: string; score?: number; published_date?: string }>;
        images?: string[];
      };
      const responseTime = Date.now() - startTime;

      this.log.info(
        {
          query: options.query,
          resultsCount: data.results?.length || 0,
          responseTime,
          hasAnswer: !!data.answer,
        },
        'Tavily search completed'
      );

      return {
        success: true,
        query: options.query,
        answer: data.answer,
        results: (data.results || []).map((r: { title?: string; url?: string; content?: string; raw_content?: string; score?: number; published_date?: string }) => ({
          title: r.title || '',
          url: r.url || '',
          content: r.content || '',
          rawContent: r.raw_content,
          score: r.score || 0,
          publishedDate: r.published_date,
        })),
        images: data.images,
        responseTime,
      };
    } catch (error) {
      const responseTime = Date.now() - startTime;

      this.log.error(
        {
          query: options.query,
          error: error instanceof Error ? error.message : String(error),
          responseTime,
        },
        'Tavily search failed'
      );

      return {
        success: false,
        query: options.query,
        results: [],
        responseTime,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Perform a deep search for comprehensive research
   */
  async deepSearch(query: string, maxResults: number = 10): Promise<TavilySearchResponse> {
    return this.search({
      query,
      searchDepth: 'advanced',
      includeAnswer: true,
      includeRawContent: true,
      maxResults,
    });
  }

  /**
   * Search for news articles
   */
  async searchNews(query: string, maxResults: number = 5): Promise<TavilySearchResponse> {
    return this.search({
      query,
      searchDepth: 'basic',
      includeAnswer: true,
      maxResults,
      topic: 'news',
    });
  }

  /**
   * Extract content from URLs (useful for RAG)
   */
  async extract(options: TavilyExtractOptions): Promise<TavilyExtractResponse> {
    const startTime = Date.now();

    try {
      const apiKey = this.getApiKey();

      const response = await fetch(`${this.baseUrl}/extract`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          api_key: apiKey,
          urls: options.urls,
          include_images: options.includeImages ?? false,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Tavily Extract API error: ${response.status} - ${errorText}`);
      }

      const data = await response.json() as {
        results?: Array<{ url?: string; raw_content?: string; images?: string[] }>;
        failed_results?: Array<{ url?: string; error?: string }>;
      };
      const responseTime = Date.now() - startTime;

      return {
        success: true,
        results: (data.results || [])
          .filter((r: { url?: string; raw_content?: string; images?: string[] }): r is { url: string; raw_content?: string; images?: string[] } => 
            r.url !== undefined && r.url !== null && typeof r.url === 'string'
          )
          .map((r): TavilyExtractResult => ({
            url: r.url,
            content: typeof r.raw_content === 'string' ? r.raw_content : '',
            images: Array.isArray(r.images) ? r.images : [],
          })),
        failedResults: (data.failed_results || [])
          .filter((r: { url?: string; error?: string }): r is { url: string; error: string } => 
            r.url !== undefined && r.url !== null && r.error !== undefined && r.error !== null
          )
          .map((r) => ({
            url: r.url,
            error: r.error,
          })),
        responseTime,
      };
    } catch (error) {
      const responseTime = Date.now() - startTime;

      this.log.error(
        {
          urls: options.urls,
          error: error instanceof Error ? error.message : String(error),
        },
        'Tavily extract failed'
      );

      return {
        success: false,
        results: [],
        failedResults: options.urls.map((url) => ({
          url,
          error: error instanceof Error ? error.message : 'Unknown error',
        })),
        responseTime,
      };
    }
  }

  /**
   * Get context for RAG (search + extract combined)
   */
  async getContext(
    query: string,
    options: {
      maxResults?: number;
      extractContent?: boolean;
    } = {}
  ): Promise<{
    success: boolean;
    context: string;
    sources: Array<{ title: string; url: string }>;
    error?: string;
  }> {
    const { maxResults = 5, extractContent = false } = options;

    // First, search for relevant results
    const searchResult = await this.search({
      query,
      searchDepth: extractContent ? 'advanced' : 'basic',
      includeAnswer: true,
      maxResults,
    });

    if (!searchResult.success) {
      return {
        success: false,
        context: '',
        sources: [],
        error: searchResult.error,
      };
    }

    // Build context from results
    let context = '';

    if (searchResult.answer) {
      context += `Summary: ${searchResult.answer}\n\n`;
    }

    context += 'Sources:\n';
    for (const result of searchResult.results) {
      context += `\n[${result.title}](${result.url})\n`;
      context += `${result.content}\n`;
    }

    return {
      success: true,
      context,
      sources: searchResult.results.map((r) => ({
        title: r.title,
        url: r.url,
      })),
    };
  }
}

// Singleton instance
let tavilyService: TavilySearchService | null = null;

export function getTavilySearchService(): TavilySearchService {
  if (!tavilyService) {
    tavilyService = new TavilySearchService();
  }
  return tavilyService;
}

