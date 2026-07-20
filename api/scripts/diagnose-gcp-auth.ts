#!/usr/bin/env tsx
// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * GCP Authentication Diagnostic Script
 * 
 * This script checks if GCP Application Default Credentials are properly configured
 * for accessing GCP Secret Manager.
 * 
 * Usage:
 *   tsx scripts/diagnose-gcp-auth.ts
 */

import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

const PROJECT_ID = process.env.GCP_SECRETS_PROJECT_ID || 
                  process.env.GCP_PROJECT_ID || 
                  process.env.GOOGLE_CLOUD_PROJECT || 
                  '';

if (!PROJECT_ID) {
  console.error('ERROR: Set GCP_SECRETS_PROJECT_ID (or GCP_PROJECT_ID / GOOGLE_CLOUD_PROJECT) to your GCP project id.');
  process.exit(1);
}

// Prefix used when naming secrets in GCP Secret Manager (e.g. "<prefix>-openai-api-key").
const SECRETS_PREFIX = (process.env.GCP_SECRETS_PREFIX || 'app') + '-';

function configureGoogleApiProxyBypass(): void {
  const noProxyHosts = [
    '127.0.0.1',
    'localhost',
    '.googleapis.com',
    'googleapis.com',
    '.google.com',
    'metadata.google.internal',
  ];
  const existingNoProxy = [process.env.NO_PROXY, process.env.no_proxy]
    .filter((value): value is string => typeof value === 'string')
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const mergedNoProxy = Array.from(new Set([...existingNoProxy, ...noProxyHosts])).join(',');
  process.env.NO_PROXY = mergedNoProxy;
  process.env.no_proxy = mergedNoProxy;
}

async function diagnoseGcpAuth(): Promise<void> {
  configureGoogleApiProxyBypass();
  console.log('🔍 Diagnosing GCP Authentication for Secret Manager...\n');
  console.log(`Project ID: ${PROJECT_ID}\n`);

  // Check 1: Verify gcloud CLI is installed
  console.log('1️⃣  Checking gcloud CLI...');
  try {
    const { execSync } = await import('child_process');
    const gcloudVersion = execSync('gcloud --version', { encoding: 'utf8' });
    console.log('   ✅ gcloud CLI is installed');
    console.log(`   ${gcloudVersion.split('\n')[0]}\n`);
  } catch (error) {
    console.error('   ❌ gcloud CLI not found');
    console.error('   Install: https://cloud.google.com/sdk/docs/install\n');
    process.exit(1);
  }

  // Check 2: Verify application-default credentials
  console.log('2️⃣  Checking Application Default Credentials...');
  try {
    const { execSync } = await import('child_process');
    try {
      const token = execSync('gcloud auth application-default print-access-token', {
        encoding: 'utf8',
        stdio: 'pipe',
      });
      if (token.trim()) {
        console.log('   ✅ Application Default Credentials are configured');
        console.log(`   Token preview: ${token.trim().substring(0, 20)}...\n`);
      } else {
        throw new Error('No token returned');
      }
    } catch (error) {
      console.error('   ❌ Application Default Credentials NOT configured');
      console.error('   SOLUTION: Run: gcloud auth application-default login\n');
      process.exit(1);
    }
  } catch (error) {
    console.error('   ❌ Failed to check Application Default Credentials\n');
    process.exit(1);
  }

  // Check 3: Verify project is set
  console.log('3️⃣  Checking GCP project configuration...');
  try {
    const { execSync } = await import('child_process');
    const currentProject = execSync('gcloud config get-value project', {
      encoding: 'utf8',
    }).trim();
    
    if (currentProject) {
      console.log(`   ✅ Current project: ${currentProject}`);
      if (currentProject !== PROJECT_ID) {
        console.warn(`   ⚠️  Project mismatch! Expected: ${PROJECT_ID}`);
        console.warn(`   Fix: gcloud config set project ${PROJECT_ID}\n`);
      } else {
        console.log('   ✅ Project matches expected value\n');
      }
    } else {
      console.warn('   ⚠️  No project set in gcloud config');
      console.warn(`   Fix: gcloud config set project ${PROJECT_ID}\n`);
    }
  } catch (error) {
    console.error('   ❌ Failed to check project configuration\n');
  }

  // Check 4: Test Secret Manager access
  console.log('4️⃣  Testing Secret Manager API access...');
  try {
    const client = new SecretManagerServiceClient();
    const parent = `projects/${PROJECT_ID}`;
    
    // Try to list secrets (minimal operation to test auth)
    const [secrets] = await client.listSecrets({ parent, pageSize: 1 });
    console.log('   ✅ Successfully authenticated with Secret Manager API');
    console.log(`   ✅ Can access project: ${PROJECT_ID}\n`);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    if (
      errorMessage.includes('Could not load the default credentials') ||
      errorMessage.includes('Could not refresh access token') ||
      errorMessage.includes('Could not automatically determine credentials') ||
      errorMessage.includes('Application Default Credentials')
    ) {
      console.error('   ❌ Authentication failed: Application Default Credentials not configured');
      console.error('   SOLUTION: Run: gcloud auth application-default login\n');
      process.exit(1);
    } else if (errorMessage.includes('Permission denied') || errorMessage.includes('403')) {
      console.error('   ❌ Permission denied: User does not have Secret Manager access');
      console.error('   SOLUTION: Ensure your account has "Secret Manager Secret Accessor" role\n');
      process.exit(1);
    } else if (errorMessage.includes('not found') || errorMessage.includes('404')) {
      console.error(`   ❌ Project not found: ${PROJECT_ID}`);
      console.error('   SOLUTION: Verify project ID and ensure it exists\n');
      process.exit(1);
    } else {
      console.error(`   ❌ Unexpected error: ${errorMessage}\n`);
      process.exit(1);
    }
  }

  // Check 5: List available secrets
  console.log('5️⃣  Checking available secrets...');
  try {
    const client = new SecretManagerServiceClient();
    const parent = `projects/${PROJECT_ID}`;
    const [secrets] = await client.listSecrets({ parent });
    
    const matchingSecrets = (secrets || []).filter((secret) =>
      secret.name?.includes(SECRETS_PREFIX)
    );
    
    console.log(`   ✅ Found ${matchingSecrets.length} secrets with prefix '${SECRETS_PREFIX}'`);
    
    if (matchingSecrets.length > 0) {
      console.log('   Available secrets:');
      matchingSecrets.slice(0, 10).forEach((secret) => {
        const name = secret.name?.split('/').pop() || 'unknown';
        console.log(`      - ${name}`);
      });
      if (matchingSecrets.length > 10) {
        console.log(`      ... and ${matchingSecrets.length - 10} more`);
      }
    } else {
      console.warn(`   ⚠️  No secrets found with prefix "${SECRETS_PREFIX}"`);
      console.warn('   This may be expected if secrets haven\'t been created yet\n');
    }
    console.log('');
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`   ⚠️  Failed to list secrets: ${errorMessage}\n`);
  }

  console.log('✅ All checks passed! GCP authentication is properly configured.\n');
  console.log('You can now run tests with:');
  console.log('  export TEST_USE_REAL_API_KEYS=true');
  console.log('  pnpm test\n');
}

diagnoseGcpAuth().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
