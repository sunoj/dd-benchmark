/**
 * Dataset Preparer
 *
 * Pre-collects and formats ground truth data for benchmark.
 * Fetches complete reports from Code4rena and stores locally.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { Finding, Severity, C4Project, VulnerabilityCategory } from '../types';

export interface DatasetMetadata {
  project: string;
  repo: string;
  preparedAt: string;
  source: string;
  findingsCount: number;
  bySeverity: Record<string, number>;
  
  /** Source code URL (GitHub repo URL) */
  sourceCodeUrl: string;
  
  /** Audit description/about */
  auditDescription?: string;
  
  /** Contest details */
  contest?: {
    prize?: string;
    startDate?: string;
    endDate?: string;
    nSLOC?: number;
  };
  
  /** Files in scope for audit */
  scope?: string[];
  
  /** Scope description */
  scopeDescription?: string;
  
  framework?: string;
  notes?: string;
}

export interface PreparedDataset {
  metadata: DatasetMetadata;
  findings: Finding[];
}

export class DatasetPreparer {
  private dataDir: string;
  private readonly CACHE_DURATION = 24 * 60 * 60 * 1000; // 1 day in milliseconds

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  /**
   * Check if existing dataset is within cache duration
   */
  private async isDatasetCached(projectName: string): Promise<boolean> {
    const datasetDir = path.join(this.dataDir, 'datasets', projectName);
    const metadataPath = path.join(datasetDir, 'metadata.json');

    try {
      const metadataContent = await fs.readFile(metadataPath, 'utf-8');
      const metadata = JSON.parse(metadataContent);

      const preparedAt = new Date(metadata.preparedAt);
      const now = new Date();
      const age = now.getTime() - preparedAt.getTime();

      return age < this.CACHE_DURATION;
    } catch {
      return false;
    }
  }

  /**
   * Prepare dataset for a project
   */
  async prepare(project: C4Project): Promise<PreparedDataset> {
    console.log(`[DatasetPreparer] Preparing dataset for ${project.name}...`);

    // Check if cached version exists and is within 1 day
    if (await this.isDatasetCached(project.name)) {
      const cachedDataset = await this.loadDataset(project.name);
      if (cachedDataset) {
        console.log(`[DatasetPreparer] Using cached dataset (less than 1 day old)`);
        return cachedDataset;
      }
    }

    // Step 1: Fetch findings from Code4rena report
    const findings = await this.fetchC4Report(project.name);
    console.log(`[DatasetPreparer] Fetched ${findings.length} findings from C4 report`);

    // Step 2: Enrich findings with GitHub content if available
    if (project.findingsFile || project.findingsFiles) {
      await this.enrichFromGitHub(project, findings);
    }

    // Step 3: Fetch scope file
    const scope = await this.fetchScope(project);

    // Step 4: Fetch audit description and contest info from README
    const auditInfo = await this.fetchAuditInfo(project);
    console.log(`[DatasetPreparer] Fetched audit info: ${auditInfo.description ? 'description found' : 'no description'}`);

    // Step 5: Validate completeness
    this.validateFindings(findings);

    // Step 6: Build metadata
    const bySeverity: Record<string, number> = {};
    for (const f of findings) {
      bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
    }

    const sourceCodeUrl = `https://github.com/${project.repo}`;

    const metadata: DatasetMetadata = {
      project: project.name,
      repo: project.repo,
      preparedAt: new Date().toISOString(),
      source: 'code4rena',
      findingsCount: findings.length,
      bySeverity,
      sourceCodeUrl,
      auditDescription: auditInfo.description,
      contest: auditInfo.contest,
      scope,
      scopeDescription: auditInfo.scopeDescription,
      framework: project.framework,
      notes: project.notes,
    };

    const dataset: PreparedDataset = { metadata, findings };

    // Step 7: Save to disk
    await this.saveDataset(project.name, dataset);

    return dataset;
  }

  /**
   * Fetch complete report from Code4rena
   */
  private async fetchC4Report(projectName: string): Promise<Finding[]> {
    const reportUrl = `https://code4rena.com/reports/${projectName}`;
    console.log(`[DatasetPreparer] Fetching from ${reportUrl}`);

    try {
      const response = await fetch(reportUrl, {
        headers: {
          'User-Agent': 'DD-Benchmark/2.0 (Dataset Preparation)',
          'Accept': 'text/html',
        },
      });

      if (!response.ok) {
        throw new Error(`C4 report not found: ${response.status}`);
      }

      const html = await response.text();
      return this.parseC4ReportHtml(html);
    } catch (error) {
      console.error(`[DatasetPreparer] Failed to fetch C4 report:`, error);
      return [];
    }
  }

  /**
   * Parse C4 report HTML with comprehensive extraction
   */
  private parseC4ReportHtml(html: string): Finding[] {
    const findings: Finding[] = [];

    // Extract the main content area (findings are usually in a specific section)
    // Look for detailed findings with full content

    // Pattern for structured findings: [H-01] Title followed by sections
    const findingPattern = /\[([HML])-(\d+)\]\s*([^\n<]+)([\s\S]*?)(?=\[[HML]-\d+\]|<h[12][^>]*>(?:High|Medium|Low|Audit|$)|$)/gi;

    let match;
    while ((match = findingPattern.exec(html)) !== null) {
      const sevChar = match[1].toUpperCase();
      const num = match[2];
      const id = `${sevChar}-${num}`;
      const title = this.cleanHtml(match[3]);
      const content = match[4] || '';

      // Skip if already exists
      if (findings.some(f => f.id === id)) continue;

      const severity = sevChar === 'H' ? 'high' : sevChar === 'M' ? 'medium' : 'low';

      const finding: Finding = {
        id,
        title,
        severity: severity as Severity,
        targets: [],
        description: this.extractSection(content, ['description', 'summary', 'vulnerability', 'detail', 'overview']),
        impact: this.extractSection(content, ['impact']),
        rootCause: this.extractSection(content, ['root cause', 'cause', 'proof of concept', 'poc', 'vulnerability detail']),
        recommendation: this.extractSection(content, ['recommendation', 'mitigation', 'fix', 'remediation', 'suggested fix']),
        source: 'ground_truth',
      };

      // Extract affected files
      finding.targets = this.extractAffectedFiles(content);

      // Extract category if present
      const category = this.extractCategory(content, title);
      if (category) {
        finding.category = category;
      }

      // If no structured description, use first paragraph of content
      if (!finding.description) {
        finding.description = this.extractFirstParagraph(content);
      }

      // Generate markdown
      finding.markdown = this.generateMarkdown(finding);

      findings.push(finding);
    }

    // Sort by severity and number
    findings.sort((a, b) => {
      const severityOrder = { high: 0, medium: 1, low: 2, critical: -1, info: 3 };
      const sevA = severityOrder[a.severity] ?? 3;
      const sevB = severityOrder[b.severity] ?? 3;
      if (sevA !== sevB) return sevA - sevB;

      const numA = parseInt(a.id.slice(2)) || 0;
      const numB = parseInt(b.id.slice(2)) || 0;
      return numA - numB;
    });

    return findings;
  }

  /**
   * Extract a section from content by heading keywords
   */
  private extractSection(content: string, keywords: string[]): string {
    for (const keyword of keywords) {
      // Try markdown headers: ## keyword or ### keyword
      const mdPattern = new RegExp(`###?\\s*${keyword}[:\\s]*\\n([\\s\\S]*?)(?=###?\\s|$)`, 'i');
      let match = content.match(mdPattern);
      if (match && match[1].trim()) {
        return this.cleanHtml(match[1].trim());
      }

      // Try HTML headers: <h3>keyword</h3>
      const htmlPattern = new RegExp(`<h[34][^>]*>\\s*${keyword}[:\\s]*</h[34]>([\\s\\S]*?)(?=<h[234]|$)`, 'i');
      match = content.match(htmlPattern);
      if (match && match[1].trim()) {
        return this.cleanHtml(match[1].trim());
      }

      // Try bold labels: **keyword**: content
      const boldPattern = new RegExp(`\\*\\*${keyword}[:\\s]*\\*\\*:?\\s*([^\\n]+(?:\\n(?![\\*#<]).*)*?)(?=\\n\\*\\*|\\n##|$)`, 'i');
      match = content.match(boldPattern);
      if (match && match[1].trim()) {
        return this.cleanHtml(match[1].trim());
      }

      // Try <strong>keyword</strong>: content
      const strongPattern = new RegExp(`<strong>${keyword}[:\\s]*</strong>:?\\s*([^<]+)`, 'i');
      match = content.match(strongPattern);
      if (match && match[1].trim()) {
        return this.cleanHtml(match[1].trim());
      }
    }
    return '';
  }

  /**
   * Extract first meaningful paragraph from content
   */
  private extractFirstParagraph(content: string): string {
    // Remove code blocks
    const cleaned = content.replace(/```[\s\S]*?```/g, '').replace(/<pre>[\s\S]*?<\/pre>/g, '');

    // Find first paragraph
    const paraMatch = cleaned.match(/<p[^>]*>([^<]+)<\/p>/i);
    if (paraMatch) {
      return this.cleanHtml(paraMatch[1]);
    }

    // Try plain text paragraph
    const lines = cleaned.split('\n').filter(l => l.trim() && !l.trim().startsWith('#') && !l.trim().startsWith('<'));
    if (lines.length > 0) {
      return this.cleanHtml(lines.slice(0, 3).join(' '));
    }

    return '';
  }

  /**
   * Extract affected file paths from content
   */
  private extractAffectedFiles(content: string): string[] {
    const files: string[] = [];

    // Pattern for Solidity files with optional line numbers
    const solPattern = /([\w\/\-\.]+\.sol)(?::(\d+)(?:-(\d+))?)?/g;
    let match;
    while ((match = solPattern.exec(content)) !== null) {
      let file = match[1];
      if (match[2]) {
        file += `:${match[2]}`;
        if (match[3]) file += `-${match[3]}`;
      }
      if (!files.includes(file) && !file.startsWith('.') && file.includes('/')) {
        files.push(file);
      }
    }

    // Pattern for GitHub file links
    const githubPattern = /github\.com\/[^\/]+\/[^\/]+\/blob\/[^\/]+\/([^\s\)#]+\.sol)(?:#L(\d+)(?:-L(\d+))?)?/g;
    while ((match = githubPattern.exec(content)) !== null) {
      let file = match[1];
      if (match[2]) {
        file += `:${match[2]}`;
        if (match[3]) file += `-${match[3]}`;
      }
      if (!files.includes(file)) {
        files.push(file);
      }
    }

    return files.slice(0, 20); // Limit to 20 files
  }

  /**
   * Extract vulnerability category from content or title
   */
  private extractCategory(content: string, title: string): VulnerabilityCategory | undefined {
    const combined = (title + ' ' + content).toLowerCase();

    // Map keywords to VulnerabilityCategory values
    const categoryMap: Array<{ category: VulnerabilityCategory; keywords: string[] }> = [
      { category: 'reentrancy', keywords: ['reentran', 'reentrancy', 're-entran'] },
      { category: 'access_control', keywords: ['access control', 'unauthorized', 'permission', 'only owner', 'admin'] },
      { category: 'arithmetic', keywords: ['overflow', 'underflow', 'integer', 'rounding'] },
      { category: 'price-manipulation', keywords: ['price manipulation', 'oracle manipulation', 'flash loan attack'] },
      { category: 'oracle', keywords: ['oracle', 'price feed', 'chainlink'] },
      { category: 'frontrunning', keywords: ['front-run', 'frontrun', 'sandwich', 'mev'] },
      { category: 'dos', keywords: ['denial of service', 'dos', 'out of gas', 'unbounded loop'] },
      { category: 'state_management', keywords: ['logic error', 'incorrect logic', 'wrong calculation', 'state'] },
      { category: 'token_handling', keywords: ['token', 'erc20', 'transfer', 'balance', 'accounting'] },
      { category: 'initialization', keywords: ['initialization', 'initializer', 'uninitialized'] },
      { category: 'upgrade', keywords: ['upgrade', 'proxy', 'delegatecall'] },
      { category: 'other', keywords: ['replay', 'signature', 'nonce', 'timestamp', 'unchecked return'] },
    ];

    for (const { category, keywords } of categoryMap) {
      for (const keyword of keywords) {
        if (combined.includes(keyword)) {
          return category;
        }
      }
    }

    return undefined;
  }

  /**
   * Clean HTML tags and entities
   */
  private cleanHtml(text: string): string {
    return text
      .replace(/<[^>]+>/g, '')           // Remove HTML tags
      .replace(/```[\s\S]*?```/g, '')    // Remove code blocks
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')              // Collapse whitespace
      .trim();
  }

  /**
   * Generate markdown representation
   */
  private generateMarkdown(finding: Finding): string {
    const lines: string[] = [];

    lines.push(`# [${finding.id}] ${finding.title}`);
    lines.push('');
    lines.push('## Severity');
    lines.push(finding.severity.charAt(0).toUpperCase() + finding.severity.slice(1));
    lines.push('');

    if (finding.category) {
      lines.push('## Category');
      lines.push(finding.category);
      lines.push('');
    }

    if (finding.description) {
      lines.push('## Description');
      lines.push(finding.description);
      lines.push('');
    }

    if (finding.impact) {
      lines.push('## Impact');
      lines.push(finding.impact);
      lines.push('');
    }

    if (finding.rootCause) {
      lines.push('## Root Cause');
      lines.push(finding.rootCause);
      lines.push('');
    }

    if (finding.targets && finding.targets.length > 0) {
      lines.push('## Affected Files');
      for (const target of finding.targets) {
        lines.push(`- \`${target}\``);
      }
      lines.push('');
    }

    if (finding.recommendation) {
      lines.push('## Recommendation');
      lines.push(finding.recommendation);
      lines.push('');
    }

    return lines.join('\n').trim();
  }

  /**
   * Enrich findings with content from GitHub findings files, or parse them if no findings exist
   */
  private async enrichFromGitHub(project: C4Project, findings: Finding[]): Promise<void> {
    const files = project.findingsFiles || (project.findingsFile ? [project.findingsFile] : []);

    // Determine if we have existing findings from C4 report
    const hasC4Findings = findings.length > 0;

    for (const file of files) {
      try {
        const rawUrl = `https://raw.githubusercontent.com/${project.repo}/main/${file}`;
        const response = await fetch(rawUrl);
        if (!response.ok) continue;

        const content = await response.text();

        if (hasC4Findings) {
          // If we have existing findings from C4 report, enrich them
          // Try to match findings by ID and enrich missing fields
          for (const finding of findings) {
            const pattern = new RegExp(`\\[${finding.id}\\][\\s\\S]*?(?=\\[[HML]-\\d+\\]|$)`, 'i');
            const match = content.match(pattern);
            if (match) {
              const section = match[0];

              if (!finding.description) {
                finding.description = this.extractSection(section, ['description', 'summary', 'detail']);
              }
              if (!finding.impact) {
                finding.impact = this.extractSection(section, ['impact']);
              }
              if (!finding.rootCause) {
                finding.rootCause = this.extractSection(section, ['root cause', 'proof of concept', 'poc']);
              }
              if (!finding.recommendation) {
                finding.recommendation = this.extractSection(section, ['recommendation', 'mitigation', 'fix']);
              }
              if (finding.targets?.length === 0) {
                finding.targets = this.extractAffectedFiles(section);
              }

              // Regenerate markdown with enriched content
              finding.markdown = this.generateMarkdown(finding);
            }
          }
        } else {
          // If no findings from C4 report, parse directly from GitHub findings file
          console.log(`[DatasetPreparer] No C4 report findings, parsing directly from ${file}`);
          const parsedFindings = this.parseGitHubFindingsFile(content, findings.length + 1);
          console.log(`[DatasetPreparer] Parsed ${parsedFindings.length} findings from ${file}`);
          parsedFindings.forEach(finding => findings.push(finding));
        }
      } catch (error) {
        console.warn(`[DatasetPreparer] Failed to fetch ${file}:`, error);
      }
    }
  }

  /**
   * Parse GitHub findings file content
   */
  private parseGitHubFindingsFile(content: string, startCounter: number = 1): Finding[] {
    const findings: Finding[] = [];

    // Split the content by findings (each starts with #)
    const sections = content.split(/^#\s+/gm).filter(Boolean);

    for (const section of sections) {
      // Skip the note section at the beginning
      if (section.toLowerCase().includes('note: not all issues')) {
        continue;
      }

      // Extract severity
      const severityMatch = section.match(/- \s*Severity:\s*(\w+)/i);
      if (!severityMatch) {
        continue;
      }

      const severityStr = severityMatch[1].trim().toLowerCase();

      // Map severity
      let severity: Severity = 'medium';
      if (severityStr.includes('high') || severityStr.includes('critical')) {
        severity = 'high';
      } else if (severityStr.includes('medium')) {
        severity = 'medium';
      } else if (severityStr.includes('low')) {
        severity = 'low';
      }

      // Extract title (everything before the first line break after #)
      const titleEnd = section.indexOf('\n');
      let title = section.slice(0, titleEnd).trim();

      // Clean up title
      title = title.replace(/^`+|`+$/g, '').trim();

      // Generate ID
      const id = `${severity.charAt(0).toUpperCase()}-${startCounter + findings.length}`;

      const finding: Finding = {
        id,
        title,
        severity,
        targets: [],
        description: '',
        impact: '',
        rootCause: '',
        recommendation: '',
        source: 'ground_truth',
        category: undefined,
        markdown: ''
      };

      // Extract targets from "Targets" section
      const targetsMatch = section.match(/## Targets\n([\s\S]*?)(?=##|$)/i);
      if (targetsMatch) {
        const targetsText = targetsMatch[1];
        const targets = targetsText.split('\n')
          .map(line => line.replace(/^-+\s*/, '').trim())
          .filter(line => line.length > 0);
        finding.targets = targets;
      }

      // Extract sections
      finding.description = this.extractSection(section, ['description', 'summary', 'detail']);
      finding.impact = this.extractSection(section, ['impact']);
      finding.rootCause = this.extractSection(section, ['root cause', 'proof of concept', 'poc']);
      finding.recommendation = this.extractSection(section, ['recommendation', 'mitigation', 'fix']);

      // If no targets from Targets section, extract from content
      if (finding.targets.length === 0) {
        finding.targets = this.extractAffectedFiles(section);
      }

      // Extract category
      const category = this.extractCategory(section, title);
      if (category) {
        finding.category = category;
      }

      // Generate markdown
      finding.markdown = this.generateMarkdown(finding);

      findings.push(finding);
    }

    return findings;
  }

  /**
   * Fetch scope file
   */
  private async fetchScope(project: C4Project): Promise<string[] | undefined> {
    if (!project.scopeFile) return undefined;

    try {
      const rawUrl = `https://raw.githubusercontent.com/${project.repo}/main/${project.scopeFile}`;
      const response = await fetch(rawUrl);
      if (!response.ok) return undefined;

      const content = await response.text();
      return content.split('\n').filter(l => l.trim() && !l.startsWith('#'));
    } catch {
      return undefined;
    }
  }

  /**
   * Fetch audit info from C4 audits page and GitHub README
   */
  private async fetchAuditInfo(project: C4Project): Promise<{
    description?: string;
    scopeDescription?: string;
    contest?: {
      prize?: string;
      startDate?: string;
      endDate?: string;
      nSLOC?: number;
    };
  }> {
    const result: {
      description?: string;
      scopeDescription?: string;
      contest?: {
        prize?: string;
        startDate?: string;
        endDate?: string;
        nSLOC?: number;
      };
    } = {};

    // Try fetching from C4 audits page
    try {
      const auditUrl = `https://code4rena.com/audits/${project.name}`;
      console.log(`[DatasetPreparer] Fetching audit info from ${auditUrl}`);
      
      const response = await fetch(auditUrl, {
        headers: {
          'User-Agent': 'DD-Benchmark/2.0 (Dataset Preparation)',
          'Accept': 'text/html',
        },
      });

      if (response.ok) {
        const html = await response.text();
        
        // Extract contest details from HTML
        const contestInfo = this.parseAuditPageHtml(html);
        if (contestInfo.prize || contestInfo.startDate) {
          result.contest = contestInfo;
        }
        
        // Extract description from page
        const descMatch = html.match(/<div[^>]*class="[^"]*prose[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
        if (descMatch) {
          result.description = this.cleanHtml(descMatch[1]).slice(0, 2000);
        }
      }
    } catch (error) {
      console.warn(`[DatasetPreparer] Failed to fetch C4 audit page:`, error);
    }

    // Also try fetching from GitHub README
    try {
      const readmeUrl = `https://raw.githubusercontent.com/${project.repo}/main/README.md`;
      const response = await fetch(readmeUrl);
      
      if (response.ok) {
        const readme = await response.text();
        
        // Extract "About" or first section as description
        if (!result.description) {
          result.description = this.extractReadmeDescription(readme);
        }
        
        // Extract scope description
        result.scopeDescription = this.extractScopeDescription(readme);
        
        // Extract nSLOC if present
        const slocMatch = readme.match(/(?:nSLOC|SLOC|lines of code)[:\s]*(\d+(?:,\d+)?)/i);
        if (slocMatch) {
          result.contest = result.contest || {};
          result.contest.nSLOC = parseInt(slocMatch[1].replace(/,/g, ''));
        }
        
        // Extract prize if present and not already found
        if (!result.contest?.prize) {
          const prizeMatch = readme.match(/(?:Total Prize Pool|Prize|Awards?)[:\s]*\$?([\d,]+(?:\.\d+)?)\s*(?:USDC|USD)?/i);
          if (prizeMatch) {
            result.contest = result.contest || {};
            result.contest.prize = `$${prizeMatch[1]}`;
          }
        }
      }
    } catch (error) {
      console.warn(`[DatasetPreparer] Failed to fetch README:`, error);
    }

    return result;
  }

  /**
   * Parse C4 audit page HTML for contest details
   */
  private parseAuditPageHtml(html: string): {
    prize?: string;
    startDate?: string;
    endDate?: string;
  } {
    const result: { prize?: string; startDate?: string; endDate?: string } = {};

    // Extract dates - looking for patterns like "Start date11 Nov 2025"
    const startMatch = html.match(/Start\s*date[:\s]*(\d{1,2}\s+\w+\s+\d{4})/i);
    if (startMatch) {
      result.startDate = startMatch[1];
    }

    const endMatch = html.match(/End\s*date[:\s]*(\d{1,2}\s+\w+\s+\d{4})/i);
    if (endMatch) {
      result.endDate = endMatch[1];
    }

    // Extract prize - looking for patterns like "Total awards$100,000"
    const prizeMatch = html.match(/(?:Total awards?|Prize)[:\s]*\$?([\d,]+(?:\.\d+)?)\s*(?:in\s+)?(?:USDC|USD)?/i);
    if (prizeMatch) {
      result.prize = `$${prizeMatch[1]}`;
    }

    return result;
  }

  /**
   * Extract description from README
   */
  private extractReadmeDescription(readme: string): string {
    // Try to find "About" section
    const aboutMatch = readme.match(/##\s*About[^\n]*\n([\s\S]*?)(?=\n##|\n---|\Z)/i);
    if (aboutMatch && aboutMatch[1].trim()) {
      return this.cleanMarkdown(aboutMatch[1]).slice(0, 2000);
    }

    // Try "Overview" section
    const overviewMatch = readme.match(/##\s*Overview[^\n]*\n([\s\S]*?)(?=\n##|\n---|\Z)/i);
    if (overviewMatch && overviewMatch[1].trim()) {
      return this.cleanMarkdown(overviewMatch[1]).slice(0, 2000);
    }

    // Try "Description" section
    const descMatch = readme.match(/##\s*Description[^\n]*\n([\s\S]*?)(?=\n##|\n---|\Z)/i);
    if (descMatch && descMatch[1].trim()) {
      return this.cleanMarkdown(descMatch[1]).slice(0, 2000);
    }

    // Fall back to first non-header paragraph after title
    const lines = readme.split('\n');
    const contentLines: string[] = [];
    let foundTitle = false;
    
    for (const line of lines) {
      if (line.startsWith('#')) {
        if (foundTitle && contentLines.length > 0) break;
        foundTitle = true;
        continue;
      }
      if (foundTitle && line.trim() && !line.startsWith('![') && !line.startsWith('[')) {
        contentLines.push(line);
        if (contentLines.length >= 10) break;
      }
    }

    return this.cleanMarkdown(contentLines.join('\n')).slice(0, 2000);
  }

  /**
   * Extract scope description from README
   */
  private extractScopeDescription(readme: string): string | undefined {
    // Try to find "Scope" section
    const scopeMatch = readme.match(/##\s*Scope[^\n]*\n([\s\S]*?)(?=\n##|\n---|\Z)/i);
    if (scopeMatch && scopeMatch[1].trim()) {
      return this.cleanMarkdown(scopeMatch[1]).slice(0, 3000);
    }

    // Try "Files in scope" section
    const filesMatch = readme.match(/##\s*Files?\s*(?:in\s*)?scope[^\n]*\n([\s\S]*?)(?=\n##|\n---|\Z)/i);
    if (filesMatch && filesMatch[1].trim()) {
      return this.cleanMarkdown(filesMatch[1]).slice(0, 3000);
    }

    return undefined;
  }

  /**
   * Clean markdown formatting
   */
  private cleanMarkdown(text: string): string {
    return text
      .replace(/```[\s\S]*?```/g, '')      // Remove code blocks
      .replace(/`[^`]+`/g, '')             // Remove inline code
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')  // Convert links to text
      .replace(/!\[[^\]]*\]\([^)]+\)/g, '') // Remove images
      .replace(/^\s*[-*]\s*/gm, '')        // Remove list markers
      .replace(/^\s*\d+\.\s*/gm, '')       // Remove numbered lists
      .replace(/\*\*([^*]+)\*\*/g, '$1')   // Remove bold
      .replace(/\*([^*]+)\*/g, '$1')       // Remove italic
      .replace(/\s+/g, ' ')                // Collapse whitespace
      .trim();
  }

  /**
   * Validate findings completeness
   */
  private validateFindings(findings: Finding[]): void {
    let warnings = 0;

    for (const finding of findings) {
      const issues: string[] = [];

      if (!finding.description) issues.push('missing description');
      if (!finding.targets || finding.targets.length === 0) issues.push('missing affected files');
      if (!finding.impact && !finding.rootCause) issues.push('missing impact/root cause');

      if (issues.length > 0) {
        console.warn(`[DatasetPreparer] ${finding.id}: ${issues.join(', ')}`);
        warnings++;
      }
    }

    if (warnings > 0) {
      console.warn(`[DatasetPreparer] ${warnings}/${findings.length} findings have incomplete data`);
    } else {
      console.log(`[DatasetPreparer] All ${findings.length} findings validated`);
    }
  }

  /**
   * Save dataset to disk
   */
  private async saveDataset(projectName: string, dataset: PreparedDataset): Promise<void> {
    const datasetDir = path.join(this.dataDir, 'datasets', projectName);
    await fs.mkdir(datasetDir, { recursive: true });

    // Save ground-truth.json
    await fs.writeFile(
      path.join(datasetDir, 'ground-truth.json'),
      JSON.stringify(dataset.findings, null, 2)
    );

    // Save metadata.json
    await fs.writeFile(
      path.join(datasetDir, 'metadata.json'),
      JSON.stringify(dataset.metadata, null, 2)
    );

    // Save scope.txt if available
    if (dataset.metadata.scope) {
      await fs.writeFile(
        path.join(datasetDir, 'scope.txt'),
        dataset.metadata.scope.join('\n')
      );
    }

    // Save individual findings as markdown for easy reading
    const findingsDir = path.join(datasetDir, 'findings');
    await fs.mkdir(findingsDir, { recursive: true });
    for (const finding of dataset.findings) {
      await fs.writeFile(
        path.join(findingsDir, `${finding.id}.md`),
        finding.markdown || ''
      );
    }

    console.log(`[DatasetPreparer] Dataset saved to ${datasetDir}`);
    console.log(`[DatasetPreparer] - ground-truth.json: ${dataset.findings.length} findings`);
    console.log(`[DatasetPreparer] - metadata.json`);
    console.log(`[DatasetPreparer] - findings/*.md`);
  }

  /**
   * Load prepared dataset from disk
   */
  async loadDataset(projectName: string): Promise<PreparedDataset | null> {
    const datasetDir = path.join(this.dataDir, 'datasets', projectName);

    try {
      const findingsContent = await fs.readFile(path.join(datasetDir, 'ground-truth.json'), 'utf-8');
      const metadataContent = await fs.readFile(path.join(datasetDir, 'metadata.json'), 'utf-8');

      return {
        findings: JSON.parse(findingsContent),
        metadata: JSON.parse(metadataContent),
      };
    } catch {
      return null;
    }
  }

  /**
   * Check if dataset exists
   */
  async hasDataset(projectName: string): Promise<boolean> {
    const datasetDir = path.join(this.dataDir, 'datasets', projectName);
    try {
      await fs.access(path.join(datasetDir, 'ground-truth.json'));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * List all prepared datasets
   */
  async listDatasets(): Promise<string[]> {
    const datasetsDir = path.join(this.dataDir, 'datasets');
    try {
      const entries = await fs.readdir(datasetsDir, { withFileTypes: true });
      return entries.filter(e => e.isDirectory()).map(e => e.name);
    } catch {
      return [];
    }
  }
}
