// The MCP endpoint at /mcp: a stateless streamable-HTTP JSON-RPC server in the
// legacy era (initialize + notifications/initialized; server/discover is a
// clean method-not-found, which the suite accepts as a pre-discover server).
// Its tools are github-mcp-server's core set, acting on the same store as the
// REST and GraphQL surfaces — an issue created here is the issue REST lists.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRepo, findItem, findRepo, nowIso, viewerLogin, type IssueRec, type RepoRec, type Store } from './store.ts';
import {
  branchHead,
  commitInfo,
  gitRepo,
  isAncestor,
  mergeBase,
  setRef,
  threeWayMergeTrees,
  writeCommit,
} from './gitstore.ts';
import { baseUrl, readBody } from './http.ts';

const SERVER_INFO = { name: 'SANTO Forge', version: '1.0.0' };
const LEGACY_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function objectSchema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', properties, required };
}

const STRING = { type: 'string' };
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: objectSchema(
      { name: STRING, description: STRING, private: { type: 'boolean' } },
      ['name'],
    ),
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: objectSchema({ owner: STRING, repo: STRING }, ['owner', 'repo']),
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: objectSchema({ owner: STRING, repo: STRING, title: STRING, body: STRING }, ['owner', 'repo', 'title']),
  },
  {
    name: 'list_issues',
    description: 'List a repository\u2019s issues, newest first, optionally filtered by state (open, closed or all).',
    inputSchema: objectSchema({ owner: STRING, repo: STRING, state: STRING }, ['owner', 'repo']),
  },
  {
    name: 'get_issue',
    description: 'Read one issue by number.',
    inputSchema: objectSchema(
      { owner: STRING, repo: STRING, issue_number: { type: 'number' } },
      ['owner', 'repo', 'issue_number'],
    ),
  },
  {
    name: 'add_issue_comment',
    description: 'Comment on an issue or pull request.',
    inputSchema: objectSchema(
      { owner: STRING, repo: STRING, issue_number: { type: 'number' }, body: STRING },
      ['owner', 'repo', 'issue_number', 'body'],
    ),
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: objectSchema(
      { owner: STRING, repo: STRING, title: STRING, body: STRING, head: STRING, base: STRING },
      ['owner', 'repo', 'title', 'head', 'base'],
    ),
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash by default), moving its base branch.',
    inputSchema: objectSchema(
      { owner: STRING, repo: STRING, pull_number: { type: 'number' }, merge_method: STRING },
      ['owner', 'repo', 'pull_number'],
    ),
  },
];

// ---------------------------------------------------------------------------
// Tool execution. Every result is a text block holding the JSON shape the REST
// surface would answer with, so a reader sees the same object on both.

interface ToolOutcome {
  text: string;
  isError?: boolean;
}

function errorText(message: string): ToolOutcome {
  return { text: message, isError: true };
}

function repoSummary(store: Store, base: string, repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: Buffer.from(`Repository:${repo.id}`).toString('base64'),
    name: repo.name,
    full_name: `${viewerLogin(store)}/${repo.name}`,
    owner: { login: viewerLogin(store) },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `${base}/${viewerLogin(store)}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

function issueSummary(item: IssueRec): Record<string, unknown> {
  return {
    id: item.id,
    number: item.number,
    title: item.title,
    body: item.body,
    state: item.state,
    labels: item.labels,
    comments: item.comments.length,
    created_at: item.createdAt,
    updated_at: item.updatedAt,
  };
}

function pullSummary(item: IssueRec): Record<string, unknown> {
  return {
    id: item.id,
    number: item.number,
    title: item.title,
    body: item.body,
    state: item.merged ? 'merged' : item.state,
    merged: item.merged ?? false,
    merge_commit_sha: item.mergeSha ?? null,
    head: { ref: item.headRef ?? null, sha: item.headSha ?? null },
    base: { ref: item.baseRef ?? null, sha: item.baseSha ?? null },
    created_at: item.createdAt,
    updated_at: item.updatedAt,
  };
}

function stringArg(args: Record<string, unknown>, name: string): string | null {
  const value = args[name];
  return typeof value === 'string' && value !== '' ? value : null;
}

function numberArg(args: Record<string, unknown>, name: string): number | null {
  const value = args[name];
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

/** The required properties of a tool that a call did not supply. */
function missingArgs(tool: ToolDef, args: Record<string, unknown>): string[] {
  const required = (tool.inputSchema.required as string[] | undefined) ?? [];
  return required.filter((name) => args[name] === undefined || args[name] === null || args[name] === '');
}

function runTool(store: Store, base: string, tool: ToolDef, args: Record<string, unknown>): ToolOutcome {
  const missing = missingArgs(tool, args);
  if (missing.length > 0) return errorText(`missing required argument(s): ${missing.join(', ')}`);

  switch (tool.name) {
    case 'create_repo': {
      const name = stringArg(args, 'name') as string;
      if (store.repos.has(name)) return errorText(`a repository named ${name} already exists`);
      const repo = createRepo(store, {
        name,
        description: stringArg(args, 'description') ?? '',
        private: args.private === true,
      });
      return { text: JSON.stringify(repoSummary(store, base, repo), null, 2) };
    }
    case 'get_repo': {
      const repo = findRepo(store, stringArg(args, 'owner') as string, stringArg(args, 'repo') as string);
      if (repo === null) return errorText('repository not found');
      return { text: JSON.stringify(repoSummary(store, base, repo), null, 2) };
    }
    case 'create_issue': {
      const repo = findRepo(store, stringArg(args, 'owner') as string, stringArg(args, 'repo') as string);
      if (repo === null) return errorText('repository not found');
      const at = nowIso();
      const item: IssueRec = {
        id: store.nextIssueId,
        number: repo.nextNumber,
        kind: 'issue',
        title: stringArg(args, 'title') as string,
        body: stringArg(args, 'body') ?? '',
        state: 'open',
        labels: [],
        comments: [],
        createdSeq: store.seq,
        createdAt: at,
        updatedAt: at,
        closedAt: null,
      };
      store.nextIssueId += 1;
      store.seq += 1;
      repo.nextNumber += 1;
      repo.items.push(item);
      return { text: JSON.stringify(issueSummary(item), null, 2) };
    }
    case 'list_issues': {
      const repo = findRepo(store, stringArg(args, 'owner') as string, stringArg(args, 'repo') as string);
      if (repo === null) return errorText('repository not found');
      const state = stringArg(args, 'state') ?? 'open';
      let items = repo.items.filter((item) => item.kind === 'issue');
      if (state === 'open' || state === 'closed') items = items.filter((item) => item.state === state);
      items = [...items].sort((a, b) => b.createdSeq - a.createdSeq);
      return { text: JSON.stringify(items.map(issueSummary), null, 2) };
    }
    case 'get_issue': {
      const repo = findRepo(store, stringArg(args, 'owner') as string, stringArg(args, 'repo') as string);
      if (repo === null) return errorText('repository not found');
      const item = findItem(repo, numberArg(args, 'issue_number') as number);
      if (item === null) return errorText('issue not found');
      return { text: JSON.stringify(item.kind === 'pull' ? pullSummary(item) : issueSummary(item), null, 2) };
    }
    case 'add_issue_comment': {
      const repo = findRepo(store, stringArg(args, 'owner') as string, stringArg(args, 'repo') as string);
      if (repo === null) return errorText('repository not found');
      const item = findItem(repo, numberArg(args, 'issue_number') as number);
      if (item === null) return errorText('issue not found');
      const at = nowIso();
      const comment = { id: store.nextCommentId, body: stringArg(args, 'body') as string, createdSeq: store.seq, createdAt: at, updatedAt: at };
      store.nextCommentId += 1;
      store.seq += 1;
      item.comments.push(comment);
      item.updatedAt = at;
      return { text: JSON.stringify({ id: comment.id, body: comment.body, created_at: at }, null, 2) };
    }
    case 'create_pull_request': {
      const repo = findRepo(store, stringArg(args, 'owner') as string, stringArg(args, 'repo') as string);
      if (repo === null) return errorText('repository not found');
      const g = gitRepo(repo.id);
      const headRef = stringArg(args, 'head') as string;
      const baseRef = stringArg(args, 'base') as string;
      const headSha = branchHead(g, headRef);
      const baseSha = branchHead(g, baseRef);
      if (headSha === null || baseSha === null) return errorText('the head or base branch does not exist');
      const at = nowIso();
      const item: IssueRec = {
        id: store.nextIssueId,
        number: repo.nextNumber,
        kind: 'pull',
        title: stringArg(args, 'title') as string,
        body: stringArg(args, 'body') ?? '',
        state: 'open',
        labels: [],
        comments: [],
        createdSeq: store.seq,
        createdAt: at,
        updatedAt: at,
        closedAt: null,
        headRef,
        headSha,
        baseRef,
        baseSha,
        merged: false,
        mergedAt: null,
      };
      store.nextIssueId += 1;
      store.seq += 1;
      repo.nextNumber += 1;
      repo.items.push(item);
      return { text: JSON.stringify(pullSummary(item), null, 2) };
    }
    case 'merge_pull_request': {
      const repo = findRepo(store, stringArg(args, 'owner') as string, stringArg(args, 'repo') as string);
      if (repo === null) return errorText('repository not found');
      const item = findItem(repo, numberArg(args, 'pull_number') as number);
      if (item === null || item.kind !== 'pull') return errorText('pull request not found');
      if (item.merged) return errorText('pull request is already merged');
      const g = gitRepo(repo.id);
      const baseRef = item.baseRef ?? repo.defaultBranch;
      const headRef = item.headRef ?? '';
      const baseTip = branchHead(g, baseRef);
      const headTip = branchHead(g, headRef);
      if (baseTip === null || headTip === null) return errorText('the pull request branches no longer exist');
      const ancestor = mergeBase(g, baseTip, headTip);
      const ancestorTree = ancestor === null ? null : (commitInfo(g, ancestor)?.tree ?? null);
      const merged = threeWayMergeTrees(g, ancestorTree, commitInfo(g, baseTip)?.tree ?? '', commitInfo(g, headTip)?.tree ?? '');
      if (merged.tree === undefined) return errorText('the pull request has conflicts and cannot be merged');
      const login = viewerLogin(store);
      const method = stringArg(args, 'merge_method') ?? 'squash';
      let newSha: string;
      if (method === 'merge' && !isAncestor(g, headTip, baseTip) && !isAncestor(g, baseTip, headTip)) {
        newSha = writeCommit(g, {
          tree: merged.tree,
          parents: [baseTip, headTip],
          authorName: login,
          authorEmail: `${login}@example.invalid`,
          message: `Merge pull request #${item.number}`,
        });
      } else if (method === 'merge' && isAncestor(g, baseTip, headTip)) {
        newSha = headTip;
      } else {
        newSha = writeCommit(g, {
          tree: merged.tree,
          parents: [baseTip],
          authorName: login,
          authorEmail: `${login}@example.invalid`,
          message: `${item.title} (#${item.number})`,
        });
      }
      setRef(g, `refs/heads/${baseRef}`, newSha);
      item.merged = true;
      item.mergeSha = newSha;
      item.mergedAt = nowIso();
      item.state = 'closed';
      item.closedAt = item.mergedAt;
      item.updatedAt = item.mergedAt;
      return { text: JSON.stringify({ sha: newSha, merged: true, message: 'Pull Request successfully merged', pull_request: pullSummary(item) }, null, 2) };
    }
    default:
      return errorText(`unknown tool ${tool.name}`);
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC plumbing.

interface RpcMessage {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/** Answer one JSON-RPC request object; null for a notification (no answer). */
function handleMessage(store: Store, base: string, message: RpcMessage): Record<string, unknown> | null {
  const isNotification = message.id === undefined;
  const method = message.method ?? '';
  const params = message.params ?? {};
  switch (method) {
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = LEGACY_REVISIONS.includes(requested) ? requested : '2025-06-18';
      return rpcResult(message.id, {
        protocolVersion: negotiated,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;
    case 'ping':
      return rpcResult(message.id, {});
    case 'tools/list':
      return rpcResult(message.id, { tools: TOOLS });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const tool = TOOLS.find((entry) => entry.name === name);
      if (tool === undefined) return rpcError(message.id, -32601, `unknown tool: ${name}`);
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const outcome = runTool(store, base, tool, args);
      return rpcResult(message.id, {
        content: [{ type: 'text', text: outcome.text }],
        isError: outcome.isError ?? false,
      });
    }
    default:
      if (isNotification) return null;
      return rpcError(message.id, -32601, `method not found: ${method}`);
  }
}

/** POST /mcp. Returns true when the path was the MCP endpoint. */
export async function handleMcp(store: Store, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== '/mcp') return false;
  if ((req.method ?? 'GET') !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json' });
    res.end(JSON.stringify(rpcError(null, -32601, 'method not allowed')));
    return true;
  }
  const raw = (await readBody(req)).toString('utf8');
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify(rpcError(null, -32700, 'Parse error')));
    return true;
  }
  const base = baseUrl(req);
  if (Array.isArray(body)) {
    const answers = body
      .map((entry) => handleMessage(store, base, entry as RpcMessage))
      .filter((entry) => entry !== null);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(answers));
    return true;
  }
  const answer = handleMessage(store, base, body as RpcMessage);
  if (answer === null) {
    res.writeHead(202);
    res.end();
    return true;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(answer));
  return true;
}
