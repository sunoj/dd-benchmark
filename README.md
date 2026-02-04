# DD Benchmark

Data collection tool for benchmarking DetectionDogs (DD) smart contract security auditor against Code4rena (C4) findings.

## Overview

DD Benchmark is a **pure data collector** that:
- Prepares ground truth datasets from C4 audit reports
- Runs DD audits on C4 projects
- Collects DD findings with analysis metadata
- Saves raw results for downstream analysis

**Note**: Matching, scoring, and analysis are performed by [Super-CC](https://github.com/AuditWare/super-cc), not this tool.

## Installation

```bash
# As a submodule of Super-CC
git submodule add https://github.com/AuditWare/dd-benchmark.git dd-benchmark
cd dd-benchmark
pnpm install
```

## Architecture

```
dd-benchmark/
├── config/
│   ├── projects.yaml      # Project list with metadata
│   └── settings.yaml      # Scheduler & DD API config
├── src/
│   ├── index.ts           # CLI entry point
│   ├── types.ts           # TypeScript interfaces
│   ├── dataset/           # Dataset preparation from C4 reports
│   ├── indexer/           # C4 project discovery & ground truth
│   ├── runner/            # DD audit execution
│   └── scheduler/         # Process control & checkpointing
└── data/
    ├── datasets/          # Prepared ground truth datasets
    ├── runs/              # Audit run results (gitignored)
    └── ground-truth/      # Cached ground truth (gitignored)
```

## Data Flow

```
┌─────────────────┐     ┌─────────────────┐
│  C4 Indexer     │     │   DD Auditor    │
│ (Ground Truth)  │     │  (DD Findings)  │
└────────┬────────┘     └────────┬────────┘
         │                       │
         └───────────┬───────────┘
                     │
                     ▼
             ┌───────────────┐
             │  dd-benchmark │
             │ (Raw Data)    │
             └───────┬───────┘
                     │
                     ▼
             ┌───────────────┐
             │   Super-CC    │
             │ (Analysis)    │
             └───────────────┘
```

## Usage

### Dataset Preparation

Prepare ground truth datasets from C4 reports before running benchmarks:

```bash
# Prepare dataset for a specific project
pnpm dataset prepare --project=2024-07-loopfi

# Prepare datasets for all projects with C4 reports
pnpm dataset prepare --with-reports

# Prepare all configured projects
pnpm dataset prepare --all

# List prepared datasets
pnpm dataset list

# Show dataset details
pnpm dataset show --project=2024-07-loopfi

# Check if dataset exists
pnpm dataset check --project=2024-07-loopfi
```

### Benchmark CLI Commands

```bash
# Run benchmark on all configured projects
pnpm run benchmark -- run

# Run benchmark on a specific project
pnpm run benchmark -- run --project=2024-07-loopfi

# Resume interrupted benchmark
pnpm run benchmark -- resume

# Discover new C4 projects
pnpm run benchmark -- discover
```

### Programmatic API

```typescript
import { BenchmarkScheduler, AuditRunner, C4Indexer } from 'dd-benchmark';

const scheduler = new BenchmarkScheduler(settings);
const result = await scheduler.runProject('2024-07-loopfi');

console.log(result.ground_truth.total);  // Ground truth count
console.log(result.dd_findings.total);   // DD findings count
```

## Output Format

### Dataset Format

Prepared datasets are saved to `data/datasets/{project}/`:

```
data/datasets/2024-07-loopfi/
├── ground-truth.json    # All findings
├── metadata.json        # Audit info, source URL, scope
├── scope.txt            # Files in scope
└── findings/            # Individual finding markdown files
    ├── H-01.md
    ├── H-02.md
    └── ...
```

**metadata.json** includes:

```typescript
interface DatasetMetadata {
  project: string;
  repo: string;
  preparedAt: string;
  source: string;
  findingsCount: number;
  bySeverity: Record<string, number>;
  
  // Source code URL (GitHub repo)
  sourceCodeUrl: string;
  
  // Audit description from C4
  auditDescription?: string;
  
  // Contest details
  contest?: {
    prize?: string;
    startDate?: string;
    endDate?: string;
    nSLOC?: number;
  };
  
  // Files in scope
  scope?: string[];
  
  // Scope description
  scopeDescription?: string;
  
  framework?: string;
  notes?: string;
}
```

### Run Results Format

Run results are saved to `data/runs/{project}/run-{timestamp}.json`:

```typescript
interface RunResult {
  metadata: {
    project: string;
    timestamp: string;
    duration_seconds: number;
    dd_version: string;
    dd_git_hash: string;
    detector_count: number;
  };

  ground_truth: {
    total: number;
    by_severity: { high: number; medium: number; low: number };
    findings: Finding[];
  };

  dd_findings: {
    total: number;
    findings: Finding[];  // Includes analysis metadata
  };
}
```

### Finding Format

```typescript
interface Finding {
  title: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  file?: string;
  description?: string;
  analysis?: {
    tools?: string[];      // e.g., ['slither', 'aderyn']
    methods?: string[];    // e.g., ['static-analysis', 'taint-analysis']
    methodology?: string;
  };
}
```

## Configuration

### config/settings.yaml

```yaml
scheduler:
  max_concurrent_projects: 1
  checkpoint_interval: 300    # seconds
  audit_timeout: 3600        # seconds
  max_retries: 3
  retry_delay: 60

dd_api:
  base_url: "http://localhost:3001"
  health_endpoint: "/api/health"
  audit_endpoint: "/api/audit"
  timeout: 300000  # ms
```

### config/projects.yaml

```yaml
projects:
  - name: 2024-07-loopfi
    repo: code-423n4/2024-07-loopfi
    status: completed
    prize_pool: 100000
    has_findings: true

  - name: 2024-04-panoptic
    repo: code-423n4/2024-04-panoptic
    status: pending
    prize_pool: 120000
    has_findings: true
```

## Integration with Super-CC

When used as a submodule of Super-CC:

1. Super-CC sets `BENCHMARK_DIR` environment variable
2. Tasks call `npm run benchmark -- run --project=$PROJECT`
3. Results are saved to `$BENCHMARK_DIR/data/runs/{project}/`
4. Super-CC reads results and performs matching/scoring

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DD_API_URL` | DD backend API URL | `http://localhost:3001` |
| `BENCHMARK_DIR` | Set by Super-CC | Current directory |
| `GITHUB_TOKEN` | For C4 indexer | None (optional) |

## Development

```bash
# Build
npm run build

# Run in development mode
npm run dev

# Run tests
npm test

# Lint
npm run lint
```

## License

MIT
