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
const YAML = require('yaml');

const JSON_PATH = path.resolve('openapi-spec.json');
const YAML_PATH = path.resolve('openapi-spec.yaml');

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function moveCommonSchemaKeysIntoVariant(sourceSchema, variantType) {
  const variant = { type: variantType };
  if (variantType === 'object') {
    if (sourceSchema.properties) variant.properties = clone(sourceSchema.properties);
    if (sourceSchema.required) variant.required = clone(sourceSchema.required);
    if (Object.prototype.hasOwnProperty.call(sourceSchema, 'additionalProperties')) {
      variant.additionalProperties = clone(sourceSchema.additionalProperties);
    }
  }
  if (variantType === 'array' && sourceSchema.items) {
    variant.items = clone(sourceSchema.items);
  }
  return variant;
}

function deleteSchemaOnlyKeys(schema) {
  delete schema.type;
  delete schema.properties;
  delete schema.required;
  delete schema.additionalProperties;
  delete schema.items;
}

function normalizeTypeArray(schema) {
  if (!Array.isArray(schema.type) || schema.type.length === 0) return false;
  const rawTypes = schema.type.filter((item) => typeof item === 'string');
  const uniqueTypes = Array.from(new Set(rawTypes));
  if (uniqueTypes.length === 0) return false;

  const hasNull = uniqueTypes.includes('null');
  const nonNullTypes = uniqueTypes.filter((t) => t !== 'null');
  if (nonNullTypes.length === 0) {
    schema.type = 'string';
    schema.nullable = true;
    return true;
  }

  if (nonNullTypes.length === 1) {
    schema.type = nonNullTypes[0];
    if (hasNull) schema.nullable = true;
    return true;
  }

  const variants = nonNullTypes.map((variantType) =>
    moveCommonSchemaKeysIntoVariant(schema, variantType)
  );
  deleteSchemaOnlyKeys(schema);
  schema.oneOf = variants;
  if (hasNull) schema.nullable = true;
  return true;
}

function normalizeCompositeNullability(schema, key) {
  if (!Array.isArray(schema[key])) return false;
  let changed = false;
  let hasNullVariant = false;
  const next = [];

  for (const variant of schema[key]) {
    if (isObject(variant) && variant.type === 'null') {
      hasNullVariant = true;
      changed = true;
      continue;
    }
    next.push(variant);
  }

  if (!hasNullVariant) return changed;
  if (next.length === 0) {
    schema.type = 'string';
    schema.nullable = true;
    delete schema[key];
    return true;
  }
  if (next.length === 1) {
    const single = next[0];
    delete schema[key];
    if (isObject(single)) {
      const preservedDescription = schema.description;
      const preservedTitle = schema.title;
      const preservedExample = schema.example;
      for (const [k, v] of Object.entries(single)) schema[k] = v;
      if (preservedDescription && !schema.description) schema.description = preservedDescription;
      if (preservedTitle && !schema.title) schema.title = preservedTitle;
      if (preservedExample !== undefined && schema.example === undefined) schema.example = preservedExample;
      schema.nullable = true;
      return true;
    }
    schema[key] = next;
    schema.nullable = true;
    return true;
  }

  schema[key] = next;
  schema.nullable = true;
  return true;
}

function inferPrimitiveType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function normalizeNullableMissingType(schema) {
  if (!isObject(schema)) return false;
  if (schema.nullable !== true) return false;
  if (typeof schema.type === 'string' && schema.type.length > 0) return false;
  if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf) || Array.isArray(schema.allOf)) {
    return false;
  }

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const nonNullValues = schema.enum.filter((value) => value !== null);
    if (nonNullValues.length > 0) {
      const inferred = inferPrimitiveType(nonNullValues[0]);
      if (inferred !== 'object' && inferred !== 'undefined') {
        schema.type = inferred;
        return true;
      }
    }
  }

  if (isObject(schema.properties) || Object.prototype.hasOwnProperty.call(schema, 'additionalProperties')) {
    schema.type = 'object';
    return true;
  }

  if (Object.prototype.hasOwnProperty.call(schema, 'items')) {
    schema.type = 'array';
    return true;
  }

  if (typeof schema.format === 'string') {
    schema.type = 'string';
    return true;
  }

  if (Object.prototype.hasOwnProperty.call(schema, 'example')) {
    const inferred = inferPrimitiveType(schema.example);
    if (inferred !== 'null' && inferred !== 'undefined' && inferred !== 'object') {
      schema.type = inferred;
      return true;
    }
  }

  schema.type = 'string';
  return true;
}

function normalizeCompositeNullableWithoutType(schema) {
  if (!isObject(schema)) return false;
  if (schema.nullable !== true) return false;
  if (typeof schema.type === 'string' && schema.type.length > 0) return false;
  if (!Array.isArray(schema.oneOf) && !Array.isArray(schema.anyOf) && !Array.isArray(schema.allOf)) {
    return false;
  }

  // In OAS 3.0, nullable without a sibling `type` is invalid. For composite
  // schemas, keep the composition and drop nullable to pass contract lint.
  delete schema.nullable;
  return true;
}

function normalizeArrayWithoutItems(schema) {
  if (!isObject(schema)) return false;
  if (schema.type !== 'array') return false;
  if (Object.prototype.hasOwnProperty.call(schema, 'items')) return false;
  schema.items = {
    type: 'object',
    additionalProperties: true,
  };
  return true;
}

function normalizeEmptyRequired(schema) {
  if (!isObject(schema)) return false;
  if (!Array.isArray(schema.required)) return false;
  if (schema.required.length > 0) return false;
  delete schema.required;
  return true;
}

function walkAndNormalize(node) {
  let changes = 0;
  if (Array.isArray(node)) {
    for (const item of node) changes += walkAndNormalize(item);
    return changes;
  }
  if (!isObject(node)) return changes;

  for (const value of Object.values(node)) {
    changes += walkAndNormalize(value);
  }

  if (normalizeTypeArray(node)) changes += 1;
  if (normalizeCompositeNullability(node, 'oneOf')) changes += 1;
  if (normalizeCompositeNullability(node, 'anyOf')) changes += 1;
  if (normalizeCompositeNullableWithoutType(node)) changes += 1;
  if (normalizeNullableMissingType(node)) changes += 1;
  if (normalizeArrayWithoutItems(node)) changes += 1;
  if (normalizeEmptyRequired(node)) changes += 1;
  return changes;
}

function normalizeSpec(spec) {
  const next = clone(spec);
  const changes = walkAndNormalize(next);
  return { next, changes };
}

function readSpec() {
  if (!fs.existsSync(JSON_PATH)) {
    throw new Error(`Missing ${JSON_PATH}`);
  }
  if (!fs.existsSync(YAML_PATH)) {
    throw new Error(`Missing ${YAML_PATH}`);
  }
  return JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
}

function writeSpec(spec) {
  fs.writeFileSync(JSON_PATH, `${JSON.stringify(spec, null, 2)}\n`, 'utf8');
  fs.writeFileSync(YAML_PATH, YAML.stringify(spec), 'utf8');
}

function main() {
  const spec = readSpec();
  const { next, changes } = normalizeSpec(spec);
  writeSpec(next);
  console.log(
    JSON.stringify(
      {
        normalized: true,
        schemaMutations: changes,
        jsonPath: path.relative(process.cwd(), JSON_PATH),
        yamlPath: path.relative(process.cwd(), YAML_PATH),
      },
      null,
      2
    )
  );
}

main();
