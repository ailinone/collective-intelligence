// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, it, expect, vi } from 'vitest';
import { createCapabilityInvoker } from '@/core/orchestration/capability-invoker';
import type { OrchestrationContext } from '@/types';

const context: OrchestrationContext = {
  organizationId: 'org-1',
  requestId: 'req-1',
  models: [],
  taskType: 'general',
  contextSize: 0,
};

function chatResponseWithContent(content: string, model = 'gpt-4o') {
  return {
    id: 'chat-1',
    object: 'chat.completion' as const,
    created: 0,
    model,
    choices: [{ index: 0, message: { role: 'assistant' as const, content }, finish_reason: 'stop' as const, logprobs: null }],
  };
}

describe('CapabilityInvoker.generateFile', () => {
  it('asks the chat handler for structured JSON content and renders it via fileService for csv', async () => {
    const chatHandler = vi.fn().mockResolvedValue(
      chatResponseWithContent('{"headers":["name","distance_km"],"rows":[["Mercury",57900000]]}')
    );
    const fileService = {
      generate: vi.fn().mockReturnValue({ buffer: Buffer.from('rendered-csv'), filename: 'report.csv', mimeType: 'text/csv' }),
    };
    const invoker = createCapabilityInvoker({ chatHandler, fileService, context });

    const result = await invoker.generateFile({ format: 'csv', prompt: 'a table of planets', filenameBase: 'report' });

    expect(chatHandler).toHaveBeenCalledTimes(1);
    const [, options] = chatHandler.mock.calls[0];
    expect(options).toMatchObject({ temperature: 0, responseFormat: 'json_object', strategy: 'single' });
    expect(fileService.generate).toHaveBeenCalledWith(
      'csv',
      { headers: ['name', 'distance_km'], rows: [['Mercury', 57900000]] },
      'report'
    );
    expect(result.buffer.toString()).toBe('rendered-csv');
    expect(result.filename).toBe('report.csv');
    expect(result.model).toBe('gpt-4o');
  });

  it('ALWAYS forces strategy:"single" on the chatHandler call, regardless of format — regression guard for the 2026-07-15 unbounded-recursion incident', async () => {
    // options.prompt is the caller's own request text (often the literal
    // user message that triggered file-generation detection). Without
    // strategy:'single', the default chatHandler wiring in
    // orchestration-engine.ts re-enters the full engine's triage/heuristic
    // pipeline, re-detects the SAME file-generation intent from that same
    // text, builds another file-generation stage, and calls generateFile()
    // again — unbounded recursion. This was found live in production
    // (hundreds of nested csv_generation stages, ~4s apart, until the
    // service was cycled). Never remove strategy:'single' from this call.
    for (const format of ['csv', 'json', 'markdown', 'docx', 'xlsx', 'pdf', 'pptx', 'zip', 'code'] as const) {
      const chatHandler = vi.fn().mockResolvedValue(
        chatResponseWithContent(
          format === 'markdown'
            ? 'text'
            : format === 'csv'
              ? '{"headers":[],"rows":[]}'
              : format === 'docx' || format === 'pdf'
                ? '{"sections":[]}'
                : format === 'xlsx'
                  ? '{"sheets":[]}'
                  : format === 'pptx'
                    ? '{"slides":[]}'
                    : format === 'zip'
                      ? '{"files":[{"filename":"x.json","format":"json","content":{}}]}'
                      : format === 'code'
                        ? '{"language":"python","code":"print(1)"}'
                        : '{}'
        )
      );
      const fileService = { generate: vi.fn().mockReturnValue({ buffer: Buffer.from('x'), filename: 'x', mimeType: 'x' }) };
      const invoker = createCapabilityInvoker({ chatHandler, fileService, context });

      await invoker.generateFile({ format, prompt: 'generate a csv of the planets' });

      const [, options] = chatHandler.mock.calls[0];
      expect(options?.strategy).toBe('single');
    }
  });

  it('asks the chat handler for structured JSON content and renders it via fileService for docx', async () => {
    const chatHandler = vi.fn().mockResolvedValue(
      chatResponseWithContent('{"title":"Report","sections":[{"type":"paragraph","text":"Body"}]}')
    );
    const fileService = {
      generate: vi.fn().mockResolvedValue({
        buffer: Buffer.from('rendered-docx'),
        filename: 'report.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
    };
    const invoker = createCapabilityInvoker({ chatHandler, fileService, context });

    const result = await invoker.generateFile({ format: 'docx', prompt: 'a short report', filenameBase: 'report' });

    const [, options] = chatHandler.mock.calls[0];
    expect(options).toMatchObject({ temperature: 0, responseFormat: 'json_object', strategy: 'single' });
    expect(fileService.generate).toHaveBeenCalledWith(
      'docx',
      { title: 'Report', sections: [{ type: 'paragraph', text: 'Body' }] },
      'report'
    );
    expect(result.buffer.toString()).toBe('rendered-docx');
    expect(result.filename).toBe('report.docx');
  });

  it('asks the chat handler for structured JSON content and renders it via fileService for xlsx', async () => {
    const chatHandler = vi.fn().mockResolvedValue(
      chatResponseWithContent('{"sheets":[{"name":"Sheet1","headers":["A"],"rows":[["1"]]}]}')
    );
    const fileService = {
      generate: vi.fn().mockResolvedValue({
        buffer: Buffer.from('rendered-xlsx'),
        filename: 'report.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
    };
    const invoker = createCapabilityInvoker({ chatHandler, fileService, context });

    const result = await invoker.generateFile({ format: 'xlsx', prompt: 'a short spreadsheet', filenameBase: 'report' });

    const [, options] = chatHandler.mock.calls[0];
    expect(options).toMatchObject({ temperature: 0, responseFormat: 'json_object', strategy: 'single' });
    expect(fileService.generate).toHaveBeenCalledWith(
      'xlsx',
      { sheets: [{ name: 'Sheet1', headers: ['A'], rows: [['1']] }] },
      'report'
    );
    expect(result.buffer.toString()).toBe('rendered-xlsx');
    expect(result.filename).toBe('report.xlsx');
  });

  it('asks the chat handler for structured JSON content and renders it via fileService for pdf', async () => {
    const chatHandler = vi.fn().mockResolvedValue(
      chatResponseWithContent('{"title":"Report","sections":[{"type":"paragraph","text":"Body"}]}')
    );
    const fileService = {
      generate: vi.fn().mockResolvedValue({
        buffer: Buffer.from('rendered-pdf'),
        filename: 'report.pdf',
        mimeType: 'application/pdf',
      }),
    };
    const invoker = createCapabilityInvoker({ chatHandler, fileService, context });

    const result = await invoker.generateFile({ format: 'pdf', prompt: 'a short report', filenameBase: 'report' });

    const [, options] = chatHandler.mock.calls[0];
    expect(options).toMatchObject({ temperature: 0, responseFormat: 'json_object', strategy: 'single' });
    expect(fileService.generate).toHaveBeenCalledWith(
      'pdf',
      { title: 'Report', sections: [{ type: 'paragraph', text: 'Body' }] },
      'report'
    );
    expect(result.buffer.toString()).toBe('rendered-pdf');
    expect(result.filename).toBe('report.pdf');
  });

  it('asks the chat handler for structured JSON content and renders it via fileService for pptx', async () => {
    const chatHandler = vi.fn().mockResolvedValue(
      chatResponseWithContent('{"title":"Report","slides":[{"items":[{"type":"paragraph","text":"Body"}]}]}')
    );
    const fileService = {
      generate: vi.fn().mockResolvedValue({
        buffer: Buffer.from('rendered-pptx'),
        filename: 'report.pptx',
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      }),
    };
    const invoker = createCapabilityInvoker({ chatHandler, fileService, context });

    const result = await invoker.generateFile({ format: 'pptx', prompt: 'a short slide deck', filenameBase: 'report' });

    const [, options] = chatHandler.mock.calls[0];
    expect(options).toMatchObject({ temperature: 0, responseFormat: 'json_object', strategy: 'single' });
    expect(fileService.generate).toHaveBeenCalledWith(
      'pptx',
      { title: 'Report', slides: [{ items: [{ type: 'paragraph', text: 'Body' }] }] },
      'report'
    );
    expect(result.buffer.toString()).toBe('rendered-pptx');
    expect(result.filename).toBe('report.pptx');
  });

  it('asks the chat handler for structured JSON content and renders it via fileService for zip', async () => {
    const chatHandler = vi.fn().mockResolvedValue(
      chatResponseWithContent(
        '{"files":[{"filename":"report.csv","format":"csv","content":{"headers":["a"],"rows":[["1"]]}}]}'
      )
    );
    const fileService = {
      generate: vi.fn().mockResolvedValue({
        buffer: Buffer.from('rendered-zip'),
        filename: 'report.zip',
        mimeType: 'application/zip',
      }),
    };
    const invoker = createCapabilityInvoker({ chatHandler, fileService, context });

    const result = await invoker.generateFile({ format: 'zip', prompt: 'bundle these into a zip', filenameBase: 'report' });

    const [, options] = chatHandler.mock.calls[0];
    expect(options).toMatchObject({ temperature: 0, responseFormat: 'json_object', strategy: 'single' });
    expect(fileService.generate).toHaveBeenCalledWith(
      'zip',
      { files: [{ filename: 'report.csv', format: 'csv', content: { headers: ['a'], rows: [['1']] } }] },
      'report'
    );
    expect(result.buffer.toString()).toBe('rendered-zip');
    expect(result.filename).toBe('report.zip');
  });

  it('asks the chat handler for structured JSON content and renders it via fileService for code', async () => {
    const chatHandler = vi.fn().mockResolvedValue(
      chatResponseWithContent('{"language":"python","code":"print(\\"hello\\")"}')
    );
    const fileService = {
      generate: vi.fn().mockResolvedValue({
        buffer: Buffer.from('print("hello")'),
        filename: 'report.py',
        mimeType: 'text/plain',
      }),
    };
    const invoker = createCapabilityInvoker({ chatHandler, fileService, context });

    const result = await invoker.generateFile({ format: 'code', prompt: 'generate a downloadable python file', filenameBase: 'report' });

    const [, options] = chatHandler.mock.calls[0];
    expect(options).toMatchObject({ temperature: 0, responseFormat: 'json_object', strategy: 'single' });
    expect(fileService.generate).toHaveBeenCalledWith(
      'code',
      { language: 'python', code: 'print("hello")' },
      'report'
    );
    expect(result.buffer.toString()).toBe('print("hello")');
    expect(result.filename).toBe('report.py');
  });

  it('strips a markdown code fence around JSON content before parsing', async () => {
    const chatHandler = vi.fn().mockResolvedValue(
      chatResponseWithContent('```json\n{"a":1}\n```')
    );
    const fileService = { generate: vi.fn().mockReturnValue({ buffer: Buffer.from('{}'), filename: 'x.json', mimeType: 'application/json' }) };
    const invoker = createCapabilityInvoker({ chatHandler, fileService, context });

    await invoker.generateFile({ format: 'json', prompt: 'give me an object' });

    expect(fileService.generate).toHaveBeenCalledWith('json', { a: 1 }, undefined);
  });

  it('passes markdown content through as raw text, never JSON-parsed', async () => {
    const chatHandler = vi.fn().mockResolvedValue(chatResponseWithContent('# Report\n\nBody text.'));
    const fileService = { generate: vi.fn().mockReturnValue({ buffer: Buffer.from('# Report'), filename: 'x.md', mimeType: 'text/markdown' }) };
    const invoker = createCapabilityInvoker({ chatHandler, fileService, context });

    await invoker.generateFile({ format: 'markdown', prompt: 'write a report' });

    expect(fileService.generate).toHaveBeenCalledWith('markdown', '# Report\n\nBody text.', undefined);
  });

  it('throws a descriptive error when the model returns invalid JSON for csv/json', async () => {
    const chatHandler = vi.fn().mockResolvedValue(chatResponseWithContent('not json at all'));
    const fileService = { generate: vi.fn() };
    const invoker = createCapabilityInvoker({ chatHandler, fileService, context });

    await expect(invoker.generateFile({ format: 'json', prompt: 'give me an object' })).rejects.toThrow(
      /invalid JSON for format "json"/
    );
    expect(fileService.generate).not.toHaveBeenCalled();
  });

  it('throws when the model returns no content', async () => {
    const chatHandler = vi.fn().mockResolvedValue(chatResponseWithContent(''));
    const fileService = { generate: vi.fn() };
    const invoker = createCapabilityInvoker({ chatHandler, fileService, context });

    await expect(invoker.generateFile({ format: 'markdown', prompt: 'write something' })).rejects.toThrow(
      /returned no content/
    );
  });

  it('throws when no chat handler is available in this context', async () => {
    const fileService = { generate: vi.fn() };
    const invoker = createCapabilityInvoker({ fileService, context });

    await expect(invoker.generateFile({ format: 'markdown', prompt: 'x' })).rejects.toThrow(
      'File generation capability not available in this context — no chat handler'
    );
  });

  it('throws when no file service is available in this context', async () => {
    const chatHandler = vi.fn().mockResolvedValue(chatResponseWithContent('# doc'));
    const invoker = createCapabilityInvoker({ chatHandler, context });

    await expect(invoker.generateFile({ format: 'markdown', prompt: 'x' })).rejects.toThrow(
      'File generation capability not available in this context — no file service'
    );
  });
});
