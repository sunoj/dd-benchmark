/**
 * Dataset CLI
 *
 * Prepares ground truth datasets from Code4rena reports.
 *
 * Usage:
 *   pnpm dataset prepare --project=2024-07-loopfi
 *   pnpm dataset prepare --all
 *   pnpm dataset list
 *   pnpm dataset show --project=2024-07-loopfi
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { DatasetPreparer } from './dataset-preparer';
import type { C4Project } from '../types';

const CONFIG_DIR = path.join(__dirname, '..', '..', 'config');
const DATA_DIR = path.join(__dirname, '..', '..', 'data');

/**
 * Load projects from config
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
 * Prepare dataset for a single project
 */
async function prepareProject(
  preparer: DatasetPreparer,
  project: C4Project
): Promise<boolean> {
  try {
    console.log(`\n========================================`);
    console.log(`Preparing: ${project.name}`);
    console.log(`Repo: ${project.repo}`);
    console.log(`========================================\n`);

    const dataset = await preparer.prepare(project);

    console.log(`\n[Summary]`);
    console.log(`  Total findings: ${dataset.metadata.findingsCount}`);
    console.log(`  By severity:`);
    for (const [sev, count] of Object.entries(dataset.metadata.bySeverity)) {
      console.log(`    - ${sev}: ${count}`);
    }

    return true;
  } catch (error) {
    console.error(`[Error] Failed to prepare ${project.name}:`, error);
    return false;
  }
}

/**
 * List all prepared datasets
 */
async function listDatasets(preparer: DatasetPreparer): Promise<void> {
  const datasets = await preparer.listDatasets();

  if (datasets.length === 0) {
    console.log('No datasets prepared yet.');
    console.log('Run: pnpm dataset prepare --project=<name>');
    return;
  }

  console.log(`\n=== Prepared Datasets (${datasets.length}) ===\n`);

  for (const name of datasets) {
    const dataset = await preparer.loadDataset(name);
    if (dataset) {
      const meta = dataset.metadata;
      console.log(`${name}`);
      console.log(`  Findings: ${meta.findingsCount}`);
      console.log(`  Prepared: ${meta.preparedAt}`);
      console.log(`  Severity: ${JSON.stringify(meta.bySeverity)}`);
      console.log('');
    }
  }
}

/**
 * Show dataset details
 */
async function showDataset(
  preparer: DatasetPreparer,
  projectName: string
): Promise<void> {
  const dataset = await preparer.loadDataset(projectName);

  if (!dataset) {
    console.error(`Dataset not found: ${projectName}`);
    console.log('Run: pnpm dataset prepare --project=' + projectName);
    return;
  }

  const meta = dataset.metadata;

  console.log(`\n=== Dataset: ${projectName} ===\n`);
  console.log(`Repo: ${meta.repo}`);
  console.log(`Source Code: ${meta.sourceCodeUrl}`);
  console.log(`Prepared: ${meta.preparedAt}`);
  console.log(`Framework: ${meta.framework || 'unknown'}`);
  
  if (meta.contest) {
    console.log(`\n=== Contest Info ===`);
    if (meta.contest.prize) console.log(`Prize: ${meta.contest.prize}`);
    if (meta.contest.startDate) console.log(`Start: ${meta.contest.startDate}`);
    if (meta.contest.endDate) console.log(`End: ${meta.contest.endDate}`);
    if (meta.contest.nSLOC) console.log(`nSLOC: ${meta.contest.nSLOC}`);
  }

  if (meta.auditDescription) {
    console.log(`\n=== Audit Description ===`);
    console.log(meta.auditDescription.slice(0, 500));
    if (meta.auditDescription.length > 500) console.log('...');
  }

  console.log(`\n=== Findings Summary ===`);
  console.log(`Total: ${meta.findingsCount}`);
  console.log(`By Severity: ${JSON.stringify(meta.bySeverity)}`);

  if (meta.scope) {
    console.log(`\n=== Scope Files (${meta.scope.length}) ===`);
    for (const file of meta.scope.slice(0, 10)) {
      console.log(`  - ${file}`);
    }
    if (meta.scope.length > 10) {
      console.log(`  ... and ${meta.scope.length - 10} more`);
    }
  }

  if (meta.scopeDescription) {
    console.log(`\n=== Scope Description ===`);
    console.log(meta.scopeDescription.slice(0, 300));
    if (meta.scopeDescription.length > 300) console.log('...');
  }

  console.log(`\n=== Findings ===\n`);

  for (const finding of dataset.findings) {
    console.log(`[${finding.id}] ${finding.title}`);
    console.log(`  Severity: ${finding.severity}`);
    if (finding.category) {
      console.log(`  Category: ${finding.category}`);
    }
    if (finding.targets && finding.targets.length > 0) {
      console.log(`  Files: ${finding.targets.slice(0, 3).join(', ')}${finding.targets.length > 3 ? '...' : ''}`);
    }
    if (finding.description) {
      const desc = finding.description.slice(0, 100);
      console.log(`  Desc: ${desc}${finding.description.length > 100 ? '...' : ''}`);
    }
    console.log('');
  }
}

/**
 * Main CLI
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] || 'help';

  const preparer = new DatasetPreparer(DATA_DIR);

  // Parse arguments
  const getArg = (prefix: string): string | undefined => {
    const arg = args.find(a => a.startsWith(prefix));
    return arg?.split('=')[1];
  };

  const hasFlag = (flag: string): boolean => {
    return args.includes(flag);
  };

  try {
    switch (command) {
      case 'prepare': {
        const projectName = getArg('--project=');
        const all = hasFlag('--all');
        const withReports = hasFlag('--with-reports');

        if (!projectName && !all && !withReports) {
          console.log('Usage: pnpm dataset prepare --project=<name>');
          console.log('       pnpm dataset prepare --all');
          console.log('       pnpm dataset prepare --with-reports');
          process.exit(1);
        }

        const projects = await loadProjects();

        if (all) {
          console.log(`Preparing all ${projects.length} projects...`);
          let success = 0;
          let failed = 0;

          for (const project of projects) {
            const ok = await prepareProject(preparer, project);
            if (ok) success++;
            else failed++;
          }

          console.log(`\n=== Complete ===`);
          console.log(`Success: ${success}`);
          console.log(`Failed: ${failed}`);
        } else if (withReports) {
          // Only projects with C4 reports (priority 1-9)
          const reportProjects = projects.filter(p => p.priority < 10);
          console.log(`Preparing ${reportProjects.length} projects with C4 reports...`);

          let success = 0;
          let failed = 0;

          for (const project of reportProjects) {
            const ok = await prepareProject(preparer, project);
            if (ok) success++;
            else failed++;
          }

          console.log(`\n=== Complete ===`);
          console.log(`Success: ${success}`);
          console.log(`Failed: ${failed}`);
        } else {
          const project = projects.find(p => p.name === projectName);
          if (!project) {
            console.error(`Project not found: ${projectName}`);
            console.log('\nAvailable projects:');
            for (const p of projects.slice(0, 10)) {
              console.log(`  - ${p.name}`);
            }
            process.exit(1);
          }

          await prepareProject(preparer, project);
        }
        break;
      }

      case 'list': {
        await listDatasets(preparer);
        break;
      }

      case 'show': {
        const projectName = getArg('--project=');
        if (!projectName) {
          console.log('Usage: pnpm dataset show --project=<name>');
          process.exit(1);
        }
        await showDataset(preparer, projectName);
        break;
      }

      case 'check': {
        // Check if a dataset exists
        const projectName = getArg('--project=');
        if (!projectName) {
          console.log('Usage: pnpm dataset check --project=<name>');
          process.exit(1);
        }
        const exists = await preparer.hasDataset(projectName);
        console.log(exists ? 'exists' : 'not_found');
        process.exit(exists ? 0 : 1);
      }

      case 'help':
      default:
        console.log(`
Dataset Preparer CLI

Commands:
  prepare   Prepare ground truth dataset from C4 reports
  list      List all prepared datasets
  show      Show dataset details
  check     Check if dataset exists

Examples:
  pnpm dataset prepare --project=2024-07-loopfi
  pnpm dataset prepare --with-reports
  pnpm dataset prepare --all
  pnpm dataset list
  pnpm dataset show --project=2024-07-loopfi
  pnpm dataset check --project=2024-07-loopfi
`);
        break;
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

export { DatasetPreparer } from './dataset-preparer';
export type { DatasetMetadata, PreparedDataset } from './dataset-preparer';
