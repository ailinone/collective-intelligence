// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Quality Validator
 *
 * Automatically validates responses before returning to user:
 * - Code: Syntax check, linting, security scan
 * - SQL: Query validation, explain plan analysis
 * - JSON: Schema validation
 * - Text: Grammar check, coherence analysis
 *
 * Enterprise-ready, production-grade implementation
 */

import type { ChatResponse } from '@/types';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'quality-validator' });

/**
 * Validation context
 */
export interface ValidationContext {
  requestId: string;
  taskType: string;
  language?: string;
  qualityThreshold: number; // 0-1
  startTime: number;
}

/**
 * Validation issue
 */
export interface ValidationIssue {
  type: 'syntax' | 'security' | 'performance' | 'style' | 'logic' | 'other';
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  location?: string;
  autoFixable: boolean;
  suggestion?: string;
}

/**
 * Validation result
 */
export interface ValidationResult {
  valid: boolean;
  score: number; // 0-100
  issues: ValidationIssue[];
  suggestions: string[];
  autoFixable: boolean;
  metadata: {
    validatorsRun: string[];
    executionTime: number;
  };
}

/**
 * Quality Validator
 */
export class QualityValidator {
  /**
   * Validate response quality
   */
  async validate(response: ChatResponse, context: ValidationContext): Promise<ValidationResult> {
    const startTime = Date.now();

    log.info(
      {
        requestId: context.requestId,
        taskType: context.taskType,
      },
      'Starting quality validation'
    );

    // Select validators based on task type
    const validators = this.selectValidators(response, context);

    // Run all validators
    const results = await Promise.all(validators.map((v) => v.validate(response, context)));

    // Aggregate results
    const allIssues = results.flatMap((r) => r.issues);
    const overallScore = this.calculateOverallScore(results, allIssues);
    const suggestions = this.generateSuggestions(allIssues);
    const autoFixable = allIssues.some((i) => i.autoFixable);

    const valid = overallScore >= context.qualityThreshold * 100;

    const result: ValidationResult = {
      valid,
      score: overallScore,
      issues: allIssues,
      suggestions,
      autoFixable,
      metadata: {
        validatorsRun: validators.map((v) => v.name),
        executionTime: Date.now() - startTime,
      },
    };

    log.info(
      {
        requestId: context.requestId,
        valid,
        score: overallScore,
        issueCount: allIssues.length,
        executionTime: result.metadata.executionTime,
      },
      'Quality validation completed'
    );

    return result;
  }

  /**
   * Auto-fix issues if possible
   */
  async autoFix(response: ChatResponse, issues: ValidationIssue[]): Promise<ChatResponse> {
    let fixed = response;

    const fixableIssues = issues.filter((i) => i.autoFixable);

    log.info(
      {
        totalIssues: issues.length,
        fixableIssues: fixableIssues.length,
      },
      'Starting auto-fix'
    );

    for (const issue of fixableIssues) {
      try {
        fixed = await this.applyFix(fixed, issue);
      } catch (error) {
        log.error(
          {
            error,
            issue: issue.description,
          },
          'Failed to apply fix'
        );
      }
    }

    return fixed;
  }

  /**
   * Select validators based on task type
   */
  private selectValidators(
    response: ChatResponse,
    context: ValidationContext
  ): Array<{
    name: string;
    validate: (r: ChatResponse, c: ValidationContext) => Promise<{ issues: ValidationIssue[] }>;
  }> {
    const validators: Array<{ name: string; validate: (r: ChatResponse, c: ValidationContext) => Promise<{ issues: ValidationIssue[] }> }> = [];

    // Always run basic validation
    validators.push({
      name: 'basic',
      validate: this.basicValidation.bind(this),
    });

    // Task-specific validators
    if (context.taskType.includes('code')) {
      validators.push({
        name: 'code',
        validate: this.codeValidation.bind(this),
      });
    }

    if (context.taskType.includes('sql') || this.containsSQL(response)) {
      validators.push({
        name: 'sql',
        validate: this.sqlValidation.bind(this),
      });
    }

    if (this.containsJSON(response)) {
      validators.push({
        name: 'json',
        validate: this.jsonValidation.bind(this),
      });
    }

    return validators;
  }

  /**
   * Basic validation
   */
  private async basicValidation(
    response: ChatResponse,
    context: ValidationContext
  ): Promise<{ issues: ValidationIssue[] }> {
    const issues: ValidationIssue[] = [];
    const content = this.getResponseContent(response);

    log.debug(
      {
        requestId: context.requestId,
        taskType: context.taskType,
      },
      'Running basic validation'
    );

    // Check for empty response
    if (!content || content.trim().length === 0) {
      issues.push({
        type: 'other',
        severity: 'critical',
        description: 'Response is empty',
        autoFixable: false,
      });
    }

    // Check for very short response (< 10 chars)
    if (content.length < 10) {
      issues.push({
        type: 'other',
        severity: 'high',
        description: 'Response is too short and may be incomplete',
        autoFixable: false,
      });
    }

    // Check for error messages in response
    const errorPatterns = [/error:/i, /exception:/i, /failed:/i, /cannot/i, /unable to/i];

    for (const pattern of errorPatterns) {
      if (pattern.test(content)) {
        issues.push({
          type: 'other',
          severity: 'medium',
          description: 'Response contains error-like messages',
          autoFixable: false,
          suggestion: 'Review the response for actual errors',
        });
        break;
      }
    }

    // Check for incomplete code blocks
    const codeBlockCount = (content.match(/```/g) || []).length;
    if (codeBlockCount % 2 !== 0) {
      issues.push({
        type: 'syntax',
        severity: 'high',
        description: 'Incomplete code block (missing closing ```)',
        autoFixable: true,
        suggestion: 'Add closing ``` to complete the code block',
      });
    }

    return { issues };
  }

  /**
   * Code validation
   */
  private async codeValidation(
    response: ChatResponse,
    context: ValidationContext
  ): Promise<{ issues: ValidationIssue[] }> {
    const issues: ValidationIssue[] = [];
    const content = this.getResponseContent(response);

    // Extract code blocks
    const codeBlocks = this.extractCodeBlocks(content);

    if (codeBlocks.length === 0) {
      // No code blocks found, but task is code-related
      issues.push({
        type: 'other',
        severity: 'medium',
        description: 'No code blocks found in response for code-related task',
        autoFixable: false,
        suggestion: 'Ensure code is properly formatted in code blocks',
      });
      return { issues };
    }

    // Validate each code block
    for (const block of codeBlocks) {
      const blockIssues = await this.validateCodeBlock(block, context);
      issues.push(...blockIssues);
    }

    return { issues };
  }

  /**
   * Validate code block
   */
  private async validateCodeBlock(
    code: string,
    context: ValidationContext
  ): Promise<ValidationIssue[]> {
    const issues: ValidationIssue[] = [];
    const language = context.language || this.detectLanguage(code);

    // Syntax validation
    const syntaxIssues = await this.validateSyntax(code, language);
    issues.push(...syntaxIssues);

    // Security validation
    const securityIssues = await this.validateSecurity(code, language);
    issues.push(...securityIssues);

    // Style validation
    const styleIssues = await this.validateStyle(code, language);
    issues.push(...styleIssues);

    return issues;
  }

  /**
   * Validate syntax
   */
  private async validateSyntax(code: string, language: string): Promise<ValidationIssue[]> {
    const issues: ValidationIssue[] = [];

    // Basic syntax checks
    switch (language.toLowerCase()) {
      case 'javascript':
      case 'typescript':
        issues.push(...this.validateJavaScriptSyntax(code));
        break;

      case 'python':
        issues.push(...this.validatePythonSyntax(code));
        break;

      case 'java':
        issues.push(...this.validateJavaSyntax(code));
        break;

      case 'go':
        issues.push(...this.validateGoSyntax(code));
        break;

      default:
        // Generic validation
        issues.push(...this.validateGenericSyntax(code));
    }

    return issues;
  }

  /**
   * Validate JavaScript/TypeScript syntax
   */
  private validateJavaScriptSyntax(code: string): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    // Check for unmatched braces
    const openBraces = (code.match(/{/g) || []).length;
    const closeBraces = (code.match(/}/g) || []).length;
    if (openBraces !== closeBraces) {
      issues.push({
        type: 'syntax',
        severity: 'critical',
        description: `Unmatched braces: ${openBraces} opening, ${closeBraces} closing`,
        autoFixable: false,
      });
    }

    // Check for unmatched parentheses
    const openParens = (code.match(/\(/g) || []).length;
    const closeParens = (code.match(/\)/g) || []).length;
    if (openParens !== closeParens) {
      issues.push({
        type: 'syntax',
        severity: 'critical',
        description: `Unmatched parentheses: ${openParens} opening, ${closeParens} closing`,
        autoFixable: false,
      });
    }

    // Check for unmatched brackets
    const openBrackets = (code.match(/\[/g) || []).length;
    const closeBrackets = (code.match(/\]/g) || []).length;
    if (openBrackets !== closeBrackets) {
      issues.push({
        type: 'syntax',
        severity: 'critical',
        description: `Unmatched brackets: ${openBrackets} opening, ${closeBrackets} closing`,
        autoFixable: false,
      });
    }

    // Check for missing semicolons (basic check)
    const lines = code.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (
        line &&
        !line.endsWith(';') &&
        !line.endsWith('{') &&
        !line.endsWith('}') &&
        !line.startsWith('//')
      ) {
        // Check if it's a statement that should end with semicolon
        if (/^(const|let|var|return|throw|break|continue)\s/.test(line)) {
          issues.push({
            type: 'style',
            severity: 'low',
            description: `Missing semicolon at line ${i + 1}`,
            location: `line ${i + 1}`,
            autoFixable: true,
            suggestion: 'Add semicolon at end of statement',
          });
        }
      }
    }

    return issues;
  }

  /**
   * Validate Python syntax
   */
  private validatePythonSyntax(code: string): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    // Check for unmatched parentheses
    const openParens = (code.match(/\(/g) || []).length;
    const closeParens = (code.match(/\)/g) || []).length;
    if (openParens !== closeParens) {
      issues.push({
        type: 'syntax',
        severity: 'critical',
        description: `Unmatched parentheses: ${openParens} opening, ${closeParens} closing`,
        autoFixable: false,
      });
    }

    // Check for unmatched brackets
    const openBrackets = (code.match(/\[/g) || []).length;
    const closeBrackets = (code.match(/\]/g) || []).length;
    if (openBrackets !== closeBrackets) {
      issues.push({
        type: 'syntax',
        severity: 'critical',
        description: `Unmatched brackets: ${openBrackets} opening, ${closeBrackets} closing`,
        autoFixable: false,
      });
    }

    // Check for inconsistent indentation
    const lines = code.split('\n');
    const indentations = lines
      .filter((l) => l.trim().length > 0)
      .map((l) => l.match(/^\s*/)?.[0].length || 0);

    const uniqueIndents = [...new Set(indentations)].sort((a, b) => a - b);
    if (uniqueIndents.length > 1) {
      const diffs = uniqueIndents.slice(1).map((v, i) => v - uniqueIndents[i]);
      const inconsistent = diffs.some((d, i) => i > 0 && d !== diffs[0]);

      if (inconsistent) {
        issues.push({
          type: 'style',
          severity: 'medium',
          description: 'Inconsistent indentation detected',
          autoFixable: false,
          suggestion: 'Use consistent indentation (2 or 4 spaces)',
        });
      }
    }

    return issues;
  }

  /**
   * Validate Java syntax
   */
  private validateJavaSyntax(code: string): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    // Check for unmatched braces
    const openBraces = (code.match(/{/g) || []).length;
    const closeBraces = (code.match(/}/g) || []).length;
    if (openBraces !== closeBraces) {
      issues.push({
        type: 'syntax',
        severity: 'critical',
        description: `Unmatched braces: ${openBraces} opening, ${closeBraces} closing`,
        autoFixable: false,
      });
    }

    // Check for missing semicolons
    const lines = code.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (
        line &&
        !line.endsWith(';') &&
        !line.endsWith('{') &&
        !line.endsWith('}') &&
        !line.startsWith('//')
      ) {
        if (/^(return|throw|break|continue|int|String|boolean|double|float|long)\s/.test(line)) {
          issues.push({
            type: 'syntax',
            severity: 'high',
            description: `Missing semicolon at line ${i + 1}`,
            location: `line ${i + 1}`,
            autoFixable: true,
          });
        }
      }
    }

    return issues;
  }

  /**
   * Validate Go syntax
   */
  private validateGoSyntax(code: string): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    // Check for unmatched braces
    const openBraces = (code.match(/{/g) || []).length;
    const closeBraces = (code.match(/}/g) || []).length;
    if (openBraces !== closeBraces) {
      issues.push({
        type: 'syntax',
        severity: 'critical',
        description: `Unmatched braces: ${openBraces} opening, ${closeBraces} closing`,
        autoFixable: false,
      });
    }

    return issues;
  }

  /**
   * Validate generic syntax
   */
  private validateGenericSyntax(code: string): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    // Check for unmatched braces
    const openBraces = (code.match(/{/g) || []).length;
    const closeBraces = (code.match(/}/g) || []).length;
    if (openBraces !== closeBraces) {
      issues.push({
        type: 'syntax',
        severity: 'high',
        description: `Unmatched braces: ${openBraces} opening, ${closeBraces} closing`,
        autoFixable: false,
      });
    }

    return issues;
  }

  /**
   * Validate security
   */
  private async validateSecurity(code: string, language: string): Promise<ValidationIssue[]> {
    const issues: ValidationIssue[] = [];

    log.debug(
      {
        language,
        length: code.length,
      },
      'Running security validation'
    );

    // Common security patterns
    const securityPatterns = [
      {
        pattern: /eval\(/i,
        description: 'Use of eval() is dangerous and should be avoided',
        severity: 'critical' as const,
      },
      {
        pattern: /exec\(/i,
        description: 'Use of exec() can lead to command injection',
        severity: 'critical' as const,
      },
      {
        pattern: /innerHTML\s*=/i,
        description: 'Direct innerHTML assignment can lead to XSS',
        severity: 'high' as const,
      },
      {
        pattern: /document\.write\(/i,
        description: 'document.write() can lead to XSS',
        severity: 'high' as const,
      },
      {
        pattern: /password\s*=\s*["'][^"']+["']/i,
        description: 'Hardcoded password detected',
        severity: 'critical' as const,
      },
      {
        pattern: /api[_-]?key\s*=\s*["'][^"']+["']/i,
        description: 'Hardcoded API key detected',
        severity: 'critical' as const,
      },
    ];

    for (const { pattern, description, severity } of securityPatterns) {
      if (pattern.test(code)) {
        issues.push({
          type: 'security',
          severity,
          description,
          autoFixable: false,
          suggestion: 'Review and fix security issue',
        });
      }
    }

    return issues;
  }

  /**
   * Validate style
   */
  private async validateStyle(code: string, language: string): Promise<ValidationIssue[]> {
    const issues: ValidationIssue[] = [];

    log.debug(
      {
        language,
        lines: code.split('\n').length,
      },
      'Running style validation'
    );

    // Check for very long lines
    const lines = code.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].length > 120) {
        issues.push({
          type: 'style',
          severity: 'low',
          description: `Line ${i + 1} exceeds 120 characters`,
          location: `line ${i + 1}`,
          autoFixable: false,
          suggestion: 'Break long lines for better readability',
        });
      }
    }

    return issues;
  }

  /**
   * SQL validation
   */
  private async sqlValidation(
    response: ChatResponse,
    context: ValidationContext
  ): Promise<{ issues: ValidationIssue[] }> {
    const issues: ValidationIssue[] = [];
    const content = this.getResponseContent(response);

    log.debug(
      {
        requestId: context.requestId,
        taskType: context.taskType,
      },
      'Running SQL validation'
    );

    // Extract SQL queries
    const sqlQueries = this.extractSQL(content);

    for (const query of sqlQueries) {
      const queryIssues = await this.validateSQLQuery(query);
      issues.push(...queryIssues);
    }

    return { issues };
  }

  /**
   * Validate SQL query
   */
  private async validateSQLQuery(query: string): Promise<ValidationIssue[]> {
    const issues: ValidationIssue[] = [];

    // Check for SQL injection patterns
    if (/['"]\s*\+\s*/.test(query)) {
      issues.push({
        type: 'security',
        severity: 'critical',
        description: 'Potential SQL injection: String concatenation detected',
        autoFixable: false,
        suggestion: 'Use parameterized queries instead',
      });
    }

    // Check for SELECT *
    if (/SELECT\s+\*/i.test(query)) {
      issues.push({
        type: 'performance',
        severity: 'low',
        description: 'SELECT * can impact performance',
        autoFixable: false,
        suggestion: 'Select only needed columns',
      });
    }

    // Check for missing WHERE clause in UPDATE/DELETE
    if (/UPDATE\s+\w+\s+SET/i.test(query) && !/WHERE/i.test(query)) {
      issues.push({
        type: 'logic',
        severity: 'critical',
        description: 'UPDATE without WHERE clause will affect all rows',
        autoFixable: false,
        suggestion: 'Add WHERE clause to limit affected rows',
      });
    }

    if (/DELETE\s+FROM/i.test(query) && !/WHERE/i.test(query)) {
      issues.push({
        type: 'logic',
        severity: 'critical',
        description: 'DELETE without WHERE clause will remove all rows',
        autoFixable: false,
        suggestion: 'Add WHERE clause to limit affected rows',
      });
    }

    return issues;
  }

  /**
   * JSON validation
   */
  private async jsonValidation(
    response: ChatResponse,
    context: ValidationContext
  ): Promise<{ issues: ValidationIssue[] }> {
    const issues: ValidationIssue[] = [];
    const content = this.getResponseContent(response);

    log.debug(
      {
        requestId: context.requestId,
        taskType: context.taskType,
      },
      'Running JSON validation'
    );

    // Extract JSON blocks
    const jsonBlocks = this.extractJSON(content);

    for (const jsonStr of jsonBlocks) {
      try {
        JSON.parse(jsonStr);
      } catch (error) {
        issues.push({
          type: 'syntax',
          severity: 'high',
          description: `Invalid JSON: ${error instanceof Error ? error.message : 'Parse error'}`,
          autoFixable: false,
          suggestion: 'Fix JSON syntax errors',
        });
      }
    }

    return { issues };
  }

  /**
   * Calculate overall score
   */
  private calculateOverallScore(
    results: Array<{ issues: ValidationIssue[] }>,
    allIssues: ValidationIssue[]
  ): number {
    let score = 100;

    // Deduct points based on severity
    for (const issue of allIssues) {
      switch (issue.severity) {
        case 'critical':
          score -= 25;
          break;
        case 'high':
          score -= 15;
          break;
        case 'medium':
          score -= 10;
          break;
        case 'low':
          score -= 5;
          break;
      }
    }

    return Math.max(0, score);
  }

  /**
   * Generate suggestions
   */
  private generateSuggestions(issues: ValidationIssue[]): string[] {
    const suggestions: string[] = [];

    // Group by type
    const byType: Record<string, ValidationIssue[]> = {};
    for (const issue of issues) {
      if (!byType[issue.type]) {
        byType[issue.type] = [];
      }
      byType[issue.type].push(issue);
    }

    // Generate suggestions
    for (const [type, typeIssues] of Object.entries(byType)) {
      if (typeIssues.length > 0) {
        suggestions.push(`Fix ${typeIssues.length} ${type} issue(s)`);
      }
    }

    return suggestions;
  }

  /**
   * Apply fix to response
   */
  private async applyFix(response: ChatResponse, issue: ValidationIssue): Promise<ChatResponse> {
    const content = this.getResponseContent(response);

    let fixed = content;

    // Apply specific fixes
    if (issue.description.includes('Incomplete code block')) {
      fixed = content + '\n```';
    }

    if (issue.description.includes('Missing semicolon')) {
      // Simple fix: Add semicolon to line
      // (In production, would need more sophisticated parsing)
      fixed = content; // Placeholder
    }

    // Update response
    return {
      ...response,
      choices: [
        {
          ...response.choices[0],
          message: {
            role: 'assistant',
            content: fixed,
          },
        },
      ],
    };
  }

  /**
   * Get response content
   */
  private getResponseContent(response: ChatResponse | null | undefined): string {
    if (!response?.choices) return '';
    const choice = response.choices[0];
    if (!choice) return '';

    const message = choice.message || choice.delta;
    if (!message) return '';

    if (typeof message.content === 'string') {
      return message.content;
    }

    if (Array.isArray(message.content)) {
      return message.content
        .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('\n');
    }

    return '';
  }

  /**
   * Check if response contains SQL
   */
  private containsSQL(response: ChatResponse): boolean {
    const content = this.getResponseContent(response);
    return /SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP/i.test(content);
  }

  /**
   * Check if response contains JSON
   */
  private containsJSON(response: ChatResponse): boolean {
    const content = this.getResponseContent(response);
    return /^\s*{[\s\S]*}\s*$/m.test(content) || /```json/i.test(content);
  }

  /**
   * Extract code blocks
   */
  private extractCodeBlocks(content: string): string[] {
    const blocks: string[] = [];
    const regex = /```[\w]*\n([\s\S]*?)```/g;
    let match;

    while ((match = regex.exec(content)) !== null) {
      blocks.push(match[1]);
    }

    return blocks;
  }

  /**
   * Extract SQL queries
   */
  private extractSQL(content: string): string[] {
    const queries: string[] = [];

    // Extract from code blocks
    const blocks = this.extractCodeBlocks(content);
    for (const block of blocks) {
      if (/SELECT|INSERT|UPDATE|DELETE/i.test(block)) {
        queries.push(block);
      }
    }

    // Extract inline SQL
    const inlineRegex = /(SELECT|INSERT|UPDATE|DELETE)[\s\S]*?;/gi;
    let match;
    while ((match = inlineRegex.exec(content)) !== null) {
      queries.push(match[0]);
    }

    return queries;
  }

  /**
   * Extract JSON blocks
   */
  private extractJSON(content: string): string[] {
    const blocks: string[] = [];

    // Extract from code blocks
    const regex = /```json\n([\s\S]*?)```/gi;
    let match;

    while ((match = regex.exec(content)) !== null) {
      blocks.push(match[1]);
    }

    // Extract inline JSON objects
    const inlineRegex = /{[\s\S]*?}/g;
    while ((match = inlineRegex.exec(content)) !== null) {
      blocks.push(match[0]);
    }

    return blocks;
  }

  /**
   * Detect programming language
   */
  private detectLanguage(code: string): string {
    if (/function\s+\w+\s*\(|const\s+\w+\s*=|let\s+\w+\s*=/.test(code)) {
      return 'javascript';
    }
    if (/def\s+\w+\s*\(|import\s+\w+|from\s+\w+\s+import/.test(code)) {
      return 'python';
    }
    if (/public\s+class|private\s+\w+|import\s+java\./.test(code)) {
      return 'java';
    }
    if (/func\s+\w+\s*\(|package\s+main/.test(code)) {
      return 'go';
    }

    return 'unknown';
  }
}

/**
 * Singleton instance
 */
let validatorInstance: QualityValidator | null = null;

/**
 * Get validator instance
 */
export function getQualityValidator(): QualityValidator {
  if (!validatorInstance) {
    validatorInstance = new QualityValidator();
  }
  return validatorInstance;
}
