/**
 * Benchmark Scheduler
 *
 * Controls benchmark operations:
 * - Run projects sequentially
 * - Checkpointing for resume capability
 * - Progress tracking
 * - Event emission
 * - Graceful shutdown
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type {
  C4Project,
  Checkpoint,
  RunResult,
  BenchmarkEvent,
  EventHandler,
  SchedulerSettings,
} from '../types';

export class BenchmarkScheduler {
  private settings: SchedulerSettings;
  private dataDir: string;
  private checkpoint: Checkpoint;
  private eventHandlers: EventHandler[] = [];
  private isRunning = false;
  private shouldStop = false;

  constructor(settings: SchedulerSettings, dataDir: string) {
    this.settings = settings;
    this.dataDir = dataDir;
    this.checkpoint = this.createInitialCheckpoint();
  }

  /**
   * Create initial checkpoint
   */
  private createInitialCheckpoint(): Checkpoint {
    return {
      currentProject: null,
      completedProjects: [],
      failedProjects: [],
      lastCheckpoint: new Date().toISOString(),
    };
  }

  /**
   * Register an event handler
   */
  onEvent(handler: EventHandler): void {
    this.eventHandlers.push(handler);
  }

  /**
   * Emit an event to all handlers
   */
  private async emit(event: BenchmarkEvent): Promise<void> {
    for (const handler of this.eventHandlers) {
      try {
        await handler(event);
      } catch (error) {
        console.error('[Scheduler] Event handler error:', error);
      }
    }
  }

  /**
   * Start benchmark run
   */
  async start(projects: C4Project[]): Promise<void> {
    if (this.isRunning) {
      throw new Error('Benchmark is already running');
    }

    this.isRunning = true;
    this.shouldStop = false;

    console.log(`[Scheduler] Starting benchmark with ${projects.length} projects`);

    // Setup signal handlers for graceful shutdown
    this.setupSignalHandlers();

    try {
      await this.runBenchmark(projects);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Stop the benchmark gracefully
   */
  stop(): void {
    console.log('[Scheduler] Stop requested, will stop after current project');
    this.shouldStop = true;
  }

  /**
   * Main benchmark loop - runs each project once
   */
  private async runBenchmark(projects: C4Project[]): Promise<void> {
    for (const project of projects) {
      if (this.shouldStop) break;

      // Skip already completed projects
      if (this.checkpoint.completedProjects.includes(project.name)) {
        console.log(`[Scheduler] Skipping completed project: ${project.name}`);
        continue;
      }

      this.checkpoint.currentProject = project.name;

      await this.emit({
        type: 'project_started',
        project: project.name,
        timestamp: new Date().toISOString(),
      });

      try {
        const result = await this.runAudit(project);

        await this.emit({
          type: 'audit_completed',
          project: project.name,
          ddFindingsCount: result.dd_findings.total,
          groundTruthCount: result.ground_truth.total,
        });

        await this.emit({
          type: 'project_completed',
          project: project.name,
        });

        this.checkpoint.completedProjects.push(project.name);
      } catch (error) {
        console.error(`[Scheduler] Project failed: ${project.name}`, error);
        this.checkpoint.failedProjects.push(project.name);

        await this.emit({
          type: 'error',
          message: error instanceof Error ? error.message : String(error),
          project: project.name,
        });
      }

      this.checkpoint.currentProject = null;
      await this.saveCheckpoint();
    }

    console.log('[Scheduler] Benchmark completed');
    console.log(`[Scheduler] Completed: ${this.checkpoint.completedProjects.length}`);
    console.log(`[Scheduler] Failed: ${this.checkpoint.failedProjects.length}`);
  }

  /**
   * Run audit for a single project
   * Override this method with actual audit logic
   */
  protected async runAudit(project: C4Project): Promise<RunResult> {
    console.log(`[Scheduler] Running audit for ${project.name}`);

    // Simulate audit time
    await this.sleep(1000);

    // Return placeholder result
    return {
      project: project.name,
      timestamp: new Date().toISOString(),
      duration_seconds: 1,
      ground_truth: {
        total: 0,
        by_severity: {},
        findings: [],
      },
      dd_findings: {
        total: 0,
        findings: [],
      },
      metadata: {
        dd_version: '1.0.0',
        benchmark_version: '2.0.0',
        tools_used: [],
        methods_used: [],
      },
    };
  }

  /**
   * Save checkpoint to disk
   */
  async saveCheckpoint(): Promise<void> {
    this.checkpoint.lastCheckpoint = new Date().toISOString();

    const checkpointPath = path.join(this.dataDir, 'checkpoint.json');
    await fs.mkdir(this.dataDir, { recursive: true });
    await fs.writeFile(checkpointPath, JSON.stringify(this.checkpoint, null, 2));

    await this.emit({
      type: 'checkpoint_saved',
      checkpoint: this.checkpoint,
    });

    console.log(`[Scheduler] Checkpoint saved: ${this.checkpoint.lastCheckpoint}`);
  }

  /**
   * Load checkpoint from disk
   */
  async loadCheckpoint(): Promise<Checkpoint | null> {
    const checkpointPath = path.join(this.dataDir, 'checkpoint.json');
    try {
      const content = await fs.readFile(checkpointPath, 'utf-8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  /**
   * Get current checkpoint
   */
  getCheckpoint(): Checkpoint {
    return { ...this.checkpoint };
  }

  /**
   * Setup signal handlers for graceful shutdown
   */
  private setupSignalHandlers(): void {
    const handler = () => {
      console.log('\n[Scheduler] Received signal, initiating graceful shutdown...');
      this.stop();
    };

    process.on('SIGINT', handler);
    process.on('SIGTERM', handler);
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
