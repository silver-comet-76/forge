// GitHub REST v3: repositories, branches, commits, contents, labels, issues, comments and
// pull requests. Every reply is application/json (never HTML), every reply carries
// X-GitHub-Request-Id (http.ts), unknown routes are JSON 404s and malformed JSON bodies are 400s.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { authorized, parseJsonBody, queryOf, sendJson, sendNoContent, store, unauthorized } from './http.ts';
import { VIEWER_LOGIN, VIEWER_ID, VIEWER_NAME, VIEWER_EMAIL, type Issue, type Pull, type Repo } from './store.ts';

const INSTALLED_VERSION = '1.0.0';

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 0, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed' };
    }),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    comments: issue.comments.length,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    head: { label: `${repo.owner}:${pull.head.ref}`, ref: pull.head.ref, sha: pull.head.sha },
    base: { label: `${repo.owner}:${pull.base.ref}`, ref: pull.base.ref, sha: pull.base.sha },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  };
}

function commentJson(comment: { id: number; body: string }): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  };
}

/** Paginate a list: the page's items and the Link header value ('' when there is no next page). */
function paginate(
  req: IncomingMessage,
  path: string,
  query: URLSearchParams,
  items: unknown[],
): { page: unknown[]; link: string } {
  const perPage = Math.max(1, Math.min(100, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  const pageNum = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const start = (pageNum - 1) * perPage;
  const page = items.slice(start, start + perPage);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  if (pageNum >= totalPages) return { page, link: '' };
  const host = req.headers.host ?? '127.0.0.1';
  const base = `http://${host}${path}`;
  const next = `${base}?per_page=${perPage}&page=${pageNum + 1}`;
  const last = `${base}?per_page=${perPage}&page=${totalPages}`;
  return { page, link: `<${next}>; rel="next", <${last}>; rel="last"` };
}

function sendPage(res: ServerResponse, req: IncomingMessage, path: string, query: URLSearchParams, items: unknown[]): void {
  const { page, link } = paginate(req, path, query, items);
  const headers: Record<string, string> = {};
  if (link !== '') headers.link = link;
  sendJson(res, 200, page, headers);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringField(body: Record<string, unknown>, field: string): string | null {
  const value = body[field];
  return typeof value === 'string' ? value : null;
}

/** The repo at /repos/{owner}/{name}, or null after answering 404 when it is not the viewer's. */
function loadRepo(res: ServerResponse, owner: string, name: string): Repo | null {
  const repo = store.getRepo(owner, name);
  if (repo === undefined || repo.owner !== VIEWER_LOGIN) {
    sendJson(res, 404, { message: 'Not Found' });
    return null;
  }
  return repo;
}

export async function handleRest(req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<void> {
  if (!authorized(req)) {
    unauthorized(res);
    return;
  }
  const method = req.method ?? 'GET';
  const rawPath = (() => {
    try {
      return new URL(req.url ?? '/', 'http://entry').pathname;
    } catch {
      return '/';
    }
  })();
  const query = queryOf(req);
  const path = rawPath.replace(/^\/api\/v3\/?/, '');
  const segments = path === '' ? [] : path.split('/').map((segment) => decodeURIComponent(segment));

  // The API root.
  if (segments.length === 0) {
    if (method !== 'GET') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    sendJson(
      res,
      200,
      {
        current_user_url: '/api/v3/user',
        rate_limit_url: '/api/v3/rate_limit',
        repository_url: '/api/v3/repos/{owner}/{repo}',
      },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
    return;
  }

  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    sendJson(res, 200, { installed_version: INSTALLED_VERSION });
    return;
  }

  if (segments[0] === 'user' && segments.length === 1) {
    if (method !== 'GET') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    sendJson(res, 200, {
      login: VIEWER_LOGIN,
      id: VIEWER_ID,
      type: 'User',
      name: VIEWER_NAME,
      email: VIEWER_EMAIL,
    });
    return;
  }

  // POST /user/repos — create a repository. GET /user/repos — list the viewer's.
  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'POST') {
      const parsed = parseJsonBody(res, body);
      if (parsed === null || !isRecord(parsed)) {
        if (parsed !== null) sendJson(res, 422, { message: 'name is required' });
        return;
      }
      const name = stringField(parsed, 'name');
      if (name === null || name === '' || name.length > 100 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
        sendJson(res, 422, { message: 'name is invalid' });
        return;
      }
      const description = stringField(parsed, 'description') ?? '';
      const isPrivate = parsed.private === true;
      const repo = store.createRepo(VIEWER_LOGIN, name, description, isPrivate);
      if (repo === null) {
        sendJson(res, 422, { message: `Repository ${name} already exists` });
        return;
      }
      sendJson(res, 201, repoJson(repo));
      return;
    }
    if (method === 'GET') {
      sendPage(res, req, rawPath, query, store.viewerRepos().map(repoJson));
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // Everything below is /repos/{owner}/{name}[...].
  if (segments[0] !== 'repos' || segments.length < 3) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const owner = segments[1]!;
  const repoName = segments[2]!;
  const repo = loadRepo(res, owner, repoName);
  if (repo === null) return;
  const rest = segments.slice(3);

  // GET/PATCH/DELETE /repos/{o}/{r}
  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'PATCH') {
      const parsed = parseJsonBody(res, body);
      if (parsed === null || !isRecord(parsed)) {
        if (parsed !== null) sendJson(res, 422, { message: 'invalid body' });
        return;
      }
      const description = stringField(parsed, 'description');
      if (description !== null) repo.description = description;
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, repoName);
      sendNoContent(res);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // Branches.
  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      sendJson(
        res,
        200,
        store.listBranches(repo).map((branch) => ({ name: branch.name, commit: { sha: branch.sha } })),
      );
      return;
    }
    if (rest.length === 2 && method === 'GET') {
      const branch = store.listBranches(repo).find((candidate) => candidate.name === rest[1]);
      if (branch === undefined) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      sendJson(res, 200, { name: branch.name, commit: { sha: branch.sha } });
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // Commits.
  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
    const sha = query.get('sha') ?? repo.defaultBranch;
    const commits = store.listCommits(repo, sha);
    sendJson(
      res,
      200,
      commits.map((commit) => ({
        sha: commit.sha,
        commit: {
          message: commit.message,
          author: { name: VIEWER_NAME, email: VIEWER_EMAIL },
          committer: { name: VIEWER_NAME, email: VIEWER_EMAIL },
        },
        author: { login: VIEWER_LOGIN },
      })),
    );
    return;
  }

  // Git Data: refs.
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const parsed = parseJsonBody(res, body);
      if (parsed === null || !isRecord(parsed)) {
        if (parsed !== null) sendJson(res, 422, { message: 'invalid body' });
        return;
      }
      const ref = stringField(parsed, 'ref');
      const sha = stringField(parsed, 'sha');
      if (ref === null || !ref.startsWith('refs/') || sha === null || !/^[0-9a-f]{40}$/i.test(sha)) {
        sendJson(res, 422, { message: 'ref and sha are required' });
        return;
      }
      const target = repo.objects.get(sha.toLowerCase());
      if (!target || target.type !== 'commit') {
        sendJson(res, 422, { message: 'sha does not name a commit' });
        return;
      }
      if (repo.refs.has(ref)) {
        sendJson(res, 422, { message: `ref ${ref} already exists` });
        return;
      }
      repo.refs.set(ref, sha.toLowerCase());
      sendJson(res, 201, { ref, object: { sha: sha.toLowerCase(), type: 'commit' } });
      return;
    }
    if (method === 'GET' && rest.length >= 4 && rest[2] === 'heads') {
      const branch = rest.slice(3).join('/');
      const oid = repo.refs.get(`refs/heads/${branch}`);
      if (oid === undefined) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      sendJson(res, 200, { ref: `refs/heads/${branch}`, object: { sha: oid, type: 'commit' } });
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // Contents.
  if (rest[0] === 'contents') {
    const filePath = rest.slice(1).join('/');
    if (method === 'PUT') {
      const parsed = parseJsonBody(res, body);
      if (parsed === null || !isRecord(parsed)) {
        if (parsed !== null) sendJson(res, 422, { message: 'invalid body' });
        return;
      }
      const message = stringField(parsed, 'message');
      const content = stringField(parsed, 'content');
      if (message === null || content === null) {
        sendJson(res, 422, { message: 'message and content are required' });
        return;
      }
      const branch = stringField(parsed, 'branch') ?? repo.defaultBranch;
      const sha = stringField(parsed, 'sha') ?? undefined;
      let contentBytes: Buffer;
      try {
        contentBytes = Buffer.from(content.replace(/[\r\n\t ]+/g, ''), 'base64');
      } catch {
        sendJson(res, 422, { message: 'content is not valid base64' });
        return;
      }
      const result = store.commitFile(repo, { branch, path: filePath, content: contentBytes, message, sha });
      if ('error' in result) {
        sendJson(res, result.error, { message: result.message });
        return;
      }
      sendJson(res, result.status, {
        content: {
          name: filePath.split('/').pop() ?? filePath,
          path: filePath,
          sha: result.blobSha,
          size: contentBytes.length,
          type: 'file',
          encoding: 'base64',
          content: contentBytes.toString('base64'),
        },
        commit: { sha: result.commitSha, message },
      });
      return;
    }
    if (method === 'GET') {
      const ref = query.get('ref') ?? repo.defaultBranch;
      const tip = store.resolveCommit(repo, ref);
      if (tip === null) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      const entry = store.readPath(repo, tip, filePath);
      if (entry === null) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      if (entry.kind === 'file') {
        sendJson(res, 200, {
          type: 'file',
          encoding: 'base64',
          name: filePath.split('/').pop() ?? filePath,
          path: filePath,
          sha: entry.oid,
          size: entry.data.length,
          content: entry.data.toString('base64'),
        });
        return;
      }
      sendJson(
        res,
        200,
        entry.entries.map((item) => ({
          type: item.mode === '40000' ? 'dir' : 'file',
          name: item.name,
          path: item.path,
          sha: item.oid,
          size: item.mode === '40000' ? 0 : (repo.objects.get(item.oid)?.data.length ?? 0),
        })),
      );
      return;
    }
    if (method === 'DELETE') {
      const parsed = body.length === 0 ? {} : parseJsonBody(res, body);
      if (parsed === null) return;
      if (!isRecord(parsed)) {
        sendJson(res, 422, { message: 'invalid body' });
        return;
      }
      const message = stringField(parsed, 'message') ?? 'Delete file';
      const sha = stringField(parsed, 'sha') ?? undefined;
      const branch = stringField(parsed, 'branch') ?? repo.defaultBranch;
      const result = store.deleteFile(repo, { branch, path: filePath, message, sha });
      if ('error' in result) {
        sendJson(res, result.error, { message: result.message });
        return;
      }
      sendJson(res, 200, { commit: { sha: result.commitSha } });
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // Labels.
  if (rest[0] === 'labels') {
    if (method === 'POST' && rest.length === 1) {
      const parsed = parseJsonBody(res, body);
      if (parsed === null || !isRecord(parsed)) {
        if (parsed !== null) sendJson(res, 422, { message: 'invalid body' });
        return;
      }
      const name = stringField(parsed, 'name');
      if (name === null || name === '') {
        sendJson(res, 422, { message: 'name is required' });
        return;
      }
      const color = stringField(parsed, 'color') ?? 'ededed';
      const label = store.createLabel(repo, name, color);
      sendJson(res, 201, { name: label.name, color: label.color });
      return;
    }
    if (method === 'GET' && rest.length === 1) {
      sendJson(
        res,
        200,
        [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })),
      );
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // Issues.
  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const parsed = parseJsonBody(res, body);
        if (parsed === null || !isRecord(parsed)) {
          if (parsed !== null) sendJson(res, 422, { message: 'invalid body' });
          return;
        }
        const title = stringField(parsed, 'title');
        if (title === null || title === '') {
          sendJson(res, 422, { message: 'title is required' });
          return;
        }
        const issueBody = stringField(parsed, 'body') ?? '';
        const labelNames = Array.isArray(parsed.labels)
          ? (parsed.labels as unknown[]).filter((entry): entry is string => typeof entry === 'string')
          : [];
        const issue = store.createIssue(repo, title, issueBody, labelNames);
        if ('error' in issue) {
          sendJson(res, issue.error, { message: issue.message });
          return;
        }
        sendJson(res, 201, issueJson(repo, issue));
        return;
      }
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        const sort = query.get('sort') ?? 'created';
        const direction = query.get('direction') ?? 'desc';
        let issues = [...repo.issues];
        if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
        else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
        if (sort === 'created') {
          issues.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
        }
        sendPage(res, req, rawPath, query, issues.map((issue) => issueJson(repo, issue)));
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const number = Number.parseInt(rest[1] ?? '', 10);
    if (!Number.isInteger(number) || number < 1) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (rest.length === 2) {
      const issue = store.getIssue(repo, number);
      if (issue === undefined) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, issueJson(repo, issue));
        return;
      }
      if (method === 'PATCH') {
        const parsed = parseJsonBody(res, body);
        if (parsed === null || !isRecord(parsed)) {
          if (parsed !== null) sendJson(res, 422, { message: 'invalid body' });
          return;
        }
        const state = stringField(parsed, 'state');
        if (state === 'open' || state === 'closed') issue.state = state;
        const title = stringField(parsed, 'title');
        if (title !== null) issue.title = title;
        const issueBody = stringField(parsed, 'body');
        if (issueBody !== null) issue.body = issueBody;
        sendJson(res, 200, issueJson(repo, issue));
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      const issue = store.getIssue(repo, number);
      if (issue === undefined) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      if (method === 'POST') {
        const parsed = parseJsonBody(res, body);
        if (parsed === null || !isRecord(parsed)) {
          if (parsed !== null) sendJson(res, 422, { message: 'invalid body' });
          return;
        }
        const commentBody = stringField(parsed, 'body');
        if (commentBody === null) {
          sendJson(res, 422, { message: 'body is required' });
          return;
        }
        const comment = store.addComment(repo, issue, commentBody);
        sendJson(res, 201, commentJson(comment));
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, issue.comments.map(commentJson));
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // Pull requests.
  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const parsed = parseJsonBody(res, body);
        if (parsed === null || !isRecord(parsed)) {
          if (parsed !== null) sendJson(res, 422, { message: 'invalid body' });
          return;
        }
        const head = stringField(parsed, 'head');
        const base = stringField(parsed, 'base');
        const title = stringField(parsed, 'title');
        if (head === null || base === null || title === null || title === '') {
          sendJson(res, 422, { message: 'head, base and title are required' });
          return;
        }
        const pullBody = stringField(parsed, 'body') ?? '';
        const pull = store.createPull(repo, head, base, title, pullBody);
        if ('error' in pull) {
          sendJson(res, pull.error, { message: pull.message });
          return;
        }
        sendJson(res, 201, pullJson(repo, pull));
        return;
      }
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        let pulls = [...repo.pulls];
        if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
        else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
        sendPage(res, req, rawPath, query, pulls.map((pull) => pullJson(repo, pull)));
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const number = Number.parseInt(rest[1] ?? '', 10);
    if (!Number.isInteger(number) || number < 1) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const pull = store.getPull(repo, number);
    if (pull === undefined) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (rest.length === 2 && method === 'GET') {
      sendJson(res, 200, pullJson(repo, pull));
      return;
    }
    if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
      const files = store.diffCommits(repo, pull.base.sha, pull.head.sha);
      sendJson(res, 200, files);
      return;
    }
    if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
      const result = store.mergePull(repo, pull);
      if ('error' in result) {
        sendJson(res, result.error, { message: result.message });
        return;
      }
      sendJson(res, 200, { sha: result.sha, merged: true, message: `Pull request #${pull.number} merged` });
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}
