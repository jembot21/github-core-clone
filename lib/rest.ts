// The REST v3 surface under /api/v3. Step 1 covers the root, meta, the viewer and
// repository CRUD with pagination; contents, issues and pull requests mount on the
// same dispatcher in later steps. Every reply is JSON with the contract headers
// (lib/http.ts), every error is a JSON object with a string message, and a
// repository addressed under a stranger's login is 404, never 403.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  createRepo,
  deleteRepo,
  findItem,
  findRepo,
  nowIso,
  viewerLogin,
  type IssueRec,
  type LabelRec,
  type RepoRec,
  type Store,
} from './store.ts';
import {
  applyChanges,
  commitInfo,
  deleteRef,
  dropGitRepo,
  flattenTree,
  gitRepo,
  isAncestor,
  mergeBase,
  readObject,
  refSha,
  setRef,
  threeWayMergeTrees,
  walkCommits,
  writeCommit,
  writeObject,
  type GitRepo,
} from './gitstore.ts';
import { baseUrl, boolField, parseJsonBody, readBody, sendEmpty, sendError, sendJson, stringField } from './http.ts';

/** The scopes header the API root must carry. */
const SCOPES = 'repo, read:org';

/** The viewer as a GitHub user object. */
export function userJson(store: Store, base: string): Record<string, unknown> {
  const login = viewerLogin(store);
  return {
    login,
    id: 1,
    node_id: 'MDQ6VXNlcjE=',
    avatar_url: `${base}/avatars/${login}`,
    gravatar_id: '',
    url: `${base}/api/v3/users/${login}`,
    html_url: `${base}/${login}`,
    type: 'User',
    site_admin: false,
    name: login,
    email: `${login}@example.invalid`,
  };
}

/** A repository as a GitHub repository object. */
export function repoJson(store: Store, repo: RepoRec, base: string): Record<string, unknown> {
  const login = viewerLogin(store);
  const fullName = `${login}/${repo.name}`;
  return {
    id: repo.id,
    node_id: Buffer.from(`Repository:${repo.id}`).toString('base64'),
    name: repo.name,
    full_name: fullName,
    owner: userJson(store, base),
    private: repo.isPrivate,
    html_url: `${base}/${fullName}`,
    description: repo.description,
    fork: false,
    url: `${base}/api/v3/repos/${fullName}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    clone_url: `${base}/${fullName}.git`,
    ssh_url: `git@${base.replace(/^https?:\/\//, '')}:${fullName}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    forks_count: 0,
    open_issues_count: repo.items.filter((item) => item.state === 'open').length,
    watchers: 0,
    default_branch: repo.defaultBranch,
    archived: false,
    disabled: false,
  };
}

/** Page parameters from a list URL: per_page defaults to 30, page to 1. */
function pageParams(url: URL): { perPage: number; page: number } {
  const perPageRaw = Number(url.searchParams.get('per_page') ?? '30');
  const pageRaw = Number(url.searchParams.get('page') ?? '1');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.floor(perPageRaw)) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
  return { perPage, page };
}

/**
 * Slice one page out of a list and, while more remain, link the next page (and
 * the last) with a Link header whose URLs stay on this origin, as the suite
 * follows them. Returns the page items.
 */
export function paginate<T>(req: IncomingMessage, res: ServerResponse, url: URL, items: readonly T[]): T[] {
  const { perPage, page } = pageParams(url);
  const total = items.length;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  if (page < lastPage) {
    const base = baseUrl(req);
    const linkFor = (p: number): string => {
      const next = new URL(url.pathname, base);
      for (const [key, value] of url.searchParams) next.searchParams.set(key, value);
      next.searchParams.set('page', String(p));
      next.searchParams.set('per_page', String(perPage));
      return next.toString();
    };
    res.setHeader('link', `<${linkFor(page + 1)}>; rel="next", <${linkFor(lastPage)}>; rel="last"`);
  }
  return slice;
}

/** GET /api/v3 — the API root, with the scopes header. */
function handleRoot(store: Store, req: IncomingMessage, res: ServerResponse): void {
  const base = baseUrl(req);
  sendJson(
    res,
    200,
    {
      current_user_url: `${base}/api/v3/user`,
      current_user_repositories_url: `${base}/api/v3/user/repos`,
      repository_url: `${base}/api/v3/repos/{owner}/{repo}`,
      rate_limit_url: `${base}/api/v3/rate_limit`,
      meta_url: `${base}/api/v3/meta`,
    },
    { 'x-oauth-scopes': SCOPES },
  );
}

/** The REST dispatcher. Returns true when the route belonged to this surface. */
export async function handleRest(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  const seg = path.split('/').filter((part) => part !== '');
  if (seg[0] !== 'api' || seg[1] !== 'v3') return false;
  const base = baseUrl(req);
  const rest = seg.slice(2);

  if (rest.length === 0) {
    if (method === 'GET') {
      handleRoot(store, req, res);
      return true;
    }
    return false;
  }

  if (rest[0] === 'meta' && rest.length === 1) {
    if (method !== 'GET') return false;
    sendJson(res, 200, {
      verifiable_password_authentication: false,
      installed_version: '3.0.0-forge',
      hooks: [],
      git: [],
      api: [],
      web: [],
    });
    return true;
  }

  if (rest[0] === 'user' && rest.length === 1) {
    if (method !== 'GET') return false;
    sendJson(res, 200, userJson(store, base));
    return true;
  }

  if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
    if (method === 'GET') {
      const all = [...store.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
      const page = paginate(req, res, url, all);
      sendJson(res, 200, page.map((repo) => repoJson(store, repo, base)));
      return true;
    }
    if (method === 'POST') {
      const parsed = parseJsonBody(await readBody(req));
      if ('malformed' in parsed) {
        sendError(res, 400, 'Problems parsing JSON');
        return true;
      }
      const name = stringField(parsed.value, 'name');
      if (name === null || name === '') {
        sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Repository', field: 'name', code: 'missing_field' }] });
        return true;
      }
      const repo = createRepo(store, {
        name,
        description: stringField(parsed.value, 'description') ?? undefined,
        isPrivate: boolField(parsed.value, 'private') ?? undefined,
        defaultBranch: stringField(parsed.value, 'default_branch') ?? undefined,
      });
      if (repo === null) {
        sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Repository', field: 'name', code: 'custom', message: 'name already exists on this account' }] });
        return true;
      }
      sendJson(res, 201, repoJson(store, repo, base));
      return true;
    }
    return false;
  }

  if (rest[0] === 'repos' && rest.length >= 3) {
    const owner = decodeURIComponent(rest[1] ?? '');
    const name = decodeURIComponent(rest[2] ?? '');
    if (rest.length === 3) {
      if (method === 'GET') {
        const repo = findRepo(store, owner, name);
        if (repo === null) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        sendJson(res, 200, repoJson(store, repo, base));
        return true;
      }
      if (method === 'PATCH') {
        const repo = findRepo(store, owner, name);
        if (repo === null) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const parsed = parseJsonBody(await readBody(req));
        if ('malformed' in parsed) {
          sendError(res, 400, 'Problems parsing JSON');
          return true;
        }
        const description = stringField(parsed.value, 'description');
        if (description !== null) repo.description = description;
        const isPrivate = boolField(parsed.value, 'private');
        if (isPrivate !== null) repo.isPrivate = isPrivate;
        const defaultBranch = stringField(parsed.value, 'default_branch');
        if (defaultBranch !== null && defaultBranch !== '') repo.defaultBranch = defaultBranch;
        const newName = stringField(parsed.value, 'name');
        if (newName !== null && newName !== '' && newName !== repo.name && !store.repos.has(newName)) {
          store.repos.delete(repo.name);
          repo.name = newName;
          store.repos.set(repo.name, repo);
        }
        repo.updatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
        sendJson(res, 200, repoJson(store, repo, base));
        return true;
      }
      if (method === 'DELETE') {
        const repo = findRepo(store, owner, name);
        if (repo === null) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        deleteRepo(store, repo.name);
        dropGitRepo(repo.id);
        sendEmpty(res, 204);
        return true;
      }
      return false;
    }
    // Deeper repository routes: contents, branches, commits, git refs, and in
    // later steps labels, issues and pull requests.
    const repo = findRepo(store, owner, name);
    if (repo === null) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    return handleRepoDeep(store, req, res, url, repo, rest.slice(3));
  }

  return false;
}

// ---------------------------------------------------------------------------
// Repository-deep routes: branches, commits, the git refs API and the contents
// API. Contents writes are real git commits on the branch they name, so the
// REST view and the git view never disagree.

/** A commit as a GitHub commit object. */
export function commitJson(store: Store, g: GitRepo, sha: string, base: string, fullName: string): Record<string, unknown> {
  const info = commitInfo(g, sha);
  const date = info === null ? nowIso() : new Date(info.authorTs * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const person = {
    name: info?.authorName ?? '',
    email: info?.authorEmail ?? '',
    date,
  };
  return {
    sha,
    node_id: Buffer.from(`Commit:${sha}`).toString('base64'),
    commit: {
      author: person,
      committer: person,
      message: info?.message ?? '',
      tree: { sha: info?.tree ?? '', url: `${base}/api/v3/repos/${fullName}/git/trees/${info?.tree ?? ''}` },
      url: `${base}/api/v3/repos/${fullName}/git/commits/${sha}`,
      comment_count: 0,
    },
    url: `${base}/api/v3/repos/${fullName}/commits/${sha}`,
    html_url: `${base}/${fullName}/commit/${sha}`,
    comments_url: `${base}/api/v3/repos/${fullName}/commits/${sha}/comments`,
    author: userJson(store, base),
    committer: userJson(store, base),
    parents: (info?.parents ?? []).map((parent) => ({
      sha: parent,
      url: `${base}/api/v3/repos/${fullName}/commits/${parent}`,
      html_url: `${base}/${fullName}/commit/${parent}`,
    })),
  };
}

/** The branch head's commit sha for a repository, or null when unborn. */
function branchHead(g: GitRepo, branch: string): string | null {
  return refSha(g, `refs/heads/${branch}`);
}

/** Resolve a ref-ish (branch name or commit sha) to a commit sha. */
function resolveCommit(g: GitRepo, ref: string): string | null {
  const byBranch = branchHead(g, ref);
  if (byBranch !== null) return byBranch;
  const obj = readObject(g, ref);
  return obj !== null && obj.type === 'commit' ? ref : null;
}

/** Commit one set of file changes onto a branch; returns the new commit sha. */
function commitChanges(
  store: Store,
  repo: RepoRec,
  g: GitRepo,
  branch: string,
  changes: ReadonlyMap<string, string | null>,
  message: string,
): string {
  const head = branchHead(g, branch);
  const headInfo = head === null ? null : commitInfo(g, head);
  const tree = applyChanges(g, headInfo?.tree ?? null, changes);
  const login = viewerLogin(store);
  const sha = writeCommit(g, {
    tree,
    parents: head === null ? [] : [head],
    authorName: login,
    authorEmail: `${login}@example.invalid`,
    message,
  });
  setRef(g, `refs/heads/${branch}`, sha);
  repo.updatedAt = nowIso();
  return sha;
}

/** One entry of a contents listing / a file object, in GitHub's shape. */
function contentEntryJson(
  base: string,
  fullName: string,
  path: string,
  entry: { sha: string; mode: string } | null,
  size: number,
): Record<string, unknown> {
  const name = path.split('/').pop() ?? path;
  const isDir = entry === null || entry.mode === '40000';
  return {
    type: isDir ? 'dir' : 'file',
    encoding: isDir ? '' : 'base64',
    size: isDir ? 0 : size,
    name,
    path,
    sha: entry?.sha ?? '',
    url: `${base}/api/v3/repos/${fullName}/contents/${path}`,
    git_url: `${base}/api/v3/repos/${fullName}/git/${isDir ? 'trees' : 'blobs'}/${entry?.sha ?? ''}`,
    html_url: `${base}/${fullName}/${isDir ? 'tree' : 'blob'}/main/${path}`,
    download_url: isDir ? null : `${base}/${fullName}/raw/main/${path}`,
    _links: {
      self: `${base}/api/v3/repos/${fullName}/contents/${path}`,
      git: `${base}/api/v3/repos/${fullName}/git/${isDir ? 'trees' : 'blobs'}/${entry?.sha ?? ''}`,
      html: `${base}/${fullName}/${isDir ? 'tree' : 'blob'}/main/${path}`,
    },
  };
}

/** The tree sha a contents request reads from: ?ref= wins, else the default branch. */
function contentsTree(g: GitRepo, repo: RepoRec, url: URL): string | null {
  const ref = url.searchParams.get('ref');
  const commit = ref !== null && ref !== '' ? resolveCommit(g, ref) : branchHead(g, repo.defaultBranch);
  if (commit === null) return null;
  return commitInfo(g, commit)?.tree ?? null;
}

/** GET /contents/{path}: a file object, or a directory's entries. */
function handleContentsGet(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  repo: RepoRec,
  path: string,
): void {
  const base = baseUrl(req);
  const fullName = `${viewerLogin(store)}/${repo.name}`;
  const g = gitRepo(repo.id);
  const tree = contentsTree(g, repo, url);
  if (tree === null) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const flat = flattenTree(g, tree);
  if (path === '') {
    // Root listing: the top-level entries of the tree.
    const entries: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    for (const [filePath, entry] of flat) {
      const first = filePath.split('/')[0] as string;
      if (seen.has(first)) continue;
      seen.add(first);
      const isDir = filePath.includes('/');
      const sub = isDir ? null : entry;
      entries.push(contentEntryJson(base, fullName, first, isDir ? { sha: '', mode: '40000' } : sub, isDir ? 0 : (readObject(g, entry.sha)?.data.length ?? 0)));
    }
    entries.sort((a, b) => String(a.name) < String(b.name) ? -1 : 1);
    sendJson(res, 200, entries);
    return;
  }
  const direct = flat.get(path);
  if (direct !== undefined) {
    const blob = readObject(g, direct.sha);
    const data = blob?.data ?? Buffer.alloc(0);
    const json = contentEntryJson(base, fullName, path, direct, data.length);
    json.content = data.toString('base64');
    sendJson(res, 200, json);
    return;
  }
  // A directory: list its immediate children.
  const prefix = `${path}/`;
  const children = new Map<string, { sha: string; mode: string; size: number }>();
  for (const [filePath, entry] of flat) {
    if (!filePath.startsWith(prefix)) continue;
    const restPath = filePath.slice(prefix.length);
    const first = restPath.split('/')[0] as string;
    if (children.has(first)) continue;
    const isDir = restPath.includes('/');
    children.set(first, isDir ? { sha: '', mode: '40000', size: 0 } : { sha: entry.sha, mode: entry.mode, size: readObject(g, entry.sha)?.data.length ?? 0 });
  }
  if (children.size === 0) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const entries = [...children.entries()]
    .map(([name, entry]) => contentEntryJson(base, fullName, `${path}/${name}`, entry.mode === '40000' ? { sha: '', mode: '40000' } : entry, entry.size))
    .sort((a, b) => (String(a.name) < String(b.name) ? -1 : 1));
  sendJson(res, 200, entries);
}

/** PUT /contents/{path}: create or update a file with a commit. */
async function handleContentsPut(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  repo: RepoRec,
  path: string,
): Promise<void> {
  const base = baseUrl(req);
  const fullName = `${viewerLogin(store)}/${repo.name}`;
  const parsed = parseJsonBody(await readBody(req));
  if ('malformed' in parsed) {
    sendError(res, 400, 'Problems parsing JSON');
    return;
  }
  const message = stringField(parsed.value, 'message') ?? 'Update file';
  const contentB64 = stringField(parsed.value, 'content');
  if (contentB64 === null) {
    sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Content', field: 'content', code: 'missing_field' }] });
    return;
  }
  const branch = stringField(parsed.value, 'branch') ?? repo.defaultBranch;
  const g = gitRepo(repo.id);
  const head = branchHead(g, branch);
  const headTree = head === null ? null : (commitInfo(g, head)?.tree ?? null);
  const existing = headTree === null ? undefined : flattenTree(g, headTree).get(path);
  const givenSha = stringField(parsed.value, 'sha');
  if (existing !== undefined) {
    if (givenSha !== existing.sha) {
      sendError(res, 409, `${path} does not match ${givenSha ?? ''}`);
      return;
    }
  }
  const data = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');
  const blobSha = writeObject(g, 'blob', data);
  const commitSha = commitChanges(store, repo, g, branch, new Map([[path, blobSha]]), message);
  const json = contentEntryJson(base, fullName, path, { sha: blobSha, mode: '100644' }, data.length);
  sendJson(res, existing !== undefined ? 200 : 201, {
    content: json,
    commit: commitJson(store, g, commitSha, base, fullName),
  });
}

/** DELETE /contents/{path}: remove a file with a commit. */
async function handleContentsDelete(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  repo: RepoRec,
  path: string,
): Promise<void> {
  const base = baseUrl(req);
  const fullName = `${viewerLogin(store)}/${repo.name}`;
  const parsed = parseJsonBody(await readBody(req));
  if ('malformed' in parsed) {
    sendError(res, 400, 'Problems parsing JSON');
    return;
  }
  const message = stringField(parsed.value, 'message') ?? 'Delete file';
  const branch = stringField(parsed.value, 'branch') ?? repo.defaultBranch;
  const g = gitRepo(repo.id);
  const head = branchHead(g, branch);
  const headTree = head === null ? null : (commitInfo(g, head)?.tree ?? null);
  const existing = headTree === null ? undefined : flattenTree(g, headTree).get(path);
  if (existing === undefined) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const givenSha = stringField(parsed.value, 'sha');
  if (givenSha !== null && givenSha !== existing.sha) {
    sendError(res, 409, `${path} does not match ${givenSha}`);
    return;
  }
  const commitSha = commitChanges(store, repo, g, branch, new Map([[path, null]]), message);
  sendJson(res, 200, { content: null, commit: commitJson(store, g, commitSha, base, fullName) });
}

/** A git ref as the refs API reports it. */
function refJson(base: string, fullName: string, ref: string, sha: string): Record<string, unknown> {
  return {
    ref,
    node_id: Buffer.from(`Ref:${ref}`).toString('base64'),
    url: `${base}/api/v3/repos/${fullName}/git/${ref}`,
    object: { sha, type: 'commit', url: `${base}/api/v3/repos/${fullName}/git/commits/${sha}` },
  };
}

/** Routes under /repos/{owner}/{repo}/… — repo already resolved and owned. */
async function handleRepoDeep(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  repo: RepoRec,
  parts: string[],
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const base = baseUrl(req);
  const fullName = `${viewerLogin(store)}/${repo.name}`;
  const g = gitRepo(repo.id);
  const head = parts[0] ?? '';

  if (head === 'branches') {
    if (parts.length === 1 && method === 'GET') {
      const branches = [...g.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort()
        .map((name) => ({
          name,
          commit: {
            sha: g.refs.get(`refs/heads/${name}`) ?? '',
            url: `${base}/api/v3/repos/${fullName}/commits/${g.refs.get(`refs/heads/${name}`) ?? ''}`,
          },
          protected: false,
        }));
      sendJson(res, 200, paginate(req, res, url, branches));
      return true;
    }
    if (parts.length === 2 && method === 'GET') {
      const name = decodeURIComponent(parts[1] ?? '');
      const sha = branchHead(g, name);
      if (sha === null) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      sendJson(res, 200, {
        name,
        commit: commitJson(store, g, sha, base, fullName),
        protected: false,
        _links: { self: `${base}/api/v3/repos/${fullName}/branches/${name}`, html: `${base}/${fullName}/tree/${name}` },
      });
      return true;
    }
    return false;
  }

  if (head === 'commits') {
    if (parts.length === 1 && method === 'GET') {
      const refParam = url.searchParams.get('sha') ?? url.searchParams.get('branch');
      const start = refParam !== null && refParam !== '' ? resolveCommit(g, refParam) : branchHead(g, repo.defaultBranch);
      if (start === null) {
        sendJson(res, 200, []);
        return true;
      }
      let shas = walkCommits(g, start);
      const pathFilter = url.searchParams.get('path');
      if (pathFilter !== null && pathFilter !== '') {
        shas = shas.filter((sha) => {
          const tree = commitInfo(g, sha)?.tree;
          return tree !== undefined && flattenTree(g, tree).has(pathFilter);
        });
      }
      const page = paginate(req, res, url, shas);
      sendJson(res, 200, page.map((sha) => commitJson(store, g, sha, base, fullName)));
      return true;
    }
    if (parts.length === 2 && method === 'GET') {
      const sha = parts[1] ?? '';
      if (commitInfo(g, sha) === null) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      sendJson(res, 200, commitJson(store, g, sha, base, fullName));
      return true;
    }
    return false;
  }

  if (head === 'git') {
    // POST /git/refs creates a ref; GET /git/refs lists them; GET /git/ref/{ref}
    // reads one (the ref name itself contains slashes).
    if (parts[1] === 'refs' && parts.length === 2) {
      if (method === 'GET') {
        const all = [...g.refs.entries()]
          .sort((a, b) => (a[0] < b[0] ? -1 : 1))
          .map(([ref, sha]) => refJson(base, fullName, ref, sha));
        sendJson(res, 200, paginate(req, res, url, all));
        return true;
      }
      if (method === 'POST') {
        const parsed = parseJsonBody(await readBody(req));
        if ('malformed' in parsed) {
          sendError(res, 400, 'Problems parsing JSON');
          return true;
        }
        const ref = stringField(parsed.value, 'ref');
        const sha = stringField(parsed.value, 'sha');
        if (ref === null || sha === null || commitInfo(g, sha) === null) {
          sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Ref', field: 'sha', code: 'invalid' }] });
          return true;
        }
        setRef(g, ref, sha);
        sendJson(res, 201, refJson(base, fullName, ref, sha));
        return true;
      }
      return false;
    }
    if (parts[1] === 'ref' && parts.length >= 3 && method === 'GET') {
      const ref = parts.slice(2).map((part) => decodeURIComponent(part)).join('/');
      const sha = refSha(g, ref);
      if (sha === null) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      sendJson(res, 200, refJson(base, fullName, ref, sha));
      return true;
    }
    if (parts[1] === 'refs' && parts.length >= 3 && method === 'DELETE') {
      const ref = parts.slice(2).map((part) => decodeURIComponent(part)).join('/');
      if (!deleteRef(g, ref)) {
        sendError(res, 422, 'Validation Failed');
        return true;
      }
      sendEmpty(res, 204);
      return true;
    }
    return false;
  }

  if (head === 'labels') return handleLabels(store, req, res, url, repo, parts);
  if (head === 'issues') return handleIssues(store, req, res, url, repo, parts);
  if (head === 'pulls') return handlePulls(store, req, res, url, repo, parts);

  if (head === 'contents') {
    const path = parts.slice(1).map((part) => decodeURIComponent(part)).join('/');
    if (method === 'GET') {
      handleContentsGet(store, req, res, url, repo, path);
      return true;
    }
    if (method === 'PUT') {
      await handleContentsPut(store, req, res, repo, path);
      return true;
    }
    if (method === 'DELETE') {
      await handleContentsDelete(store, req, res, repo, path);
      return true;
    }
    return false;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Labels, issues, comments and pull requests. Issues and pull requests share
// one numbering sequence per repository (as on GitHub); a pull request is an
// issue record with head/base refs and merge state.

/** A label as a GitHub label object. */
function labelJson(base: string, fullName: string, label: LabelRec): Record<string, unknown> {
  return {
    id: label.id,
    node_id: Buffer.from(`Label:${label.id}`).toString('base64'),
    url: `${base}/api/v3/repos/${fullName}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

/** An issue as a GitHub issue object. */
function issueJson(store: Store, base: string, fullName: string, repo: RepoRec, item: IssueRec): Record<string, unknown> {
  const json: Record<string, unknown> = {
    id: item.id,
    node_id: Buffer.from(`Issue:${item.id}`).toString('base64'),
    url: `${base}/api/v3/repos/${fullName}/issues/${item.number}`,
    repository_url: `${base}/api/v3/repos/${fullName}`,
    labels_url: `${base}/api/v3/repos/${fullName}/issues/${item.number}/labels{/name}`,
    comments_url: `${base}/api/v3/repos/${fullName}/issues/${item.number}/comments`,
    events_url: `${base}/api/v3/repos/${fullName}/issues/${item.number}/events`,
    html_url: `${base}/${fullName}/issues/${item.number}`,
    number: item.number,
    state: item.state,
    title: item.title,
    body: item.body,
    user: userJson(store, base),
    labels: item.labels
      .map((name) => repo.labels.get(name))
      .filter((label): label is LabelRec => label !== undefined)
      .map((label) => labelJson(base, fullName, label)),
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
    active_lock_reason: null,
    comments: item.comments.length,
    closed_at: item.closedAt ?? null,
    created_at: item.createdAt,
    updated_at: item.updatedAt,
    author_association: 'OWNER',
  };
  if (item.kind === 'pull') {
    json.pull_request = {
      url: `${base}/api/v3/repos/${fullName}/pulls/${item.number}`,
      html_url: `${base}/${fullName}/pull/${item.number}`,
      diff_url: `${base}/${fullName}/pull/${item.number}.diff`,
      patch_url: `${base}/${fullName}/pull/${item.number}.patch`,
    };
  }
  return json;
}

/** A comment as a GitHub issue-comment object. */
function commentJson(store: Store, base: string, fullName: string, item: IssueRec, commentId: number): Record<string, unknown> {
  const comment = item.comments.find((c) => c.id === commentId);
  return {
    id: commentId,
    node_id: Buffer.from(`Comment:${commentId}`).toString('base64'),
    url: `${base}/api/v3/repos/${fullName}/issues/comments/${commentId}`,
    html_url: `${base}/${fullName}/issues/${item.number}#issuecomment-${commentId}`,
    body: comment?.body ?? '',
    user: userJson(store, base),
    created_at: comment?.createdAt ?? nowIso(),
    updated_at: comment?.updatedAt ?? nowIso(),
    issue_url: `${base}/api/v3/repos/${fullName}/issues/${item.number}`,
    author_association: 'OWNER',
  };
}

/** Label names from a create/patch body: strings, or objects with a name. */
function labelNamesOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') names.push(entry);
    else if (entry !== null && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string') {
      names.push((entry as { name: string }).name);
    }
  }
  return names;
}

/** Routes under /repos/{o}/{r}/labels. */
async function handleLabels(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  repo: RepoRec,
  parts: string[],
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const base = baseUrl(req);
  const fullName = `${viewerLogin(store)}/${repo.name}`;
  if (parts.length === 1) {
    if (method === 'GET') {
      const all = [...repo.labels.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
      sendJson(res, 200, paginate(req, res, url, all).map((label) => labelJson(base, fullName, label)));
      return true;
    }
    if (method === 'POST') {
      const parsed = parseJsonBody(await readBody(req));
      if ('malformed' in parsed) {
        sendError(res, 400, 'Problems parsing JSON');
        return true;
      }
      const name = stringField(parsed.value, 'name');
      if (name === null || name === '') {
        sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Label', field: 'name', code: 'missing_field' }] });
        return true;
      }
      if (repo.labels.has(name)) {
        sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Label', field: 'name', code: 'already_exists' }] });
        return true;
      }
      const label: LabelRec = {
        id: store.nextLabelId,
        name,
        color: (stringField(parsed.value, 'color') ?? 'ededed').replace(/^#/, ''),
        description: stringField(parsed.value, 'description') ?? '',
      };
      store.nextLabelId += 1;
      repo.labels.set(name, label);
      sendJson(res, 201, labelJson(base, fullName, label));
      return true;
    }
    return false;
  }
  if (parts.length === 2) {
    const name = decodeURIComponent(parts[1] ?? '');
    const label = repo.labels.get(name);
    if (method === 'GET') {
      if (label === undefined) sendError(res, 404, 'Not Found');
      else sendJson(res, 200, labelJson(base, fullName, label));
      return true;
    }
    if (method === 'DELETE') {
      if (label === undefined) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      repo.labels.delete(name);
      sendEmpty(res, 204);
      return true;
    }
    if (method === 'PATCH') {
      if (label === undefined) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      const parsed = parseJsonBody(await readBody(req));
      if ('malformed' in parsed) {
        sendError(res, 400, 'Problems parsing JSON');
        return true;
      }
      const newName = stringField(parsed.value, 'new_name') ?? stringField(parsed.value, 'name');
      const color = stringField(parsed.value, 'color');
      if (color !== null) label.color = color.replace(/^#/, '');
      const description = stringField(parsed.value, 'description');
      if (description !== null) label.description = description;
      if (newName !== null && newName !== '' && newName !== name) {
        repo.labels.delete(name);
        label.name = newName;
        repo.labels.set(newName, label);
        for (const item of repo.items) item.labels = item.labels.map((l) => (l === name ? newName : l));
      }
      sendJson(res, 200, labelJson(base, fullName, label));
      return true;
    }
    return false;
  }
  return false;
}

/** Routes under /repos/{o}/{r}/issues (comments included). */
async function handleIssues(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  repo: RepoRec,
  parts: string[],
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const base = baseUrl(req);
  const fullName = `${viewerLogin(store)}/${repo.name}`;

  if (parts.length === 1) {
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      let items = repo.items.filter((item) => item.kind === 'issue');
      if (state === 'open') items = items.filter((item) => item.state === 'open');
      else if (state === 'closed') items = items.filter((item) => item.state === 'closed');
      const direction = url.searchParams.get('direction') ?? 'desc';
      items = [...items].sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
      const page = paginate(req, res, url, items);
      sendJson(res, 200, page.map((item) => issueJson(store, base, fullName, repo, item)));
      return true;
    }
    if (method === 'POST') {
      const parsed = parseJsonBody(await readBody(req));
      if ('malformed' in parsed) {
        sendError(res, 400, 'Problems parsing JSON');
        return true;
      }
      const title = stringField(parsed.value, 'title');
      if (title === null || title === '') {
        sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Issue', field: 'title', code: 'missing_field' }] });
        return true;
      }
      const labels = labelNamesOf(parsed.value.labels);
      for (const name of labels) {
        if (!repo.labels.has(name)) {
          sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Issue', field: 'labels', code: 'invalid', message: `label '${name}' does not exist` }] });
          return true;
        }
      }
      const at = nowIso();
      const item: IssueRec = {
        id: store.nextIssueId,
        number: repo.nextNumber,
        kind: 'issue',
        title,
        body: stringField(parsed.value, 'body') ?? '',
        state: 'open',
        labels,
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
      sendJson(res, 201, issueJson(store, base, fullName, repo, item));
      return true;
    }
    return false;
  }

  const number = Number(parts[1]);
  const item = Number.isInteger(number) ? findItem(repo, number) : null;

  if (parts.length === 2) {
    if (item === null) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    if (method === 'GET') {
      sendJson(res, 200, issueJson(store, base, fullName, repo, item));
      return true;
    }
    if (method === 'PATCH') {
      const parsed = parseJsonBody(await readBody(req));
      if ('malformed' in parsed) {
        sendError(res, 400, 'Problems parsing JSON');
        return true;
      }
      const title = stringField(parsed.value, 'title');
      if (title !== null) item.title = title;
      const body = stringField(parsed.value, 'body');
      if (body !== null) item.body = body;
      if (Array.isArray(parsed.value.labels)) {
        const labels = labelNamesOf(parsed.value.labels);
        for (const name of labels) {
          if (!repo.labels.has(name)) {
            sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Issue', field: 'labels', code: 'invalid' }] });
            return true;
          }
        }
        item.labels = labels;
      }
      const state = stringField(parsed.value, 'state');
      if (state === 'closed' || state === 'open') {
        item.state = state;
        item.closedAt = state === 'closed' ? nowIso() : null;
      }
      item.updatedAt = nowIso();
      sendJson(res, 200, issueJson(store, base, fullName, repo, item));
      return true;
    }
    return false;
  }

  if (parts.length === 3 && parts[2] === 'comments') {
    if (item === null) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    if (method === 'GET') {
      const sorted = [...item.comments].sort((a, b) => a.createdSeq - b.createdSeq);
      const page = paginate(req, res, url, sorted);
      sendJson(res, 200, page.map((comment) => commentJson(store, base, fullName, item, comment.id)));
      return true;
    }
    if (method === 'POST') {
      const parsed = parseJsonBody(await readBody(req));
      if ('malformed' in parsed) {
        sendError(res, 400, 'Problems parsing JSON');
        return true;
      }
      const body = stringField(parsed.value, 'body');
      if (body === null) {
        sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Comment', field: 'body', code: 'missing_field' }] });
        return true;
      }
      const at = nowIso();
      const comment = { id: store.nextCommentId, body, createdSeq: store.seq, createdAt: at, updatedAt: at };
      store.nextCommentId += 1;
      store.seq += 1;
      item.comments.push(comment);
      item.updatedAt = at;
      sendJson(res, 201, commentJson(store, base, fullName, item, comment.id));
      return true;
    }
    return false;
  }

  if (parts.length === 3 && parts[2] === 'labels') {
    if (item === null) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    if (method === 'POST' || method === 'PUT') {
      const parsed = parseJsonBody(await readBody(req));
      if ('malformed' in parsed) {
        sendError(res, 400, 'Problems parsing JSON');
        return true;
      }
      const labels = labelNamesOf(parsed.value.labels ?? parsed.value);
      for (const name of labels) {
        if (!repo.labels.has(name)) {
          sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Issue', field: 'labels', code: 'invalid' }] });
          return true;
        }
      }
      item.labels = method === 'PUT' ? labels : [...new Set([...item.labels, ...labels])];
      item.updatedAt = nowIso();
      sendJson(res, 200, item.labels.map((name) => labelJson(base, fullName, repo.labels.get(name) as LabelRec)));
      return true;
    }
    if (method === 'DELETE') {
      item.labels = [];
      sendJson(res, 200, []);
      return true;
    }
    if (method === 'GET') {
      sendJson(res, 200, item.labels.map((name) => labelJson(base, fullName, repo.labels.get(name) as LabelRec)));
      return true;
    }
    return false;
  }
  if (parts.length === 4 && parts[2] === 'labels' && method === 'DELETE') {
    if (item === null) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    const name = decodeURIComponent(parts[3] ?? '');
    item.labels = item.labels.filter((l) => l !== name);
    sendJson(res, 200, item.labels.map((l) => labelJson(base, fullName, repo.labels.get(l) as LabelRec)));
    return true;
  }

  return false;
}

/** A pull request as a GitHub pull-request object. */
function pullJson(store: Store, base: string, fullName: string, repo: RepoRec, g: GitRepo, item: IssueRec): Record<string, unknown> {
  const headSha = item.headRef !== undefined ? (branchHead(g, item.headRef) ?? item.headSha ?? '') : (item.headSha ?? '');
  const baseSha = item.baseRef !== undefined ? (branchHead(g, item.baseRef) ?? item.baseSha ?? '') : (item.baseSha ?? '');
  const refJsonFor = (ref: string | undefined, sha: string): Record<string, unknown> => ({
    label: `${viewerLogin(store)}:${ref ?? ''}`,
    ref: ref ?? '',
    sha,
    user: userJson(store, base),
    repo: repoJson(store, repo, base),
  });
  return {
    ...issueJson(store, base, fullName, repo, item),
    url: `${base}/api/v3/repos/${fullName}/pulls/${item.number}`,
    html_url: `${base}/${fullName}/pull/${item.number}`,
    diff_url: `${base}/${fullName}/pull/${item.number}.diff`,
    patch_url: `${base}/${fullName}/pull/${item.number}.patch`,
    merged_at: item.mergedAt ?? null,
    merge_commit_sha: item.mergeSha ?? null,
    merged: item.merged ?? false,
    head: refJsonFor(item.headRef, headSha),
    base: refJsonFor(item.baseRef, baseSha),
    _links: {
      self: { href: `${base}/api/v3/repos/${fullName}/pulls/${item.number}` },
      html: { href: `${base}/${fullName}/pull/${item.number}` },
      issue: { href: `${base}/api/v3/repos/${fullName}/issues/${item.number}` },
      comments: { href: `${base}/api/v3/repos/${fullName}/issues/${item.number}/comments` },
      commits: { href: `${base}/api/v3/repos/${fullName}/pulls/${item.number}/commits` },
    },
    author_association: 'OWNER',
    draft: false,
    additions: 0,
    deletions: 0,
    changed_files: 0,
    commits: 0,
    comments: item.comments.length,
    review_comments: 0,
    maintainer_can_modify: true,
  };
}

/** Line counts of a text diff: an LCS over lines, plenty for these file sizes. */
function lineDiffCounts(before: string, after: string): { additions: number; deletions: number } {
  if (before === after) return { additions: 0, deletions: 0 };
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  // Classic LCS dynamic program over lines.
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? (dp[i + 1]![j + 1] ?? 0) + 1 : Math.max(dp[i + 1]![j] ?? 0, dp[i]![j + 1] ?? 0);
    }
  }
  const common = dp[0]![0] ?? 0;
  return { additions: b.length - common, deletions: a.length - common };
}

/** The files a pull request changes: merge-base tree against head tree. */
function pullFiles(g: GitRepo, item: IssueRec): { path: string; status: string; baseSha: string | null; headSha: string | null }[] {
  const headSha = item.headRef !== undefined ? branchHead(g, item.headRef) : null;
  const baseSha = item.baseRef !== undefined ? branchHead(g, item.baseRef) : null;
  if (headSha === null || baseSha === null) return [];
  const ancestor = mergeBase(g, baseSha, headSha) ?? baseSha;
  const baseTree = commitInfo(g, ancestor)?.tree ?? null;
  const headTree = commitInfo(g, headSha)?.tree ?? null;
  const baseFiles = baseTree === null ? new Map<string, string>() : new Map([...flattenTree(g, baseTree)].map(([p, e]) => [p, e.sha]));
  const headFiles = headTree === null ? new Map<string, string>() : new Map([...flattenTree(g, headTree)].map(([p, e]) => [p, e.sha]));
  const out: { path: string; status: string; baseSha: string | null; headSha: string | null }[] = [];
  for (const path of new Set([...baseFiles.keys(), ...headFiles.keys()])) {
    const b = baseFiles.get(path);
    const h = headFiles.get(path);
    if (b === h) continue;
    out.push({ path, status: b === undefined ? 'added' : h === undefined ? 'removed' : 'modified', baseSha: b ?? null, headSha: h ?? null });
  }
  return out.sort((x, y) => (x.path < y.path ? -1 : 1));
}

/** Routes under /repos/{o}/{r}/pulls. */
async function handlePulls(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  repo: RepoRec,
  parts: string[],
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const base = baseUrl(req);
  const fullName = `${viewerLogin(store)}/${repo.name}`;
  const g = gitRepo(repo.id);

  if (parts.length === 1) {
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      let items = repo.items.filter((item) => item.kind === 'pull');
      if (state === 'open') items = items.filter((item) => item.state === 'open');
      else if (state === 'closed') items = items.filter((item) => item.state === 'closed');
      items = [...items].sort((a, b) => b.createdSeq - a.createdSeq);
      const page = paginate(req, res, url, items);
      sendJson(res, 200, page.map((item) => pullJson(store, base, fullName, repo, g, item)));
      return true;
    }
    if (method === 'POST') {
      const parsed = parseJsonBody(await readBody(req));
      if ('malformed' in parsed) {
        sendError(res, 400, 'Problems parsing JSON');
        return true;
      }
      const title = stringField(parsed.value, 'title');
      const headRef = stringField(parsed.value, 'head');
      const baseRef = stringField(parsed.value, 'base') ?? repo.defaultBranch;
      if (title === null || headRef === null) {
        sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', field: title === null ? 'title' : 'head', code: 'missing_field' }] });
        return true;
      }
      const headSha = branchHead(g, headRef.replace(/^[^:]+:/, ''));
      const baseSha = branchHead(g, baseRef);
      if (headSha === null || baseSha === null) {
        sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', field: 'head', code: 'invalid', message: 'head branch does not exist' }] });
        return true;
      }
      const at = nowIso();
      const item: IssueRec = {
        id: store.nextIssueId,
        number: repo.nextNumber,
        kind: 'pull',
        title,
        body: stringField(parsed.value, 'body') ?? '',
        state: 'open',
        labels: [],
        comments: [],
        createdSeq: store.seq,
        createdAt: at,
        updatedAt: at,
        closedAt: null,
        headRef: headRef.replace(/^[^:]+:/, ''),
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
      sendJson(res, 201, pullJson(store, base, fullName, repo, g, item));
      return true;
    }
    return false;
  }

  const number = Number(parts[1]);
  const item = Number.isInteger(number) ? findItem(repo, number) : null;
  if (item === null || item.kind !== 'pull') {
    sendError(res, 404, 'Not Found');
    return true;
  }

  if (parts.length === 2 && method === 'GET') {
    sendJson(res, 200, pullJson(store, base, fullName, repo, g, item));
    return true;
  }
  if (parts.length === 2 && method === 'PATCH') {
    const parsed = parseJsonBody(await readBody(req));
    if ('malformed' in parsed) {
      sendError(res, 400, 'Problems parsing JSON');
      return true;
    }
    const title = stringField(parsed.value, 'title');
    if (title !== null) item.title = title;
    const body = stringField(parsed.value, 'body');
    if (body !== null) item.body = body;
    const state = stringField(parsed.value, 'state');
    if (state === 'closed' || state === 'open') {
      item.state = state;
      item.closedAt = state === 'closed' ? nowIso() : null;
    }
    item.updatedAt = nowIso();
    sendJson(res, 200, pullJson(store, base, fullName, repo, g, item));
    return true;
  }

  if (parts.length === 3 && parts[2] === 'files' && method === 'GET') {
    const files = pullFiles(g, item).map((file) => {
      const before = file.baseSha === null ? '' : (readObject(g, file.baseSha)?.data.toString('utf8') ?? '');
      const after = file.headSha === null ? '' : (readObject(g, file.headSha)?.data.toString('utf8') ?? '');
      const counts = lineDiffCounts(before, after);
      return {
        sha: file.headSha ?? file.baseSha ?? '',
        filename: file.path,
        status: file.status,
        additions: counts.additions,
        deletions: counts.deletions,
        changes: counts.additions + counts.deletions,
        blob_url: `${base}/api/v3/repos/${fullName}/git/blobs/${file.headSha ?? ''}`,
        raw_url: `${base}/${fullName}/raw/${item.headRef ?? ''}/${file.path}`,
        contents_url: `${base}/api/v3/repos/${fullName}/contents/${file.path}?ref=${item.headRef ?? ''}`,
      };
    });
    sendJson(res, 200, paginate(req, res, url, files));
    return true;
  }

  if (parts.length === 3 && parts[2] === 'commits' && method === 'GET') {
    const headSha = item.headRef !== undefined ? branchHead(g, item.headRef) : null;
    const baseSha = item.baseRef !== undefined ? branchHead(g, item.baseRef) : null;
    if (headSha === null || baseSha === null) {
      sendJson(res, 200, []);
      return true;
    }
    const baseAncestors = new Set(walkCommits(g, baseSha, 100000));
    const shas = walkCommits(g, headSha).filter((sha) => !baseAncestors.has(sha));
    const page = paginate(req, res, url, shas);
    sendJson(res, 200, page.map((sha) => commitJson(store, g, sha, base, fullName)));
    return true;
  }

  if (parts.length === 3 && parts[2] === 'merge') {
    if (method === 'GET') {
      sendJson(res, 200, { merged: item.merged ?? false, message: item.merged ? 'Pull Request is merged' : 'Not merged' });
      return true;
    }
    if (method === 'PUT') {
      const parsed = parseJsonBody(await readBody(req));
      if ('malformed' in parsed) {
        sendError(res, 400, 'Problems parsing JSON');
        return true;
      }
      if (item.state === 'closed' && item.merged) {
        sendError(res, 405, 'Pull Request is already merged');
        return true;
      }
      const baseRef = item.baseRef ?? repo.defaultBranch;
      const headRef = item.headRef ?? '';
      const baseTip = branchHead(g, baseRef);
      const headTip = branchHead(g, headRef);
      if (baseTip === null || headTip === null) {
        sendError(res, 405, 'Pull Request is not mergeable');
        return true;
      }
      const ancestor = mergeBase(g, baseTip, headTip);
      const ancestorTree = ancestor === null ? null : (commitInfo(g, ancestor)?.tree ?? null);
      const baseTree = commitInfo(g, baseTip)?.tree ?? '';
      const headTree = commitInfo(g, headTip)?.tree ?? '';
      const mergeMethod = stringField(parsed.value, 'merge_method') ?? 'merge';
      let newSha: string;
      if (mergeMethod === 'squash') {
        const merged = threeWayMergeTrees(g, ancestorTree, baseTree, headTree);
        if (merged.tree === undefined) {
          sendError(res, 405, 'Pull Request is not mergeable');
          return true;
        }
        const login = viewerLogin(store);
        const message = stringField(parsed.value, 'commit_message') ?? `${item.title} (#${item.number})`;
        newSha = writeCommit(g, { tree: merged.tree, parents: [baseTip], authorName: login, authorEmail: `${login}@example.invalid`, message });
      } else if (isAncestor(g, headTip, baseTip)) {
        newSha = baseTip; // Already up to date: nothing to merge.
      } else if (isAncestor(g, baseTip, headTip)) {
        newSha = headTip; // Fast-forward.
        // A plain merge still records a merge commit on GitHub unless told
        // otherwise; the fast-forward sha keeps content checks honest.
      } else {
        const merged = threeWayMergeTrees(g, ancestorTree, baseTree, headTree);
        if (merged.tree === undefined) {
          sendError(res, 405, 'Pull Request is not mergeable');
          return true;
        }
        const login = viewerLogin(store);
        newSha = writeCommit(g, {
          tree: merged.tree,
          parents: [baseTip, headTip],
          authorName: login,
          authorEmail: `${login}@example.invalid`,
          message: stringField(parsed.value, 'commit_message') ?? `Merge pull request #${item.number}`,
        });
      }
      setRef(g, `refs/heads/${baseRef}`, newSha);
      item.merged = true;
      item.mergeSha = newSha;
      item.mergedAt = nowIso();
      item.state = 'closed';
      item.closedAt = item.mergedAt;
      item.updatedAt = item.mergedAt;
      repo.updatedAt = item.mergedAt;
      sendJson(res, 200, { sha: newSha, merged: true, message: 'Pull Request successfully merged' });
      return true;
    }
    return false;
  }

  return false;
}
