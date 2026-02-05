/**
 * C4 Project Indexer
 *
 * Discovers and indexes code-423n4 projects from GitHub,
 * parsing their structure to extract:
 * - Audit scope files
 * - Ground truth findings
 * - Project metadata
 */

import { Octokit } from '@octokit/rest';
import * as yaml from 'js-yaml';
import * as fs from 'fs/promises';
import * as path from 'path';
import type {
  C4Project,
  Finding,
  ParsedFinding,
  Severity,
  GitHubSettings,
} from '../types';

// Simple HTML parsing for Code4rena reports
interface C4ReportFinding {
  id: string;
  title: string;
  severity: Severity;
  wardenCount?: number;
}

export class C4Indexer {
  private octokit: Octokit;
  private settings: GitHubSettings;
  private cacheDir: string;

  constructor(settings: GitHubSettings, cacheDir: string) {
    // Create Octokit without auth for public repos (higher rate limit with token)
    this.octokit = new Octokit({
      auth: process.env.GITHUB_TOKEN || undefined,
    });
    this.settings = settings;
    this.cacheDir = cacheDir;
  }

  /**
   * Discover all matching C4 projects
   */
  async discoverProjects(): Promise<C4Project[]> {
    console.log(`[Indexer] Discovering projects from ${this.settings.organization}...`);

    const repos = await this.listOrgRepos();
    const pattern = new RegExp(this.settings.projectPattern);

    const matchingRepos = repos.filter((repo) => pattern.test(repo.name));
    console.log(`[Indexer] Found ${matchingRepos.length} matching repositories`);

    const projects: C4Project[] = [];

    for (const repo of matchingRepos) {
      try {
        const project = await this.parseProject(repo.name);
        if (project) {
          if (!this.settings.requireFindings || project.findingsFile || project.findingsFiles) {
            projects.push(project);
          }
        }
      } catch (error) {
        console.warn(`[Indexer] Failed to parse ${repo.name}:`, error);
      }
    }

    // Sort by priority (newer projects first)
    projects.sort((a, b) => {
      // Extract date from name (e.g., 2025-11-sequence)
      const dateA = a.name.match(/(\d{4})-(\d{2})/);
      const dateB = b.name.match(/(\d{4})-(\d{2})/);
      if (dateA && dateB) {
        return dateB[0].localeCompare(dateA[0]);
      }
      return 0;
    });

    return projects;
  }

  /**
   * Parse a single project repository
   */
  async parseProject(repoName: string): Promise<C4Project | null> {
    const fullRepo = `${this.settings.organization}/${repoName}`;
    console.log(`[Indexer] Parsing ${fullRepo}...`);

    // Get repo contents
    const contents = await this.getRepoContents(repoName);
    if (!contents) return null;

    // Detect findings files
    const findingsFiles = contents
      .filter((f) => f.name.includes('findings') && f.name.endsWith('.md'))
      .map((f) => f.name);

    // Detect scope file
    const scopeFile = contents.find((f) => f.name === 'scope.txt')?.name || null;

    // Detect framework
    const framework = this.detectFramework(contents);

    // Parse README for additional info
    const readme = await this.getFileContent(repoName, 'README.md');
    const notes = this.extractNotesFromReadme(readme);

    const project: C4Project = {
      name: repoName,
      repo: fullRepo,
      status: 'pending',
      priority: this.calculatePriority(repoName, findingsFiles.length),
      framework,
      notes,
    };

    if (findingsFiles.length === 1) {
      project.findingsFile = findingsFiles[0];
    } else if (findingsFiles.length > 1) {
      project.findingsFiles = findingsFiles;
    }

    if (scopeFile) {
      project.scopeFile = scopeFile;
    }

    return project;
  }

  /**
   * Fetch and parse ground truth findings for a project
   *
   * Priority:
   * 1. Try local prepared dataset (fastest, most reliable)
   * 2. Try Code4rena reports page
   * 3. Fall back to GitHub findings files
   *
   * All findings are formatted to unified markdown format.
   */
  async getGroundTruth(project: C4Project): Promise<Finding[]> {
    let findings: Finding[] = [];

    // Try local prepared dataset first
    const datasetPath = path.join(this.cacheDir, '..', 'datasets', project.name, 'ground-truth.json');
    try {
      const datasetContent = await fs.readFile(datasetPath, 'utf-8');
      findings = JSON.parse(datasetContent);
      console.log(`[Indexer] Found ${findings.length} findings from local dataset`);
    } catch (error) {
      console.log(`[Indexer] Local dataset not found or invalid: ${(error as Error).message}`);

      // Try Code4rena reports next
      const reportFindings = await this.getC4ReportFindings(project.name);
      if (reportFindings.length > 0) {
        console.log(`[Indexer] Found ${reportFindings.length} findings from C4 report`);
        findings = reportFindings;
      } else {
        // Fall back to GitHub findings files
        const files = project.findingsFiles || (project.findingsFile ? [project.findingsFile] : []);

        for (const file of files) {
          const content = await this.getFileContent(project.name, file);
          if (content) {
            const parsed = this.parseFindingsMarkdown(content);
            findings.push(...parsed);
          }
        }
      }
    }

    // Format all findings to unified markdown (if not already formatted)
    return findings.map(f => {
      if (f.markdown) {
        return f;
      }
      return this.formatFindingMarkdown(f);
    });
  }

  /**
   * Format a finding to clean, unified markdown
   */
  private formatFindingMarkdown(finding: Finding): Finding {
    const lines: string[] = [];

    // Header with ID and title
    lines.push(`# [${finding.id}] ${finding.title}`);
    lines.push('');

    // Severity
    lines.push('## Severity');
    lines.push(finding.severity.charAt(0).toUpperCase() + finding.severity.slice(1));
    lines.push('');

    // Category (if available)
    if (finding.category) {
      lines.push('## Category');
      lines.push(finding.category.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()));
      lines.push('');
    }

    // Description
    if (finding.description) {
      lines.push('## Description');
      lines.push(finding.description.trim());
      lines.push('');
    }

    // Impact
    if (finding.impact) {
      lines.push('## Impact');
      lines.push(finding.impact.trim());
      lines.push('');
    }

    // Root Cause
    if (finding.rootCause) {
      lines.push('## Root Cause');
      lines.push(finding.rootCause.trim());
      lines.push('');
    }

    // Affected Files/Targets
    if (finding.targets && finding.targets.length > 0) {
      lines.push('## Affected Files');
      for (const target of finding.targets) {
        lines.push(`- \`${target}\``);
      }
      lines.push('');
    } else if (finding.file) {
      lines.push('## Affected Files');
      let loc = `\`${finding.file}\``;
      if (finding.function) loc += ` :: \`${finding.function}()\``;
      if (finding.lines && finding.lines.length > 0) {
        loc += ` (L${finding.lines.join('-')})`;
      }
      lines.push(`- ${loc}`);
      lines.push('');
    }

    // Recommendation
    if (finding.recommendation) {
      lines.push('## Recommendation');
      lines.push(finding.recommendation.trim());
      lines.push('');
    }

    return {
      ...finding,
      markdown: lines.join('\n').trim(),
    };
  }

  /**
   * Fetch findings from Code4rena reports page
   * URL format: https://code4rena.com/reports/{project-name}
   */
  async getC4ReportFindings(projectName: string): Promise<Finding[]> {
    const reportUrl = `https://code4rena.com/reports/${projectName}`;
    console.log(`[Indexer] Fetching C4 report from ${reportUrl}`);

    try {
      const response = await fetch(reportUrl, {
        headers: {
          'User-Agent': 'DetectionDogs-Benchmark/1.0',
          'Accept': 'text/html',
        },
      });

      if (!response.ok) {
        console.log(`[Indexer] C4 report not found: ${response.status}`);
        return [];
      }

      const html = await response.text();
      return this.parseC4ReportHtml(html);
    } catch (error) {
      console.log(`[Indexer] Failed to fetch C4 report:`, error);
      return [];
    }
  }

  /**
   * Parse findings from Code4rena report HTML
   */
  private parseC4ReportHtml(html: string): Finding[] {
    const findings: Finding[] = [];

    // Try to extract detailed findings with sections
    // Pattern: [H-01] Title followed by content until next finding or section
    const detailedPattern = /\[([HML])-(\d+)\]\s*([^\n]+)([\s\S]*?)(?=\[[HML]-\d+\]|<h[12]|$)/gi;
    let match;

    while ((match = detailedPattern.exec(html)) !== null) {
      const sevChar = match[1].toUpperCase();
      const num = match[2];
      const id = `${sevChar}-${num}`;
      const title = this.cleanHtmlTitle(match[3]);
      const content = match[4] || '';

      if (title && !findings.some(f => f.id === id)) {
        const severity = sevChar === 'H' ? 'high' : sevChar === 'M' ? 'medium' : 'low';

        // Extract description, impact, etc. from content
        const finding: Finding = {
          id,
          title,
          severity: severity as Severity,
          targets: [],
          description: this.extractSection(content, ['description', 'summary', 'vulnerability']),
          impact: this.extractSection(content, ['impact']),
          rootCause: this.extractSection(content, ['root cause', 'cause']),
          recommendation: this.extractSection(content, ['recommendation', 'mitigation', 'fix']),
          source: 'ground_truth',
        };

        // Extract affected files
        const files = this.extractAffectedFiles(content);
        if (files.length > 0) {
          finding.targets = files;
        }

        findings.push(finding);
      }
    }

    // Fallback: simple pattern matching if detailed extraction found nothing
    if (findings.length === 0) {
      // Extract High severity findings
      const highPattern = /\[H-(\d+)\]\s*([^\n<]+)|<h[23][^>]*>\s*\[?H-(\d+)\]?\s*[:\-]?\s*([^<]+)/gi;
      while ((match = highPattern.exec(html)) !== null) {
        const num = match[1] || match[3];
        const title = (match[2] || match[4] || '').trim();
        if (title && !findings.some(f => f.id === `H-${num}`)) {
          findings.push({
            id: `H-${num}`,
            title: this.cleanHtmlTitle(title),
            severity: 'high',
            targets: [],
            description: '',
            source: 'ground_truth',
          });
        }
      }

      // Extract Medium severity findings
      const mediumPattern = /\[M-(\d+)\]\s*([^\n<]+)|<h[23][^>]*>\s*\[?M-(\d+)\]?\s*[:\-]?\s*([^<]+)/gi;
      while ((match = mediumPattern.exec(html)) !== null) {
        const num = match[1] || match[3];
        const title = (match[2] || match[4] || '').trim();
        if (title && !findings.some(f => f.id === `M-${num}`)) {
          findings.push({
            id: `M-${num}`,
            title: this.cleanHtmlTitle(title),
            severity: 'medium',
            targets: [],
            description: '',
            source: 'ground_truth',
          });
        }
      }

      // Try to extract from table rows
      const tablePattern = /<tr[^>]*>[\s\S]*?<td[^>]*>([HML]-\d+)<\/td>[\s\S]*?<td[^>]*>([^<]+)<\/td>/gi;
      while ((match = tablePattern.exec(html)) !== null) {
        const id = match[1];
        const title = match[2].trim();
        if (!findings.some(f => f.id === id)) {
          const severity = id.startsWith('H') ? 'high' : id.startsWith('M') ? 'medium' : 'low';
          findings.push({
            id,
            title: this.cleanHtmlTitle(title),
            severity: severity as Severity,
            targets: [],
            description: '',
            source: 'ground_truth',
          });
        }
      }
    }

    // Sort by ID
    findings.sort((a, b) => {
      const [aType, aNum] = [a.id[0], parseInt(a.id.slice(2))];
      const [bType, bNum] = [b.id[0], parseInt(b.id.slice(2))];
      if (aType !== bType) {
        return aType === 'H' ? -1 : aType === 'M' ? (bType === 'H' ? 1 : -1) : 1;
      }
      return aNum - bNum;
    });

    return findings;
  }

  /**
   * Extract a section from HTML content by heading keywords
   */
  private extractSection(content: string, keywords: string[]): string {
    for (const keyword of keywords) {
      // Try markdown-style headers
      const mdPattern = new RegExp(`##\\s*${keyword}[:\\s]*\\n([\\s\\S]*?)(?=##|$)`, 'i');
      let match = content.match(mdPattern);
      if (match) {
        return this.cleanHtmlContent(match[1].trim());
      }

      // Try HTML headers
      const htmlPattern = new RegExp(`<h[34][^>]*>\\s*${keyword}[:\\s]*</h[34]>([\\s\\S]*?)(?=<h[234]|$)`, 'i');
      match = content.match(htmlPattern);
      if (match) {
        return this.cleanHtmlContent(match[1].trim());
      }

      // Try bold/strong labels
      const boldPattern = new RegExp(`\\*\\*${keyword}[:\\s]*\\*\\*:?\\s*([^\\n]+)`, 'i');
      match = content.match(boldPattern);
      if (match) {
        return this.cleanHtmlContent(match[1].trim());
      }
    }
    return '';
  }

  /**
   * Extract affected file paths from content
   */
  private extractAffectedFiles(content: string): string[] {
    const files: string[] = [];

    // Pattern for Solidity files: path/to/File.sol
    const solPattern = /[\w\/\-\.]+\.sol/g;
    let match;
    while ((match = solPattern.exec(content)) !== null) {
      const file = match[0];
      if (!files.includes(file) && !file.startsWith('.')) {
        files.push(file);
      }
    }

    // Pattern for GitHub file links
    const githubPattern = /github\.com\/[^\/]+\/[^\/]+\/blob\/[^\/]+\/([^\s\)]+\.sol)/g;
    while ((match = githubPattern.exec(content)) !== null) {
      const file = match[1];
      if (!files.includes(file)) {
        files.push(file);
      }
    }

    return files.slice(0, 10); // Limit to 10 files
  }

  /**
   * Clean HTML content to plain text
   */
  private cleanHtmlContent(content: string): string {
    return content
      .replace(/<[^>]+>/g, '')          // Remove HTML tags
      .replace(/```[\s\S]*?```/g, '')   // Remove code blocks
      .replace(/`[^`]+`/g, '')          // Remove inline code
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\n{3,}/g, '\n\n')       // Collapse multiple newlines
      .trim();
  }

  /**
   * Clean HTML entities and tags from title
   */
  private cleanHtmlTitle(title: string): string {
    return title
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Parse findings from markdown content
   */
  parseFindingsMarkdown(content: string): Finding[] {
    const findings: Finding[] = [];

    // Try to parse structured C4 findings format first
    // Pattern: ## [H-01] Title or # [H-01] Title
    const c4Pattern = /^#{1,2}\s*\[([HML])-(\d+)\]\s*(.+?)$([\s\S]*?)(?=^#{1,2}\s*\[[HML]-\d+\]|$)/gm;
    let match;

    while ((match = c4Pattern.exec(content)) !== null) {
      const sevChar = match[1].toUpperCase();
      const num = match[2];
      const id = `${sevChar}-${num}`;
      const title = match[3].trim();
      const body = match[4] || '';

      const severity = sevChar === 'H' ? 'high' : sevChar === 'M' ? 'medium' : 'low';

      const finding: Finding = {
        id,
        title,
        severity: severity as Severity,
        targets: this.extractAffectedFiles(body),
        description: this.extractSectionFromMd(body, ['description', 'summary', 'vulnerability', 'details']),
        impact: this.extractSectionFromMd(body, ['impact']),
        rootCause: this.extractSectionFromMd(body, ['root cause', 'cause', 'proof of concept', 'poc']),
        recommendation: this.extractSectionFromMd(body, ['recommendation', 'mitigation', 'fix', 'remediation']),
        source: 'ground_truth',
        raw: match[0],
      };

      // If no structured description, use the body as description
      if (!finding.description && body.trim()) {
        finding.description = body.split(/^###?\s+/m)[0].trim();
      }

      findings.push(finding);
    }

    // Fallback: split by # headers
    if (findings.length === 0) {
      const sections = content.split(/^# /gm).filter(Boolean);

      for (const section of sections) {
        const finding = this.parseSection(section);
        if (finding) {
          findings.push({
            id: `gt-${findings.length + 1}`,
            ...finding,
            source: 'ground_truth',
            raw: section,
          });
        }
      }
    }

    return findings;
  }

  /**
   * Extract a section from markdown by heading keywords
   */
  private extractSectionFromMd(content: string, keywords: string[]): string {
    for (const keyword of keywords) {
      // Match ### keyword or ## keyword
      const pattern = new RegExp(`^###?\\s*${keyword}[:\\s]*$([\\s\\S]*?)(?=^###?\\s|$)`, 'im');
      const match = content.match(pattern);
      if (match && match[1]) {
        return match[1].trim();
      }
    }
    return '';
  }

  /**
   * Parse a single finding section (fallback parser)
   */
  private parseSection(section: string): ParsedFinding | null {
    const lines = section.split('\n');
    const title = lines[0]?.trim();
    if (!title) return null;

    // Skip non-finding sections
    if (title.toLowerCase().includes('table of contents') ||
        title.toLowerCase().includes('summary') ||
        title.toLowerCase().includes('overview')) {
      return null;
    }

    // Extract severity from title or content
    let severity: Severity = 'medium';
    const titleSevMatch = title.match(/\[(high|medium|low|critical|info)\]/i);
    if (titleSevMatch) {
      severity = this.normalizeSeverity(titleSevMatch[1]);
    } else {
      const severityMatch = section.match(/severity:\s*(critical|high|medium|low|info)/i) ||
                            section.match(/-\s*Severity:\s*(Critical|High|Medium|Low|Info)/i);
      if (severityMatch) {
        severity = this.normalizeSeverity(severityMatch[1]);
      }
    }

    // Extract targets
    const targetsSection = section.match(/##\s*Targets?\n([\s\S]*?)(?=##|$)/i);
    const targets: string[] = [];
    if (targetsSection) {
      const targetLines = targetsSection[1].split('\n');
      for (const line of targetLines) {
        const target = line.replace(/^-\s*/, '').trim();
        if (target && !target.startsWith('#')) {
          targets.push(target);
        }
      }
    }

    // Also extract .sol files from body
    const solFiles = this.extractAffectedFiles(section);
    for (const file of solFiles) {
      if (!targets.includes(file)) {
        targets.push(file);
      }
    }

    // Extract description
    const descMatch = section.match(/##\s*Description\n([\s\S]*?)(?=##|$)/i);
    let description = descMatch?.[1]?.trim() || '';

    // If no description section, use first paragraph after title
    if (!description) {
      const bodyStart = section.indexOf('\n');
      if (bodyStart > 0) {
        const body = section.slice(bodyStart + 1);
        const firstPara = body.split(/\n##/)[0].trim();
        if (firstPara) {
          description = firstPara;
        }
      }
    }

    // Extract root cause
    const rootCauseMatch = section.match(/##\s*Root cause\n([\s\S]*?)(?=##|$)/i) ||
                           section.match(/##\s*Proof of Concept\n([\s\S]*?)(?=##|$)/i);
    const rootCause = rootCauseMatch?.[1]?.trim();

    // Extract impact
    const impactMatch = section.match(/##\s*Impact\n([\s\S]*?)(?=##|$)/i);
    const impact = impactMatch?.[1]?.trim();

    return {
      title: title.replace(/\[(high|medium|low|critical|info)\]/gi, '').trim(),
      severity,
      targets,
      description,
      rootCause,
      impact,
    };
  }

  /**
   * Normalize severity string
   */
  private normalizeSeverity(severity: string | undefined): Severity {
    if (!severity) return 'medium';
    const lower = severity.toLowerCase();
    if (lower === 'critical') return 'critical';
    if (lower === 'high') return 'high';
    if (lower === 'medium') return 'medium';
    if (lower === 'low') return 'low';
    return 'info';
  }

  /**
   * List all repositories in the organization
   */
  private async listOrgRepos(): Promise<Array<{ name: string; full_name: string }>> {
    const repos: Array<{ name: string; full_name: string }> = [];
    let page = 1;

    while (true) {
      const response = await this.octokit.repos.listForOrg({
        org: this.settings.organization,
        per_page: 100,
        page,
        sort: 'updated',
        direction: 'desc',
      });

      repos.push(...response.data.map((r) => ({ name: r.name, full_name: r.full_name })));

      if (response.data.length < 100) break;
      page++;

      // Limit to avoid rate limiting
      if (page > 10) break;
    }

    return repos;
  }

  /**
   * Get repository root contents
   */
  private async getRepoContents(repoName: string): Promise<Array<{ name: string; type: string }> | null> {
    try {
      const response = await this.octokit.repos.getContent({
        owner: this.settings.organization,
        repo: repoName,
        path: '',
      });

      if (Array.isArray(response.data)) {
        return response.data.map((f) => ({ name: f.name, type: f.type }));
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Get file content from repository
   * Falls back to raw.githubusercontent.com if GitHub API fails
   */
  async getFileContent(repoName: string, filePath: string): Promise<string | null> {
    // Try direct raw URL first (no auth needed)
    try {
      const rawUrl = `https://raw.githubusercontent.com/${this.settings.organization}/${repoName}/main/${filePath}`;
      const response = await fetch(rawUrl);
      if (response.ok) {
        return await response.text();
      }
    } catch {
      // Fall through to API
    }

    // Try GitHub API
    try {
      const response = await this.octokit.repos.getContent({
        owner: this.settings.organization,
        repo: repoName,
        path: filePath,
      });

      if ('content' in response.data) {
        return Buffer.from(response.data.content, 'base64').toString('utf-8');
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Detect project framework from files
   */
  private detectFramework(contents: Array<{ name: string; type: string }>): C4Project['framework'] {
    const fileNames = contents.map((f) => f.name);

    if (fileNames.includes('foundry.toml')) return 'foundry';
    if (fileNames.includes('hardhat.config.js') || fileNames.includes('hardhat.config.ts')) return 'hardhat';
    if (fileNames.includes('brownie-config.yaml')) return 'brownie';
    return 'unknown';
  }

  /**
   * Extract useful notes from README
   */
  private extractNotesFromReadme(readme: string | null): string {
    if (!readme) return '';

    // Extract prize pool info
    const prizeMatch = readme.match(/Total Prize Pool:\s*\$([\d,]+)/i);
    const prize = prizeMatch ? `Prize: $${prizeMatch[1]}` : '';

    // Extract date info
    const dateMatch = readme.match(/Starts?\s+(\w+\s+\d+,?\s+\d{4})/i);
    const date = dateMatch ? `Start: ${dateMatch[1]}` : '';

    return [prize, date].filter(Boolean).join(', ');
  }

  /**
   * Calculate project priority
   */
  private calculatePriority(repoName: string, findingsCount: number): number {
    // Higher priority for newer projects
    const dateMatch = repoName.match(/(\d{4})-(\d{2})/);
    let priority = 100;

    if (dateMatch) {
      const year = parseInt(dateMatch[1]);
      const month = parseInt(dateMatch[2]);
      priority = (year - 2025) * 12 + month;
    }

    // Boost projects with more findings (more learning opportunity)
    priority += findingsCount * 10;

    return priority;
  }

  /**
   * Save project index to cache
   */
  async saveIndex(projects: C4Project[]): Promise<void> {
    const indexPath = path.join(this.cacheDir, 'project-index.yaml');
    await fs.mkdir(this.cacheDir, { recursive: true });
    await fs.writeFile(indexPath, yaml.dump({
      lastUpdated: new Date().toISOString(),
      projectCount: projects.length,
      projects,
    }));
    console.log(`[Indexer] Saved ${projects.length} projects to ${indexPath}`);
  }

  /**
   * Load project index from cache
   */
  async loadIndex(): Promise<C4Project[]> {
    const indexPath = path.join(this.cacheDir, 'project-index.yaml');
    try {
      const content = await fs.readFile(indexPath, 'utf-8');
      const data = yaml.load(content) as { projects: C4Project[] };
      return data.projects;
    } catch {
      return [];
    }
  }
}
