/**
 * Core types for the C4 Benchmark System
 *
 * Pure data collection tool. Responsibilities:
 * - Run DD audits on projects
 * - Collect ground truth findings from C4
 * - Collect DD findings with analysis metadata
 *
 * NOT responsible for:
 * - Matching findings (TP/FP/FN) - Super-CC's job
 * - Score calculation - Super-CC's job
 * - Comparing results - Super-CC's job
 * - Suggestions/recommendations - Super-CC's job
 */

// ============ Project Types ============

export interface C4Project {
  name: string;
  repo: string;
  status: ProjectStatus;
  priority: number;
  findingsFile?: string;
  findingsFiles?: string[];
  scopeFile?: string;
  framework: 'foundry' | 'hardhat' | 'brownie' | 'unknown';
  notes?: string;
  lastRun?: string;
}

export type ProjectStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped';

// ============ Finding Types ============

export interface Finding {
  id: string;
  title: string;
  severity: Severity;
  description: string;
  category?: VulnerabilityCategory;
  file?: string;
  function?: string;
  lines?: number[];
  targets: string[];
  rootCause?: string;
  impact?: string;
  recommendation?: string;
  source: 'ground_truth' | 'dd_audit';
  detector?: string;
  confidence?: string;

  /** Raw original content (unparsed) */
  raw?: string;

  /** Clean formatted markdown - unified format for all findings */
  markdown?: string;

  /**
   * Analysis metadata - DD provides this for each finding
   * Captures HOW DD arrived at this finding
   */
  analysis?: AnalysisMetadata;
}

/**
 * Detailed analysis metadata for each DD finding
 */
export interface AnalysisMetadata {
  /** Step-by-step analysis process */
  process?: string[];
  /** Tools used (e.g., slither, aderyn, manual review) */
  tools?: string[];
  /** Specific methods applied (e.g., taint analysis, data flow) */
  methods?: string[];
  /** High-level methodology */
  methodology?: string;
  /** Time spent on this finding (seconds) */
  duration?: number;
  /** Reasoning chain for severity assignment */
  severityReasoning?: string;
}

export type Severity =
  | 'critical'
  | 'high'
  | 'medium'
  | 'low'
  | 'info';

export type VulnerabilityCategory =
  | 'reentrancy'
  | 'access_control'
  | 'arithmetic'
  | 'oracle'
  | 'token_handling'
  | 'state_management'
  | 'initialization'
  | 'upgrade'
  | 'dos'
  | 'frontrunning'
  | 'price-manipulation'
  | 'other';

/**
 * Parsed finding from C4 markdown
 */
export interface ParsedFinding {
  title: string;
  severity: Severity;
  targets: string[];
  description: string;
  rootCause?: string;
  impact?: string;
}

// ============ Run Types ============

/**
 * Result of a single benchmark run
 *
 * Raw data only - Super-CC handles matching and scoring
 */
export interface RunResult {
  project: string;
  timestamp: string;
  duration_seconds: number;

  ground_truth: {
    total: number;
    by_severity: Record<string, number>;
    findings: Finding[];
  };

  dd_findings: {
    total: number;
    findings: Finding[];
  };

  metadata: {
    dd_version: string;
    benchmark_version: string;
    tools_used: string[];
    methods_used: string[];
    audit_session_id?: string;
  };

  error?: string;
}

/**
 * Checkpoint state for resumable runs
 */
export interface Checkpoint {
  currentProject: string | null;
  completedProjects: string[];
  failedProjects: string[];
  lastCheckpoint: string;
}

// ============ Configuration Types ============

export interface Settings {
  scheduler: SchedulerSettings;
  github: GitHubSettings;
}

export interface SchedulerSettings {
  maxConcurrentProjects: number;
  checkpointInterval: number;
  auditTimeout: number;
  maxRetries: number;
  retryDelay: number;
}

export interface GitHubSettings {
  organization: string;
  projectPattern: string;
  requireFindings: boolean;
}

// ============ Event Types ============

export type BenchmarkEvent =
  | { type: 'project_started'; project: string; timestamp: string }
  | { type: 'audit_completed'; project: string; ddFindingsCount: number; groundTruthCount: number }
  | { type: 'project_completed'; project: string }
  | { type: 'checkpoint_saved'; checkpoint: Checkpoint }
  | { type: 'error'; message: string; project?: string };

export type EventHandler = (event: BenchmarkEvent) => void | Promise<void>;
