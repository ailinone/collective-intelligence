// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { logger } from '@/utils/logger';
import type { GcpSecretsProviderConfig } from '@/types';
import type { SecretsProvider } from './secrets-provider.js';
import { isObject } from '@/utils/type-guards';

type ClientOptions = ConstructorParameters<typeof SecretManagerServiceClient>[0];

export class GcpSecretsProvider implements SecretsProvider {
  readonly id: string;
  readonly type = 'gcp';
  readonly priority: number;
  readonly failOpen: boolean;

  private readonly projectId: string;
  private readonly prefix: string;
  private readonly credentialsFile?: string;
  private readonly credentialsJson?: string;
  private client!: SecretManagerServiceClient;

  constructor(config: GcpSecretsProviderConfig) {
    this.id = config.id;
    this.priority = config.priority;
    this.failOpen = config.failOpen ?? false;
    this.projectId = config.options.projectId;
    this.prefix =
      config.options.secretPrefix?.replace(/[^a-zA-Z0-9-_]/g, '-').replace(/-+$/, '') ?? '';
    this.credentialsFile = config.options.credentialsFile;
    this.credentialsJson = config.options.credentialsJson;
  }

  async initialize(): Promise<void> {
    try {
      this.applyGoogleProxyBypass();
      const clientOptions = await this.buildClientOptions();

      // ── Pre-flight ADC check (Hardening: degraded boot support) ──────
      // When ADC is expired/missing, constructing SecretManagerServiceClient
      // triggers google-gax to create background gRPC stub promises that
      // resolve asynchronously and leak as unhandledRejection — killing the
      // process before our try/catch around listSecrets() can respond.
      //
      // By validating ADC with google-auth-library DIRECTLY (awaited), we
      // surface the auth failure as a HANDLED rejection, and can abort the
      // provider init cleanly — letting the secrets-manager skip gcp-p1 and
      // fall through to env-p2 without unhandled rejections.
      //
      // This only runs the expensive preflight when using pure ADC (no
      // explicit credentials). With a credentials file or JSON, the SDK
      // authenticates deterministically and this path is unnecessary.
      const usingPureAdc = !this.credentialsJson && !this.credentialsFile;
      if (usingPureAdc) {
        try {
          // google-auth-library is a transitive dependency of @google-cloud/secret-manager.
          // We access it via Node's module resolution at runtime rather than a direct
          // import so we don't need to declare it as an explicit dep in package.json.
          // The type is `unknown` deliberately — we only use the constructor + getClient().
          const googleAuthLib = (await import('google-auth-library' as string)) as {
            GoogleAuth: new (opts: { scopes: string[]; projectId: string }) => {
              getClient: () => Promise<unknown>;
            };
          };
          const auth = new googleAuthLib.GoogleAuth({
            scopes: ['https://www.googleapis.com/auth/cloud-platform'],
            projectId: this.projectId,
          });
          await auth.getClient();
        } catch (adcError: unknown) {
          const adcErrorMessage = adcError instanceof Error ? adcError.message : String(adcError);
          logger.error(
            {
              provider: this.id,
              projectId: this.projectId,
              phase: 'adc_preflight',
              error: adcErrorMessage,
            },
            'ADC preflight failed — skipping GCP Secret Manager client construction to avoid unhandled gRPC rejections'
          );
          throw new Error(
            `GCP Secret Manager ADC preflight failed: ${adcErrorMessage}\n` +
            `SOLUTION (local): Run 'gcloud auth application-default login' to configure Application Default Credentials.\n` +
            `SOLUTION (production): Use Workload Identity Federation / attached Service Account for ADC.`
          );
        }
      }

      this.client = new SecretManagerServiceClient(clientOptions);
      const credentialsSource = this.credentialsJson
        ? 'inline_json'
        : this.credentialsFile
          ? 'credentials_file'
          : 'adc';
      const gcpPrimary = (process.env.SECRETS_PROVIDER_PRIMARY || '').trim().toLowerCase() === 'gcp';
      const failFastEnv = (process.env.SECRETS_GCP_FAIL_FAST || '').trim().toLowerCase();
      const failFast = failFastEnv === 'true' || (failFastEnv !== 'false' && gcpPrimary);

      // Test authentication by attempting a simple operation
      try {
        await this.client.listSecrets(
          { parent: this.projectPath(), pageSize: 1 },
          { autoPaginate: false }
        );
        logger.info(
          { provider: this.id, projectId: this.projectId, credentialsSource },
          'GCP Secret Manager provider initialized and authenticated'
        );
      } catch (authError: unknown) {
        const errorMessage = authError instanceof Error ? authError.message : String(authError);
        const isAuthError = 
          errorMessage.includes('Could not load the default credentials') ||
          errorMessage.includes('Could not refresh access token') ||
          errorMessage.includes('Could not automatically determine credentials') ||
          errorMessage.includes('Application Default Credentials') ||
          errorMessage.includes('invalid_grant') ||
          errorMessage.includes('invalid_rapt') ||
          errorMessage.includes('reauth') ||
          errorMessage.includes('cannot prompt during non-interactive execution') ||
          (typeof authError === 'object' && authError !== null && 'code' in authError && 
           (() => {
             const codeDescriptor = Object.getOwnPropertyDescriptor(authError, 'code');
             return codeDescriptor?.value === 7;
           })()); // UNAUTHENTICATED
        
        if (isAuthError) {
          logger.error(
            {
              provider: this.id,
              projectId: this.projectId,
              error: errorMessage,
              solution: 'Local: gcloud auth application-default login | Prod: Workload Identity Federation/Service Account',
            },
            'GCP Secret Manager authentication failed. Application Default Credentials not configured.'
          );
          throw new Error(
            `GCP Secret Manager authentication failed: ${errorMessage}\n` +
            `SOLUTION (local): Run 'gcloud auth application-default login' to configure Application Default Credentials.\n` +
            `SOLUTION (production): Use Workload Identity Federation / attached Service Account for ADC.\n` +
            `Note: Google API key does not authenticate Secret Manager.`
          );
        }

        // Check if the error is transient (network/capacity) — don't block startup for those
        const isTransient =
          errorMessage.includes('DEADLINE_EXCEEDED') ||
          errorMessage.includes('UNAVAILABLE') ||
          errorMessage.includes('RESOURCE_EXHAUSTED') ||
          errorMessage.includes('ECONNRESET') ||
          errorMessage.includes('ENOTFOUND') ||
          errorMessage.includes('ETIMEDOUT') ||
          errorMessage.includes('socket hang up');

        if (failFast && !isTransient) {
          throw new Error(
            `GCP Secret Manager health check failed while fail-fast is enabled: ${errorMessage}`
          );
        }

        if (isTransient) {
          logger.warn(
            { provider: this.id, projectId: this.projectId, error: errorMessage },
            'GCP Secret Manager health check failed with transient error — continuing (will retry on access)'
          );
        }

        // If fail-fast is disabled, log warning and continue (best-effort mode).
        logger.warn(
          { provider: this.id, projectId: this.projectId, error: errorMessage, failFast },
          'GCP Secret Manager initialized but health check failed (continuing because fail-fast is disabled)'
        );
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(
        { provider: this.id, projectId: this.projectId, error: errorMessage },
        'Failed to initialize GCP Secret Manager provider'
      );
      throw error;
    }
  }

  async getSecret(key: string): Promise<string> {
    // Retry transient GCP errors (2026-06-29). At boot the loader fetches ~137
    // secrets in a burst; transient gRPC errors (UNAVAILABLE/DEADLINE/RESOURCE_
    // EXHAUSTED/INTERNAL/ABORTED) or socket resets caused VALID secrets (e.g.
    // ailin-openai-key, confirmed present) to intermittently return empty → the
    // env var stayed unset → the native provider was disabled → requests fell
    // through to broken hub resellers. No negative cache exists (getSecret caches
    // only on success), so a retry re-hits GCP and succeeds. NOT_FOUND/permission
    // errors are permanent and fail fast (no wasted retries on the ~32 genuinely
    // absent secrets).
    const maxAttempts = Math.max(1, Number(process.env.GCP_SECRET_FETCH_ATTEMPTS) || 3);
    const TRANSIENT_GRPC = new Set([4, 8, 10, 13, 14]); // DEADLINE_EXCEEDED, RESOURCE_EXHAUSTED, ABORTED, INTERNAL, UNAVAILABLE
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const [version] = await this.client.accessSecretVersion({
          name: this.buildVersionName(key),
        });
        const payload = version.payload?.data?.toString();
        if (!payload) {
          throw new Error(`GCP Secret "${key}" has no payload`);
        }
        return payload;
      } catch (error) {
        lastError = error;
        const code = (error as { code?: number })?.code;
        const msg = error instanceof Error ? error.message : String(error);
        const isTransient =
          (typeof code === 'number' && TRANSIENT_GRPC.has(code)) ||
          /ECONNRESET|ETIMEDOUT|socket hang up|UNAVAILABLE|DEADLINE_EXCEEDED|RESOURCE_EXHAUSTED|\bINTERNAL\b|\bABORTED\b/i.test(msg);
        if (!isTransient || attempt === maxAttempts) {
          throw error;
        }
        const backoffMs = Math.min(2000, 150 * 2 ** (attempt - 1));
        logger.warn(
          { key, attempt, maxAttempts, code, error: msg },
          'GCP secret fetch transient error — retrying',
        );
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(`GCP Secret "${key}" fetch failed after ${maxAttempts} attempts`);
  }

  async getSecrets(keys: string[]): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    await Promise.all(
      keys.map(async (key) => {
        try {
          result[key] = await this.getSecret(key);
        } catch (error) {
          logger.warn({ key, error }, 'Failed to fetch GCP secret');
        }
      })
    );
    return result;
  }

  async setSecret(key: string, value: string): Promise<void> {
    const secretId = this.resolveSecretId(key);
    const secretName = await this.ensureSecret(secretId);

    await this.client.addSecretVersion({
      parent: secretName,
      payload: {
        data: Buffer.from(value, 'utf8'),
      },
    });
  }

  async deleteSecret(key: string): Promise<void> {
    const name = this.buildSecretName(key);
    await this.client.deleteSecret({ name });
  }

  async listSecrets(): Promise<string[]> {
    const parent = this.projectPath();
    const [secrets] = await this.client.listSecrets({ parent });
    return (secrets || [])
      .map((secret) => secret.name || '')
      .filter((name) => name.startsWith(`${parent}/secrets/`))
      .map((name) => name.substring(`${parent}/secrets/`.length))
      .filter((name) => (this.prefix ? name.startsWith(`${this.prefix}-`) : true))
      .map((name) => this.stripPrefix(name));
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.client.listSecrets(
        { parent: this.projectPath(), pageSize: 1 },
        { autoPaginate: false }
      );
      return true;
    } catch (error) {
      logger.error({ error }, 'GCP Secret Manager health check failed');
      return false;
    }
  }

  async rotateSecret(key: string, value: string): Promise<void> {
    await this.setSecret(key, value);
  }

  async disconnect(): Promise<void> {
    await this.client.close();
  }

  private projectPath(): string {
    return `projects/${this.projectId}`;
  }

  private resolveSecretId(key: string): string {
    return this.prefix ? `${this.prefix}-${key}` : key;
  }

  private stripPrefix(name: string): string {
    if (!this.prefix) {
      return name;
    }
    const prefixToken = `${this.prefix}-`;
    return name.startsWith(prefixToken) ? name.substring(prefixToken.length) : name;
  }

  private buildSecretName(key: string): string {
    return `${this.projectPath()}/secrets/${this.resolveSecretId(key)}`;
  }

  private buildVersionName(key: string): string {
    return `${this.buildSecretName(key)}/versions/latest`;
  }

  private async ensureSecret(secretId: string): Promise<string> {
    const parent = this.projectPath();
    const name = `${parent}/secrets/${secretId}`;

    try {
      await this.client.getSecret({ name });
      return name;
    } catch (error: unknown) {
      // GCP error code 5 = NOT_FOUND
      // Type guard to check if error has code property
      if (
        isObject(error) &&
        'code' in error &&
        typeof error.code === 'number' &&
        error.code === 5
      ) {
        // Secret doesn't exist, create it
        await this.client.createSecret({
          parent,
          secretId,
          secret: {
            replication: {
              automatic: {},
            },
          },
        });
        return name;
      }
      // Re-throw if it's not a NOT_FOUND error
      throw error;
    }
  }

  private async buildClientOptions(): Promise<ClientOptions | undefined> {
    if (this.credentialsJson) {
      const credentials = this.parseCredentialsJson(this.credentialsJson, 'GCP credentialsJson');
      this.validateCredentialType(credentials, 'GCP credentialsJson');
      return {
        credentials,
        projectId: this.projectId,
      } as ClientOptions;
    }

    if (this.credentialsFile) {
      const resolvedPath = this.resolveCredentialsFilePath(this.credentialsFile);

      try {
        const stat = await fs.stat(resolvedPath);
        if (!stat.isFile()) {
          this.unsetInvalidGoogleApplicationCredentials(resolvedPath);
          logger.warn(
            {
              provider: this.id,
              configuredPath: this.credentialsFile,
              resolvedPath,
            },
            'GCP credentials path is not a file; falling back to ADC/WIF'
          );
          return { projectId: this.projectId } as ClientOptions;
        }

        // NOTE: Use keyFilename instead of parsing JSON manually to support
        // service_account, authorized_user and external_account (WIF) formats.
        await this.validateCredentialFileType(resolvedPath);
        return {
          keyFilename: resolvedPath,
          projectId: this.projectId,
        } as ClientOptions;
      } catch (error: unknown) {
        const errorCode =
          isObject(error) && 'code' in error && typeof error.code === 'string'
            ? error.code
            : undefined;
        const recoverablePathError =
          errorCode === 'ENOENT' || errorCode === 'EISDIR' || errorCode === 'EACCES';

        if (recoverablePathError) {
          this.unsetInvalidGoogleApplicationCredentials(resolvedPath);
          logger.warn(
            {
              provider: this.id,
              configuredPath: this.credentialsFile,
              resolvedPath,
              error: error instanceof Error ? error.message : String(error),
            },
            'GCP credentials file is unavailable; falling back to ADC/WIF'
          );
          return { projectId: this.projectId } as ClientOptions;
        }

        throw error;
      }
    }

    return { projectId: this.projectId } as ClientOptions;
  }

  private resolveCredentialsFilePath(filePath: string): string {
    const trimmed = filePath.trim();
    if (trimmed.startsWith('~')) {
      return path.resolve(trimmed.replace(/^~(?=$|[\\/])/, os.homedir()));
    }
    return path.resolve(trimmed);
  }

  private unsetInvalidGoogleApplicationCredentials(resolvedPath: string): void {
    const envPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (!envPath) {
      return;
    }

    const resolvedEnvPath = this.resolveCredentialsFilePath(envPath);
    if (resolvedEnvPath === resolvedPath) {
      delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    }
  }

  private parseCredentialsJson(raw: string, source: string): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isObject(parsed)) {
        throw new Error('credentials must be a JSON object');
      }
      return parsed as Record<string, unknown>;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${source} is invalid JSON: ${message}`);
    }
  }

  private async validateCredentialFileType(filePath: string): Promise<void> {
    const raw = await fs.readFile(filePath, 'utf8');
    const credentials = this.parseCredentialsJson(raw, `GCP credentials file (${filePath})`);
    this.validateCredentialType(credentials, `GCP credentials file (${filePath})`);
  }

  private validateCredentialType(
    credentials: Record<string, unknown>,
    source: string
  ): void {
    const credentialTypeRaw = credentials.type;
    const credentialType =
      typeof credentialTypeRaw === 'string' ? credentialTypeRaw.trim().toLowerCase() : '';

    if (!credentialType) {
      logger.warn(
        { provider: this.id, source },
        'GCP credentials type not found; continuing with runtime ADC validation'
      );
      return;
    }

    const disallowAuthorizedUser = this.shouldDisallowAuthorizedUserCredentials();
    if (credentialType === 'authorized_user' && disallowAuthorizedUser) {
      throw new Error(
        `${source} uses credential type "authorized_user", which is not allowed for production ` +
          `secrets bootstrap. Use a service account key or Workload Identity Federation ` +
          `(set SECRETS_GCP_ALLOW_AUTHORIZED_USER=true only for local diagnostics).`
      );
    }
  }

  private shouldDisallowAuthorizedUserCredentials(): boolean {
    const allowAuthorizedUser =
      (process.env.SECRETS_GCP_ALLOW_AUTHORIZED_USER || '').trim().toLowerCase() === 'true';
    if (allowAuthorizedUser) {
      return false;
    }

    const disallowEnv = (process.env.SECRETS_GCP_DISALLOW_AUTHORIZED_USER || '')
      .trim()
      .toLowerCase();
    if (disallowEnv === 'true') {
      return true;
    }
    if (disallowEnv === 'false') {
      return false;
    }

    return process.env.NODE_ENV === 'production';
  }

  private applyGoogleProxyBypass(): void {
    const gcpPrimary = (process.env.SECRETS_PROVIDER_PRIMARY || '').trim().toLowerCase() === 'gcp';
    const bypassEnv = (process.env.SECRETS_GCP_BYPASS_PROXY || '').trim().toLowerCase();
    const bypassEnabled = bypassEnv === 'true' || (bypassEnv !== 'false' && gcpPrimary);
    if (!bypassEnabled) {
      return;
    }

    const expectedNoProxyHosts = [
      '127.0.0.1',
      'localhost',
      '.googleapis.com',
      'googleapis.com',
      '.google.com',
      'metadata.google.internal',
    ];
    const noProxyValues = [process.env.NO_PROXY, process.env.no_proxy]
      .filter((value): value is string => typeof value === 'string')
      .flatMap((value) => value.split(','))
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    const mergedNoProxy = Array.from(new Set([...noProxyValues, ...expectedNoProxyHosts])).join(',');

    if (process.env.NO_PROXY !== mergedNoProxy || process.env.no_proxy !== mergedNoProxy) {
      process.env.NO_PROXY = mergedNoProxy;
      process.env.no_proxy = mergedNoProxy;
      logger.info(
        { provider: this.id, noProxyEntries: expectedNoProxyHosts },
        'Updated NO_PROXY to bypass proxy for Google API domains'
      );
    }

    const sanitizeLoopbackEnv = (process.env.SECRETS_GCP_SANITIZE_LOOPBACK_PROXY || '')
      .trim()
      .toLowerCase();
    const sanitizeLoopback =
      sanitizeLoopbackEnv === 'true' || (sanitizeLoopbackEnv !== 'false' && gcpPrimary);
    if (!sanitizeLoopback) {
      return;
    }

    const allowLoopbackProxy =
      (process.env.SECRETS_GCP_ALLOW_LOOPBACK_PROXY || '').trim().toLowerCase() === 'true';
    if (allowLoopbackProxy) {
      return;
    }

    const proxyKeys = [
      'HTTP_PROXY',
      'http_proxy',
      'HTTPS_PROXY',
      'https_proxy',
      'ALL_PROXY',
      'all_proxy',
      'GRPC_PROXY',
      'grpc_proxy',
    ] as const;

    for (const key of proxyKeys) {
      const raw = process.env[key];
      if (!raw) {
        continue;
      }
      const parsed = this.parseProxyUrl(raw);
      if (!parsed) {
        continue;
      }

      if (this.isLoopbackHost(parsed.hostname)) {
        delete process.env[key];
        logger.warn(
          { provider: this.id, envVar: key, host: parsed.hostname, port: parsed.port || '' },
          'Removed loopback proxy configuration for GCP Secret Manager access'
        );
      }
    }
  }

  private parseProxyUrl(raw: string): URL | null {
    try {
      const value = raw.trim();
      if (!value) {
        return null;
      }
      if (value.includes('://')) {
        return new URL(value);
      }
      return new URL(`http://${value}`);
    } catch {
      return null;
    }
  }

  private isLoopbackHost(host: string): boolean {
    const normalized = host.trim().toLowerCase();
    return (
      normalized === '127.0.0.1' ||
      normalized === '::1' ||
      normalized === 'localhost' ||
      normalized.startsWith('127.')
    );
  }
}

