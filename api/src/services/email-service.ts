// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Email Service
 * Enterprise-grade email delivery for authentication flows
 */

import { config } from '@/config';
import { logger } from '@/utils/logger';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

type SendFunction = (message: EmailMessage) => Promise<void>;

class EmailService {
  private readonly log = logger.child({ service: 'email-service' });
  private sendFn?: SendFunction;
  private sendgridClient?: unknown;
  private sesClient?: unknown;
  private sesCommand?: unknown;
  private smtpTransporter?: {
    sendMail: (options: {
      from: string;
      to: string;
      subject: string;
      text?: string;
      html?: string;
    }) => Promise<{ messageId: string }>;
  };

  async send(message: EmailMessage): Promise<void> {
    // Test isolation: if tests explicitly request the console provider, ensure we don't reuse a cached
    // SMTP/SendGrid/SES sender from previous runs (which would attempt real network calls).
    const envProviderRaw = process.env.AUTH_EMAIL_PROVIDER;
    const envProvider = envProviderRaw?.toLowerCase().trim();
    if (process.env.NODE_ENV === 'test' && envProvider === 'console') {
      this.sendFn = undefined;
      this.sendgridClient = undefined;
      this.sesClient = undefined;
      this.sesCommand = undefined;
      this.smtpTransporter = undefined;
    }

    // Always re-initialize if not initialized yet
    if (!this.sendFn) {
      try {
        this.sendFn = await this.initialize();
      } catch (error) {
        this.log.error({ error }, 'Failed to initialize email service, will retry on next call');
        // Clear any partial state
        this.sendFn = undefined;
        this.sendgridClient = undefined;
        this.sesClient = undefined;
        this.smtpTransporter = undefined;
        throw error;
      }
    }

    try {
      await this.sendFn(message);
    } catch (error) {
      // If sending fails with configuration error, clear cache and retry
      // This handles cases where env vars become available after first initialization
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isConfigError =
        errorMessage.includes('SendGrid API key not configured') ||
        errorMessage.includes('SMTP configuration') ||
        errorMessage.includes('configuration missing') ||
        errorMessage.includes('configuration incomplete');

      if (isConfigError) {
        this.log.warn(
          { errorMessage },
          'Email send failed with configuration error, clearing cache and re-initializing...'
        );
        this.sendFn = undefined;
        this.sendgridClient = undefined;
        this.sesClient = undefined;
        this.smtpTransporter = undefined;

        // Retry once with fresh initialization
        try {
          this.sendFn = await this.initialize();
          await this.sendFn(message);
        } catch (retryError) {
          this.log.error({ error: retryError }, 'Failed to send email after re-initialization');
          throw retryError;
        }
      } else {
        throw error;
      }
    }
  }

  async sendLoginCode(email: string, code: string, expiresAt: Date): Promise<void> {
    const subject = 'Your Ailin access code';
    const minutes = Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 60000));

    const text = [
      'Use the verification code below to finish signing in to Ailin:',
      '',
      `    ${code}`,
      '',
      `This code expires in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      '',
      'If you did not request this code, please contact your administrator immediately.',
    ].join('\n');

    const html = `
      <p>Use the verification code below to finish signing in to <strong>Ailin</strong>:</p>
      <p style="font-size: 24px; letter-spacing: 4px; font-weight: bold;">${code}</p>
      <p>This code expires in <strong>${minutes} minute${minutes === 1 ? '' : 's'}</strong>.</p>
      <p style="color:#555;font-size:14px;">If you did not request this code, contact your administrator immediately.</p>
    `;

    await this.send({ to: email, subject, text, html });
  }

  private async initialize(): Promise<SendFunction> {
    // Re-read provider from environment to ensure we have the latest value
    // This is important because config may be initialized before env vars are available
    const envProviderRaw = process.env.AUTH_EMAIL_PROVIDER;
    const envProvider = envProviderRaw?.toLowerCase().trim();

    // Check if SMTP environment variables are present - if so, force SMTP provider
    const hasSmtpEnvVars = !!(
      process.env.SMTP_HOST &&
      process.env.SMTP_USER &&
      process.env.SMTP_PASS
    );

    // Determine provider: prioritize SMTP if env vars are present, otherwise use config or env
    const configuredProvider = (envProvider || config.auth.email.provider || '').toLowerCase().trim();

    // IMPORTANT: In tests and local development, we often set AUTH_EMAIL_PROVIDER=console to avoid
    // sending real emails. Do not override an explicit "console" provider just because SMTP env vars exist.
    const shouldForceSmtpFromEnv = hasSmtpEnvVars && configuredProvider !== 'console';

    const provider = shouldForceSmtpFromEnv ? 'smtp' : configuredProvider;
    if (shouldForceSmtpFromEnv) {
      console.error('🔧 FORCING SMTP PROVIDER: SMTP environment variables detected');
    }

    // Log provider selection for debugging - use console.error to ensure it appears in logs
    console.error(
      '🔧 EMAIL SERVICE INITIALIZE:',
      JSON.stringify(
        {
          provider,
          providerLength: provider?.length,
          providerCharCodes: provider?.split('').map((c) => c.charCodeAt(0)),
          configProvider: config.auth.email.provider,
          envProviderRaw,
          envProvider,
          hasSmtpEnvVars,
          hasSmtpConfig: !!config.auth.email.smtp,
          hasSendgridConfig: !!config.auth.email.sendgrid,
          smtpHost: process.env.SMTP_HOST,
          smtpUser: process.env.SMTP_USER,
          smtpPass: process.env.SMTP_PASS ? '***' : undefined,
          allEnvKeys: Object.keys(process.env).filter(
            (k) => k.includes('AUTH') || k.includes('SMTP') || k.includes('EMAIL')
          ),
        },
        null,
        2
      )
    );

    this.log.info(
      {
        provider,
        configProvider: config.auth.email.provider,
        envProvider: process.env.AUTH_EMAIL_PROVIDER,
        hasSmtpEnvVars,
        hasSmtpConfig: !!config.auth.email.smtp,
        hasSendgridConfig: !!config.auth.email.sendgrid,
        smtpHost: process.env.SMTP_HOST,
        smtpUser: process.env.SMTP_USER,
      },
      'Initializing email service'
    );

    // Use explicit comparison to handle any whitespace issues
    if (provider === 'smtp' || provider?.trim() === 'smtp') {
      // Always use SMTP from env if env vars are present, even if config doesn't have it
      if (!config.auth.email.smtp || hasSmtpEnvVars) {
        this.log.warn('SMTP provider selected, using environment variables');
        return this.initializeSMTPFromEnv();
      }
      return this.initializeSMTP();
    }

    if (provider === 'ses' || provider?.trim() === 'ses') {
      return this.initializeSES();
    }

    if (provider === 'sendgrid' || provider?.trim() === 'sendgrid') {
      // If we have SMTP env vars but provider is sendgrid, that's a configuration issue
      if (hasSmtpEnvVars) {
        console.error(
          '⚠️ ERROR: AUTH_EMAIL_PROVIDER is "sendgrid" but SMTP env vars are present. Forcing SMTP.'
        );
        return this.initializeSMTPFromEnv();
      }
      console.error(
        '⚠️ WARNING: Using SendGrid provider, but AUTH_EMAIL_PROVIDER should be "smtp"'
      );
      return this.initializeSendgrid();
    }

    // Console provider for testing - just logs email to console without sending
    if (provider === 'console' || provider?.trim() === 'console') {
      this.log.info('Using console email provider (emails will be logged, not sent)');
      return this.initializeConsole();
    }

    throw new Error(
      `Unsupported email provider: "${provider}" (type: ${typeof provider}, length: ${provider?.length})`
    );
  }

  private async initializeSMTPFromEnv(): Promise<SendFunction> {
    const host = process.env.SMTP_HOST || '';
    const port = parseInt(process.env.SMTP_PORT || '587', 10);
    const user = process.env.SMTP_USER || '';
    const pass = process.env.SMTP_PASS || '';
    const secureEnv = process.env.SMTP_SECURE;
    const secure = secureEnv ? secureEnv.toLowerCase() === 'true' : port === 465;

    // Log SMTP configuration for debugging
    this.log.info(
      {
        host,
        port,
        hasUser: !!user,
        hasPass: !!pass,
        secure,
      },
      'Initializing SMTP email service from environment variables'
    );

    if (!host || !user || !pass) {
      throw new Error('SMTP configuration incomplete. Set SMTP_HOST, SMTP_USER, and SMTP_PASS.');
    }

    interface NodemailerModule {
      createTransport: (config: {
        host: string;
        port: number;
        secure: boolean;
        auth: {
          user: string;
          pass: string;
        };
      }) => {
        sendMail: (options: {
          from: string;
          to: string;
          subject: string;
          text?: string;
          html?: string;
        }) => Promise<{ messageId: string }>;
      };
    }
    const nodemailer = (await import('nodemailer')) as NodemailerModule;
    this.smtpTransporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: {
        user,
        pass,
      },
    });

    const fromEmail = process.env.AUTH_EMAIL_FROM_EMAIL || process.env.SMTP_FROM_EMAIL || user;
    const fromName = process.env.AUTH_EMAIL_FROM_NAME || 'Ailin Platform';

    return async (message: EmailMessage) => {
      if (!this.smtpTransporter) {
        throw new Error('SMTP transporter not initialized');
      }
      try {
        await this.smtpTransporter.sendMail({
          from: fromName ? `"${fromName}" <${fromEmail}>` : fromEmail,
          to: message.to,
          subject: message.subject,
          text: message.text,
          html: message.html ?? message.text.replace(/\n/g, '<br>'),
        });
        this.log.debug({ provider: 'smtp', to: message.to }, 'Email sent');
      } catch (error) {
        this.log.error({ error }, 'Failed to send email via SMTP');
        throw error instanceof Error ? error : new Error('Failed to send email via SMTP');
      }
    };
  }

  /**
   * Console email provider - logs emails instead of sending them
   * Useful for testing and development environments
   */
  private async initializeConsole(): Promise<SendFunction> {
    this.log.info('Console email provider initialized - emails will be logged to console');
    
    return async (message: EmailMessage) => {
      // Log the email content to console for debugging/testing
      console.log('📧 EMAIL (console provider):');
      console.log('  To:', message.to);
      console.log('  Subject:', message.subject);
      console.log('  Text:', message.text?.substring(0, 200) + (message.text && message.text.length > 200 ? '...' : ''));
      
      this.log.info(
        { 
          provider: 'console', 
          to: message.to, 
          subject: message.subject 
        }, 
        'Email logged (not sent - console provider)'
      );
    };
  }

  private async initializeSendgrid(): Promise<SendFunction> {
    // Double-check if SMTP env vars are available - if so, we should use SMTP instead
    const hasSmtpEnvVars = !!(
      process.env.SMTP_HOST &&
      process.env.SMTP_USER &&
      process.env.SMTP_PASS
    );
    if (hasSmtpEnvVars) {
      console.error(
        '⚠️ ERROR: initializeSendgrid() called but SMTP env vars are present. Redirecting to SMTP.'
      );
      return this.initializeSMTPFromEnv();
    }

    const apiKey = config.auth.email.sendgrid?.apiKey || process.env.SENDGRID_API_KEY;
    if (!apiKey) {
      // Before throwing error, check if SMTP is available as fallback
      if (hasSmtpEnvVars) {
        console.error(
          '⚠️ SendGrid API key not configured, but SMTP env vars are present. Using SMTP instead.'
        );
        return this.initializeSMTPFromEnv();
      }
      throw new Error(
        'SendGrid API key not configured. Set SENDGRID_API_KEY or choose a different provider.'
      );
    }

    const sgMailModule = await import('@sendgrid/mail');
    this.sendgridClient = sgMailModule.default;
    if (typeof this.sendgridClient === 'object' && this.sendgridClient !== null && 'setApiKey' in this.sendgridClient && typeof this.sendgridClient.setApiKey === 'function') {
      this.sendgridClient.setApiKey(apiKey);
    }

    const fromEmail = config.auth.email.fromEmail || 'noreply@ailin.dev';
    const fromName = config.auth.email.fromName || 'Ailin Platform';

    return async (message: EmailMessage) => {
      if (!this.sendgridClient || typeof this.sendgridClient !== 'object' || !('send' in this.sendgridClient) || typeof this.sendgridClient.send !== 'function') {
        throw new Error('SendGrid client not initialized');
      }
      try {
        await this.sendgridClient.send({
          to: message.to,
          from: {
            email: fromEmail,
            name: fromName,
          },
          subject: message.subject,
          text: message.text,
          html: message.html ?? message.text.replace(/\n/g, '<br>'),
        });
        this.log.debug({ provider: 'sendgrid', to: message.to }, 'Email sent');
      } catch (error) {
        this.log.error({ error }, 'Failed to send email via SendGrid');
        throw error instanceof Error ? error : new Error('Failed to send email via SendGrid');
      }
    };
  }

  private async initializeSES(): Promise<SendFunction> {
    const region = config.auth.email.ses?.region;
    if (!region) {
      throw new Error(
        'AWS SES region not configured. Set AWS_SES_REGION or AUTH_EMAIL_PROVIDER to another provider.'
      );
    }

    const { SESClient, SendEmailCommand } = await import('@aws-sdk/client-ses');
    this.sesClient = new SESClient({
      region,
      credentials:
        config.auth.email.ses?.accessKeyId && config.auth.email.ses?.secretAccessKey
          ? {
              accessKeyId: config.auth.email.ses.accessKeyId,
              secretAccessKey: config.auth.email.ses.secretAccessKey,
            }
          : undefined,
    });
    this.sesCommand = SendEmailCommand;

    const fromEmail = config.auth.email.fromEmail || 'noreply@ailin.dev';
    const fromName = config.auth.email.fromName || 'Ailin Platform';

    return async (message: EmailMessage) => {
      if (!this.sesClient || typeof this.sesClient !== 'object' || !('send' in this.sesClient) || typeof this.sesClient.send !== 'function') {
        throw new Error('SES client not initialized');
      }
      if (!this.sesCommand || typeof this.sesCommand !== 'function') {
        throw new Error('SES command not initialized');
      }
      // Type guard: verify sesCommand is constructable
      const SesCommandClass = this.sesCommand as new (args: {
        Source: string;
        Destination: { ToAddresses: string[] };
        Message: {
          Subject: { Data: string; Charset: string };
          Body: { Text: { Data: string; Charset: string }; Html?: { Data: string; Charset: string } };
        };
      }) => unknown;
      try {
        await this.sesClient.send(
          new SesCommandClass({
            Source: fromName ? `"${fromName}" <${fromEmail}>` : fromEmail,
            Destination: {
              ToAddresses: [message.to],
            },
            Message: {
              Subject: {
                Data: message.subject,
                Charset: 'UTF-8',
              },
              Body: {
                Text: {
                  Data: message.text,
                  Charset: 'UTF-8',
                },
                ...(message.html && {
                  Html: {
                    Data: message.html,
                    Charset: 'UTF-8',
                  },
                }),
              },
            },
          })
        );
        this.log.debug({ provider: 'ses', to: message.to }, 'Email sent');
      } catch (error) {
        this.log.error({ error }, 'Failed to send email via SES');
        throw error instanceof Error ? error : new Error('Failed to send email via SES');
      }
    };
  }

  private async initializeSMTP(): Promise<SendFunction> {
    const smtpConfig = config.auth.email.smtp;

    // Log SMTP configuration for debugging
    this.log.info(
      {
        hasSmtpConfig: !!smtpConfig,
        host: smtpConfig?.host,
        port: smtpConfig?.port,
        hasUser: !!smtpConfig?.auth?.user,
        hasPass: !!smtpConfig?.auth?.pass,
        envHost: process.env.SMTP_HOST,
        envPort: process.env.SMTP_PORT,
        envUser: process.env.SMTP_USER,
      },
      'Initializing SMTP email service'
    );

    if (!smtpConfig) {
      throw new Error(
        'SMTP configuration missing. Set SMTP_HOST, SMTP_PORT, SMTP_USER, and SMTP_PASS.'
      );
    }

    interface NodemailerModule {
      createTransport: (config: {
        host: string;
        port: number;
        secure: boolean;
        auth: {
          user: string;
          pass: string;
        };
      }) => {
        sendMail: (options: {
          from: string;
          to: string;
          subject: string;
          text?: string;
          html?: string;
        }) => Promise<{ messageId: string }>;
      };
    }
    const nodemailer = (await import('nodemailer')) as NodemailerModule;
    this.smtpTransporter = nodemailer.createTransport({
      host: smtpConfig.host,
      port: smtpConfig.port,
      secure: smtpConfig.secure,
      auth: smtpConfig.auth,
    });

    const fromEmail = config.auth.email.fromEmail || smtpConfig.auth.user;
    const fromName = config.auth.email.fromName || 'Ailin Platform';

    return async (message: EmailMessage) => {
      if (!this.smtpTransporter) {
        throw new Error('SMTP transporter not initialized');
      }
      try {
        await this.smtpTransporter.sendMail({
          from: fromName ? `"${fromName}" <${fromEmail}>` : fromEmail,
          to: message.to,
          subject: message.subject,
          text: message.text,
          html: message.html ?? message.text.replace(/\n/g, '<br>'),
        });
        this.log.debug({ provider: 'smtp', to: message.to }, 'Email sent');
      } catch (error) {
        this.log.error({ error }, 'Failed to send email via SMTP');
        throw error instanceof Error ? error : new Error('Failed to send email via SMTP');
      }
    };
  }
}

let globalEmailService: EmailService | null = null;

export function getEmailService(): EmailService {
  if (!globalEmailService) {
    globalEmailService = new EmailService();
  }
  return globalEmailService;
}
