/**
 * Audit Runner
 *
 * Executes DD audits on projects and collects results.
 * Integrates with the DD backend API.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { C4Project, Finding, RunResult } from '../types';

export interface DDApiConfig {
  baseUrl: string;
  timeout: number;
}

export class AuditRunner {
  private config: DDApiConfig;
  private outputDir: string;

  constructor(config: DDApiConfig, outputDir: string) {
    this.config = config;
    this.outputDir = outputDir;
  }

  /**
   * Audit result including findings and session logs
   */
  public lastSessionLogs: any[] = [];

  /**
   * Run a full DD audit on a project
   */
  async runAudit(project: C4Project): Promise<Finding[]> {
    console.log(`[AuditRunner] Starting audit for ${project.name}`);
    this.lastSessionLogs = []; // Reset logs for new audit

    // Step 1: Create a DD project first
    const projectId = await this.createProject(project);
    console.log(`[AuditRunner] Created project: ${projectId}`);

    // Step 2: Ensure container is initialized (clones repo, starts container)
    await this.ensureContainer(projectId);
    console.log(`[AuditRunner] Container initialized for project: ${projectId}`);

    // Step 3: Create a session for the project
    const sessionId = await this.createSession(project, projectId);
    console.log(`[AuditRunner] Created session: ${sessionId}`);

    // Step 4: Run the audit via a single comprehensive message
    // Include the repo URL so the agent can clone it
    const repoUrl = `https://github.com/${project.repo}`;
    await this.sendMessage(sessionId, `IMPORTANT: Call tools immediately - do NOT just describe what you will do.

Run a comprehensive security audit on this GitHub repository: ${repoUrl}

Execute these steps in order:

STEP 1 - Clone repository:
cloneRepository({ url: "${repoUrl}" })

STEP 2 - Detect project type:
detectProjectType({})

STEP 3 - Install dependencies:
installDependencies({})

STEP 4 - Run static analysis:
runSlither({})
runAderyn({})

STEP 5 - Analyze findings:
Review the Slither and Aderyn results. For each real vulnerability:
- Use readContract to examine the vulnerable code
- Verify it's a real issue, not a false positive

STEP 6 - Create findings:
For each confirmed vulnerability, use createFinding with:
- severity: "high", "medium", or "low"
- title: Brief description of the vulnerability
- description: Full explanation with code location
- recommendation: How to fix it
- analysisProcess: Array of steps you took to find this (e.g., ["ran slither", "reviewed tainted variables", "verified exploit path"])
- tools: Tools you used (e.g., ["slither", "manual review"])
- methods: Analysis methods applied (e.g., ["taint analysis", "control flow"])
- severityReasoning: Why you assigned this severity level

Focus on HIGH and MEDIUM severity issues:
- Reentrancy attacks
- Access control bypasses
- Integer overflow/underflow
- Oracle/price manipulation
- Token handling issues
- Logic errors

START NOW by calling cloneRepository.
    `);

    // Step 5: Retrieve findings from project
    const findings = await this.getFindingsFromProject(projectId);
    console.log(`[AuditRunner] Retrieved ${findings.length} findings from project`);

    // Save results
    await this.saveResults(project.name, findings);

    return findings;
  }

  /**
   * Create a DD project
   */
  private async createProject(project: C4Project): Promise<string> {
    const response = await fetch(`${this.config.baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: project.name,
        repoUrl: `https://github.com/${project.repo}`,
        framework: project.framework || 'unknown',
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to create project: ${response.status} ${errorText}`);
    }

    const data = await response.json() as { id: string };
    return data.id;
  }

  /**
   * Ensure container is initialized for the project
   * This clones the repo and starts the Docker container
   */
  private async ensureContainer(projectId: string): Promise<void> {
    console.log(`[AuditRunner] Ensuring container for project ${projectId}...`);

    const response = await fetch(
      `${this.config.baseUrl}/api/projects/${projectId}/ensure-container`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(300000), // 5 min timeout for container init + repo clone
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to ensure container: ${response.status} ${errorText}`);
    }

    const data = await response.json() as {
      containerId: string;
      wasCreated: boolean;
      wasRestarted: boolean;
    };

    console.log(`[AuditRunner] Container ready: ${data.containerId} (created: ${data.wasCreated}, restarted: ${data.wasRestarted})`);

    // Wait a bit for container to be fully ready
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  /**
   * Create a new audit session for a project
   */
  private async createSession(project: C4Project, projectId: string): Promise<string> {
    const response = await fetch(`${this.config.baseUrl}/api/agent/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `Benchmark: ${project.name}`,
        projectId: projectId,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to create session: ${response.statusText}`);
    }

    const data = await response.json() as { id: string };
    return data.id;
  }

  /**
   * Send a message to the audit session
   */
  private async sendMessage(sessionId: string, message: string): Promise<string> {
    // Start the session execution
    const startResponse = await fetch(
      `${this.config.baseUrl}/api/agent/sessions/${sessionId}/chat/stream`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: message }),
        signal: AbortSignal.timeout(30000), // 30s timeout for starting
      }
    );

    if (!startResponse.ok) {
      const errorText = await startResponse.text();
      throw new Error(`Failed to start chat: ${startResponse.status} ${errorText}`);
    }

    const startData = await startResponse.json() as { runningId: string; eventStreamUrl: string };
    console.log(`[AuditRunner] Started run: ${startData.runningId}`);

    // Poll for completion instead of SSE streaming
    const startTime = Date.now();
    const timeout = this.config.timeout;
    let pollCount = 0;
    let lastStatus = '';

    // Give the agent time to start processing before first poll
    console.log('[AuditRunner] Waiting for agent to start processing...');
    await new Promise(resolve => setTimeout(resolve, 10000));

    while (Date.now() - startTime < timeout) {
      pollCount++;

      // Check session status
      const statusResponse = await fetch(
        `${this.config.baseUrl}/api/agent/sessions/${sessionId}`,
        { signal: AbortSignal.timeout(10000) }
      );

      if (!statusResponse.ok) {
        console.warn('[AuditRunner] Status check failed, continuing...');
        await new Promise(resolve => setTimeout(resolve, 5000));
        continue;
      }

      const sessionData = await statusResponse.json() as { status: string; runningId: string | null };
      const currentStatus = `${sessionData.status}:${sessionData.runningId || 'none'}`;

      // Only log status changes
      if (currentStatus !== lastStatus) {
        console.log(`[AuditRunner] Session status: ${sessionData.status}, runningId: ${sessionData.runningId || 'none'}`);
        lastStatus = currentStatus;
      }

      // If session is idle AND we've been polling for a while, it might be done
      // But if runningId is null immediately, the agent may not have started yet
      if (sessionData.status === 'idle' && sessionData.runningId === null) {
        // Check if we have messages to verify agent actually ran
        const msgCheckResponse = await fetch(
          `${this.config.baseUrl}/api/agent/sessions/${sessionId}/messages`,
          { signal: AbortSignal.timeout(10000) }
        );

        if (msgCheckResponse.ok) {
          const messages = await msgCheckResponse.json() as Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
          const assistantMsgs = messages.filter(m => m.role === 'assistant');

          // If we have assistant messages, check if audit actually completed
          if (assistantMsgs.length > 0) {
            // Check if the last message indicates real work was done
            const lastMsg = assistantMsgs[assistantMsgs.length - 1];
            const msgText = lastMsg.content?.map(c => c.text || '').join('') || '';

            // If the message is asking for repo URL or says no repo, keep waiting if still early
            if (pollCount < 6 && (msgText.includes('repository URL') || msgText.includes('no repository') || msgText.includes('Could you please provide'))) {
              console.log('[AuditRunner] Agent needs more info, waiting for tools to execute...');
              await new Promise(resolve => setTimeout(resolve, 15000));
              continue;
            }

            // Check if slither or aderyn was mentioned (indicates actual analysis was done)
            const analysisPerformed = msgText.toLowerCase().includes('slither') ||
                                      msgText.toLowerCase().includes('aderyn') ||
                                      msgText.toLowerCase().includes('vulnerabilit') ||
                                      msgText.toLowerCase().includes('finding');

            if (analysisPerformed || pollCount >= 12) {
              console.log(`[AuditRunner] Session completed with ${assistantMsgs.length} assistant messages`);
              break;
            }

            // Otherwise keep waiting for the agent to complete more work
            console.log(`[AuditRunner] Waiting for analysis to complete (poll ${pollCount})...`);
            await new Promise(resolve => setTimeout(resolve, 15000));
            continue;
          }
        }

        // If no assistant messages yet and we just started, keep waiting
        if (pollCount < 6) {
          console.log('[AuditRunner] No response yet, waiting for agent to process...');
          await new Promise(resolve => setTimeout(resolve, 15000));
          continue;
        }

        // Agent seems to have completed (or failed to start)
        console.log('[AuditRunner] Session appears complete');
        break;
      }

      // Wait before next poll
      await new Promise(resolve => setTimeout(resolve, 10000));
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`[AuditRunner] Polling completed after ${elapsed}s (${pollCount} checks)`);

    // Get the last assistant message
    const messagesResponse = await fetch(
      `${this.config.baseUrl}/api/agent/sessions/${sessionId}/messages`,
      { signal: AbortSignal.timeout(10000) }
    );

    if (!messagesResponse.ok) {
      throw new Error('Failed to get messages');
    }

    const messages = await messagesResponse.json() as Array<{
      role: string;
      content: Array<{ type: string; text?: string; name?: string; input?: any }>;
    }>;

    // Store the full session logs for later retrieval
    this.lastSessionLogs = messages;

    // Find the last assistant message
    const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
    let fullResponse = '';

    if (lastAssistant && lastAssistant.content) {
      for (const part of lastAssistant.content) {
        if (part.type === 'text' && part.text) {
          fullResponse += part.text;
        }
      }
    }

    console.log(`[AuditRunner] Response received (${fullResponse.length} chars), ${messages.length} messages logged`);
    return fullResponse;
  }

  /**
   * Get the session logs from the last audit
   */
  getSessionLogs(): any[] {
    return this.lastSessionLogs;
  }

  /**
   * Get findings from project via DD API
   */
  private async getFindingsFromProject(projectId: string): Promise<Finding[]> {
    try {
      const response = await fetch(
        `${this.config.baseUrl}/api/projects/${projectId}/findings`,
        { signal: AbortSignal.timeout(30000) }
      );

      if (!response.ok) {
        console.warn(`[AuditRunner] Failed to get findings: ${response.status}`);
        return [];
      }

      const data = await response.json() as Array<{
        meta: {
          id: string;
          title: string;
          severity: string;
          file?: string;
          function?: string;
          category?: string;
          detector?: string;
          confidence?: string;
          analysis?: {
            process?: string[];
            tools?: string[];
            methods?: string[];
            methodology?: string;
            duration?: number;
            severityReasoning?: string;
          };
        };
        content: string;
      }>;

      return data.map((f) => ({
        id: f.meta.id || 'unknown',
        title: f.meta.title || 'Untitled',
        severity: this.normalizeSeverity(f.meta.severity),
        description: f.content || '',
        targets: f.meta.file ? [f.meta.file] : [],
        source: 'dd_audit' as const,
        category: f.meta.category as any,
        file: f.meta.file,
        function: f.meta.function,
        detector: f.meta.detector,
        confidence: f.meta.confidence,
        // Include analysis metadata if provided
        analysis: f.meta.analysis,
      }));
    } catch (error) {
      console.warn('[AuditRunner] Error getting findings:', error);
      return [];
    }
  }

  /**
   * Normalize severity string
   */
  private normalizeSeverity(severity: string | undefined): Finding['severity'] {
    if (!severity) return 'medium';
    const lower = severity.toLowerCase();
    if (lower.includes('crit')) return 'critical';
    if (lower.includes('high')) return 'high';
    if (lower.includes('med')) return 'medium';
    if (lower.includes('low')) return 'low';
    return 'info';
  }

  /**
   * Save audit results
   */
  private async saveResults(projectName: string, findings: Finding[]): Promise<void> {
    const resultsDir = path.join(this.outputDir, 'runs', projectName);
    await fs.mkdir(resultsDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = path.join(resultsDir, `findings-${timestamp}.json`);

    await fs.writeFile(filePath, JSON.stringify(findings, null, 2));
    console.log(`[AuditRunner] Saved ${findings.length} findings to ${filePath}`);
  }

  /**
   * Run audit in mock mode (for testing)
   */
  async runMockAudit(project: C4Project): Promise<Finding[]> {
    console.log(`[AuditRunner] Running mock audit for ${project.name}`);

    // Simulate audit time
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Return some mock findings
    return [
      {
        id: 'dd-mock-1',
        title: 'Mock Finding 1',
        severity: 'medium',
        description: 'This is a mock finding for testing',
        targets: ['Contract.sol'],
        source: 'dd_audit',
      },
    ];
  }
}
