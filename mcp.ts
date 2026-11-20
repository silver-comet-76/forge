// Model Context Protocol at /mcp: Streamable HTTP JSON-RPC, modern era (2026-07-28) with the
// legacy initialize handshake kept for older clients. One JSON body answers each POST; there is
// no session and no SSE stream. Authentication is decided before any tool exists: no bearer
// token is HTTP 401. Unknown tools are JSON-RPC errors, never HTTP 500.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { authorized, sendJson, store, unauthorized } from './http.ts';
import { VIEWER_LOGIN, type Issue, type Pull, type Repo } from './store.ts';

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18'] as const;

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

/** The tool list is one constant so two tools/list answers are byte-identical. */
const TOOLS: readonly ToolDefinition[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request between two branches of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringArg(args: Record<string, unknown>, name: string): string | null {
  const value = args[name];
  return typeof value === 'string' ? value : null;
}

function numberArg(args: Record<string, unknown>, name: string): number | null {
  const value = args[name];
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  return null;
}

interface ToolOutcome {
  structured: Record<string, unknown>;
  isError: boolean;
}

function toolOk(structured: Record<string, unknown>): ToolOutcome {
  return { structured, isError: false };
}

function toolError(message: string): ToolOutcome {
  return { structured: { error: message }, isError: true };
}

/** The repo at owner/name, or null when it is not the viewer's. */
function loadRepo(args: Record<string, unknown>): Repo | null {
  const owner = stringArg(args, 'owner');
  const repoName = stringArg(args, 'repo');
  if (owner === null || repoName === null) return null;
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined || repo.owner !== VIEWER_LOGIN) return null;
  return repo;
}

function repoResult(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function issueResult(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels,
    repository: `${repo.owner}/${repo.name}`,
  };
}

function pullResult(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    head: { ref: pull.head.ref, sha: pull.head.sha },
    base: { ref: pull.base.ref, sha: pull.base.sha },
    repository: `${repo.owner}/${repo.name}`,
  };
}

function callTool(name: string, args: Record<string, unknown>): ToolOutcome {
  switch (name) {
    case 'create_repo': {
      const repoName = stringArg(args, 'name');
      if (repoName === null || repoName === '') return toolError('create_repo needs a name');
      const description = stringArg(args, 'description') ?? '';
      const isPrivate = args.private === true;
      const repo = store.createRepo(VIEWER_LOGIN, repoName, description, isPrivate);
      if (repo === null) return toolError(`Repository ${repoName} already exists`);
      return toolOk(repoResult(repo));
    }
    case 'get_repo': {
      const repo = loadRepo(args);
      if (repo === null) return toolError('repository not found');
      return toolOk(repoResult(repo));
    }
    case 'create_issue': {
      const repo = loadRepo(args);
      if (repo === null) return toolError('repository not found');
      const title = stringArg(args, 'title');
      if (title === null || title === '') return toolError('create_issue needs a title');
      const body = stringArg(args, 'body') ?? '';
      const issue = store.createIssue(repo, title, body, []);
      if ('error' in issue) return toolError(issue.message);
      return toolOk(issueResult(repo, issue));
    }
    case 'list_issues': {
      const repo = loadRepo(args);
      if (repo === null) return toolError('repository not found');
      const state = stringArg(args, 'state') ?? 'open';
      let issues = [...repo.issues];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      return toolOk({ issues: issues.map((issue) => issueResult(repo, issue)) });
    }
    case 'create_pull_request': {
      const repo = loadRepo(args);
      if (repo === null) return toolError('repository not found');
      const title = stringArg(args, 'title');
      const head = stringArg(args, 'head');
      const base = stringArg(args, 'base');
      if (title === null || title === '' || head === null || base === null) {
        return toolError('create_pull_request needs title, head and base');
      }
      const pull = store.createPull(repo, head, base, title, '');
      if ('error' in pull) return toolError(pull.message);
      return toolOk(pullResult(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = loadRepo(args);
      if (repo === null) return toolError('repository not found');
      const number = numberArg(args, 'pull_number');
      if (number === null) return toolError('merge_pull_request needs pull_number');
      const pull = store.getPull(repo, number);
      if (pull === undefined) return toolError(`pull request #${number} not found`);
      const result = store.mergePull(repo, pull);
      if ('error' in result) return toolError(result.message);
      return toolOk({ number: pull.number, merged: true, sha: result.sha, state: pull.state });
    }
    default:
      return toolError(`unknown tool ${name}`);
  }
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<void> {
  // Authentication is decided before any tool exists.
  if (!authorized(req)) {
    unauthorized(res);
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    sendJson(res, 200, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }
  const request = parsed as Record<string, unknown>;
  const id = request.id === undefined ? null : request.id;
  const method = request.method;
  if (typeof method !== 'string') {
    sendJson(res, 200, { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }
  // A notification (no id) is answered with 202 and no body.
  if (id === null) {
    res.writeHead(202);
    res.end();
    return;
  }
  const params = isRecord(request.params) ? request.params : {};
  const respond = (result: unknown): void => {
    sendJson(res, 200, { jsonrpc: '2.0', id, result });
  };
  const respondError = (code: number, message: string): void => {
    sendJson(res, 200, { jsonrpc: '2.0', id, error: { code, message } });
  };

  switch (method) {
    case 'server/discover': {
      respond({
        supportedVersions: [...SUPPORTED_VERSIONS],
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        _meta: {
          'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION },
          'io.modelcontextprotocol/protocolVersion': SUPPORTED_VERSIONS[0],
        },
      });
      return;
    }
    case 'initialize': {
      const offered = params.protocolVersion;
      const version =
        typeof offered === 'string' && (SUPPORTED_VERSIONS as readonly string[]).includes(offered) ? offered : SUPPORTED_VERSIONS[0]!;
      respond({
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
      return;
    }
    case 'tools/list': {
      respond({ tools: TOOLS });
      return;
    }
    case 'tools/call': {
      const name = params.name;
      if (typeof name !== 'string' || name === '') {
        respondError(-32602, 'tools/call needs a tool name');
        return;
      }
      const tool = TOOLS.find((candidate) => candidate.name === name);
      if (tool === undefined) {
        respondError(-32601, `Method not found: ${name}`);
        return;
      }
      const args = isRecord(params.arguments) ? params.arguments : {};
      const missing = tool.inputSchema.required.filter((property) => !(property in args));
      if (missing.length > 0) {
        respond({
          content: [{ type: 'text', text: `Missing required arguments: ${missing.join(', ')}` }],
          structuredContent: { error: `Missing required arguments: ${missing.join(', ')}` },
          isError: true,
        });
        return;
      }
      const outcome = callTool(name, args);
      const text = JSON.stringify(outcome.structured);
      respond({
        content: [{ type: 'text', text }],
        structuredContent: outcome.structured,
        isError: outcome.isError,
      });
      return;
    }
    default: {
      respondError(-32601, `Method not found: ${method}`);
      return;
    }
  }
}
