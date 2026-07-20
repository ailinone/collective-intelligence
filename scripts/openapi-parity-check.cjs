// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

const fs = require("fs");
const path = require("path");
const YAML = require("yaml");

function sortObject(value) {
  if (Array.isArray(value)) {
    return value.map(sortObject);
  }

  if (value && typeof value === "object") {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortObject(value[key]);
    }
    return sorted;
  }

  return value;
}

function readYaml(filePath) {
  return YAML.parse(fs.readFileSync(filePath, "utf8"));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function semanticEqual(left, right) {
  return JSON.stringify(sortObject(left)) === JSON.stringify(sortObject(right));
}

const yamlPath = path.resolve("openapi-spec.yaml");
const jsonPath = path.resolve("openapi-spec.json");
const bundleJsonPath = path.resolve("dist/openapi.bundle.json");

const yamlDoc = readYaml(yamlPath);
const jsonDoc = readJson(jsonPath);
const bundleJsonDoc = readJson(bundleJsonPath);

const yamlVsJson = semanticEqual(yamlDoc, jsonDoc);
const jsonVsBundle = semanticEqual(jsonDoc, bundleJsonDoc);

if (!yamlVsJson || !jsonVsBundle) {
  console.error("OpenAPI parity check failed.");
  console.error(`yaml_vs_json_semantic_equal=${yamlVsJson}`);
  console.error(`json_vs_dist_bundle_semantic_equal=${jsonVsBundle}`);
  process.exit(1);
}

console.log("OpenAPI parity check passed.");
console.log("yaml_vs_json_semantic_equal=true");
console.log("json_vs_dist_bundle_semantic_equal=true");
