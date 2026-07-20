// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Input Sanitizers (v5.0)
 *
 * Enterprise-grade input sanitization to prevent OWASP Top 10:
 * - A03:2021 – Injection (SQL, NoSQL, Command, LDAP)
 * - A01:2021 – Broken Access Control
 * - XSS attacks
 * - Path traversal
 * - Prototype pollution
 *
 * All sanitizers are defense-in-depth (used WITH schema validation, not instead)
 */

import { logger } from './logger.js';

// ============================================
// 1. HTML/XSS Sanitization
// ============================================

// Enhanced XSS protection: Remove dangerous protocols and event handlers (case-insensitive)
const JAVASCRIPT_PROTOCOL = /javascript\s*:/gi;
const DANGEROUS_EVENT_HANDLERS = /\bon\w+\s*=/gi; // onerror=, onload=, onclick=, etc.
const HTML_DANGEROUS_TAGS = /<script|<iframe|<object|<embed|<applet/gi;
const HTML_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#x27;',
  '/': '&#x2F;',
};

/**
 * Sanitize HTML to prevent XSS attacks
 *
 * Strategy:
 * - Strip dangerous tags (script, iframe, etc)
 * - Escape HTML entities
 * - Remove javascript: protocols
 */
export function sanitizeHTML(input: string): string {
  if (typeof input !== 'string') return String(input);

  // 1. Remove javascript: protocol (case-insensitive, handles variations)
  let sanitized = input.replace(JAVASCRIPT_PROTOCOL, '');

  // 2. Remove dangerous event handlers (onerror=, onload=, onclick=, etc.)
  sanitized = sanitized.replace(DANGEROUS_EVENT_HANDLERS, '');

  // 3. Remove dangerous HTML tags
  sanitized = sanitized.replace(HTML_DANGEROUS_TAGS, '');

  // 4. Escape HTML entities
  sanitized = sanitized.replace(/[&<>"'\/]/g, (char) => HTML_ENTITIES[char] || char);

  return sanitized;
}

/**
 * Strip ALL HTML tags (aggressive)
 */
export function stripHTML(input: string): string {
  if (typeof input !== 'string') return String(input);

  return input.replace(/<[^>]*>/g, '');
}

// ============================================
// 2. SQL Injection Prevention
// ============================================

const SQL_KEYWORDS =
  /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|EXEC|EXECUTE|UNION|OR|AND)\b)/gi;
const SQL_DANGEROUS_CHARS = /['";\\#-]/g;

/**
 * Sanitize input to prevent SQL injection
 *
 * NOTE: Prisma uses parameterized queries (safe by default)
 * This is an EXTRA layer of defense for raw queries
 */
export function sanitizeSQL(input: string): string {
  if (typeof input !== 'string') return String(input);

  // 1. Escape dangerous characters
  let sanitized = input.replace(SQL_DANGEROUS_CHARS, '');

  // 2. Log suspicious patterns (don't remove - might be legitimate)
  if (SQL_KEYWORDS.test(input)) {
    logger.warn(
      {
        input: input.substring(0, 100),
        pattern: 'SQL_KEYWORDS',
      },
      'Suspicious SQL pattern detected in input'
    );
  }

  return sanitized;
}

// ============================================
// 3. Command Injection Prevention
// ============================================

const COMMAND_DANGEROUS_CHARS = /[;&|`$(){}[\]<>]/g;
const SHELL_METACHARACTERS = /[\n\r\t]/g;

/**
 * Sanitize input to prevent command injection
 *
 * Removes shell metacharacters and dangerous operators
 */
export function sanitizeCommand(input: string): string {
  if (typeof input !== 'string') return String(input);

  // Remove shell metacharacters
  let sanitized = input.replace(COMMAND_DANGEROUS_CHARS, '');
  sanitized = sanitized.replace(SHELL_METACHARACTERS, '');

  return sanitized;
}

/**
 * Validate command argument against whitelist
 */
export function validateCommandArg(
  input: string,
  allowedChars: RegExp = /^[a-zA-Z0-9\-_.]+$/
): boolean {
  return allowedChars.test(input);
}

// ============================================
// 4. Path Traversal Prevention
// ============================================

/**
 * Sanitize file path to prevent traversal attacks
 *
 * Removes:
 * - ../ (directory traversal)
 * - Absolute paths
 * - Null bytes
 * - Windows drive letters
 */
export function sanitizeFilePath(input: string): string {
  if (typeof input !== 'string') return String(input);

  // 1. Remove null bytes
  let sanitized = input.replace(/\0/g, '');

  // 2. Remove ../ and ..\
  sanitized = sanitized.replace(/\.\.[/\\]/g, '');

  // 3. Remove leading / or \ (no absolute paths)
  sanitized = sanitized.replace(/^[/\\]+/, '');

  // 4. Remove Windows drive letters (C:\)
  sanitized = sanitized.replace(/^[a-zA-Z]:[/\\]/, '');

  // 5. Normalize separators
  sanitized = sanitized.replace(/[\\]/g, '/');

  // 6. Remove multiple slashes
  sanitized = sanitized.replace(/\/+/g, '/');

  return sanitized;
}

/**
 * Validate path is within allowed base directory
 */
export function validatePathWithinBase(path: string, baseDir: string): boolean {
  const sanitizedPath = sanitizeFilePath(path);
  const fullPath = `${baseDir}/${sanitizedPath}`;

  // Check it doesn't escape base directory
  const normalized = fullPath.replace(/\/+/g, '/');
  return normalized.startsWith(baseDir);
}

// ============================================
// 5. Prototype Pollution Prevention
// ============================================

const DANGEROUS_KEYS = ['__proto__', 'constructor', 'prototype'];

/**
 * Remove dangerous keys that could cause prototype pollution
 */
export function sanitizeObject(obj: unknown, maxDepth: number = 10): unknown {
  if (maxDepth <= 0) {
    logger.warn('Max object depth reached, truncating');
    return {};
  }

  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeObject(item, maxDepth - 1));
  }

  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    // Skip dangerous keys
    if (DANGEROUS_KEYS.includes(key.toLowerCase())) {
      logger.warn({ key }, 'Dangerous key removed (prototype pollution prevention)');
      continue;
    }

    // Recursively sanitize nested objects
    sanitized[key] = typeof value === 'object' ? sanitizeObject(value, maxDepth - 1) : value;
  }

  return sanitized;
}

// ============================================
// 6. Unicode Normalization
// ============================================

/**
 * Normalize Unicode to prevent homograph/confusable attacks
 *
 * Example: "аdmin" (Cyrillic 'a') → "admin" (Latin 'a') or rejected
 */
export function normalizeUnicode(input: string): string {
  if (typeof input !== 'string') return String(input);

  // NFC normalization (Canonical Decomposition + Canonical Composition)
  const normalized = input.normalize('NFC');

  // Remove zero-width characters (invisible characters)
  const cleaned = normalized.replace(/[\u200B-\u200D\uFEFF]/g, '');

  return cleaned;
}

/**
 * Detect dangerous Unicode (homograph attacks)
 */
export function detectDangerousUnicode(input: string): boolean {
  // Detect mixed scripts (Latin + Cyrillic)
  const hasCyrillic = /[\u0400-\u04FF]/.test(input);
  const hasLatin = /[a-zA-Z]/.test(input);

  if (hasCyrillic && hasLatin) {
    return true; // Mixed scripts (suspicious)
  }

  // Detect zero-width characters
  if (/[\u200B-\u200D\uFEFF]/.test(input)) {
    return true;
  }

  return false;
}

// ============================================
// 7. Whitespace Normalization
// ============================================

/**
 * Normalize whitespace
 * - Trim leading/trailing
 * - Collapse multiple spaces
 * - Remove control characters
 */
export function normalizeWhitespace(input: string): string {
  if (typeof input !== 'string') return String(input);

  // 1. Remove control characters (except \n, \r, \t)
  let normalized = input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  normalized = normalized.replace(/\x7F/g, ''); // DEL character

  // 2. Normalize line endings
  normalized = normalized.replace(/\r\n/g, '\n');

  // 3. Collapse multiple spaces
  normalized = normalized.replace(/  +/g, ' ');

  // 4. Trim
  normalized = normalized.trim();

  return normalized;
}

// ============================================
// 8. Email Sanitization
// ============================================

const EMAIL_PATTERN =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

/**
 * Sanitize and validate email address
 */
export function sanitizeEmail(email: string): string {
  if (typeof email !== 'string') throw new Error('Email must be a string');

  // 1. Trim and lowercase
  let sanitized = email.trim().toLowerCase();

  // 2. Remove comments (RFC 5322 - not commonly used, remove for security)
  sanitized = sanitized.replace(/\(.*?\)/g, '');

  // 3. Max length (RFC 5321)
  if (sanitized.length > 320) {
    throw new Error('Email too long (max 320 chars)');
  }

  // 4. Validate pattern
  if (!EMAIL_PATTERN.test(sanitized)) {
    throw new Error('Invalid email format');
  }

  return sanitized;
}

// ============================================
// 9. URL Sanitization
// ============================================

/**
 * Sanitize and validate URL to prevent SSRF
 */
export function sanitizeURL(
  url: string,
  options?: {
    allowedProtocols?: string[];
    blockPrivateIPs?: boolean;
    blockLocalhost?: boolean;
    domainWhitelist?: string[];
  }
): string {
  if (typeof url !== 'string') throw new Error('URL must be a string');

  const opts = {
    allowedProtocols: options?.allowedProtocols || ['http', 'https'],
    blockPrivateIPs: options?.blockPrivateIPs ?? true,
    blockLocalhost: options?.blockLocalhost ?? true,
    domainWhitelist: options?.domainWhitelist || [],
  };

  // 1. Trim
  const sanitized = url.trim();

  // 2. Max length
  if (sanitized.length > 2048) {
    throw new Error('URL too long (max 2048 chars)');
  }

  // 3. Parse URL
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(sanitized);
  } catch {
    throw new Error('Invalid URL format');
  }

  // 4. Validate protocol
  if (!opts.allowedProtocols.includes(parsedUrl.protocol.replace(':', ''))) {
    throw new Error(`Protocol not allowed: ${parsedUrl.protocol}`);
  }

  // 5. Block localhost (SSRF prevention)
  if (opts.blockLocalhost) {
    const hostname = parsedUrl.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
      throw new Error('Localhost URLs not allowed (SSRF prevention)');
    }
  }

  // 6. Block private IPs (SSRF prevention)
  if (opts.blockPrivateIPs) {
    if (isPrivateIP(parsedUrl.hostname)) {
      throw new Error('Private IP addresses not allowed (SSRF prevention)');
    }
  }

  // 7. Domain whitelist
  if (opts.domainWhitelist.length > 0) {
    const hostname = parsedUrl.hostname.toLowerCase();
    const isAllowed = opts.domainWhitelist.some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
    );

    if (!isAllowed) {
      throw new Error(`Domain not in whitelist: ${hostname}`);
    }
  }

  return parsedUrl.href;
}

/**
 * Check if hostname is a private IP
 */
function isPrivateIP(hostname: string): boolean {
  // IPv4 private ranges
  const privateRanges = [
    /^10\./, // 10.0.0.0/8
    /^172\.(1[6-9]|2[0-9]|3[01])\./, // 172.16.0.0/12
    /^192\.168\./, // 192.168.0.0/16
    /^169\.254\./, // 169.254.0.0/16 (link-local)
  ];

  return privateRanges.some((range) => range.test(hostname));
}

// ============================================
// 10. Phone Number Sanitization
// ============================================

/**
 * Sanitize phone number (E.164 format)
 */
export function sanitizePhoneNumber(phone: string): string {
  if (typeof phone !== 'string') throw new Error('Phone must be a string');

  // Remove all non-digit characters
  const digits = phone.replace(/\D/g, '');

  // Validate length (E.164: max 15 digits)
  if (digits.length < 10 || digits.length > 15) {
    throw new Error('Invalid phone number length');
  }

  // Return with + prefix (E.164)
  return `+${digits}`;
}

// ============================================
// Generic Sanitizer
// ============================================

export interface SanitizeOptions {
  stripHTML?: boolean;
  escapeSQL?: boolean;
  normalizeUnicode?: boolean;
  normalizeWhitespace?: boolean;
  maxLength?: number;
  allowedChars?: RegExp;
}

/**
 * Generic sanitizer with multiple options
 */
export function sanitizeInput(input: string, options: SanitizeOptions = {}): string {
  if (typeof input !== 'string') return String(input);

  let sanitized = input;

  // Max length check (first, for performance)
  if (options.maxLength && sanitized.length > options.maxLength) {
    sanitized = sanitized.substring(0, options.maxLength);
    logger.warn(
      {
        originalLength: input.length,
        maxLength: options.maxLength,
      },
      'Input truncated to max length'
    );
  }

  // Unicode normalization
  if (options.normalizeUnicode !== false) {
    sanitized = normalizeUnicode(sanitized);
  }

  // Whitespace normalization
  if (options.normalizeWhitespace !== false) {
    sanitized = normalizeWhitespace(sanitized);
  }

  // HTML stripping
  if (options.stripHTML) {
    sanitized = stripHTML(sanitized);
  }

  // SQL escaping
  if (options.escapeSQL) {
    sanitized = sanitizeSQL(sanitized);
  }

  // Allowed chars validation
  if (options.allowedChars && !options.allowedChars.test(sanitized)) {
    throw new Error('Input contains disallowed characters');
  }

  return sanitized;
}

/**
 * Maximum depth for sanitization to prevent stack overflow
 * OWASP recommends limiting nested structures to prevent DoS attacks
 */
const MAX_SANITIZATION_DEPTH = 50;

/**
 * Sanitize entire request body with depth limit to prevent stack overflow
 */
export function sanitizeRequestBody(body: unknown, options: SanitizeOptions = {}): unknown {
  if (body === null || body === undefined) return body;

  // Prevent prototype pollution
  const sanitizedObj = sanitizeObject(body);

  // Recursively sanitize string values with depth limit
  return deepSanitize(sanitizedObj, options, 0);
}

/**
 * Recursively sanitize values with depth limit to prevent stack overflow
 * 
 * @param obj - Object to sanitize
 * @param options - Sanitization options
 * @param depth - Current recursion depth (internal use)
 * @returns Sanitized object
 */
function deepSanitize(obj: unknown, options: SanitizeOptions, depth: number = 0): unknown {
  // Prevent stack overflow from deeply nested structures
  if (depth > MAX_SANITIZATION_DEPTH) {
    throw new Error(
      `Maximum sanitization depth exceeded (${MAX_SANITIZATION_DEPTH}). This may indicate a malicious payload.`
    );
  }

  if (obj === null || obj === undefined) return obj;

  if (typeof obj === 'string') {
    return sanitizeInput(obj, options);
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => deepSanitize(item, options, depth + 1));
  }

  if (typeof obj === 'object' && obj !== null) {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      sanitized[key] = deepSanitize(value, options, depth + 1);
    }
    return sanitized;
  }

  return obj;
}

// ============================================
// Exports
// ============================================

export const Sanitizers = {
  html: sanitizeHTML,
  stripHTML,
  sql: sanitizeSQL,
  command: sanitizeCommand,
  filePath: sanitizeFilePath,
  object: sanitizeObject,
  unicode: normalizeUnicode,
  whitespace: normalizeWhitespace,
  email: sanitizeEmail,
  url: sanitizeURL,
  phoneNumber: sanitizePhoneNumber,
  generic: sanitizeInput,
  requestBody: sanitizeRequestBody,
};
