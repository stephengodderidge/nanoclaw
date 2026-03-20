/**
 * NanoClaw Agent Runner (GitHub Copilot SDK)
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import { CopilotClient, approveAll } from '@github/copilot-sdk';
import type { CopilotSession } from '@github/copilot-sdk';
import { fileURLToPath } from 'url';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;
const DEFAULT_MODEL = process.env.MODEL || 'claude-opus-4.6';

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function getSessionSummary(sessionId: string, groupDir: string): string | null {
  const indexPath = path.join(groupDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    const entry = index.entries.find(e => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(`Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`);
  }

  return null;
}

/**
 * Archive the conversation to conversations/ on compaction.
 * Called when the Copilot SDK fires session.compaction_start.
 * Uses session.getMessages() instead of Claude SDK's transcript file.
 */
function archiveConversation(session: CopilotSession, containerInput: ContainerInput): void {
  try {
    const events = session.getMessages();
    const messages: ParsedMessage[] = [];

    for (const event of events) {
      if (event.type === 'user.message' && event.data?.content) {
        messages.push({ role: 'user', content: String(event.data.content) });
      } else if (event.type === 'assistant.message' && event.data?.content) {
        messages.push({ role: 'assistant', content: String(event.data.content) });
      }
    }

    if (messages.length === 0) {
      log('No messages to archive');
      return;
    }

    const sessionId = session.sessionId;
    const summary = getSessionSummary(sessionId, '/workspace/group');
    const name = summary ? sanitizeFilename(summary) : generateFallbackName();

    const conversationsDir = '/workspace/group/conversations';
    fs.mkdirSync(conversationsDir, { recursive: true });

    const date = new Date().toISOString().split('T')[0];
    const filename = `${date}-${name}.md`;
    const filePath = path.join(conversationsDir, filename);

    const markdown = formatTranscriptMarkdown(messages, summary, containerInput.assistantName);
    fs.writeFileSync(filePath, markdown);

    log(`Archived conversation to ${filePath}`);
  } catch (err) {
    log(`Failed to archive conversation: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null, assistantName?: string): string {
  const now = new Date();
  const formatDateTime = (d: Date) => d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : (assistantName || 'Assistant');
    const content = msg.content.length > 2000
      ? msg.content.slice(0, 2000) + '...'
      : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages.
 * Returns messages found, or empty array.
 */
function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the messages as a single string, or null if _close.
 */
function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

/**
 * Find the memory file in a directory: prefers AGENTS.md, falls back to CLAUDE.md.
 */
function findMemoryFile(dir: string): string | null {
  const agentsMd = path.join(dir, 'AGENTS.md');
  if (fs.existsSync(agentsMd)) return agentsMd;
  const claudeMd = path.join(dir, 'CLAUDE.md');
  if (fs.existsSync(claudeMd)) return claudeMd;
  return null;
}

/**
 * Build the system message from global and extra directory memory files.
 * Group-level AGENTS.md is auto-loaded by the Copilot SDK via workspacePath,
 * so we only inject global + extra memories here.
 */
function buildSystemMessage(containerInput: ContainerInput): { content: string; mode: 'append' } | undefined {
  const parts: string[] = [];

  // Global memory (shared across all groups, read-only for non-main)
  if (!containerInput.isMain) {
    const globalFile = findMemoryFile('/workspace/global');
    if (globalFile) {
      parts.push(fs.readFileSync(globalFile, 'utf-8'));
    }
  }

  // Extra directories' memory files
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const memFile = findMemoryFile(path.join(extraBase, entry));
      if (memFile) {
        parts.push(fs.readFileSync(memFile, 'utf-8'));
      }
    }
  }

  if (parts.length === 0) return undefined;
  return { content: parts.join('\n\n---\n\n'), mode: 'append' as const };
}

/**
 * Create or resume a Copilot SDK session.
 */
async function createOrResumeSession(
  client: CopilotClient,
  containerInput: ContainerInput,
  mcpServerPath: string,
): Promise<CopilotSession> {
  const systemMessage = buildSystemMessage(containerInput);

  const sessionConfig = {
    model: DEFAULT_MODEL,
    streaming: true,
    onPermissionRequest: approveAll,
    systemMessage,
    mcpServers: {
      nanoclaw: {
        type: 'local' as const,
        command: 'node',
        args: [mcpServerPath],
        env: {
          NANOCLAW_CHAT_JID: containerInput.chatJid,
          NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
          NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
        },
        tools: ['*'] as string[],
      },
    },
    infiniteSessions: {
      enabled: true,
      backgroundCompactionThreshold: 0.80,
      bufferExhaustionThreshold: 0.95,
    },
  };

  if (containerInput.sessionId) {
    log(`Resuming session: ${containerInput.sessionId}`);
    return client.resumeSession({
      sessionId: containerInput.sessionId,
      ...sessionConfig,
    });
  }

  log('Creating new session');
  return client.createSession(sessionConfig);
}

/**
 * Send a prompt and wait for the response.
 * Polls for _close sentinel and IPC follow-up messages during execution.
 */
async function sendPrompt(
  session: CopilotSession,
  prompt: string,
): Promise<{ result: string | null; aborted: boolean }> {
  let aborted = false;

  // Poll for _close sentinel and IPC follow-up messages during query
  const ipcPoll = setInterval(() => {
    if (shouldClose()) {
      log('Close sentinel detected during query, aborting');
      aborted = true;
      session.abort();
      clearInterval(ipcPoll);
      return;
    }
    const messages = drainIpcInput();
    for (const text of messages) {
      log(`Enqueuing IPC follow-up message (${text.length} chars)`);
      session.send({ prompt: text, mode: 'enqueue' });
    }
  }, IPC_POLL_MS);

  try {
    const response = await session.sendAndWait({ prompt });
    clearInterval(ipcPoll);
    return { result: response?.data?.content || null, aborted };
  } catch (err) {
    clearInterval(ipcPoll);
    if (aborted) return { result: null, aborted: true };
    throw err;
  }
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try { fs.unlinkSync('/tmp/input.json'); } catch { /* may not exist */ }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Start Copilot SDK client
  // Auth: picks up GITHUB_TOKEN from environment (injected by host credential proxy)
  const client = new CopilotClient();
  await client.start();

  let session: CopilotSession;
  try {
    session = await createOrResumeSession(client, containerInput, mcpServerPath);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to create session: ${err instanceof Error ? err.message : String(err)}`
    });
    await client.stop();
    process.exit(1);
  }

  // Session ID for tracking — use the provided ID or the SDK-assigned one
  const sessionId = containerInput.sessionId || session.sessionId;
  log(`Session ready: ${sessionId} (model: ${DEFAULT_MODEL})`);

  // Archive conversation before context compaction
  session.on('session.compaction_start', () => {
    archiveConversation(session, containerInput);
  });

  // Query loop: send prompt → wait for response → wait for IPC message → repeat
  try {
    while (true) {
      log(`Sending prompt (${prompt.length} chars)...`);

      const { result, aborted } = await sendPrompt(session, prompt);

      writeOutput({
        status: 'success',
        result,
        newSessionId: sessionId,
      });

      if (aborted) {
        log('Query aborted via close sentinel, exiting');
        break;
      }

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), continuing session`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage
    });
  }

  // Cleanup: disconnect session (preserves state on disk) and stop client
  await session.disconnect();
  await client.stop();
}

main();
