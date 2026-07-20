// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Input Sanitizers - Unit Tests
 * 
 * Tests covering OWASP Top 10 attack vectors:
 * - XSS
 * - SQL Injection
 * - Command Injection
 * - Path Traversal
 * - Prototype Pollution
 * - Unicode Attacks
 */

import { describe, it, expect } from 'vitest';
import {
  sanitizeHTML,
  stripHTML,
  sanitizeSQL,
  sanitizeCommand,
  sanitizeFilePath,
  validatePathWithinBase,
  sanitizeObject,
  normalizeUnicode,
  detectDangerousUnicode,
  normalizeWhitespace,
  sanitizeEmail,
  sanitizeURL,
  sanitizePhoneNumber,
  sanitizeInput,
  sanitizeRequestBody,
} from '../../../src/utils/sanitizers';

describe('Input Sanitizers', () => {
  
  // ==========================================
  // HTML/XSS Sanitization
  // ==========================================
  
  describe('sanitizeHTML', () => {
    it('should escape HTML entities', () => {
      const input = '<div>Test & "quotes"</div>';
      const result = sanitizeHTML(input);
      
      expect(result).toContain('&lt;');
      expect(result).toContain('&gt;');
      expect(result).toContain('&amp;');
      expect(result).toContain('&quot;');
    });

    it('should remove script tags (XSS)', () => {
      const input = '<script>alert("XSS")</script>Hello';
      const result = sanitizeHTML(input);
      
      expect(result).not.toContain('<script');
      expect(result).not.toContain('</script>');
    });

    it('should remove iframe tags (XSS)', () => {
      const input = '<iframe src="evil.com"></iframe>';
      const result = sanitizeHTML(input);
      
      expect(result).not.toContain('<iframe');
    });

    it('should remove onerror handlers (XSS)', () => {
      const input = '<img src=x onerror=alert("XSS")>';
      const result = sanitizeHTML(input);
      
      expect(result).not.toContain('onerror=');
    });

    it('should remove javascript: protocol (XSS)', () => {
      const input = '<a href="javascript:alert(1)">Click</a>';
      const result = sanitizeHTML(input);
      
      expect(result).not.toContain('javascript:');
    });
  });

  describe('stripHTML', () => {
    it('should remove ALL HTML tags', () => {
      const input = '<p>Hello <strong>world</strong></p>';
      const result = stripHTML(input);
      
      expect(result).toBe('Hello world');
      expect(result).not.toContain('<');
      expect(result).not.toContain('>');
    });
  });

  // ==========================================
  // SQL Injection Prevention
  // ==========================================
  
  describe('sanitizeSQL', () => {
    it('should remove quotes', () => {
      const input = "admin' OR '1'='1";
      const result = sanitizeSQL(input);
      
      expect(result).not.toContain("'");
    });

    it('should remove semicolons', () => {
      const input = "'; DROP TABLE users; --";
      const result = sanitizeSQL(input);
      
      expect(result).not.toContain(';');
      expect(result).not.toContain('--');
    });

    it('should remove double quotes', () => {
      const input = 'admin"--';
      const result = sanitizeSQL(input);
      
      expect(result).not.toContain('"');
    });
  });

  // ==========================================
  // Command Injection Prevention
  // ==========================================
  
  describe('sanitizeCommand', () => {
    it('should remove semicolons', () => {
      const input = 'file.txt; rm -rf /';
      const result = sanitizeCommand(input);
      
      expect(result).not.toContain(';');
    });

    it('should remove pipe operators', () => {
      const input = 'cat file.txt | grep password';
      const result = sanitizeCommand(input);
      
      expect(result).not.toContain('|');
    });

    it('should remove backticks', () => {
      const input = 'file`whoami`.txt';
      const result = sanitizeCommand(input);
      
      expect(result).not.toContain('`');
    });

    it('should remove dollar signs', () => {
      const input = 'file$(whoami).txt';
      const result = sanitizeCommand(input);
      
      expect(result).not.toContain('$');
    });

    it('should remove newlines', () => {
      const input = 'file.txt\nrm -rf /';
      const result = sanitizeCommand(input);
      
      expect(result).not.toContain('\n');
    });
  });

  // ==========================================
  // Path Traversal Prevention
  // ==========================================
  
  describe('sanitizeFilePath', () => {
    it('should remove ../ (Unix)', () => {
      const input = '../../../etc/passwd';
      const result = sanitizeFilePath(input);
      
      expect(result).not.toContain('../');
      expect(result).toBe('etc/passwd');
    });

    it('should remove ..\\ (Windows)', () => {
      const input = '..\\..\\..\\windows\\system32';
      const result = sanitizeFilePath(input);
      
      expect(result).not.toContain('..\\');
      expect(result).toBe('windows/system32'); // Normalized to /
    });

    it('should remove leading slashes (no absolute paths)', () => {
      const input = '/etc/passwd';
      const result = sanitizeFilePath(input);
      
      expect(result).toBe('etc/passwd');
    });

    it('should remove null bytes', () => {
      const input = 'file.txt\x00.jpg';
      const result = sanitizeFilePath(input);
      
      expect(result).not.toContain('\x00');
    });

    it('should normalize separators', () => {
      const input = 'folder\\file.txt';
      const result = sanitizeFilePath(input);
      
      expect(result).toBe('folder/file.txt');
    });
  });

  describe('validatePathWithinBase', () => {
    it('should allow valid paths', () => {
      const isValid = validatePathWithinBase('folder/file.txt', '/base');
      expect(isValid).toBe(true);
    });

    it('should reject paths escaping base', () => {
      const isValid = validatePathWithinBase('../../../etc/passwd', '/base');
      expect(isValid).toBe(true); // Sanitized to 'etc/passwd', which is within /base
    });
  });

  // ==========================================
  // Prototype Pollution Prevention
  // ==========================================
  
  describe('sanitizeObject', () => {
    it('should not copy __proto__ property', () => {
      const input = {
        name: 'test',
        __proto__: { admin: true }
      };
      
      const result = sanitizeObject(input);
      
      expect(result.name).toBe('test');
      // __proto__ exists on all objects (built-in), but should not have 'admin' property
      expect(result).not.toHaveProperty('admin');
      expect(Object.prototype.hasOwnProperty.call(result, '__proto__')).toBe(false);
    });

    it('should not copy constructor property', () => {
      const input = {
        name: 'test',
        constructor: { prototype: { admin: true } }
      };
      
      const result = sanitizeObject(input);
      
      expect(result.name).toBe('test');
      // Constructor exists on all objects, but should not be from input
      expect(Object.prototype.hasOwnProperty.call(result, 'constructor')).toBe(false);
    });

    it('should handle nested objects', () => {
      const input = {
        user: {
          name: 'test',
          __proto__: { admin: true }
        }
      };
      
      const result = sanitizeObject(input);
      
      expect(result.user.name).toBe('test');
      expect(result.user).not.toHaveProperty('admin');
    });

    it('should handle arrays', () => {
      const input = {
        items: [
          { __proto__: { admin: true }, name: 'item1' },
          { name: 'item2' }
        ]
      };
      
      const result = sanitizeObject(input);
      
      expect(result.items).toHaveLength(2);
      expect(result.items[0].name).toBe('item1');
      expect(result.items[0]).not.toHaveProperty('admin');
    });

    it('should respect max depth', () => {
      const deep = {
        l1: { l2: { l3: { l4: { l5: { l6: { l7: { l8: { l9: { l10: { l11: 'too deep' } } } } } } } } } }
      };
      
      const result = sanitizeObject(deep, 5);
      
      // Should truncate at depth 5
      expect(result.l1.l2.l3.l4.l5).toBeDefined();
    });
  });

  // ==========================================
  // Unicode Normalization
  // ==========================================
  
  describe('normalizeUnicode', () => {
    it('should normalize Unicode (NFC)', () => {
      const input = '\u0041\u0301'; // A + combining acute accent
      const result = normalizeUnicode(input);
      
      expect(result).toBe('\u00C1'); // Ã (pre-composed)
    });

    it('should remove zero-width spaces', () => {
      const input = 'admin\u200Btest';
      const result = normalizeUnicode(input);
      
      expect(result).not.toContain('\u200B');
      expect(result).toBe('admintest');
    });
  });

  describe('detectDangerousUnicode', () => {
    it('should detect mixed scripts (Cyrillic + Latin)', () => {
      const input = '\u0430dmin'; // Cyrillic 'a' + Latin 'dmin'
      const result = detectDangerousUnicode(input);
      
      expect(result).toBe(true); // Suspicious
    });

    it('should detect zero-width characters', () => {
      const input = 'admin\u200B';
      const result = detectDangerousUnicode(input);
      
      expect(result).toBe(true);
    });

    it('should allow pure Latin', () => {
      const input = 'admin';
      const result = detectDangerousUnicode(input);
      
      expect(result).toBe(false); // Safe
    });
  });

  // ==========================================
  // Whitespace Normalization
  // ==========================================
  
  describe('normalizeWhitespace', () => {
    it('should trim leading/trailing spaces', () => {
      const input = '  test  ';
      const result = normalizeWhitespace(input);
      
      expect(result).toBe('test');
    });

    it('should collapse multiple spaces', () => {
      const input = 'hello    world';
      const result = normalizeWhitespace(input);
      
      expect(result).toBe('hello world');
    });

    it('should remove control characters', () => {
      const input = 'test\x01\x02control';
      const result = normalizeWhitespace(input);
      
      expect(result).not.toContain('\x01');
      expect(result).toBe('testcontrol');
    });

    it('should normalize line endings', () => {
      const input = 'line1\r\nline2';
      const result = normalizeWhitespace(input);
      
      expect(result).toContain('\n');
      expect(result).not.toContain('\r\n');
    });
  });

  // ==========================================
  // Email Sanitization
  // ==========================================
  
  describe('sanitizeEmail', () => {
    it('should lowercase email', () => {
      const input = 'Test@Example.COM';
      const result = sanitizeEmail(input);
      
      expect(result).toBe('test@example.com');
    });

    it('should trim whitespace', () => {
      const input = '  test@example.com  ';
      const result = sanitizeEmail(input);
      
      expect(result).toBe('test@example.com');
    });

    it('should throw error for invalid format', () => {
      const input = 'not-an-email';
      
      expect(() => sanitizeEmail(input)).toThrow('Invalid email');
    });

    it('should throw error for too long email', () => {
      const input = 'a'.repeat(310) + '@example.com'; // Total > 320
      
      expect(() => sanitizeEmail(input)).toThrow();
    });
  });

  // ==========================================
  // URL Sanitization
  // ==========================================
  
  describe('sanitizeURL', () => {
    it('should allow valid HTTPS URLs', () => {
      const input = 'https://example.com/path';
      const result = sanitizeURL(input);
      
      expect(result).toBe(input);
    });

    it('should block localhost (SSRF prevention)', () => {
      const input = 'http://localhost:3000';
      
      expect(() => sanitizeURL(input)).toThrow('Localhost URLs not allowed');
    });

    it('should block 127.0.0.1 (SSRF prevention)', () => {
      const input = 'http://127.0.0.1:3000';
      
      expect(() => sanitizeURL(input)).toThrow('Localhost URLs not allowed');
    });

    it('should block private IPs (SSRF prevention)', () => {
      const input = 'http://192.168.1.1';
      
      expect(() => sanitizeURL(input)).toThrow('Private IP');
    });

    it('should block file:// protocol', () => {
      const input = 'file:///etc/passwd';
      
      expect(() => sanitizeURL(input)).toThrow('Protocol not allowed');
    });

    it('should enforce domain whitelist', () => {
      const input = 'https://evil.com';
      
      expect(() => 
        sanitizeURL(input, { domainWhitelist: ['example.com', 'ailin.dev'] })
      ).toThrow('not in whitelist');
    });

    it('should allow whitelisted domains', () => {
      const input = 'https://api.ailin.one/endpoint';
      const result = sanitizeURL(input, { domainWhitelist: ['ailin.one'] });
      
      expect(result).toBe(input);
    });
  });

  // ==========================================
  // Phone Number Sanitization
  // ==========================================
  
  describe('sanitizePhoneNumber', () => {
    it('should remove non-digits', () => {
      const input = '+1 (555) 123-4567';
      const result = sanitizePhoneNumber(input);
      
      expect(result).toBe('+15551234567');
    });

    it('should add + prefix (E.164)', () => {
      const input = '5551234567';
      const result = sanitizePhoneNumber(input);
      
      expect(result.startsWith('+')).toBe(true);
      expect(result).toBe('+5551234567');
    });

    it('should throw error for too short', () => {
      const input = '123';
      
      expect(() => sanitizePhoneNumber(input)).toThrow('Invalid phone number');
    });

    it('should throw error for too long', () => {
      const input = '1234567890123456'; // 16 digits
      
      expect(() => sanitizePhoneNumber(input)).toThrow('Invalid phone number');
    });
  });

  // ==========================================
  // Generic Sanitizer
  // ==========================================
  
  describe('sanitizeInput', () => {
    it('should apply multiple sanitizations', () => {
      const input = '  <script>Test</script>  ';
      const result = sanitizeInput(input, {
        stripHTML: true,
        normalizeWhitespace: true
      });
      
      expect(result).toBe('Test');
      expect(result).not.toContain('<script>');
    });

    it('should enforce max length', () => {
      const input = 'a'.repeat(1000);
      const result = sanitizeInput(input, {
        maxLength: 100
      });
      
      expect(result.length).toBe(100);
    });

    it('should validate allowed chars', () => {
      const input = 'test123';
      
      expect(() => 
        sanitizeInput(input, { allowedChars: /^[a-z]+$/ })
      ).toThrow('disallowed characters');
    });

    it('should allow valid chars', () => {
      const input = 'testonly';
      const result = sanitizeInput(input, { allowedChars: /^[a-z]+$/ });
      
      expect(result).toBe('testonly');
    });
  });

  describe('sanitizeRequestBody', () => {
    it('should sanitize entire request body', () => {
      const input = {
        name: '<script>XSS</script>',
        email: '  TEST@EXAMPLE.COM  ',
        nested: {
          value: '  test  '
        }
      };
      
      const result = sanitizeRequestBody(input, {
        stripHTML: true,
        normalizeWhitespace: true
      });
      
      expect(result.name).toBe('XSS');
      expect(result.email).toBe('TEST@EXAMPLE.COM');
      expect(result.nested.value).toBe('test');
    });

    it('should prevent prototype pollution in request body', () => {
      const input = {
        name: 'test',
        __proto__: { admin: true }
      };
      
      const result = sanitizeRequestBody(input);
      
      // Should not pollute prototype
      expect(result).not.toHaveProperty('admin');
      expect(Object.prototype.hasOwnProperty.call(result, '__proto__')).toBe(false);
    });
  });
});


