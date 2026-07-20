// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

const fs = require('node:fs');
const path = require('node:path');

const SPEC_PATH = path.resolve('openapi-spec.json');
const OUTPUT_DIR = path.resolve('docs', 'reference', 'endpoints');
const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace'];

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function securityLabel(operation, globalSecurity) {
  const security = Object.prototype.hasOwnProperty.call(operation, 'security')
    ? operation.security
    : globalSecurity;

  if (!Array.isArray(security) || security.length === 0) {
    return 'Public (no authentication required).';
  }

  const schemes = new Set();
  for (const entry of security) {
    if (!entry || typeof entry !== 'object') continue;
    for (const key of Object.keys(entry)) schemes.add(key);
  }

  if (schemes.size === 0) return 'Public (no authentication required).';

  const labels = [];
  if (schemes.has('bearerAuth')) labels.push('Bearer token');
  if (schemes.has('apiKeyAuth')) labels.push('API key');
  for (const key of schemes) {
    if (key !== 'bearerAuth' && key !== 'apiKeyAuth') labels.push(key);
  }
  return `Requires: ${labels.join(' or ')}.`;
}

function pathParamSample(name) {
  const normalized = String(name || '').toLowerCase();
  if (normalized === 'capability') return 'chat';
  if (normalized.includes('organization')) return '123e4567-e89b-12d3-a456-426614174000';
  if (normalized.includes('user')) return '123e4567-e89b-12d3-a456-426614174001';
  if (normalized.includes('id')) return 'sample';
  return 'sample';
}

function normalizePathForExample(routePath) {
  return routePath.replace(/\{([^}]+)\}/g, (_match, group) => pathParamSample(group));
}

function extractParameters(operation) {
  if (!Array.isArray(operation.parameters)) return [];
  return operation.parameters
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => {
      const schema = entry.schema && typeof entry.schema === 'object' ? entry.schema : {};
      return {
        name: entry.name || '',
        in: entry.in || '',
        required: Boolean(entry.required),
        type: schema.type || 'object',
        description: entry.description || '',
      };
    });
}

function resolveSchema(schema, components) {
  if (!schema || typeof schema !== 'object') return null;
  if (!schema.$ref || typeof schema.$ref !== 'string') return schema;
  const match = schema.$ref.match(/^#\/components\/schemas\/(.+)$/);
  if (!match) return schema;
  return components?.schemas?.[match[1]] || schema;
}

function sampleFromSchema(schema, components, depth = 0) {
  if (!schema || typeof schema !== 'object') return {};
  const resolved = resolveSchema(schema, components);
  if (!resolved || typeof resolved !== 'object') return {};
  if (depth > 3) return {};

  if (Array.isArray(resolved.enum) && resolved.enum.length > 0) {
    return resolved.enum[0];
  }
  if (resolved.example !== undefined) {
    return resolved.example;
  }
  if (resolved.default !== undefined) {
    return resolved.default;
  }
  if (resolved.nullable === true) {
    return null;
  }
  if (Array.isArray(resolved.oneOf) && resolved.oneOf.length > 0) {
    return sampleFromSchema(resolved.oneOf[0], components, depth + 1);
  }
  if (Array.isArray(resolved.anyOf) && resolved.anyOf.length > 0) {
    return sampleFromSchema(resolved.anyOf[0], components, depth + 1);
  }

  switch (resolved.type) {
    case 'string':
      if (resolved.format === 'date-time') return '2026-01-01T00:00:00Z';
      if (resolved.format === 'email') return 'user@example.com';
      return 'string';
    case 'integer':
    case 'number':
      return 1;
    case 'boolean':
      return true;
    case 'array':
      return [sampleFromSchema(resolved.items || {}, components, depth + 1)];
    case 'object': {
      const output = {};
      const properties = resolved.properties && typeof resolved.properties === 'object' ? resolved.properties : {};
      for (const [key, value] of Object.entries(properties)) {
        output[key] = sampleFromSchema(value, components, depth + 1);
      }
      return output;
    }
    default:
      return {};
  }
}

function requestJsonSample(operation, components) {
  const requestBody = operation.requestBody;
  if (!requestBody || typeof requestBody !== 'object') return null;
  const content = requestBody.content;
  if (!content || typeof content !== 'object') return null;
  const appJson = content['application/json'];
  if (!appJson || typeof appJson !== 'object') return null;
  const schema = appJson.schema;
  if (!schema) return null;
  return sampleFromSchema(schema, components);
}

function summarizeResponses(operation) {
  const responses = operation.responses && typeof operation.responses === 'object' ? operation.responses : {};
  return Object.entries(responses).map(([statusCode, response]) => {
    if (response && typeof response === 'object' && typeof response.description === 'string') {
      return { statusCode, description: response.description };
    }
    if (response && typeof response === 'object' && typeof response.$ref === 'string') {
      return { statusCode, description: response.$ref };
    }
    return { statusCode, description: 'Response contract defined in OpenAPI.' };
  });
}

function collectOperations(spec) {
  const groups = new Map();
  const globalSecurity = Array.isArray(spec.security) ? spec.security : [];

  for (const [routePath, pathItem] of Object.entries(spec.paths || {})) {
    for (const method of METHODS) {
      const operation = pathItem?.[method];
      if (!operation) continue;

      const tag = Array.isArray(operation.tags) && operation.tags.length > 0 ? operation.tags[0] : 'Uncategorized';
      if (!groups.has(tag)) groups.set(tag, []);
      groups.get(tag).push({
        method: method.toUpperCase(),
        methodLower: method,
        routePath,
        summary: operation.summary || `${method.toUpperCase()} ${routePath}`,
        description: operation.description || '',
        securityLabel: securityLabel(operation, globalSecurity),
        parameters: extractParameters(operation),
        requestSample: requestJsonSample(operation, spec.components || {}),
        responses: summarizeResponses(operation),
        rateLimit: operation['x-rateLimit'] || null,
      });
    }
  }

  return groups;
}

function buildOperationDoc(operation) {
  const examplePath = normalizePathForExample(operation.routePath);
  const modelsByIdPath =
    operation.method === 'GET' && operation.routePath === '/v1/models/{id}';
  const hasJsonBody = operation.requestSample && Object.keys(operation.requestSample).length > 0;
  const jsonBody = hasJsonBody ? JSON.stringify(operation.requestSample, null, 2) : null;

  let output = '';
  output += `## ${operation.method} \`${operation.routePath}\`\n\n`;
  output += '### Purpose\n\n';
  output += `${operation.summary}.\n\n`;
  if (operation.description) {
    output += `${operation.description}\n\n`;
  }

  output += '### Authentication\n\n';
  output += `${operation.securityLabel}\n\n`;

  output += '### Parameters\n\n';
  if (operation.parameters.length === 0) {
    output += 'This operation does not declare explicit parameters.\n\n';
  } else {
    output += '| Name | In | Required | Type | Description |\n';
    output += '|---|---|---|---|---|\n';
    for (const parameter of operation.parameters) {
      output += `| \`${parameter.name}\` | ${parameter.in} | ${parameter.required ? 'yes' : 'no'} | ${parameter.type} | ${parameter.description || '-'} |\n`;
    }
    output += '\n';
  }

  output += '### Request Body\n\n';
  if (!jsonBody) {
    output += 'No JSON request body is required.\n\n';
  } else {
    output += '```json\n';
    output += `${jsonBody}\n`;
    output += '```\n\n';
  }

  output += '### Responses\n\n';
  output += '| Status | Description |\n';
  output += '|---|---|\n';
  for (const response of operation.responses) {
    output += `| \`${response.statusCode}\` | ${response.description} |\n`;
  }
  output += '\n';

  output += '### Error Handling\n\n';
  output +=
    'Client errors generally follow 4xx contracts (`BadRequest`, `Unauthorized`, `Forbidden`, `NotFound`, `Conflict`, `UnprocessableEntity`, `TooManyRequests`). Server failures return `500`.\n\n';

  output += '### Rate Limits\n\n';
  if (operation.rateLimit) {
    output += 'This operation defines route-level rate-limit metadata in `x-rateLimit`.\n\n';
    output += '```json\n';
    output += `${JSON.stringify(operation.rateLimit, null, 2)}\n`;
    output += '```\n\n';
  } else {
    output += 'Subject to tenant-level quota and platform-level rate-limit policies.\n\n';
  }

  output += '### Observability\n\n';
  output +=
    'Propagate and log `X-Request-Id` and `X-Correlation-Id` for traceability, debugging, and audit workflows.\n\n';

  output += '### Examples\n\n';
  if (modelsByIdPath) {
    output += '```bash\n';
    output += 'curl -X GET "https://api.ailin.one/v1/models/ai21%2Fjamba-large-1.7" \\\n';
    output += '  -H "Authorization: Bearer $AILIN_TOKEN" \\\n';
    output += '  -H "X-API-Key: $AILIN_API_KEY"\n';
    output += '```\n\n';

    output += '```ts\n';
    output += 'const modelId = "ai21/jamba-large-1.7";\n';
    output += 'const encodedId = encodeURIComponent(modelId);\n';
    output += 'const response = await fetch(`https://api.ailin.one/v1/models/${encodedId}`, {\n';
    output += '  method: "GET",\n';
    output += '  headers: {\n';
    output += '    Authorization: `Bearer ${process.env.AILIN_TOKEN}`,\n';
    output += '    "X-API-Key": process.env.AILIN_API_KEY || "",\n';
    output += '  },\n';
    output += '});\n';
    output += 'const data = await response.json();\n';
    output += '```\n\n';

    output += '```python\n';
    output += 'import os\n';
    output += 'import requests\n';
    output += 'from urllib.parse import quote\n\n';
    output += 'model_id = "ai21/jamba-large-1.7"\n';
    output += 'encoded_id = quote(model_id, safe="")\n\n';
    output += 'response = requests.request(\n';
    output += '    "GET",\n';
    output += '    f"https://api.ailin.one/v1/models/{encoded_id}",\n';
    output += '    headers={\n';
    output += '        "Authorization": f"Bearer {os.environ.get(\'AILIN_TOKEN\', \'\')}",\n';
    output += '        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),\n';
    output += '    },\n';
    output += ')\n';
    output += 'print(response.status_code)\n';
    output += 'print(response.text)\n';
    output += '```\n\n';
  } else {
    output += '```bash\n';
    output += `curl -X ${operation.method} \"https://api.ailin.one${examplePath}\" \\\n`;
    output += '  -H \"Authorization: Bearer $AILIN_TOKEN\" \\\n';
    output += '  -H \"X-API-Key: $AILIN_API_KEY\"';
    if (jsonBody) {
      output += ' \\\n';
      output += '  -H \"Content-Type: application/json\" \\\n';
      output += `  -d '${JSON.stringify(operation.requestSample)}'`;
    }
    output += '\n';
    output += '```\n\n';

    output += '```ts\n';
    output += `const response = await fetch("https://api.ailin.one${examplePath}", {\n`;
    output += `  method: "${operation.method}",\n`;
    output += '  headers: {\n';
    output += '    Authorization: `Bearer ${process.env.AILIN_TOKEN}`,\n';
    output += '    "X-API-Key": process.env.AILIN_API_KEY || "",\n';
    if (jsonBody) output += '    "Content-Type": "application/json",\n';
    output += '  },\n';
    if (jsonBody) {
      output += `  body: JSON.stringify(${JSON.stringify(operation.requestSample, null, 2)}),\n`;
    }
    output += '});\n';
    output += 'const data = await response.json();\n';
    output += '```\n\n';

    output += '```python\n';
    output += 'import os\n';
    output += 'import requests\n\n';
    output += `response = requests.request(\n    "${operation.method}",\n    "https://api.ailin.one${examplePath}",\n`;
    output += '    headers={\n';
    output += '        "Authorization": f"Bearer {os.environ.get(\'AILIN_TOKEN\', \'\')}",\n';
    output += '        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),\n';
    if (jsonBody) output += '        "Content-Type": "application/json",\n';
    output += '    },\n';
    if (jsonBody) {
      output += `    json=${JSON.stringify(operation.requestSample, null, 4)},\n`;
    }
    output += ')\n';
    output += 'print(response.status_code)\n';
    output += 'print(response.text)\n';
    output += '```\n\n';
  }

  return output;
}

function main() {
  const spec = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8'));
  const groups = collectOperations(spec);

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const indexLines = ['# Endpoint Reference by Tag', '', 'Generated from `openapi-spec.json`.', ''];

  for (const tag of [...groups.keys()].sort((a, b) => a.localeCompare(b))) {
    const operations = groups
      .get(tag)
      .sort((a, b) => a.routePath.localeCompare(b.routePath) || a.method.localeCompare(b.method));
    const slug = slugify(tag);
    const fileName = `${slug || 'uncategorized'}.md`;
    const outputPath = path.join(OUTPUT_DIR, fileName);

    let content = '';
    content += `# ${tag} Endpoints\n\n`;
    content += `Total operations: ${operations.length}\n\n`;
    for (const operation of operations) {
      content += buildOperationDoc(operation);
    }

    fs.writeFileSync(outputPath, content, 'utf8');
    indexLines.push(`- [${tag}](./${fileName}) (${operations.length})`);
  }

  fs.writeFileSync(path.join(OUTPUT_DIR, 'README.md'), `${indexLines.join('\n')}\n`, 'utf8');
  process.stdout.write(`Generated endpoint reference files in ${OUTPUT_DIR}\n`);
}

main();
