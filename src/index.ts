/**
 * C4 Benchmark System
 *
 * Pure data collection tool. Responsibilities:
 * - Run DD audits on projects
 * - Collect ground truth findings from C4
 * - Collect DD findings with analysis metadata (process, tools, methods, methodology)
 *
 * NOT responsible for:
 * - Matching findings (TP/FP/FN classification) - Super-CC's job
 * - Score calculation (recall, precision, F1) - Super-CC's job
 * - Comparing results between runs - Super-CC's job
 * - Providing suggestions/recommendations - Super-CC's job
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as yaml from 'js-yaml';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config({ path: path.join(__dirname, '..', '.env') });

import { C4Indexer } from './indexer/c4-indexer';
import { BenchmarkScheduler } from './scheduler/benchmark-scheduler';
import { AuditRunner, type DDApiConfig } from './runner/audit-runner';
import type {
  C4Project,
  Settings,
  RunResult,
  BenchmarkEvent,
  Finding,
} from './types';

// Directory paths
const CONFIG_DIR = path.join(__dirname, '..', 'config');
const DATA_DIR = path.join(__dirname, '..', 'data');

/**
 * Load settings from YAML config
 */
async function loadSettings(): Promise<Settings> {
  const settingsPath = path.join(CONFIG_DIR, 'settings.yaml');
  const content = await fs.readFile(settingsPath, 'utf-8');
  const raw = yaml.load(content) as any;

  return {
    scheduler: {
      maxConcurrentProjects: raw.scheduler.max_concurrent_projects,
      checkpointInterval: raw.scheduler.checkpoint_interval,
      auditTimeout: raw.scheduler.audit_timeout,
      maxRetries: raw.scheduler.max_retries,
      retryDelay: raw.scheduler.retry_delay,
    },
    github: {
      organization: raw.github.organization,
      projectPattern: raw.github.project_pattern,
      requireFindings: raw.github.require_findings,
    },
  };
}

/**
 * Load projects from YAML config
 */
async function loadProjects(): Promise<C4Project[]> {
  const projectsPath = path.join(CONFIG_DIR, 'projects.yaml');
  const content = await fs.readFile(projectsPath, 'utf-8');
  const raw = yaml.load(content) as any;

  return raw.projects.map((p: any) => ({
    name: p.name,
    repo: p.repo,
    status: p.status,
    priority: p.priority,
    findingsFile: p.findings_file,
    findingsFiles: p.findings_files,
    scopeFile: p.scope_file,
    framework: p.framework || 'unknown',
    notes: p.notes,
  }));
}

/**
 * Main BenchmarkRunner class
 *
 * Pure data collector - runs audits and saves raw results.
 */
export class BenchmarkRunner {
  private settings: Settings;
  private indexer: C4Indexer;
  private scheduler: BenchmarkScheduler;
  private auditRunner: AuditRunner;

  constructor(settings: Settings, ddApiConfig: DDApiConfig) {
    this.settings = settings;

    // Initialize components
    this.indexer = new C4Indexer(
      settings.github,
      path.join(DATA_DIR, 'projects')
    );

    this.scheduler = new ExtendedScheduler(
      settings.scheduler,
      DATA_DIR,
      this
    );

    this.auditRunner = new AuditRunner(
      ddApiConfig,
      DATA_DIR
    );
  }

  /**
   * Run benchmark on all configured projects
   */
  async run(projectFilter?: string): Promise<void> {
    console.log('[Benchmark] Starting benchmark run...');

    // Load projects
    let projects = await loadProjects();

    // Filter if specified
    if (projectFilter) {
      projects = projects.filter((p) => p.name === projectFilter);
      if (projects.length === 0) {
        throw new Error(`Project not found: ${projectFilter}`);
      }
    }

    // Sort by priority
    projects.sort((a, b) => a.priority - b.priority);

    console.log(`[Benchmark] Running ${projects.length} projects`);

    // Setup event handlers
    this.scheduler.onEvent(this.handleEvent.bind(this));

    // Start the scheduler
    await this.scheduler.start(projects);
  }

  /**
   * Discover new projects from C4
   */
  async discover(): Promise<void> {
    console.log('[Benchmark] Discovering projects from code-423n4...');

    const projects = await this.indexer.discoverProjects();
    console.log(`[Benchmark] Found ${projects.length} projects`);

    await this.indexer.saveIndex(projects);
  }

  /**
   * Run a single audit for a project
   *
   * Collects raw data only - no matching or scoring.
   */
  async runAudit(project: C4Project): Promise<RunResult> {
    const startTime = Date.now();
    console.log(`[Benchmark] Running audit for ${project.name}`);

    // Step 1: Fetch ground truth
    console.log('[Benchmark] Fetching ground truth...');
    const groundTruth = await this.indexer.getGroundTruth(project);
    console.log(`[Benchmark] Ground truth: ${groundTruth.length} findings`);

    // Step 2: Run DD audit
    console.log('[Benchmark] Running DD audit...');
    const ddFindings = await this.auditRunner.runAudit(project);
    console.log(`[Benchmark] DD found: ${ddFindings.length} findings`);

    const duration = Math.round((Date.now() - startTime) / 1000);

    // Build result with raw data only
    const result = this.buildRunResult(
      project,
      groundTruth,
      ddFindings,
      duration
    );

    // Save result
    await this.saveRunResult(result);

    return result;
  }

  /**
   * Build RunResult with raw data only
   *
   * No matching or scoring - that's Super-CC's job.
   */
  private buildRunResult(
    project: C4Project,
    groundTruth: Finding[],
    ddFindings: Finding[],
    duration: number
  ): RunResult {
    // Count ground truth by severity
    const bySeverity: Record<string, number> = {};
    for (const f of groundTruth) {
      bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
    }

    // Collect tools and methods used
    const toolsUsed = new Set<string>();
    const methodsUsed = new Set<string>();
    for (const f of ddFindings) {
      if (f.detector) toolsUsed.add(f.detector);
      if (f.analysis?.tools) {
        for (const tool of f.analysis.tools) toolsUsed.add(tool);
      }
      if (f.analysis?.methods) {
        for (const method of f.analysis.methods) methodsUsed.add(method);
      }
    }

    return {
      project: project.name,
      timestamp: new Date().toISOString(),
      duration_seconds: duration,

      ground_truth: {
        total: groundTruth.length,
        by_severity: bySeverity,
        findings: groundTruth,
      },

      dd_findings: {
        total: ddFindings.length,
        findings: ddFindings,
      },

      metadata: {
        dd_version: process.env.DD_VERSION || '1.0.0',
        benchmark_version: '2.0.0',
        tools_used: Array.from(toolsUsed),
        methods_used: Array.from(methodsUsed),
      },
    };
  }

  /**
   * Save run result to disk
   */
  private async saveRunResult(result: RunResult): Promise<void> {
    const runDir = path.join(DATA_DIR, 'runs', result.project);
    await fs.mkdir(runDir, { recursive: true });

    const fileName = `run-${result.timestamp.replace(/[:.]/g, '-')}.json`;

    await fs.writeFile(
      path.join(runDir, fileName),
      JSON.stringify(result, null, 2)
    );
  }

  /**
   * Handle scheduler events
   */
  private handleEvent(event: BenchmarkEvent): void {
    switch (event.type) {
      case 'project_started':
        console.log(`\n========================================`);
        console.log(`Project: ${event.project}`);
        console.log(`========================================\n`);
        break;

      case 'audit_completed':
        console.log(`Audit completed. DD: ${event.ddFindingsCount} findings, Ground Truth: ${event.groundTruthCount} findings`);
        break;

      case 'project_completed':
        console.log(`\nProject completed!`);
        break;

      case 'error':
        console.error(`Error: ${event.message}`);
        break;
    }
  }
}

/**
 * Extended scheduler with actual audit logic
 */
class ExtendedScheduler extends BenchmarkScheduler {
  private runner: BenchmarkRunner;

  constructor(
    settings: any,
    dataDir: string,
    runner: BenchmarkRunner
  ) {
    super(settings, dataDir);
    this.runner = runner;
  }

  protected async runAudit(project: C4Project): Promise<RunResult> {
    return this.runner.runAudit(project);
  }
}

/**
 * CLI entry point
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] || 'run';

  try {
    const settings = await loadSettings();

    const ddApiConfig: DDApiConfig = {
      baseUrl: process.env.DD_API_URL || 'http://localhost:3001',
      timeout: settings.scheduler.auditTimeout * 1000,
    };

    const runner = new BenchmarkRunner(settings, ddApiConfig);

    switch (command) {
      case 'run':
        const projectFilter = args.find((a) => a.startsWith('--project='))?.split('=')[1];
        await runner.run(projectFilter);
        break;

      case 'discover':
        await runner.discover();
        break;

      case 'report':
        console.log('Report generation not yet implemented');
        break;

      default:
        console.log('Usage: pnpm run [--project=<name>]');
        console.log('       pnpm discover');
        console.log('       pnpm report');
        process.exit(1);
    }
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  main();
}

export { loadSettings, loadProjects };
