// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Enhanced Script to check documentation completeness for all API endpoints
 * 
 * Features:
 * - Robust parsing of route definitions (handles TypeScript generics, spread operators)
 * - Detects external schema references (e.g., ...toolResponseSchema)
 * - Detailed analysis of schema components
 * - Comprehensive reporting
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

interface EndpointInfo {
  file: string;
  method: string;
  path: string;
  lineNumber?: number;
  hasSchema: boolean;
  hasDescription: boolean;
  hasSummary: boolean;
  descriptionLength: number;
  hasBody: boolean;
  hasParams: boolean;
  hasQuerystring: boolean;
  hasResponse: boolean;
  responseStatusCodes: string[];
  responseHasDetails: boolean;
  hasSecurity: boolean;
  hasTags: boolean;
  bodyPropertiesCount: number;
  bodyPropertiesWithDescription: number;
  querystringPropertiesCount: number;
  querystringPropertiesWithDescription: number;

  hasRequiredFields: boolean;
  securityIssues: string[];
  issues: string[];
  schemaComplete: boolean;
  schemaQuality: 'excellent' | 'good' | 'partial' | 'minimal' | 'none';
  securityScore: number;
  documentationScore: number;
}

interface ParseContext {
  content: string;
  position: number;
  lineNumber: number;
}

/**
 * Extract balanced braces/brackets content
 */
function extractBalanced(
  context: ParseContext,
  openChar: string,
  closeChar: string
): { content: string; endPos: number; lineNumber: number } | null {
  if (context.content[context.position] !== openChar) return null;

  let depth = 0;
  let pos = context.position;
  let inString = false;
  let stringChar = '';
  let escapeNext = false;
  let startLine = context.lineNumber;

  // Adjust line number for current position
  for (let i = 0; i < context.position; i++) {
    if (context.content[i] === '\n') startLine++;
  }

  while (pos < context.content.length) {
    const char = context.content[pos];
    const prevChar = pos > 0 ? context.content[pos - 1] : '';

    if (escapeNext) {
      escapeNext = false;
      pos++;
      continue;
    }

    // Handle strings
    if (!inString && (char === '"' || char === "'" || char === '`')) {
      inString = true;
      stringChar = char;
    } else if (inString && char === stringChar && prevChar !== '\\') {
      inString = false;
      stringChar = '';
    } else if (char === '\\' && inString) {
      escapeNext = true;
    }

    if (!inString) {
      if (char === openChar) depth++;
      if (char === closeChar) {
        depth--;
        if (depth === 0) {
          return {
            content: context.content.substring(context.position + 1, pos),
            endPos: pos + 1,
            lineNumber: startLine,
          };
        }
      }
    }

    pos++;
  }

  return null;
}

/**
 * Check if content contains a pattern (multiline-aware)
 */
function containsPattern(content: string, pattern: RegExp): boolean {
  return pattern.test(content);
}

/**
 * Extract all property names from an object-like string
 */
function extractProperties(content: string): string[] {
  const properties: string[] = [];
  
  // Match property names: key: or "key": or 'key': or key?: or "key"?:
  const propPattern = /(?:^|\s+|,)(?:"([^"]+)"|'([^']+)'|([a-zA-Z_$][a-zA-Z0-9_$]*))(?:\??)\s*:/gm;
  let match;
  
  while ((match = propPattern.exec(content)) !== null) {
    const propName = match[1] || match[2] || match[3];
    if (propName && !properties.includes(propName)) {
      properties.push(propName);
    }
  }
  
  return properties;
}

/**
 * Extract status codes from response schema
 */
function extractResponseStatusCodes(schemaContent: string): string[] {
  const statusCodes: string[] = [];
  
  // Match response object patterns: 200:, 201:, 400:, etc.
  const statusPattern = /(\d{3})\s*:/g;
  let match;
  
  while ((match = statusPattern.exec(schemaContent)) !== null) {
    statusCodes.push(match[1]);
  }
  
  // Also check for common patterns like { 200: ..., 400: ..., 500: ... }
  const responsePattern = /response:\s*\{([^}]*\{[^}]*\}[^}]*)*\}/s;
  const responseMatch = schemaContent.match(responsePattern);
  if (responseMatch) {
    const responseContent = responseMatch[1];
    const codes = responseContent.match(/\d{3}/g);
    if (codes) {
      codes.forEach(code => {
        if (!statusCodes.includes(code)) statusCodes.push(code);
      });
    }
  }
  
  return statusCodes.sort();
}

/**
 * Check for security-sensitive information exposure
 */
function checkSecurityIssues(schemaContent: string, path: string): string[] {
  const issues: string[] = [];
  
  // Check for hardcoded secrets, keys, tokens
  const sensitivePatterns = [
    /api[_-]?key\s*[:=]\s*['"][^'"]+['"]/gi,
    /secret\s*[:=]\s*['"][^'"]+['"]/gi,
    /token\s*[:=]\s*['"][^'"]+['"]/gi,
    /password\s*[:=]\s*['"][^'"]+['"]/gi,
    /bearer\s+[\w-]{20,}/gi,
    /sk-[a-zA-Z0-9]{20,}/gi,
    /pk_[a-zA-Z0-9]{20,}/gi,
  ];
  
  for (const pattern of sensitivePatterns) {
    if (pattern.test(schemaContent)) {
      issues.push('potentially sensitive information exposed');
      break;
    }
  }
  
  // Check if internal paths or system information is exposed
  if (/\/etc\/|\/var\/|C:\\|localhost:\d{4}/i.test(schemaContent)) {
    issues.push('internal system paths referenced');
  }
  
  // Check for SQL injection risk in examples
  if (/DROP TABLE|DELETE FROM|UPDATE.*SET.*WHERE|SELECT.*FROM.*WHERE/i.test(schemaContent)) {
    issues.push('SQL-like patterns detected (potential security risk in examples)');
  }
  
  return issues;
}

/**
 * Extract description text and calculate length
 * Handles escaped quotes and nested quotes correctly
 */
function extractDescriptionLength(schemaContent: string): number {
  // Try to match description with proper quote handling
  // Match description: followed by quote, then content (handling escaped quotes), then closing quote
  const patterns = [
    // Single quotes with escaped single quotes
    /description:\s*'((?:[^'\\]|\\.)*)'/s,
    // Double quotes with escaped double quotes  
    /description:\s*"((?:[^"\\]|\\.)*)"/s,
    // Backticks with escaped backticks
    /description:\s*`((?:[^`\\]|\\.)*)`/s,
  ];
  
  for (const pattern of patterns) {
    const match = schemaContent.match(pattern);
    if (match) {
      // Unescape the string content
      const content = match[1]
        .replace(/\\'/g, "'")
        .replace(/\\"/g, '"')
        .replace(/\\`/g, '`')
        .replace(/\\\\/g, '\\');
      return content.trim().length;
    }
  }
  
  return 0;
}

/**
 * Extract balanced content (handles nested braces)
 */
function extractBalancedContent(content: string, startPattern: RegExp): string | null {
  const match = content.match(startPattern);
  if (!match) return null;
  
  const startPos = match.index! + match[0].length - 1; // Position of opening {
  let depth = 1;
  let pos = startPos + 1;
  let inString = false;
  let stringChar = '';
  let escapeNext = false;
  
  while (pos < content.length && depth > 0) {
    const char = content[pos];
    const prevChar = pos > 0 ? content[pos - 1] : '';
    
    if (escapeNext) {
      escapeNext = false;
      pos++;
      continue;
    }
    
    // Handle strings
    if (!inString && (char === '"' || char === "'" || char === '`')) {
      inString = true;
      stringChar = char;
    } else if (inString && char === stringChar && prevChar !== '\\') {
      inString = false;
      stringChar = '';
    } else if (char === '\\' && inString) {
      escapeNext = true;
    }
    
    // Count braces only outside strings
    if (!inString) {
      if (char === '{') depth++;
      else if (char === '}') depth--;
    }
    
    pos++;
  }
  
  if (depth === 0) {
    return content.substring(startPos + 1, pos - 1);
  }
  
  return null;

}

/**
 * Count body properties and those with descriptions
 */
function analyzeBodyProperties(schemaContent: string): { total: number; withDescription: number } {
  // Extract body content using balanced extraction
  const bodyContent = extractBalancedContent(schemaContent, /body:\s*\{/);
  if (!bodyContent) return { total: 0, withDescription: 0 };
  
  // Extract properties content using balanced extraction
  const propsContent = extractBalancedContent(bodyContent, /properties:\s*\{/);
  if (!propsContent) return { total: 0, withDescription: 0 };
  
  // Count top-level properties (not nested inside other objects)
  // Match property name followed by colon and object start, but not nested
  const propertyPattern = /(\w+):\s*(?:\{|oneOf|anyOf|allOf|enum|type|string|number|boolean|array|object|null)/g;
  const properties: string[] = [];
  let match;
  
  // Reset regex lastIndex
  propertyPattern.lastIndex = 0;
  
  // Track brace depth to identify top-level properties
  let braceDepth = 0;
  let lastPropEnd = 0;
  
  while ((match = propertyPattern.exec(propsContent)) !== null) {
    const propName = match[1];
    const propStart = match.index;
    
    // Skip if it's a known non-property keyword
    if (['type', 'description', 'required', 'items', 'properties', 'additionalProperties', 'format', 'minItems', 'maxItems', 'minimum', 'maximum', 'default', 'nullable'].includes(propName)) {
      continue;
    }
    
    // Count braces between last property and this one to determine if it's top-level
    const between = propsContent.substring(lastPropEnd, propStart);
    const openBraces = (between.match(/\{/g) || []).length;
    const closeBraces = (between.match(/\}/g) || []).length;
    braceDepth += openBraces - closeBraces;
    
    // If brace depth is 0 or 1, this is a top-level property
    if (braceDepth <= 1 && !properties.includes(propName)) {
      properties.push(propName);
      lastPropEnd = propStart;
    }
  }
  
  // Count properties with descriptions (check if description appears after property definition)
  const withDescription = properties.filter(prop => {
    // Look for property definition followed by description
    // Pattern 1: prop: { ... description: ...
    const propWithDescPattern = new RegExp(`${prop}:\\s*(?:\\{[^}]*description:|oneOf[^}]*description:|enum[^}]*description:)`, 's');
    // Pattern 2: prop: { ... (possibly nested) ... description: ...
    const propBlockPattern = new RegExp(`${prop}:\\s*\\{([\\s\\S]*?)description:`, 's');
    return propWithDescPattern.test(propsContent) || propBlockPattern.test(propsContent);
  }).length;
  
  return { total: properties.length, withDescription };
}

/**
 * Count querystring properties and those with descriptions
 */
function analyzeQuerystringProperties(schemaContent: string): { total: number; withDescription: number } {
  // Extract querystring content using balanced extraction
  const querystringContent = extractBalancedContent(schemaContent, /querystring:\s*\{/);
  if (!querystringContent) return { total: 0, withDescription: 0 };
  
  // Extract properties content using balanced extraction
  const propsContent = extractBalancedContent(querystringContent, /properties:\s*\{/);
  if (!propsContent) return { total: 0, withDescription: 0 };
  
  // Count top-level properties (same logic as body properties)
  const propertyPattern = /(\w+):\s*(?:\{|oneOf|anyOf|allOf|enum|type|string|number|boolean|array|object|null)/g;
  const properties: string[] = [];
  let match;
  
  propertyPattern.lastIndex = 0;
  let braceDepth = 0;
  let lastPropEnd = 0;
  
  while ((match = propertyPattern.exec(propsContent)) !== null) {
    const propName = match[1];
    const propStart = match.index;
    
    if (['type', 'description', 'required', 'items', 'properties', 'additionalProperties', 'format', 'minItems', 'maxItems', 'minimum', 'maximum', 'default', 'nullable'].includes(propName)) {
      continue;
    }
    
    const between = propsContent.substring(lastPropEnd, propStart);
    const openBraces = (between.match(/\{/g) || []).length;
    const closeBraces = (between.match(/\}/g) || []).length;
    braceDepth += openBraces - closeBraces;
    
    if (braceDepth <= 1 && !properties.includes(propName)) {
      properties.push(propName);
      lastPropEnd = propStart;

    }
  }
  
  // Count properties with descriptions
  const withDescription = properties.filter(prop => {
    const propWithDescPattern = new RegExp(`${prop}:\\s*(?:\\{[^}]*description:|oneOf[^}]*description:|enum[^}]*description:)`, 's');
    const propBlockPattern = new RegExp(`${prop}:\\s*\\{([\\s\\S]*?)description:`, 's');
    return propWithDescPattern.test(propsContent) || propBlockPattern.test(propsContent);

  }).length;
  
  return { total: properties.length, withDescription };
}

/**
 * Check if response has detailed property definitions
 */
function checkResponseDetails(schemaContent: string): boolean {
  const responseMatch = schemaContent.match(/response:\s*\{([^}]*\{[^}]*\}[^}]*)*\}/s);
  if (!responseMatch) return false;
  
  const responseContent = responseMatch[1];
  
  // Check if response has at least one status code with properties
  const statusPattern = /(\d{3}):\s*\{[^}]*properties:\s*\{/s;
  const hasProperties = statusPattern.test(responseContent);
  
  // Check for spread operators (indicating external schema with details)
  // Common patterns: toolResponseSchema, chatCompletionResponseSchema, etc.
  const hasSpreadOperator = /\.\.\.[a-zA-Z_$][a-zA-Z0-9_$]*(Response|Error|Success)?Schema/.test(responseContent) ||
                           /\.\.\.[a-zA-Z_$][a-zA-Z0-9_$]*Schema/.test(responseContent);
  
  // Check for description fields in response schemas (indicates detailed documentation)
  const hasDescriptionInResponse = /(\d{3}):\s*\{[^}]*description:/s.test(responseContent);
  
  // If has properties directly OR uses a well-named schema spread OR has descriptions
  // Spread operators are considered as having details if they follow naming conventions
  return hasProperties || hasSpreadOperator || hasDescriptionInResponse;
}

/**
 * Check for required fields in body/params
 */
function checkRequiredFields(schemaContent: string): boolean {
  return /required:\s*\[/s.test(schemaContent);
}

/**
 * Calculate security score (0-100)
 */
function calculateSecurityScore(endpoint: Omit<EndpointInfo, 'securityScore' | 'documentationScore' | 'schemaQuality'>): number {
  let score = 100;
  
  // Deduct for security issues
  score -= endpoint.securityIssues.length * 20;
  
  // Deduct if no security definition
  if (!endpoint.hasSecurity) score -= 30;
  
  // Deduct if security is defined but unclear
  // This is checked via securityIssues
  
  return Math.max(0, score);
}

/**
 * Calculate documentation score (0-100)
 */
function calculateDocumentationScore(endpoint: Omit<EndpointInfo, 'securityScore' | 'documentationScore' | 'schemaQuality'>): number {
  let score = 0;
  
  // Basic components (40 points)
  if (endpoint.hasDescription) score += 10;
  if (endpoint.hasSummary) score += 5;
  if (endpoint.descriptionLength > 50) score += 5;
  if (endpoint.hasBody || endpoint.hasParams || endpoint.hasQuerystring) score += 10;
  if (endpoint.hasResponse) score += 10;
  
  // Quality indicators (30 points)
  if (endpoint.responseStatusCodes.length >= 3) score += 10;
  if (endpoint.responseHasDetails) score += 10;
  if (endpoint.hasRequiredFields) score += 5;
  
  // Body/querystring properties documentation (5 points)
  // If endpoint has properties (body or querystring), calculate ratio
  // If endpoint has no properties, give full points (expected for GET/DELETE without body/querystring)
  const totalPropertiesCount = endpoint.bodyPropertiesCount + endpoint.querystringPropertiesCount;
  if (totalPropertiesCount > 0) {
    const totalWithDescription = endpoint.bodyPropertiesWithDescription + endpoint.querystringPropertiesWithDescription;
    const descRatio = totalWithDescription / totalPropertiesCount;
    score += descRatio * 5;
  } else {
    // No properties to document - give full points (expected for endpoints without body/querystring)
    score += 5;

  }
  
  // Metadata (20 points)
  if (endpoint.hasSecurity) score += 10;
  if (endpoint.hasTags) score += 5;
  if (endpoint.responseStatusCodes.length >= 4) score += 5;
  
  // Completeness (10 points)
  if (endpoint.schemaComplete) score += 10;
  
  return Math.min(100, score);
}

/**
 * Analyze schema quality
 */
function analyzeSchemaQuality(
  endpoint: Omit<EndpointInfo, 'schemaQuality' | 'securityScore' | 'documentationScore'>
): EndpointInfo['schemaQuality'] {
  if (!endpoint.hasSchema) return 'none';
  
  const docScore = calculateDocumentationScore(endpoint);
  const secScore = calculateSecurityScore(endpoint);
  const combinedScore = (docScore + secScore) / 2;
  
  // Adjust for critical issues
  const criticalIssues = endpoint.issues.filter(issue => 
    issue.includes('missing response') || 
    issue.includes('no schema') ||
    endpoint.securityIssues.length > 0
  ).length;
  
  if (criticalIssues > 0) {
    return combinedScore > 70 ? 'partial' : 'minimal';
  }
  
  if (combinedScore >= 90 && endpoint.responseStatusCodes.length >= 3) return 'excellent';
  if (combinedScore >= 75 && endpoint.responseStatusCodes.length >= 2) return 'good';
  if (combinedScore >= 60) return 'partial';
  if (combinedScore >= 40) return 'minimal';
  return 'minimal';
}

/**
 * Extract endpoints from a route file
 */
function extractEndpoints(filePath: string): EndpointInfo[] {
  const content = readFileSync(filePath, 'utf-8');
  const endpoints: EndpointInfo[] = [];
  
  // Match route definitions: server.(get|post|put|delete|patch)(<Type>)?('path', { config })
  // Handles both with and without TypeScript generics
  const routePatterns = [
    // Standard: server.post('path', { schema: ... })
    /server\.(get|post|put|delete|patch)(?:<[^>]*>)?\s*\(['"]([^'"]+)['"],\s*\{/g,
    // With type annotation: server.post<{Body:...}>('path', { schema: ... })
    /server\.(get|post|put|delete|patch)<[^>]*>\s*\(['"]([^'"]+)['"],\s*\{/g,
    // Fastify style: fastify.post('path', { schema: ... })
    /fastify\.(get|post|put|delete|patch)(?:<[^>]*>)?\s*\(['"]([^'"]+)['"],\s*\{/g,
  ];
  
  for (const routePattern of routePatterns) {
    let match;
    while ((match = routePattern.exec(content)) !== null) {
      const method = match[1].toUpperCase();
      const path = match[2];
      const routeStartPos = match.index;
      
      // Calculate line number
      let lineNumber = 1;
      for (let i = 0; i < routeStartPos; i++) {
        if (content[i] === '\n') lineNumber++;
      }
      
      const routeConfigStart = match.index + match[0].length - 1; // Position of opening {
      
      const context: ParseContext = {
        content,
        position: routeConfigStart,
        lineNumber,
      };
      
      // Extract the route configuration object
      const routeConfig = extractBalanced(context, '{', '}');
      if (!routeConfig) continue;
      
      // Look for schema within the route config
      const schemaMatch = routeConfig.content.match(/schema:\s*\{/);
      if (!schemaMatch) {
        // Route without schema
        endpoints.push({
          file: filePath.replace(process.cwd() + '/', ''),
          method,
          path,
          lineNumber,
          hasSchema: false,
          hasDescription: false,
          hasSummary: false,
          descriptionLength: 0,
          hasBody: false,
          hasParams: false,
          hasQuerystring: false,
          hasResponse: false,
          responseStatusCodes: [],
          responseHasDetails: false,
          hasSecurity: false,
          hasTags: false,
          bodyPropertiesCount: 0,
          bodyPropertiesWithDescription: 0,
          querystringPropertiesCount: 0,
          querystringPropertiesWithDescription: 0,

          hasRequiredFields: false,
          securityIssues: [],
          issues: ['no schema defined'],
          schemaComplete: false,
          securityScore: 0,
          documentationScore: 0,
          schemaQuality: 'none',
        });
        continue;
      }
      
      // Extract schema content
      const schemaStartInConfig = schemaMatch.index! + schemaMatch[0].length - 1;
      const schemaPos = routeConfigStart + 1 + schemaStartInConfig;
      
      const schemaContext: ParseContext = {
        content,
        position: schemaPos,
        lineNumber,
      };
      
      const schemaObj = extractBalanced(schemaContext, '{', '}');
      if (!schemaObj) continue;
      
      const schemaContent = schemaObj.content;
      
      // Analyze schema components
      const hasDescription = containsPattern(schemaContent, /description:\s*['"`][^'"`]+['"`]/s);
      const hasSummary = containsPattern(schemaContent, /summary:\s*['"`][^'"`]+['"`]/s);
      const descriptionLength = hasDescription ? extractDescriptionLength(schemaContent) : 0;
      const hasBody = containsPattern(schemaContent, /body:\s*\{/s) || 
                     containsPattern(schemaContent, /body:\s*\.\.\./s) ||
                     containsPattern(schemaContent, /body:\s*[a-zA-Z]/s);
      const hasParams = containsPattern(schemaContent, /params:\s*\{/s);
      const hasQuerystring = containsPattern(schemaContent, /querystring:\s*\{/s);
      const hasResponse = containsPattern(schemaContent, /response:\s*\{/s) ||
                         containsPattern(schemaContent, /response:\s*\.\.\./s);
      const hasSecurity = containsPattern(schemaContent, /security:\s*\[/s);
      const hasTags = containsPattern(schemaContent, /tags:\s*\[/s);
      
      const responseStatusCodes = hasResponse ? extractResponseStatusCodes(schemaContent) : [];
      const responseHasDetails = hasResponse ? checkResponseDetails(schemaContent) : false;
      
      // Analyze body properties
      const bodyAnalysis = hasBody ? analyzeBodyProperties(schemaContent) : { total: 0, withDescription: 0 };
      // Analyze querystring properties
      const querystringAnalysis = hasQuerystring ? analyzeQuerystringProperties(schemaContent) : { total: 0, withDescription: 0 };

      const hasRequiredFields = checkRequiredFields(schemaContent);
      
      // Security checks
      const securityIssues = checkSecurityIssues(schemaContent, path);
      
      // Build issues list
      const issues: string[] = [];
      if (!hasDescription) issues.push('missing description');
      if (hasDescription && descriptionLength < 30) issues.push('description too short (should be at least 30 characters)');
      if (!hasSummary) issues.push('missing summary');
      if (!hasBody && !hasParams && !hasQuerystring) {
        // For POST/PUT/PATCH, body is usually required
        if (['POST', 'PUT', 'PATCH'].includes(method)) {
          issues.push('missing body (expected for POST/PUT/PATCH)');
        } else {
          issues.push('missing params/querystring');
        }
      }
      if (!hasResponse) issues.push('missing response schema');
      if (hasResponse && responseStatusCodes.length === 0) {
        issues.push('response schema has no status codes defined');
      }
      if (hasResponse && !responseHasDetails) {
        issues.push('response schema lacks detailed property definitions');
      }
      if (!hasSecurity) issues.push('missing security definition');
      if (!hasTags) issues.push('missing tags');
      if (hasBody && bodyAnalysis.total > 0 && bodyAnalysis.withDescription / bodyAnalysis.total < 0.5) {
        issues.push('body properties lack descriptions (less than 50% documented)');
      }
      if (!hasRequiredFields && (hasBody || hasParams)) {
        issues.push('missing required fields specification');
      }
      
      // Add security issues
      issues.push(...securityIssues);
      
      // Schema is complete if it has description, (body/params/querystring), and response
      const schemaComplete = hasDescription && 
                            descriptionLength >= 30 &&
                            (hasBody || hasParams || hasQuerystring) && 
                            hasResponse && 
                            responseStatusCodes.length > 0 &&
                            responseHasDetails &&
                            hasSecurity &&
                            securityIssues.length === 0;
      
      const endpoint: EndpointInfo = {
        file: filePath.replace(process.cwd() + '/', ''),
        method,
        path,
        lineNumber,
        hasSchema: true,
        hasDescription,
        hasSummary,
        descriptionLength,
        hasBody,
        hasParams,
        hasQuerystring,
        hasResponse,
        responseStatusCodes,
        responseHasDetails,
        hasSecurity,
        hasTags,
        bodyPropertiesCount: bodyAnalysis.total,
        bodyPropertiesWithDescription: bodyAnalysis.withDescription,
        querystringPropertiesCount: querystringAnalysis.total,
        querystringPropertiesWithDescription: querystringAnalysis.withDescription,

        hasRequiredFields,
        securityIssues,
        issues,
        schemaComplete,
        securityScore: 0, // Will be calculated below
        documentationScore: 0, // Will be calculated below
        schemaQuality: 'minimal', // Will be calculated below
      };
      
      endpoint.securityScore = calculateSecurityScore(endpoint);
      endpoint.documentationScore = calculateDocumentationScore(endpoint);
      endpoint.schemaQuality = analyzeSchemaQuality(endpoint);
      
      // Only add if not already found (avoid duplicates from multiple patterns)
      if (!endpoints.find(e => e.method === method && e.path === path && e.file === endpoint.file)) {
        endpoints.push(endpoint);
      }
    }
  }
  
  return endpoints;
}

/**
 * Get all route files
 */
function getAllRouteFiles(dir: string): string[] {
  const files: string[] = [];
  
  function traverse(currentDir: string) {
    try {
      const entries = readdirSync(currentDir);
      
      for (const entry of entries) {
        const fullPath = join(currentDir, entry);
        const stat = statSync(fullPath);
        
        if (stat.isDirectory() && !entry.includes('node_modules') && !entry.includes('.git') && !entry.includes('dist')) {
          traverse(fullPath);
        } else if (entry.endsWith('-routes.ts') || entry.endsWith('-routes.js')) {
          files.push(fullPath);
        }
      }
    } catch (error) {
      // Skip directories we can't read
    }
  }
  
  traverse(dir);
  return files;
}

/**
 * Main function
 */
function main() {
  const routesDir = join(process.cwd(), 'src', 'routes');
  const routeFiles = getAllRouteFiles(routesDir);
  
  console.log(`\n📊 Analyzing ${routeFiles.length} route files...\n`);
  
  const allEndpoints: EndpointInfo[] = [];
  
  for (const file of routeFiles) {
    try {
      const endpoints = extractEndpoints(file);
      allEndpoints.push(...endpoints);
    } catch (error) {
      console.error(`❌ Error processing ${file}:`, error instanceof Error ? error.message : error);
    }
  }
  
  console.log(`✅ Found ${allEndpoints.length} endpoints total\n`);
  
  // Categorize endpoints
  const complete = allEndpoints.filter(e => e.schemaComplete);
  const incomplete = allEndpoints.filter(e => e.hasSchema && !e.schemaComplete);
  const noSchema = allEndpoints.filter(e => !e.hasSchema);
  
  // Quality distribution
  const qualityDistribution = {
    excellent: allEndpoints.filter(e => e.schemaQuality === 'excellent').length,
    good: allEndpoints.filter(e => e.schemaQuality === 'good').length,
    partial: allEndpoints.filter(e => e.schemaQuality === 'partial').length,
    minimal: allEndpoints.filter(e => e.schemaQuality === 'minimal').length,
    none: allEndpoints.filter(e => e.schemaQuality === 'none').length,
  };
  
  console.log(`📈 Documentation Status:\n`);
  console.log(`  ✅ Complete:     ${complete.length} (${Math.round((complete.length / allEndpoints.length) * 100) || 0}%)`);
  console.log(`  ⚠️  Incomplete:   ${incomplete.length} (${Math.round((incomplete.length / allEndpoints.length) * 100) || 0}%)`);
  console.log(`  ❌ No Schema:    ${noSchema.length} (${Math.round((noSchema.length / allEndpoints.length) * 100) || 0}%)\n`);
  
  console.log(`📊 Schema Quality Distribution:\n`);
  console.log(`  ⭐ Excellent:    ${qualityDistribution.excellent} (${Math.round((qualityDistribution.excellent / allEndpoints.length) * 100) || 0}%)`);
  console.log(`  ✅ Good:         ${qualityDistribution.good} (${Math.round((qualityDistribution.good / allEndpoints.length) * 100) || 0}%)`);
  console.log(`  ⚠️  Partial:      ${qualityDistribution.partial} (${Math.round((qualityDistribution.partial / allEndpoints.length) * 100) || 0}%)`);
  console.log(`  🔴 Minimal:      ${qualityDistribution.minimal} (${Math.round((qualityDistribution.minimal / allEndpoints.length) * 100) || 0}%)`);
  console.log(`  ❌ None:         ${qualityDistribution.none} (${Math.round((qualityDistribution.none / allEndpoints.length) * 100) || 0}%)\n`);
  
  // Calculate average scores
  const avgDocScore = allEndpoints.reduce((sum, e) => sum + e.documentationScore, 0) / allEndpoints.length;
  const avgSecScore = allEndpoints.reduce((sum, e) => sum + e.securityScore, 0) / allEndpoints.length;
  const endpointsWithSecurityIssues = allEndpoints.filter(e => e.securityIssues.length > 0).length;
  
  console.log(`📈 Quality Metrics:\n`);
  console.log(`  📚 Avg Documentation Score: ${Math.round(avgDocScore)}/100`);
  console.log(`  🔒 Avg Security Score:      ${Math.round(avgSecScore)}/100`);
  console.log(`  ⚠️  Endpoints with Security Issues: ${endpointsWithSecurityIssues} (${Math.round((endpointsWithSecurityIssues / allEndpoints.length) * 100) || 0}%)\n`);
  
  // Group by file
  const byFile = new Map<string, EndpointInfo[]>();
  for (const endpoint of allEndpoints) {
    if (!byFile.has(endpoint.file)) {
      byFile.set(endpoint.file, []);
    }
    byFile.get(endpoint.file)!.push(endpoint);
  }
  
  console.log(`\n📁 Status by Route File:\n`);
  for (const [file, endpoints] of Array.from(byFile.entries()).sort()) {
    const fileComplete = endpoints.filter(e => e.schemaComplete).length;
    const fileIncomplete = endpoints.filter(e => e.hasSchema && !e.schemaComplete).length;
    const fileNoSchema = endpoints.filter(e => !e.hasSchema).length;
    
    const qualityCounts = {
      excellent: endpoints.filter(e => e.schemaQuality === 'excellent').length,
      good: endpoints.filter(e => e.schemaQuality === 'good').length,
      partial: endpoints.filter(e => e.schemaQuality === 'partial').length,
      minimal: endpoints.filter(e => e.schemaQuality === 'minimal').length,
      none: endpoints.filter(e => e.schemaQuality === 'none').length,
    };
    
    const status = fileNoSchema > 0 ? '❌' : 
                   fileIncomplete > 0 ? '⚠️ ' : 
                   qualityCounts.excellent === endpoints.length ? '⭐' : '✅';
    
    console.log(`${status} ${file}`);
    console.log(`   Total: ${endpoints.length} | Complete: ${fileComplete} | Incomplete: ${fileIncomplete} | No Schema: ${fileNoSchema}`);
    console.log(`   Quality: ⭐${qualityCounts.excellent} ✅${qualityCounts.good} ⚠️${qualityCounts.partial} 🔴${qualityCounts.minimal} ❌${qualityCounts.none}`);
    
    // Show incomplete endpoints with details
    if (fileIncomplete > 0 || fileNoSchema > 0) {
      for (const endpoint of endpoints) {
        if (!endpoint.schemaComplete) {
          const issuesStr = endpoint.issues.length > 0 
            ? endpoint.issues.join(', ')
            : 'unknown issues';
          const responseCodes = endpoint.responseStatusCodes.length > 0
            ? ` [${endpoint.responseStatusCodes.join(', ')}]`
            : '';
          const docScore = Math.round(endpoint.documentationScore);
          const secScore = Math.round(endpoint.securityScore);
          const scoreStr = `[Doc: ${docScore}/100, Sec: ${secScore}/100]`;
          console.log(`      - ${endpoint.method} ${endpoint.path}${responseCodes} (line ${endpoint.lineNumber || '?'}) ${scoreStr}`);
          console.log(`        Issues: ${issuesStr}`);
          if (endpoint.securityIssues.length > 0) {
            console.log(`        🔒 Security: ${endpoint.securityIssues.join(', ')}`);
          }
        }
      }
    }
    console.log('');
  }
  
  // Summary with recommendations
  console.log(`\n📋 Summary:\n`);
  console.log(`Total endpoints analyzed: ${allEndpoints.length}`);
  console.log(`Fully documented: ${complete.length} (${Math.round((complete.length / allEndpoints.length) * 100) || 0}%)`);
  console.log(`Needs completion: ${incomplete.length + noSchema.length} (${Math.round(((incomplete.length + noSchema.length) / allEndpoints.length) * 100) || 0}%)\n`);
  
  // Top issues
  const allIssues = new Map<string, number>();
  for (const endpoint of allEndpoints) {
    for (const issue of endpoint.issues) {
      allIssues.set(issue, (allIssues.get(issue) || 0) + 1);
    }
  }
  
  if (allIssues.size > 0) {
    console.log(`🔍 Top Issues:\n`);
    const sortedIssues = Array.from(allIssues.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    
    for (const [issue, count] of sortedIssues) {
      console.log(`   ${count.toString().padStart(3)} endpoints: ${issue}`);
    }
    console.log('');
    
    // Detailed list of endpoints with specific issues
    console.log(`📋 Detailed Issue Report:\n`);
    
    // Body properties without descriptions
    const bodyDescIssues = allEndpoints.filter(e => 
      e.issues.includes('body properties lack descriptions (less than 50% documented)')
    );
    if (bodyDescIssues.length > 0) {
      console.log(`   ⚠️  Body Properties Missing Descriptions (${bodyDescIssues.length} endpoints):\n`);
      for (const endpoint of bodyDescIssues) {
        const coverage = endpoint.bodyPropertiesCount > 0 
          ? Math.round((endpoint.bodyPropertiesWithDescription / endpoint.bodyPropertiesCount) * 100)
          : 0;
        console.log(`      ${endpoint.method} ${endpoint.path}`);
        console.log(`         File: ${endpoint.file} (line ${endpoint.lineNumber || '?'})`);
        console.log(`         Coverage: ${endpoint.bodyPropertiesWithDescription}/${endpoint.bodyPropertiesCount} (${coverage}%)`);
        console.log(`         Documentation Score: ${Math.round(endpoint.documentationScore)}/100\n`);
      }
    }
    
    // Missing required fields
    const missingRequired = allEndpoints.filter(e => 
      e.issues.includes('missing required fields specification')
    );
    if (missingRequired.length > 0) {
      console.log(`   ⚠️  Missing Required Fields Specification (${missingRequired.length} endpoints):\n`);
      for (const endpoint of missingRequired) {
        const hasBody = endpoint.hasBody ? 'has body' : '';
        const hasParams = endpoint.hasParams ? 'has params' : '';
        const hasQuerystring = endpoint.hasQuerystring ? 'has querystring' : '';
        const schemas = [hasBody, hasParams, hasQuerystring].filter(Boolean).join(', ');
        console.log(`      ${endpoint.method} ${endpoint.path}`);
        console.log(`         File: ${endpoint.file} (line ${endpoint.lineNumber || '?'})`);
        console.log(`         Schema types: ${schemas || 'none'}`);
        console.log(`         Documentation Score: ${Math.round(endpoint.documentationScore)}/100\n`);
      }
    }

  }
  
  // Security recommendations
  if (endpointsWithSecurityIssues > 0) {
    console.log(`\n🔒 Security Recommendations:\n`);
    console.log(`   ${endpointsWithSecurityIssues} endpoint(s) have potential security issues.`);
    console.log(`   Review and ensure no sensitive information is exposed in documentation.\n`);
  }
  
  // Documentation recommendations
  const avgDocBelow70 = allEndpoints.filter(e => e.documentationScore < 70).length;
  const avgDocBelow90 = allEndpoints.filter(e => e.documentationScore < 90).length;
  const avgDocBelow100 = allEndpoints.filter(e => e.documentationScore < 100).length;
  const endpoints90to99 = allEndpoints.filter(e => e.documentationScore >= 90 && e.documentationScore < 100);
  
  if (avgDocBelow100 > 0) {
    console.log(`\n📚 Documentation Score Analysis:\n`);
    console.log(`   Below 70: ${avgDocBelow70} endpoints`);
    console.log(`   Below 90: ${avgDocBelow90} endpoints`);
    console.log(`   90-99: ${endpoints90to99.length} endpoints`);
    console.log(`   100: ${allEndpoints.length - avgDocBelow100} endpoints`);
    console.log(`   Below 100: ${avgDocBelow100} endpoints\n`);
    
    if (endpoints90to99.length > 0) {
      console.log(`   📊 Endpoints with scores 90-99 (can be improved to 100):\n`);
      const sorted90to99 = endpoints90to99.sort((a, b) => a.documentationScore - b.documentationScore);
      
      for (const endpoint of sorted90to99) {
        const score = Math.round(endpoint.documentationScore);
        const missingPoints = 100 - score;
        console.log(`      ${endpoint.method} ${endpoint.path} - Score: ${score}/100 (missing ${missingPoints} points)`);
        console.log(`         File: ${endpoint.file} (line ${endpoint.lineNumber || '?'})`);
        
        // Identify what's missing based on score calculation
        const missing: string[] = [];
        if (endpoint.responseStatusCodes.length < 4) missing.push(`Need ${4 - endpoint.responseStatusCodes.length} more status code(s) (currently ${endpoint.responseStatusCodes.length}, need 4 for full points)`);
        if (!endpoint.responseHasDetails) missing.push('Response schema needs detailed property descriptions');
        if (!endpoint.hasRequiredFields) missing.push('Missing required fields specification');
        if (endpoint.bodyPropertiesCount > 0 && endpoint.bodyPropertiesWithDescription < endpoint.bodyPropertiesCount) {
          const missingDesc = endpoint.bodyPropertiesCount - endpoint.bodyPropertiesWithDescription;
          missing.push(`${missingDesc} body property(ies) missing descriptions`);
        }
        if (endpoint.descriptionLength <= 50) missing.push('Description too short (need >50 chars for full points)');
        if (!endpoint.schemaComplete) missing.push('Schema incomplete');
        
        if (missing.length > 0) {
          console.log(`         Missing for 100: ${missing.join(', ')}`);
        }
        console.log('');
      }
    }
    
    if (avgDocBelow90 > 0) {
      console.log(`   ⚠️  Endpoints with scores below 90 (needs improvement):\n`);
      const below90 = allEndpoints.filter(e => e.documentationScore < 90)
        .sort((a, b) => a.documentationScore - b.documentationScore);
      
      for (const endpoint of below90.slice(0, 20)) { // Show top 20 worst
        const score = Math.round(endpoint.documentationScore);
        const issues = endpoint.issues.filter(i => 
          !i.includes('body properties') && 
          !i.includes('missing required')
        ).slice(0, 3);
        console.log(`      ${endpoint.method} ${endpoint.path} - Score: ${score}/100`);
        console.log(`         File: ${endpoint.file} (line ${endpoint.lineNumber || '?'})`);
        if (issues.length > 0) {
          console.log(`         Issues: ${issues.join(', ')}`);
        }
        console.log('');
      }
    }

  }
  
  // Exit with appropriate code
  const hasErrors = noSchema.length > 0 || endpointsWithSecurityIssues > 0 || avgDocScore < 70;
  process.exit(hasErrors ? 1 : 0);
}

main();
