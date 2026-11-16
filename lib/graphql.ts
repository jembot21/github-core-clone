// The GraphQL v4 surface at /api/graphql: a small parser and executor for the
// documents gh and github-mcp-server actually send — viewer, repository reads,
// issue and pull-request connections with cursor pagination, the five mutations
// those clients use, Relay node(id:) and the __type introspection probes gh's
// feature detection relies on. It reads and writes the same store as REST, so
// an issue created here is the issue REST lists.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { findItem, findRepo, nowIso, viewerLogin, type IssueRec, type RepoRec, type Store } from './store.ts';
import {
  branchHead,
  commitInfo,
  gitRepo,
  isAncestor,
  mergeBase,
  setRef,
  threeWayMergeTrees,
  writeCommit,
  type GitRepo,
} from './gitstore.ts';
import { parseJsonBody, readBody, sendJson } from './http.ts';
import { pullFiles } from './rest.ts';

// ---------------------------------------------------------------------------
// Lexer and parser for the GraphQL subset these documents use: operations
// with variables, aliases, arguments (literals, lists, objects, enums,
// variables), inline and named fragments. Directives are parsed and ignored.

type GqlValue =
  | string
  | number
  | boolean
  | null
  | GqlValue[]
  | { [key: string]: GqlValue }
  | { $var: string }
  | { $enum: string };

interface GqlField {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Record<string, GqlValue>;
  selections: GqlSelection[];
}

type GqlSelection =
  | GqlField
  | { kind: 'inline'; typeCondition: string | null; selections: GqlSelection[] }
  | { kind: 'spread'; name: string };

interface GqlOperation {
  type: 'query' | 'mutation';
  name: string | null;
  selections: GqlSelection[];
}

interface Token {
  kind: 'name' | 'string' | 'number' | 'punct' | 'spread';
  value: string;
}

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  while (at < input.length) {
    const ch = input[at] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      at += 1;
      continue;
    }
    if (ch === '#') {
      while (at < input.length && input[at] !== '\n') at += 1;
      continue;
    }
    if (ch === '.' && input.slice(at, at + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      at += 3;
      continue;
    }
    if ('!$():=@[]{}|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      at += 1;
      continue;
    }
    if (ch === '"') {
      if (input.slice(at, at + 3) === '"""') {
        const end = input.indexOf('"""', at + 3);
        tokens.push({ kind: 'string', value: input.slice(at + 3, end === -1 ? input.length : end) });
        at = end === -1 ? input.length : end + 3;
        continue;
      }
      let value = '';
      at += 1;
      while (at < input.length && input[at] !== '"') {
        if (input[at] === '\\' && at + 1 < input.length) {
          const esc = input[at + 1] as string;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          at += 2;
        } else {
          value += input[at];
          at += 1;
        }
      }
      at += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let end = at;
      while (end < input.length && /[0-9.eE+-]/.test(input[end] as string)) end += 1;
      tokens.push({ kind: 'number', value: input.slice(at, end) });
      at = end;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let end = at;
      while (end < input.length && /[_0-9A-Za-z]/.test(input[end] as string)) end += 1;
      tokens.push({ kind: 'name', value: input.slice(at, end) });
      at = end;
      continue;
    }
    at += 1; // Any other character is not meaningful in these documents.
  }
  return tokens;
}

class Parser {
  private tokens: Token[];
  private at = 0;

  constructor(input: string) {
    this.tokens = lex(input);
  }

  private peek(): Token | null {
    return this.tokens[this.at] ?? null;
  }

  private next(): Token {
    const token = this.tokens[this.at];
    if (token === undefined) throw new Error('unexpected end of document');
    this.at += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}, found ${token.value}`);
  }

  private skipBalanced(open: string, close: string): void {
    // The opening token is already consumed.
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.kind === 'punct' && token.value === open) depth += 1;
      else if (token.kind === 'punct' && token.value === close) depth -= 1;
    }
  }

  parseDocument(): { operations: GqlOperation[]; fragments: Map<string, GqlSelection[]> } {
    const operations: GqlOperation[] = [];
    const fragments = new Map<string, GqlSelection[]>();
    while (this.peek() !== null) {
      const token = this.peek() as Token;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind !== 'name') throw new Error(`unexpected token ${token.value}`);
      if (token.value === 'query' || token.value === 'mutation') {
        this.next();
        let name: string | null = null;
        if (this.peek()?.kind === 'name') name = this.next().value;
        if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
          this.next();
          this.skipBalanced('(', ')'); // Variable definitions: names/types/defaults.
        }
        this.skipDirectives();
        operations.push({ type: token.value, name, selections: this.parseSelectionSet() });
        continue;
      }
      if (token.value === 'fragment') {
        this.next();
        const fragName = this.next().value;
        this.next(); // 'on'
        this.next(); // type condition
        this.skipDirectives();
        fragments.set(fragName, this.parseSelectionSet());
        continue;
      }
      throw new Error(`unexpected definition ${token.value}`);
    }
    return { operations, fragments };
  }

  private skipDirectives(): void {
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
      this.next();
      this.next(); // directive name
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
        this.next();
        this.skipBalanced('(', ')');
      }
    }
  }

  private parseSelectionSet(): GqlSelection[] {
    this.expectPunct('{');
    const selections: GqlSelection[] = [];
    for (;;) {
      const token = this.peek();
      if (token === null) throw new Error('unterminated selection set');
      if (token.kind === 'punct' && token.value === '}') {
        this.next();
        return selections;
      }
      if (token.kind === 'spread') {
        this.next();
        const head = this.peek();
        if (head?.kind === 'name' && head.value === 'on') {
          this.next();
          const typeCondition = this.next().value;
          this.skipDirectives();
          selections.push({ kind: 'inline', typeCondition, selections: this.parseSelectionSet() });
        } else {
          const name = this.next().value;
          this.skipDirectives();
          selections.push({ kind: 'spread', name });
        }
        continue;
      }
      selections.push(this.parseField());
    }
  }

  private parseField(): GqlField {
    const first = this.next();
    if (first.kind !== 'name') throw new Error(`expected a field name, found ${first.value}`);
    let alias: string | null = null;
    let name = first.value;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === ':') {
      this.next();
      alias = name;
      name = this.next().value;
    }
    const args: Record<string, GqlValue> = {};
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.next();
      for (;;) {
        const token = this.peek();
        if (token?.kind === 'punct' && token.value === ')') {
          this.next();
          break;
        }
        const argName = this.next().value;
        this.expectPunct(':');
        args[argName] = this.parseValue();
      }
    }
    this.skipDirectives();
    let selections: GqlSelection[] = [];
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', name, alias, args, selections };
  }

  private parseValue(): GqlValue {
    const token = this.next();
    if (token.kind === 'string') return token.value;
    if (token.kind === 'number') return Number(token.value);
    if (token.kind === 'punct' && token.value === '$') return { $var: this.next().value };
    if (token.kind === 'punct' && token.value === '[') {
      const list: GqlValue[] = [];
      for (;;) {
        const head = this.peek();
        if (head?.kind === 'punct' && head.value === ']') {
          this.next();
          return list;
        }
        list.push(this.parseValue());
      }
    }
    if (token.kind === 'punct' && token.value === '{') {
      const obj: Record<string, GqlValue> = {};
      for (;;) {
        const head = this.peek();
        if (head?.kind === 'punct' && head.value === '}') {
          this.next();
          return obj;
        }
        const key = this.next().value;
        this.expectPunct(':');
        obj[key] = this.parseValue();
      }
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return { $enum: token.value };
    }
    throw new Error(`unexpected value token ${token.value}`);
  }
}

/** Resolve a parsed argument value against the operation's variables. */
function resolveValue(value: GqlValue, vars: Record<string, unknown>): unknown {
  if (value !== null && typeof value === 'object') {
    if ('$var' in value) return vars[(value as { $var: string }).$var] ?? null;
    if ('$enum' in value) return (value as { $enum: string }).$enum;
    if (Array.isArray(value)) return value.map((entry) => resolveValue(entry, vars));
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = resolveValue(entry, vars);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Global ids: the same base64 "Type:id" strings the REST node_id fields carry,
// so an id read on one surface resolves on the other.

function globalId(type: string, id: number): string {
  return Buffer.from(`${type}:${id}`).toString('base64');
}

function decodeGlobalId(id: string): { type: string; raw: string } | null {
  try {
    const decoded = Buffer.from(id, 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon === -1) return null;
    return { type: decoded.slice(0, colon), raw: decoded.slice(colon + 1) };
  } catch {
    return null;
  }
}

/** Find a repository by its numeric id (node ids carry the id, not the name). */
function repoById(store: Store, id: number): RepoRec | null {
  for (const repo of store.repos.values()) if (repo.id === id) return repo;
  return null;
}

/** Find an issue or pull request, and its repository, by numeric item id. */
function itemById(store: Store, id: number): { repo: RepoRec; item: IssueRec } | null {
  for (const repo of store.repos.values()) {
    const item = repo.items.find((entry) => entry.id === id);
    if (item !== undefined) return { repo, item };
  }
  return null;
}

// ---------------------------------------------------------------------------
// The schema's field lists, served to __type introspection (gh's feature
// detection probes these) and used to reject unknown fields by name.

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'nodes', 'user', 'organization', 'rateLimit', 'search', 'meta'],
  Mutation: [
    'createIssue', 'closeIssue', 'reopenIssue', 'createPullRequest', 'mergePullRequest', 'closePullRequest',
    'addComment', 'updateIssue', 'updatePullRequest',
  ],
  User: [
    'id', 'databaseId', 'login', 'name', 'email', 'url', 'resourcePath', 'avatarUrl', 'bio', 'company',
    'location', 'createdAt', 'updatedAt', 'isViewer', 'repositories', 'issues', 'pullRequests',
  ],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'hasProjectsEnabled', 'hasWikiEnabled', 'issue', 'issues', 'pullRequest',
    'pullRequests', 'description', 'isPrivate', 'isFork', 'isArchived', 'createdAt', 'updatedAt', 'url',
    'resourcePath', 'homepageUrl', 'primaryLanguage', 'stargazerCount', 'forkCount', 'labels', 'ref', 'refs',
  ],
  Ref: ['id', 'name', 'prefix', 'target', 'repository', 'associatedPullRequests'],
  Commit: ['id', 'oid', 'message', 'author', 'committer', 'committedDate', 'tree', 'parents', 'url'],
  Issue: [
    'id', 'databaseId', 'number', 'title', 'state', 'body', 'bodyText', 'author', 'editor', 'labels',
    'comments', 'assignees', 'milestone', 'createdAt', 'updatedAt', 'closedAt', 'closed', 'locked', 'url',
    'resourcePath', 'repository', 'participants', 'reactionGroups', 'viewerCanReact',
  ],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'state', 'body', 'bodyText', 'author', 'merged', 'mergedAt',
    'mergedBy', 'mergeable', 'mergeCommit', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid',
    'headRef', 'baseRef', 'files', 'commits', 'comments', 'createdAt', 'updatedAt', 'closedAt', 'closed',
    'locked', 'url', 'resourcePath', 'repository', 'additions', 'deletions', 'changedFiles', 'labels',
    'isDraft', 'reviewRequests', 'reviews',
  ],
  IssueComment: ['id', 'databaseId', 'body', 'bodyText', 'author', 'editor', 'createdAt', 'updatedAt', 'url', 'resourcePath', 'issue', 'pullRequest'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequestFile: ['path', 'additions', 'deletions', 'changeType', 'viewerViewedState'],
  CreateIssuePayload: ['clientMutationId', 'issue'],
  CloseIssuePayload: ['clientMutationId', 'issue'],
  CreatePullRequestPayload: ['clientMutationId', 'pullRequest'],
  MergePullRequestPayload: ['clientMutationId', 'pullRequest'],
  AddCommentPayload: ['clientMutationId', 'commentEdge', 'subject'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'interfaces', 'ofType'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __Schema: ['types', 'queryType', 'mutationType', 'subscriptionType', 'directives'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// ---------------------------------------------------------------------------
// Tagged values the executor walks.

interface Obj {
  t: string;
  [key: string]: unknown;
}

function userObj(store: Store): Obj {
  return { t: 'User', login: viewerLogin(store) };
}

function repoObj(repo: RepoRec): Obj {
  return { t: 'Repository', repo };
}

function itemObj(item: IssueRec, repo: RepoRec): Obj {
  return { t: item.kind === 'pull' ? 'PullRequest' : 'Issue', item, repo };
}

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`).toString('base64');
}

function indexFromCursor(cursor: string): number {
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(decoded);
    return match === null ? -1 : Number(match[1]);
  } catch {
    return -1;
  }
}

/** Slice a full list into a connection window by first/after. */
function connection(type: string, all: Obj[], args: Record<string, unknown>): Obj {
  const after = typeof args.after === 'string' ? args.after : null;
  const start = after === null ? 0 : indexFromCursor(after) + 1;
  const first = typeof args.first === 'number' ? Math.max(0, Math.floor(args.first)) : all.length;
  const window = all.slice(start, start + first);
  const nodes = window.map((node, i) => ({ node, cursor: cursorFor(start + i) }));
  return {
    t: type,
    nodes,
    totalCount: all.length,
    pageInfo: {
      t: 'PageInfo',
      hasNextPage: start + window.length < all.length,
      hasPreviousPage: start > 0,
      startCursor: nodes[0]?.cursor ?? null,
      endCursor: nodes[nodes.length - 1]?.cursor ?? null,
    } satisfies Obj,
  };
}

// ---------------------------------------------------------------------------
// Executor.

interface ExecCtx {
  store: Store;
  vars: Record<string, unknown>;
  fragments: Map<string, GqlSelection[]>;
  errors: { message: string }[];
}

function executeSelections(ctx: ExecCtx, typeName: string, source: unknown, selections: GqlSelection[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === typeName) {
        Object.assign(out, executeSelections(ctx, typeName, source, selection.selections));
      }
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined) Object.assign(out, executeSelections(ctx, typeName, source, fragment));
      continue;
    }
    const key = selection.alias ?? selection.name;
    out[key] = executeField(ctx, typeName, source, selection);
  }
  return out;
}

function executeField(ctx: ExecCtx, typeName: string, source: unknown, field: GqlField): unknown {
  if (field.name === '__typename') return typeName;
  const args: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(field.args)) args[name] = resolveValue(value, ctx.vars);
  const raw = resolveField(ctx, typeName, source, field.name, args);
  if (raw === FIELD_UNKNOWN) {
    ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName}'` });
    return null;
  }
  return completeValue(ctx, raw, field.selections);
}

function completeValue(ctx: ExecCtx, value: unknown, selections: GqlSelection[]): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => completeValue(ctx, entry, selections));
  if (typeof value === 'object' && 't' in (value as Obj)) {
    const obj = value as Obj;
    if (selections.length === 0) return obj;
    return executeSelections(ctx, obj.t, obj, selections);
  }
  return value;
}

const FIELD_UNKNOWN = Symbol('field-unknown');

function resolveField(ctx: ExecCtx, typeName: string, source: unknown, name: string, args: Record<string, unknown>): unknown {
  const { store } = ctx;
  const obj = source as Obj;

  if (typeName === 'Query') {
    switch (name) {
      case 'viewer':
        return userObj(store);
      case 'user':
        return typeof args.login === 'string' && args.login === viewerLogin(store) ? userObj(store) : null;
      case 'repository': {
        const repo = findRepo(store, String(args.owner ?? ''), String(args.name ?? ''));
        return repo === null ? null : repoObj(repo);
      }
      case 'node': {
        const decoded = decodeGlobalId(String(args.id ?? ''));
        if (decoded === null) return null;
        if (decoded.type === 'Repository') {
          const repo = repoById(store, Number(decoded.raw));
          return repo === null ? null : repoObj(repo);
        }
        if (decoded.type === 'Issue' || decoded.type === 'PullRequest' || decoded.type === 'Comment') {
          const found = itemById(store, Number(decoded.raw));
          if (found === null) return null;
          if (decoded.type === 'Comment') {
            const comment = found.item.comments.find((c) => c.id === Number(decoded.raw));
            return comment === undefined ? null : { t: 'IssueComment', item: found.item, repo: found.repo, commentId: comment.id };
          }
          return itemObj(found.item, found.repo);
        }
        return null;
      }
      case '__type': {
        const typeNameArg = String(args.name ?? '');
        if (!(typeNameArg in TYPE_FIELDS) && !(typeNameArg in ENUM_VALUES)) return null;
        return { t: '__Type', name: typeNameArg };
      }
      case '__schema':
        return { t: '__Schema' };
      default:
        return FIELD_UNKNOWN;
    }
  }

  if (typeName === 'Mutation') return resolveMutation(ctx, name, args);

  if (typeName === '__Type') {
    const typeNameArg = obj.name as string;
    switch (name) {
      case 'name':
        return typeNameArg;
      case 'kind':
        return typeNameArg in ENUM_VALUES ? 'ENUM' : 'OBJECT';
      case 'description':
        return null;
      case 'fields':
        return (TYPE_FIELDS[typeNameArg] ?? []).map((fieldName) => ({ t: '__Field', name: fieldName }));
      case 'enumValues':
        return (ENUM_VALUES[typeNameArg] ?? []).map((valueName) => ({ t: '__EnumValue', name: valueName }));
      case 'possibleTypes':
      case 'inputFields':
      case 'interfaces':
        return [];
      case 'ofType':
        return null;
      default:
        return FIELD_UNKNOWN;
    }
  }
  if (typeName === '__Field' || typeName === '__EnumValue') {
    if (name === 'name') return obj.name;
    if (name === 'description') return null;
    if (name === 'isDeprecated') return false;
    if (name === 'deprecationReason') return null;
    if (name === 'args') return [];
    if (name === 'type') return null;
    return FIELD_UNKNOWN;
  }
  if (typeName === '__Schema') {
    if (name === 'types') return Object.keys(TYPE_FIELDS).map((typeName) => ({ t: '__Type', name: typeName }));
    if (name === 'queryType') return { t: '__Type', name: 'Query' };
    if (name === 'mutationType') return { t: '__Type', name: 'Mutation' };
    if (name === 'subscriptionType') return null;
    if (name === 'directives') return [];
    return FIELD_UNKNOWN;
  }

  if (typeName === 'User') {
    switch (name) {
      case 'login':
        return viewerLogin(store);
      case 'id':
        return 'MDQ6VXNlcjE=';
      case 'databaseId':
        return 1;
      case 'name':
        return viewerLogin(store);
      case 'email':
        return '';
      case 'url':
      case 'resourcePath':
        return `https://github.example/${viewerLogin(store)}`;
      case 'avatarUrl':
        return 'https://github.example/avatar.png';
      case 'isViewer':
        return true;
      case 'createdAt':
      case 'updatedAt':
        return '2026-01-01T00:00:00Z';
      default:
        return FIELD_UNKNOWN;
    }
  }

  if (typeName === 'Repository') return resolveRepository(ctx, obj.repo as RepoRec, name, args);
  if (typeName === 'Issue' || typeName === 'PullRequest') {
    return resolveItem(ctx, obj.item as IssueRec, obj.repo as RepoRec, typeName, name, args);
  }
  if (typeName === 'Ref') {
    if (name === 'name') return obj.refName;
    if (name === 'prefix') return 'refs/heads/';
    if (name === 'id') return globalId('Ref', 0);
    if (name === 'target') return { t: 'Commit', oid: obj.oid };
    if (name === 'repository') return repoObj(obj.repo as RepoRec);
    return FIELD_UNKNOWN;
  }
  if (typeName === 'Commit') {
    if (name === 'oid') return obj.oid;
    if (name === 'id') return globalId('Commit', 0);
    return FIELD_UNKNOWN;
  }
  if (typeName === 'IssueComment') {
    const item = obj.item as IssueRec;
    const comment = item.comments.find((c) => c.id === (obj.commentId as number));
    switch (name) {
      case 'id':
        return globalId('Comment', obj.commentId as number);
      case 'databaseId':
        return obj.commentId;
      case 'body':
      case 'bodyText':
        return comment?.body ?? '';
      case 'author':
        return userObj(store);
      case 'createdAt':
        return comment?.createdAt ?? nowIso();
      case 'updatedAt':
        return comment?.updatedAt ?? nowIso();
      default:
        return FIELD_UNKNOWN;
    }
  }
  if (typeName === 'PageInfo') {
    if (name in obj) return obj[name];
    return FIELD_UNKNOWN;
  }
  if (typeName.endsWith('Connection')) {
    if (name === 'nodes') return (obj.nodes as { node: Obj }[]).map((edge) => edge.node);
    if (name === 'edges') return (obj.nodes as { node: Obj; cursor: string }[]).map((edge) => ({ t: 'Edge', node: edge.node, cursor: edge.cursor }));
    if (name === 'pageInfo') return obj.pageInfo;
    if (name === 'totalCount') return obj.totalCount;
    return FIELD_UNKNOWN;
  }
  if (typeName === 'Edge') {
    if (name === 'node') return obj.node;
    if (name === 'cursor') return obj.cursor;
    return FIELD_UNKNOWN;
  }
  if (typeName === 'PullRequestFile') {
    if (name === 'path') return obj.path;
    if (name === 'additions') return obj.additions;
    if (name === 'deletions') return obj.deletions;
    if (name === 'changeType') return obj.changeType;
    return FIELD_UNKNOWN;
  }
  if (typeName.endsWith('Payload')) {
    if (name === 'clientMutationId') return null;
    if (name === 'issue') return obj.issue;
    if (name === 'pullRequest') return obj.pullRequest;
    if (name === 'commentEdge') return obj.commentEdge;
    if (name === 'subject') return obj.subject;
    return FIELD_UNKNOWN;
  }
  return FIELD_UNKNOWN;
}

/** Repository fields: reads plus the issue/pull connections. */
function resolveRepository(ctx: ExecCtx, repo: RepoRec, name: string, args: Record<string, unknown>): unknown {
  const { store } = ctx;
  const g = gitRepo(repo.id);
  switch (name) {
    case 'id':
      return globalId('Repository', repo.id);
    case 'databaseId':
      return repo.id;
    case 'name':
      return repo.name;
    case 'nameWithOwner':
      return `${viewerLogin(store)}/${repo.name}`;
    case 'owner':
      return userObj(store);
    case 'defaultBranchRef': {
      const oid = branchHead(g, repo.defaultBranch);
      return oid === null ? null : { t: 'Ref', refName: repo.defaultBranch, oid, repo };
    }
    case 'viewerPermission':
      return 'ADMIN';
    case 'hasIssuesEnabled':
    case 'hasProjectsEnabled':
    case 'hasWikiEnabled':
      return true;
    case 'isPrivate':
      return repo.private;
    case 'isFork':
    case 'isArchived':
      return false;
    case 'description':
      return repo.description;
    case 'createdAt':
      return repo.createdAt;
    case 'updatedAt':
      return repo.updatedAt;
    case 'url':
    case 'resourcePath':
      return `https://github.example/${viewerLogin(store)}/${repo.name}`;
    case 'issue': {
      const item = findItem(repo, Number(args.number));
      return item !== null && item.kind === 'issue' ? itemObj(item, repo) : null;
    }
    case 'pullRequest': {
      const item = findItem(repo, Number(args.number));
      return item !== null && item.kind === 'pull' ? itemObj(item, repo) : null;
    }
    case 'issues': {
      let items = repo.items.filter((item) => item.kind === 'issue');
      const states = Array.isArray(args.states) ? (args.states as string[]) : null;
      if (states !== null) {
        const wanted = new Set(states.map((s) => s.toLowerCase()));
        items = items.filter((item) => wanted.has(item.state));
      }
      const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
      const ascending = orderBy.direction === 'ASC';
      items = [...items].sort((a, b) => (ascending ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
      return connection('IssueConnection', items.map((item) => itemObj(item, repo)), args);
    }
    case 'pullRequests': {
      let items = repo.items.filter((item) => item.kind === 'pull');
      const states = Array.isArray(args.states) ? (args.states as string[]) : ['OPEN'];
      const wanted = new Set(states);
      items = items.filter((item) => {
        const state = item.merged ? 'MERGED' : item.state.toUpperCase();
        return wanted.has(state);
      });
      items = [...items].sort((a, b) => b.createdSeq - a.createdSeq);
      return connection('PullRequestConnection', items.map((item) => itemObj(item, repo)), args);
    }
    default:
      return FIELD_UNKNOWN;
  }
}

/** Issue and pull-request fields. */
function resolveItem(
  ctx: ExecCtx,
  item: IssueRec,
  repo: RepoRec,
  typeName: string,
  name: string,
  args: Record<string, unknown>,
): unknown {
  const { store } = ctx;
  const g = gitRepo(repo.id);
  switch (name) {
    case 'id':
      return globalId(typeName, item.id);
    case 'databaseId':
      return item.id;
    case 'number':
      return item.number;
    case 'title':
      return item.title;
    case 'body':
    case 'bodyText':
      return item.body;
    case 'state':
      if (typeName === 'PullRequest' && item.merged) return 'MERGED';
      return item.state.toUpperCase();
    case 'author':
      return userObj(store);
    case 'createdAt':
      return item.createdAt;
    case 'updatedAt':
      return item.updatedAt;
    case 'closedAt':
      return item.closedAt ?? null;
    case 'closed':
      return item.state === 'closed';
    case 'locked':
      return false;
    case 'url':
    case 'resourcePath': {
      const segment = typeName === 'PullRequest' ? 'pull' : 'issues';
      return `https://github.example/${viewerLogin(store)}/${repo.name}/${segment}/${item.number}`;
    }
    case 'repository':
      return repoObj(repo);
    case 'comments': {
      const all = [...item.comments]
        .sort((a, b) => a.createdSeq - b.createdSeq)
        .map((comment) => ({ t: 'IssueComment', item, repo, commentId: comment.id }) as Obj);
      return connection('IssueCommentConnection', all, args);
    }
    case 'merged':
      return item.merged ?? false;
    case 'mergedAt':
      return item.mergedAt ?? null;
    case 'headRefName':
      return item.headRef ?? null;
    case 'baseRefName':
      return item.baseRef ?? null;
    case 'headRefOid':
      return item.headRef !== undefined ? branchHead(g, item.headRef) : null;
    case 'baseRefOid':
      return item.baseRef !== undefined ? branchHead(g, item.baseRef) : null;
    case 'isDraft':
      return false;
    case 'mergeable': {
      if (item.merged) return 'UNKNOWN';
      const baseTip = item.baseRef !== undefined ? branchHead(g, item.baseRef) : null;
      const headTip = item.headRef !== undefined ? branchHead(g, item.headRef) : null;
      if (baseTip === null || headTip === null) return 'UNKNOWN';
      const ancestor = mergeBase(g, baseTip, headTip);
      const ancestorTree = ancestor === null ? null : (commitInfo(g, ancestor)?.tree ?? null);
      const merged = threeWayMergeTrees(
        g,
        ancestorTree,
        commitInfo(g, baseTip)?.tree ?? '',
        commitInfo(g, headTip)?.tree ?? '',
      );
      return merged.tree === undefined ? 'CONFLICTING' : 'MERGEABLE';
    }
    case 'files': {
      const files = pullFiles(g, item).map((file) => {
        const statusToChange: Record<string, string> = { added: 'ADDED', modified: 'MODIFIED', removed: 'DELETED', renamed: 'RENAMED' };
        return {
          t: 'PullRequestFile',
          path: file.path,
          additions: 0,
          deletions: 0,
          changeType: statusToChange[file.status] ?? 'MODIFIED',
        } as Obj;
      });
      return connection('PullRequestFileConnection', files, args);
    }
    case 'additions':
    case 'deletions':
    case 'changedFiles':
      return 0;
    default:
      return FIELD_UNKNOWN;
  }
}

// ---------------------------------------------------------------------------
// Mutations: the same state changes the REST endpoints make.

function resolveMutation(ctx: ExecCtx, name: string, args: Record<string, unknown>): unknown {
  const { store } = ctx;
  const input = (args.input ?? {}) as Record<string, unknown>;

  if (name === 'createIssue') {
    const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
    const repo = decoded !== null && decoded.type === 'Repository' ? repoById(store, Number(decoded.raw)) : null;
    if (repo === null) {
      ctx.errors.push({ message: 'Could not resolve the repository for createIssue' });
      return null;
    }
    const at = nowIso();
    const item: IssueRec = {
      id: store.nextIssueId,
      number: repo.nextNumber,
      kind: 'issue',
      title: String(input.title ?? ''),
      body: String(input.body ?? ''),
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
    return { t: 'CreateIssuePayload', issue: itemObj(item, repo) };
  }

  if (name === 'closeIssue' || name === 'reopenIssue') {
    const decoded = decodeGlobalId(String(input.issueId ?? ''));
    const found = decoded !== null ? itemById(store, Number(decoded.raw)) : null;
    if (found === null) {
      ctx.errors.push({ message: `Could not resolve the issue for ${name}` });
      return null;
    }
    const closing = name === 'closeIssue';
    found.item.state = closing ? 'closed' : 'open';
    found.item.closedAt = closing ? nowIso() : null;
    found.item.updatedAt = nowIso();
    return { t: 'CloseIssuePayload', issue: itemObj(found.item, found.repo) };
  }

  if (name === 'createPullRequest') {
    const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
    const repo = decoded !== null && decoded.type === 'Repository' ? repoById(store, Number(decoded.raw)) : null;
    if (repo === null) {
      ctx.errors.push({ message: 'Could not resolve the repository for createPullRequest' });
      return null;
    }
    const g = gitRepo(repo.id);
    const headRef = String(input.headRefName ?? '');
    const baseRef = String(input.baseRefName ?? repo.defaultBranch);
    const headSha = branchHead(g, headRef);
    const baseSha = branchHead(g, baseRef);
    if (headSha === null || baseSha === null) {
      ctx.errors.push({ message: 'The head or base branch does not exist' });
      return null;
    }
    const at = nowIso();
    const item: IssueRec = {
      id: store.nextIssueId,
      number: repo.nextNumber,
      kind: 'pull',
      title: String(input.title ?? ''),
      body: String(input.body ?? ''),
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
    return { t: 'CreatePullRequestPayload', pullRequest: itemObj(item, repo) };
  }

  if (name === 'mergePullRequest') {
    const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
    const found = decoded !== null ? itemById(store, Number(decoded.raw)) : null;
    if (found === null || found.item.kind !== 'pull') {
      ctx.errors.push({ message: 'Could not resolve the pull request for mergePullRequest' });
      return null;
    }
    const { repo, item } = found;
    const g = gitRepo(repo.id);
    const baseRef = item.baseRef ?? repo.defaultBranch;
    const headRef = item.headRef ?? '';
    const baseTip = branchHead(g, baseRef);
    const headTip = branchHead(g, headRef);
    if (baseTip === null || headTip === null) {
      ctx.errors.push({ message: 'The pull request branches no longer exist' });
      return null;
    }
    const ancestor = mergeBase(g, baseTip, headTip);
    const ancestorTree = ancestor === null ? null : (commitInfo(g, ancestor)?.tree ?? null);
    const merged = threeWayMergeTrees(g, ancestorTree, commitInfo(g, baseTip)?.tree ?? '', commitInfo(g, headTip)?.tree ?? '');
    if (merged.tree === undefined) {
      ctx.errors.push({ message: 'The pull request has conflicts and cannot be merged' });
      return null;
    }
    const login = viewerLogin(store);
    const method = String(input.mergeMethod ?? 'SQUASH');
    let newSha: string;
    if (method === 'MERGE' && !isAncestor(g, headTip, baseTip) && !isAncestor(g, baseTip, headTip)) {
      newSha = writeCommit(g, {
        tree: merged.tree,
        parents: [baseTip, headTip],
        authorName: login,
        authorEmail: `${login}@example.invalid`,
        message: `Merge pull request #${item.number}`,
      });
    } else if (method === 'MERGE' && isAncestor(g, baseTip, headTip)) {
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
    return { t: 'MergePullRequestPayload', pullRequest: itemObj(item, repo) };
  }

  if (name === 'addComment') {
    const decoded = decodeGlobalId(String(input.subjectId ?? ''));
    const found = decoded !== null ? itemById(store, Number(decoded.raw)) : null;
    if (found === null) {
      ctx.errors.push({ message: 'Could not resolve the subject for addComment' });
      return null;
    }
    const at = nowIso();
    const comment = { id: store.nextCommentId, body: String(input.body ?? ''), createdSeq: store.seq, createdAt: at, updatedAt: at };
    store.nextCommentId += 1;
    store.seq += 1;
    found.item.comments.push(comment);
    found.item.updatedAt = at;
    const commentObj: Obj = { t: 'IssueComment', item: found.item, repo: found.repo, commentId: comment.id };
    return {
      t: 'AddCommentPayload',
      commentEdge: { t: 'Edge', node: commentObj, cursor: cursorFor(found.item.comments.length - 1) },
      subject: itemObj(found.item, found.repo),
    };
  }

  return FIELD_UNKNOWN;
}

// ---------------------------------------------------------------------------
// The HTTP endpoint: one operation or a batch, variables as object or string.

/** Execute one parsed operation and shape the {data, errors?} envelope. */
function executeOperation(store: Store, queryText: string, variables: Record<string, unknown>, operationName: string | null): Record<string, unknown> {
  let parsed: { operations: GqlOperation[]; fragments: Map<string, GqlSelection[]> };
  try {
    parsed = new Parser(queryText).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'could not parse the document' }] };
  }
  const operation =
    parsed.operations.find((op) => operationName !== null && op.name === operationName) ?? parsed.operations[0];
  if (operation === undefined) return { data: null, errors: [{ message: 'no operation in the document' }] };
  const ctx: ExecCtx = { store, vars: variables, fragments: parsed.fragments, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelections(ctx, rootType, { t: rootType }, operation.selections);
  const envelope: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) envelope.errors = ctx.errors;
  return envelope;
}

/** POST /api/graphql. Returns true when the path was the GraphQL endpoint. */
export async function handleGraphql(store: Store, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== '/api/graphql') return false;
  if ((req.method ?? 'GET') !== 'POST') {
    sendJson(res, 200, { data: {} });
    return true;
  }
  // The shared body parser rejects top-level arrays (right for REST), but a
  // batched GraphQL request IS a top-level array — parse it here directly.
  const raw = await readBody(req);
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return true;
  }
  const runOne = (entry: Record<string, unknown>): Record<string, unknown> => {
    let variables: Record<string, unknown> = {};
    if (typeof entry.variables === 'string') {
      try {
        variables = JSON.parse(entry.variables) as Record<string, unknown>;
      } catch {
        variables = {};
      }
    } else if (entry.variables !== null && typeof entry.variables === 'object') {
      variables = entry.variables as Record<string, unknown>;
    }
    return executeOperation(
      store,
      String(entry.query ?? ''),
      variables,
      typeof entry.operationName === 'string' ? entry.operationName : null,
    );
  };
  if (Array.isArray(body)) {
    sendJson(res, 200, body.map((entry) => runOne(entry as Record<string, unknown>)));
    return true;
  }
  sendJson(res, 200, runOne(body as Record<string, unknown>));
  return true;
}
