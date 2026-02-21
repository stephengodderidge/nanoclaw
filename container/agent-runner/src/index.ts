/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent idle event).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import { CopilotClient } from '@github/copilot-sdk';
import type { MCPLocalServerConfig, SessionConfig } from '@github/copilot-sdk';
import { fileURLToPath } from 'url';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  secrets?: Record<string, string>;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

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

// Secrets to strip from shell tool subprocess environments.
// These are needed by copilot for API auth but should never
// be visible to commands the agent runs.
const SECRET_ENV_VARS = ['GITHUB_TOKEN'];

function createSanitizeBashHook(): NonNullable<NonNullable<SessionConfig['hooks']>['onPreToolUse']> {
  return async (input) => {
    const args = input.toolArgs as Record<string, unknown> | null;
    const command = args?.command as string | undefined;
    if (!command) return;

    const unsetPrefix = `unset ${SECRET_ENV_VARS.join(' ')} 2>/dev/null; `;
    return {
      modifiedArgs: {
        ...args,
        command: unsetPrefix + command,
      },
    };
  };
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

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null): string {
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
    const sender = msg.role === 'user' ? 'User' : 'Andy';
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
 * Run a single query against the Copilot session and stream results via writeOutput.
 * Enqueues IPC messages into the session while the agent is processing.
 * Returns when the session goes idle (all queued messages processed).
 */
async function runQuery(
  prompt: string,
  client: CopilotClient,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  globalClaudeMd: string | undefined,
): Promise<{ newSessionId: string; lastAssistantContent: string | null; closedDuringQuery: boolean }> {
  const nanoclaw: MCPLocalServerConfig = {
    command: 'node',
    args: [mcpServerPath],
    env: {
      NANOCLAW_CHAT_JID: containerInput.chatJid,
      NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
      NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
    },
    tools: ['*'],
  };

  const sessionConfig = {
    model: 'claude-opus-4.6',
    workingDirectory: '/workspace/group',
    configDir: '/workspace/copilot-config',
    systemMessage: globalClaudeMd
      ? { mode: 'append' as const, content: globalClaudeMd }
      : undefined,
    hooks: {
      onPreToolUse: createSanitizeBashHook(),
    },
    // Bypass permission prompts: the agent runs inside an isolated container, so all
    // operations are already sandboxed at the OS level (filesystem mounts, network).
    onPermissionRequest: () => ({ kind: 'approved' as const }),
    mcpServers: { nanoclaw },
  };

  let session;
  if (sessionId) {
    log(`Resuming session ${sessionId}`);
    session = await client.resumeSession(sessionId, sessionConfig);
  } else {
    log('Creating new session');
    session = await client.createSession(sessionConfig);
  }

  const newSessionId = session.sessionId;
  log(`Session ID: ${newSessionId}`);

  let lastAssistantContent: string | null = null;
  let sessionTitle: string | null = null;
  let closedDuringQuery = false;
  let ipcPolling = true;

  session.on('assistant.message', (event) => {
    lastAssistantContent = event.data.content;
  });
  session.on('session.title_changed', (event) => {
    sessionTitle = event.data.title;
  });

  // Archive conversation when Copilot begins context compaction
  session.on('session.compaction_start', async () => {
    try {
      const events = await session.getMessages();
      const messages: ParsedMessage[] = [];
      for (const evt of events) {
        if (evt.type === 'user.message' && evt.data.content) {
          messages.push({ role: 'user', content: evt.data.content });
        } else if (evt.type === 'assistant.message' && evt.data.content) {
          messages.push({ role: 'assistant', content: evt.data.content });
        }
      }

      if (messages.length === 0) return;

      const name = sessionTitle ? sanitizeFilename(sessionTitle) : generateFallbackName();
      const conversationsDir = '/workspace/group/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);
      fs.writeFileSync(filePath, formatTranscriptMarkdown(messages, sessionTitle));
      log(`Archived conversation to ${filePath}`);
    } catch (err) {
      log(`Failed to archive on compaction: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // Send the initial prompt
  await session.send({ prompt });

  // Poll IPC while the agent is processing; enqueue any follow-up messages
  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      log('Close sentinel detected during query, aborting session');
      closedDuringQuery = true;
      ipcPolling = false;
      session.abort().catch(() => { /* ignore */ });
      return;
    }
    const messages = drainIpcInput();
    for (const text of messages) {
      log(`Enqueuing IPC message into active query (${text.length} chars)`);
      session.send({ prompt: text, mode: 'enqueue' }).catch(err => { log(`Failed to enqueue IPC message: ${err instanceof Error ? err.message : String(err)}`); });
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  // Wait for the session to become idle (all queued messages processed)
  await new Promise<void>((resolve) => {
    const unsub = session.on('session.idle', () => {
      unsub();
      resolve();
    });
    session.on('session.error', (event) => {
      log(`Session error: ${event.data.message}`);
      unsub();
      resolve();
    });
  });

  ipcPolling = false;
  log(`Query done. lastAssistantContent: ${lastAssistantContent ? (lastAssistantContent as string).slice(0, 100) : 'none'}, closedDuringQuery: ${closedDuringQuery}`);
  return { newSessionId, lastAssistantContent, closedDuringQuery };
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    // Delete the temp file the entrypoint wrote — it contains secrets
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

  // Build SDK env: merge secrets into process.env for the SDK only.
  // Secrets never touch process.env itself, so shell subprocesses can't see them.
  const sdkEnv: Record<string, string | undefined> = { ...process.env };
  for (const [key, value] of Object.entries(containerInput.secrets || {})) {
    sdkEnv[key] = value;
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId = containerInput.sessionId;
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

  // Load global CLAUDE.md as additional system context (shared across all groups)
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  let globalClaudeMd: string | undefined;
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  // Create the Copilot client (shared across all queries in this container run).
  // sdkEnv includes GITHUB_TOKEN (injected from secrets), which the CLI picks up for auth.
  const client = new CopilotClient({
    env: sdkEnv,
    cwd: '/workspace/group',
  });

  // Query loop: run query → wait for IPC message → run new query → repeat
  try {
    while (true) {
      log(`Starting query (session: ${sessionId || 'new'})...`);

      const queryResult = await runQuery(prompt, client, sessionId, mcpServerPath, containerInput, globalClaudeMd);
      sessionId = queryResult.newSessionId;

      // If _close was consumed during the query, exit immediately.
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      writeOutput({
        status: 'success',
        result: queryResult.lastAssistantContent,
        newSessionId: sessionId,
      });

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
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
    process.exit(1);
  } finally {
    await client.stop().catch(() => { /* ignore cleanup errors */ });
  }
}

main();
