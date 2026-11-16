// The forge's whole world: one authenticated user, their repositories, and everything
// inside them. In-memory by design — a trial starts empty and lives for minutes, so
// nothing here touches disk. Git object state lives in lib/gitstore.ts, keyed by repo id.

/** An ISO-8601 UTC timestamp for right now, the shape every GitHub timestamp takes. */
export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export interface LabelRec {
  readonly id: number;
  name: string;
  color: string;
  description: string;
}

export interface CommentRec {
  readonly id: number;
  body: string;
  readonly createdSeq: number;
  readonly createdAt: string;
  updatedAt: string;
}

export interface IssueRec {
  readonly id: number;
  readonly number: number;
  readonly kind: 'issue' | 'pull';
  title: string;
  body: string;
  state: 'open' | 'closed';
  /** Label names attached to this issue or pull request. */
  labels: string[];
  comments: CommentRec[];
  readonly createdSeq: number;
  readonly createdAt: string;
  updatedAt: string;
  // Pull-request-only fields, set when kind is 'pull'.
  headRef?: string;
  headSha?: string;
  baseRef?: string;
  baseSha?: string;
  merged?: boolean;
  mergeSha?: string;
  /** When the issue or pull request was closed, if it is. */
  closedAt?: string | null;
  /** When the pull request was merged, if it was. */
  mergedAt?: string | null;
}

export interface RepoRec {
  readonly id: number;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  readonly createdSeq: number;
  readonly createdAt: string;
  updatedAt: string;
  labels: Map<string, LabelRec>;
  /** Issues and pull requests together: GitHub numbers them from one sequence. */
  items: IssueRec[];
  nextNumber: number;
}

export interface Store {
  /**
   * The authenticated user's login. The suite never tells the forge this string —
   * the bearer token is opaque — so it starts unset and is adopted from the first
   * owner path segment that addresses an existing repository (see findRepo).
   */
  login: string | null;
  repos: Map<string, RepoRec>;
  nextRepoId: number;
  nextLabelId: number;
  nextIssueId: number;
  nextCommentId: number;
  /** Global monotonic sequence: the order things happened, for stable sorting. */
  seq: number;
}

export function createStore(): Store {
  return {
    login: null,
    repos: new Map(),
    nextRepoId: 1,
    nextLabelId: 1,
    nextIssueId: 1,
    nextCommentId: 1,
    seq: 0,
  };
}

/** The login API surfaces report: the adopted one, or a placeholder before adoption. */
export function viewerLogin(store: Store): string {
  return store.login ?? 'viewer';
}

/**
 * Resolve an owner path segment against the one authenticated user. While the
 * canonical login is unset, the first owner that addresses an existing repository
 * is adopted as it. Once set, any other owner is a stranger: their view of this
 * user's repositories is "not found", never "forbidden".
 */
export function ownerMatches(store: Store, owner: string): boolean {
  if (store.login === null) return true;
  return store.login === owner;
}

/** Look a repository up by owner + name, adopting the login on first contact. */
export function findRepo(store: Store, owner: string, name: string): RepoRec | null {
  const repo = store.repos.get(name);
  if (repo === undefined) return null;
  if (store.login === null) {
    store.login = owner;
  } else if (store.login !== owner) {
    return null;
  }
  return repo;
}

/** Create a repository under the authenticated user; null when the name is taken. */
export function createRepo(
  store: Store,
  input: { name: string; description?: string; isPrivate?: boolean; defaultBranch?: string },
): RepoRec | null {
  if (store.repos.has(input.name)) return null;
  const at = nowIso();
  const repo: RepoRec = {
    id: store.nextRepoId,
    name: input.name,
    description: input.description ?? '',
    isPrivate: input.isPrivate ?? false,
    defaultBranch: input.defaultBranch ?? 'main',
    createdSeq: store.seq,
    createdAt: at,
    updatedAt: at,
    labels: new Map(),
    items: [],
    nextNumber: 1,
  };
  store.nextRepoId += 1;
  store.seq += 1;
  store.repos.set(repo.name, repo);
  return repo;
}

/** Delete a repository by name; true when it existed. */
export function deleteRepo(store: Store, name: string): boolean {
  return store.repos.delete(name);
}

/** The issue or pull request with this number in this repository, if any. */
export function findItem(repo: RepoRec, number: number): IssueRec | null {
  return repo.items.find((item) => item.number === number) ?? null;
}
