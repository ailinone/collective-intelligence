// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Model Discovery Scheduler
 *
 * Agenda e coordena a descoberta automática de modelos de todos os provedores/hubs.
 * Executa descobertas diárias e validações periódicas.
 */

import { logger } from '@/utils/logger';
import { getModelDiscoveryService } from './model-discovery-service';
import { getModelValidationService } from './model-validation-service';
import { getModelRepository } from './model-repository';

export interface DiscoverySchedule {
  id: string;
  name: string;
  cron: string; // Cron expression ou intervalo simples
  providers?: string[]; // Provedores específicos ou todos se undefined
  enabled: boolean;
  lastRun?: Date;
  nextRun?: Date;
  priority: number;
}

export class ModelDiscoveryScheduler {
  private schedules: Map<string, DiscoverySchedule> = new Map();
  private running = false;
  private timers: Map<string, NodeJS.Timeout> = new Map();

  constructor(
    private discoveryService = getModelDiscoveryService(),
    private validationService = getModelValidationService(),
    private repository = getModelRepository()
  ) {
    this.initializeDefaultSchedules();
  }

  /**
   * Inicializa schedules padrão
   */
  private initializeDefaultSchedules(): void {
    // Descoberta completa diária às 2:00 AM
    this.addSchedule({
      id: 'daily-full-discovery',
      name: 'Descoberta Completa Diária',
      cron: '0 2 * * *', // Todos os dias às 2:00 AM
      enabled: true,
      priority: 1,
    });

    // Descoberta incremental a cada 4 horas
    this.addSchedule({
      id: 'hourly-incremental-discovery',
      name: 'Descoberta Incremental',
      cron: '0 */4 * * *', // A cada 4 horas
      enabled: true,
      priority: 2,
    });

    // Validação de modelos críticos a cada 30 minutos
    this.addSchedule({
      id: 'critical-models-validation',
      name: 'Validação Modelos Críticos',
      cron: '*/30 * * * *', // A cada 30 minutos
      enabled: true,
      priority: 3,
    });

    // Validação geral a cada 2 horas
    this.addSchedule({
      id: 'general-models-validation',
      name: 'Validação Geral',
      cron: '0 */2 * * *', // A cada 2 horas
      enabled: true,
      priority: 4,
    });
  }

  /**
   * Adiciona um novo schedule
   */
  addSchedule(schedule: DiscoverySchedule): void {
    this.schedules.set(schedule.id, schedule);
    // Only schedule timers when the scheduler is actually running.
    // This avoids unintended background discovery/validation during tests or simple status reads.
    this.scheduleNextRun(schedule);
    logger.info({ scheduleId: schedule.id, schedule: schedule.name }, 'Schedule adicionado');
  }

  /**
   * Remove um schedule
   */
  removeSchedule(scheduleId: string): void {
    const schedule = this.schedules.get(scheduleId);
    if (schedule) {
      const timer = this.timers.get(scheduleId);
      if (timer) {
        clearTimeout(timer);
        this.timers.delete(scheduleId);
      }
      this.schedules.delete(scheduleId);
      logger.info({ scheduleId }, 'Schedule removido');
    }
  }

  /**
   * Agenda a próxima execução de um schedule
   */
  private scheduleNextRun(schedule: DiscoverySchedule): void {
    if (!schedule.enabled) return;

    const now = new Date();
    const nextRun = this.calculateNextRun(schedule.cron, now);

    schedule.nextRun = nextRun;
    this.schedules.set(schedule.id, schedule);

    // Do not create timers until start() is called.
    if (!this.running) {
      return;
    }

    const delay = nextRun.getTime() - now.getTime();

    // Limpa timer anterior se existir
    const existingTimer = this.timers.get(schedule.id);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Agenda nova execução
    const timer = setTimeout(() => {
      this.executeSchedule(schedule);
    }, delay);

    this.timers.set(schedule.id, timer);

    logger.debug({
      scheduleId: schedule.id,
      nextRun: nextRun.toISOString(),
      delayMs: delay
    }, 'Próxima execução agendada');
  }

  /**
   * Calcula próxima execução baseada em cron expression simples
   */
  private calculateNextRun(cron: string, now: Date): Date {
    const trimmed = cron.trim();

    // Common schedules used by this service:
    // - "*/30 * * * *" (every 30 minutes)
    // - "0 */4 * * *" (every 4 hours at minute 0)
    // - "0 */2 * * *" (every 2 hours at minute 0)
    // - "0 2 * * *"   (daily at 02:00)
    //
    // We compute the next run strictly AFTER the provided `now` to avoid negative delays.
    const base = new Date(now.getTime() + 60_000); // +1 minute to ensure future scheduling
    base.setSeconds(0, 0);

    const everyMinutes = trimmed.match(/^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/);
    if (everyMinutes) {
      const intervalMinutes = Number.parseInt(everyMinutes[1], 10);
      if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
        return new Date(base.getTime() + 60 * 60 * 1000);
      }

      const minutesInDay = base.getHours() * 60 + base.getMinutes();
      const nextMinutesInDay = Math.ceil(minutesInDay / intervalMinutes) * intervalMinutes;
      const dayMinutes = 24 * 60;

      const dayOffset = Math.floor(nextMinutesInDay / dayMinutes);
      const minuteOfDay = nextMinutesInDay % dayMinutes;

      const next = new Date(base);
      next.setDate(next.getDate() + dayOffset);
      next.setHours(Math.floor(minuteOfDay / 60), minuteOfDay % 60, 0, 0);
      return next;
    }

    const everyHoursAtMinuteZero = trimmed.match(/^0\s+\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/);
    if (everyHoursAtMinuteZero) {
      const intervalHours = Number.parseInt(everyHoursAtMinuteZero[1], 10);
      if (!Number.isFinite(intervalHours) || intervalHours <= 0) {
        return new Date(base.getTime() + 60 * 60 * 1000);
      }

      const next = new Date(base);
      // Move to the next hour boundary if we're not exactly at minute 0
      if (next.getMinutes() !== 0) {
        next.setHours(next.getHours() + 1, 0, 0, 0);
      } else {
        next.setMinutes(0, 0, 0);
      }

      const hour = next.getHours();
      const alignedHour = Math.ceil(hour / intervalHours) * intervalHours;
      const dayOffset = Math.floor(alignedHour / 24);
      const hourOfDay = alignedHour % 24;

      next.setDate(next.getDate() + dayOffset);
      next.setHours(hourOfDay, 0, 0, 0);
      return next;
    }

    const dailyAtHour = trimmed.match(/^0\s+(\d+)\s+\*\s+\*\s+\*\s+\*$/);
    if (dailyAtHour) {
      const targetHour = Number.parseInt(dailyAtHour[1], 10);
      if (!Number.isFinite(targetHour) || targetHour < 0 || targetHour > 23) {
        return new Date(base.getTime() + 60 * 60 * 1000);
      }

      const next = new Date(base);
      next.setHours(targetHour, 0, 0, 0);
      if (next <= base) {
        next.setDate(next.getDate() + 1);
      }
      return next;
    }

    // Suporte básico para cron expressions simples
    // Formato: "MINUTE HOUR DAY MONTH DAYOFWEEK"
    const parts = cron.split(' ');

    if (parts.length !== 5) {
      // Assume que é um intervalo em minutos (ex: "*/30" = a cada 30 minutos)
      const intervalMinutes = parseInt(cron.replace('*/', ''));
      if (!isNaN(intervalMinutes)) {
        const next = new Date(now);
        next.setMinutes(next.getMinutes() + intervalMinutes);
        return next;
      }
      // Fallback para 1 hora
      const next = new Date(now);
      next.setHours(next.getHours() + 1);
      return next;
    }

    const [minute, hour, day, month, dayOfWeek] = parts;
    const next = new Date(now);

    // Parse minute
    const targetMinute = minute === '*' ? 0 : parseInt(minute) || 0;
    next.setMinutes(targetMinute);
    next.setSeconds(0);
    next.setMilliseconds(0);

    // Parse hour
    if (hour.startsWith('*/')) {
      // Interval hours (e.g., "*/4" = every 4 hours)
      const intervalHours = parseInt(hour.replace('*/', ''));
      next.setHours(next.getHours() + intervalHours);
    } else if (hour !== '*') {
      // Specific hour
      const targetHour = parseInt(hour);
      next.setHours(targetHour);
      if (next <= now) {
        next.setDate(next.getDate() + 1);
      }
    }

    // Parse day of month
    if (day !== '*') {
      const targetDay = parseInt(day);
      if (!isNaN(targetDay)) {
        next.setDate(targetDay);
        // If we're past this day in current month, move to next month
        if (next <= now) {
          next.setMonth(next.getMonth() + 1);
        }
      }
    }

    // Parse month (1-12 in cron, 0-11 in JS)
    if (month !== '*') {
      const targetMonth = parseInt(month) - 1; // Convert to 0-indexed
      if (!isNaN(targetMonth)) {
        next.setMonth(targetMonth);
        // If we're past this month, move to next year
        if (next <= now) {
          next.setFullYear(next.getFullYear() + 1);
        }
      }
    }

    // Parse day of week (0=Sunday, 6=Saturday)
    if (dayOfWeek !== '*') {
      const targetDayOfWeek = parseInt(dayOfWeek);
      if (!isNaN(targetDayOfWeek)) {
        const currentDayOfWeek = next.getDay();
        let daysToAdd = targetDayOfWeek - currentDayOfWeek;
        if (daysToAdd <= 0) {
          daysToAdd += 7; // Move to next week
        }
        next.setDate(next.getDate() + daysToAdd);
      }
    }

    return next;
  }

  /**
   * Executa um schedule
   */
  private async executeSchedule(schedule: DiscoverySchedule): Promise<void> {
    if (!schedule.enabled) return;

    const startTime = Date.now();
    schedule.lastRun = new Date();

    logger.info({
      scheduleId: schedule.id,
      scheduleName: schedule.name,
      priority: schedule.priority
    }, 'Iniciando execução de schedule');

    try {
      switch (schedule.id) {
        case 'daily-full-discovery':
          await this.executeFullDiscovery();
          break;

        case 'hourly-incremental-discovery':
          await this.executeIncrementalDiscovery();
          break;

        case 'critical-models-validation':
          await this.executeCriticalModelsValidation();
          break;

        case 'general-models-validation':
          await this.executeGeneralModelsValidation();
          break;

        default:
          logger.warn({ scheduleId: schedule.id }, 'Schedule não reconhecido');
      }

      const duration = Date.now() - startTime;
      logger.info({
        scheduleId: schedule.id,
        duration,
        success: true
      }, 'Schedule executado com sucesso');
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error({
        scheduleId: schedule.id,
        duration,
        error: error instanceof Error ? error.message : String(error)
      }, 'Erro na execução do schedule');
    }

    // Reagenda próxima execução
    this.scheduleNextRun(schedule);
  }

  /**
   * Executa descoberta completa de todos os provedores
   */
  private async executeFullDiscovery(): Promise<void> {
    logger.info('Executando descoberta completa de modelos');

    const result = await this.discoveryService.discoverNewModels();

    logger.info(
      { discovered: result.models.length, errors: result.errors.length, success: result.success },
      'Descoberta completa finalizada'
    );
  }

  /**
   * Executa descoberta incremental (apenas atualizações)
   */
  private async executeIncrementalDiscovery(): Promise<void> {
    logger.info('Executando descoberta incremental');

    const result = await this.discoveryService.discoverNewModels();

    logger.info(
      { discovered: result.models.length, errors: result.errors.length, success: result.success },
      'Descoberta incremental finalizada'
    );
  }

  /**
   * Executa validação de modelos críticos
   */
  private async executeCriticalModelsValidation(): Promise<void> {
    logger.info('Executando validação de modelos críticos');

    // Busca modelos com alta prioridade (usados frequentemente ou críticos)
    const candidateModels = await this.repository.searchModels({
      status: 'active',
      limit: 200,
      sortBy: 'quality',
      sortOrder: 'desc',
    });

    const criticalModels = candidateModels
      .filter((model) => (model.performance?.quality ?? 0) >= 0.75)
      .sort((a, b) => (b.performance?.quality ?? 0) - (a.performance?.quality ?? 0))
      .slice(0, 25);

    for (const model of criticalModels) {
      try {
        await this.validationService.validateModelCapabilities(model, [
          'chat', 'text_generation', 'streaming', 'function_calling'
        ]);
      } catch (error) {
        logger.error({
          modelId: model.id,
          error: error instanceof Error ? error.message : String(error)
        }, 'Erro na validação de modelo crítico');
      }
    }

    logger.info({ count: criticalModels.length }, 'Validação de modelos críticos finalizada');
  }

  /**
   * Executa validação geral de todos os modelos
   */
  private async executeGeneralModelsValidation(): Promise<void> {
    logger.info('Executando validação geral de modelos');

    // Busca todos os modelos ativos
    const allModels = await this.repository.getAllModels();

    // Valida apenas uma amostra para não sobrecarregar
    const sampleSize = Math.min(50, allModels.length);
    const sampleModels = this.sampleArray(allModels, sampleSize);

    for (const model of sampleModels) {
      try {
        await this.validationService.validateModelCapabilities(model, [
          'chat', 'text_generation'
        ]);
      } catch (error) {
        logger.error({
          modelId: model.id,
          error: error instanceof Error ? error.message : String(error)
        }, 'Erro na validação geral');
      }
    }

    logger.info({ total: allModels.length, validated: sampleModels.length },
      'Validação geral finalizada');
  }

  /**
   * Seleciona uma amostra aleatória de um array
   */
  private sampleArray<T>(array: T[], size: number): T[] {
    if (size >= array.length) return array;

    const shuffled = [...array].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, size);
  }

  /**
   * Inicia o scheduler
   */
  start(): void {
    if (process.env.NODE_ENV === 'test') {
      logger.info('Model Discovery Scheduler disabled in test environment');
      return;
    }
    if (this.running) return;

    this.running = true;
    logger.info('Model Discovery Scheduler iniciado');

    // Agenda todas as execuções iniciais
    for (const schedule of this.schedules.values()) {
      this.scheduleNextRun(schedule);
    }
  }

  /**
   * Para o scheduler
   */
  stop(): void {
    if (!this.running) return;

    this.running = false;

    // Limpa todos os timers
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();

    logger.info('Model Discovery Scheduler parado');
  }

  /**
   * Retorna status atual do scheduler
   */
  getStatus() {
    const schedules = Array.from(this.schedules.values()).map(schedule => ({
      id: schedule.id,
      name: schedule.name,
      enabled: schedule.enabled,
      lastRun: schedule.lastRun?.toISOString(),
      nextRun: schedule.nextRun?.toISOString(),
      priority: schedule.priority,
    }));

    return {
      running: this.running,
      schedules,
      activeTimers: this.timers.size,
    };
  }

  /**
   * Executa descoberta manual imediata
   */
  async executeManualDiscovery(providers?: string[]): Promise<void> {
    logger.info({ providers }, 'Executando descoberta manual');

    if (providers && providers.length > 0) {
      logger.info({ providers }, 'Descoberta manual solicitada - executando varredura completa');
    }

    await this.executeFullDiscovery();

    logger.info('Descoberta manual finalizada');
  }

  /**
   * Executa validação manual imediata
   */
  async executeManualValidation(modelIds?: string[]): Promise<void> {
    logger.info({ modelIds }, 'Executando validação manual');

    if (!modelIds || modelIds.length === 0) {
      await this.executeGeneralModelsValidation();
    } else {
      for (const modelId of modelIds) {
        try {
          const model = await this.repository.getModelById(modelId);
          if (!model) {
            logger.warn({ modelId }, 'Modelo não encontrado para validação manual');
            continue;
          }
          await this.validationService.validateModelCapabilities(model, [
            'chat', 'text_generation', 'streaming', 'function_calling'
          ]);
        } catch (error) {
          logger.error({
            modelId,
            error: error instanceof Error ? error.message : String(error)
          }, 'Erro na validação manual');
        }
      }
    }

    logger.info('Validação manual finalizada');
  }
}

// Singleton
let schedulerInstance: ModelDiscoveryScheduler | null = null;

export function getModelDiscoveryScheduler(): ModelDiscoveryScheduler {
  if (!schedulerInstance) {
    schedulerInstance = new ModelDiscoveryScheduler();
  }
  return schedulerInstance;
}
