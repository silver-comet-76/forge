// GitHub GraphQL v4 at /api/graphql: a small executor for the documents the suite sends
// (the 18 fixed documents in the kit's checks-graphql.ts). It parses the query text, resolves
// it against the same store the REST surface uses, and answers {data} or {data, errors}.
// Unknown fields are GraphQL errors (HTTP 200), never crashes; unauthenticated calls are 401.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { authorized, sendJson, store, unauthorized } from './http.ts';
import { VIEWER_LOGIN, type Issue, type Pull, type Repo } from './store.ts';

// ---------------------------------------------------------------------------------------------------------
// Lexer and parser for the small GraphQL subset the suite uses.
// ---------------------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'punct'; value: string }
  | { kind: 'var'; value: string };

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const char = text[i]!;
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === ',') {
      i += 1;
      continue;
    }
    if (char === '#') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (char === '.' && text.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():![]=$'.includes(char)) {
      tokens.push({ kind: 'punct', value: char });
      i += 1;
      continue;
    }
    if (char === '"') {
      let value = '';
      i += 1;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < text.length) {
          const escaped = text[i + 1]!;
          value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped;
          i += 2;
        } else {
          value += text[i];
          i += 1;
        }
      }
      i += 1; // the closing quote
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(char)) {
      let value = '';
      while (i < text.length && /[0-9]/.test(text[i]!)) {
        value += text[i];
        i += 1;
      }
      tokens.push({ kind: 'int', value: Number.parseInt(value, 10) });
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      let value = '';
      while (i < text.length && /[A-Za-z0-9_]/.test(text[i]!)) {
        value += text[i];
        i += 1;
      }
      tokens.push({ kind: 'name', value });
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(char)} in the GraphQL document`);
  }
  return tokens;
}

type GqlValue =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: GqlValue[] }
  | { kind: 'object'; fields: Array<{ name: string; value: GqlValue }> };

type Selection =
  | { kind: 'field'; alias: string | null; name: string; args: Record<string, GqlValue>; selections: Selection[] | null }
  | { kind: 'fragment'; typeCondition: string | null; selections: Selection[] };

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  selections: Selection[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of the GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected ${value} in the GraphQL document, got ${JSON.stringify(token)}`);
    }
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name in the GraphQL document, got ${JSON.stringify(token)}`);
    return token.value;
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.pos < this.tokens.length) {
      const token = this.peek();
      if (token?.kind === 'punct' && token.value === '{') {
        operations.push({ kind: 'query', name: null, selections: this.parseSelectionSet() });
        continue;
      }
      const kind = this.expectName();
      if (kind !== 'query' && kind !== 'mutation') throw new Error(`unsupported operation ${kind}`);
      let name: string | null = null;
      if (this.peek()?.kind === 'name') name = this.expectName();
      // Variable definitions: ($owner: String!, ...) — skipped, the values come from `variables`.
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
        let depth = 0;
        while (this.pos < this.tokens.length) {
          const token = this.next();
          if (token.kind === 'punct' && token.value === '(') depth += 1;
          if (token.kind === 'punct' && token.value === ')') {
            depth -= 1;
            if (depth === 0) break;
          }
        }
      }
      operations.push({ kind, name, selections: this.parseSelectionSet() });
    }
    return operations;
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (true) {
      const token = this.peek();
      if (token === undefined) throw new Error('unterminated selection set');
      if (token.kind === 'punct' && token.value === '}') {
        this.next();
        return selections;
      }
      if (token.kind === 'punct' && token.value === '...') {
        this.next();
        let typeCondition: string | null = null;
        if (this.peek()?.kind === 'name' && this.peek()?.value === 'on') {
          this.next();
          typeCondition = this.expectName();
        }
        selections.push({ kind: 'fragment', typeCondition, selections: this.parseSelectionSet() });
        continue;
      }
      const first = this.expectName();
      let alias: string | null = null;
      let name = first;
      if (this.peek()?.kind === 'punct' && this.peek()?.value === ':') {
        this.next();
        alias = first;
        name = this.expectName();
      }
      const args: Record<string, GqlValue> = {};
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
        this.next();
        while (true) {
          const next = this.peek();
          if (next?.kind === 'punct' && next.value === ')') {
            this.next();
            break;
          }
          const argName = this.expectName();
          this.expectPunct(':');
          args[argName] = this.parseValue();
        }
      }
      let child: Selection[] | null = null;
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') child = this.parseSelectionSet();
      selections.push({ kind: 'field', alias, name, args, selections: child });
    }
  }

  private parseValue(): GqlValue {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: GqlValue[] = [];
      while (true) {
        const next = this.peek();
        if (next?.kind === 'punct' && next.value === ']') {
          this.next();
          break;
        }
        items.push(this.parseValue());
      }
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: GqlValue }> = [];
      while (true) {
        const next = this.peek();
        if (next?.kind === 'punct' && next.value === '}') {
          this.next();
          break;
        }
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected token ${JSON.stringify(token)} in a GraphQL value`);
  }
}

function resolveValue(value: GqlValue, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name] ?? null;
    case 'string':
    case 'int':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const record: Record<string, unknown> = {};
      for (const field of value.fields) record[field.name] = resolveValue(field.value, variables);
      return record;
    }
  }
}

function resolveArgs(args: Record<string, GqlValue>, variables: Record<string, unknown>): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(args)) record[name] = resolveValue(value, variables);
  return record;
}

// ---------------------------------------------------------------------------------------------------------
// Global ids: opaque, stable, and never the plain database id.
// ---------------------------------------------------------------------------------------------------------

function globalId(kind: 'R' | 'I' | 'P' | 'C', id: number): string {
  return Buffer.from(`${kind}-${id}`, 'utf8').toString('base64');
}

function decodeGlobalId(id: unknown): { kind: 'R' | 'I' | 'P' | 'C'; id: number } | null {
  if (typeof id !== 'string' || id === '') return null;
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const match = /^([RIPC])-(\d+)$/.exec(text);
    if (match === null) return null;
    return { kind: match[1] as 'R' | 'I' | 'P' | 'C', id: Number.parseInt(match[2]!, 10) };
  } catch {
    return null;
  }
}

function repoGlobalId(repo: Repo): string {
  return globalId('R', repo.id);
}

function issueGlobalId(issue: Issue): string {
  return globalId('I', issue.id);
}

function pullGlobalId(pull: Pull): string {
  return globalId('P', pull.id);
}

function findRepoByGlobalId(id: unknown): Repo | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'R') return null;
  for (const repo of store.repos.values()) {
    if (repo.id === decoded.id) return repo;
  }
  return null;
}

function findIssueByGlobalId(id: unknown): { repo: Repo; issue: Issue } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'I') return null;
  for (const repo of store.repos.values()) {
    const issue = repo.issues.find((candidate) => candidate.id === decoded.id);
    if (issue !== undefined) return { repo, issue };
  }
  return null;
}

function findPullByGlobalId(id: unknown): { repo: Repo; pull: Pull } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'P') return null;
  for (const repo of store.repos.values()) {
    const pull = repo.pulls.find((candidate) => candidate.id === decoded.id);
    if (pull !== undefined) return { repo, pull };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------
// Introspection: the type shapes gh feature-detects.
// ---------------------------------------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files',
    'headRefOid', 'baseRefOid', 'url', 'createdAt', 'updatedAt', 'author',
  ],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest',
  ],
};

const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
};

// ---------------------------------------------------------------------------------------------------------
// Execution.
// ---------------------------------------------------------------------------------------------------------

type Parent =
  | { type: 'Query' }
  | { type: 'Viewer' }
  | { type: 'User'; login: string }
  | { type: 'Repository'; repo: Repo }
  | { type: 'Ref'; name: string }
  | { type: 'Issue'; repo: Repo; issue: Issue }
  | { type: 'PullRequest'; repo: Repo; pull: Pull }
  | { type: 'IssueConnection'; repo: Repo; issues: Issue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
  | { type: 'PullRequestConnection'; repo: Repo; pulls: Pull[] }
  | { type: 'FileConnection'; files: Array<{ filename: string; status: string; additions: number; deletions: number }> }
  | { type: 'Type'; name: string }
  | { type: 'PageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { type: 'CommentEdge'; comment: { id: number; body: string } }
  | { type: 'Comment'; comment: { id: number; body: string } };

const TYPE_NAMES: Record<Parent['type'], string> = {
  Query: 'Query',
  Viewer: 'User',
  User: 'User',
  Repository: 'Repository',
  Ref: 'Ref',
  Issue: 'Issue',
  PullRequest: 'PullRequest',
  IssueConnection: 'IssueConnection',
  PullRequestConnection: 'PullRequestConnection',
  FileConnection: 'PullRequestChangedFileConnection',
  Type: '__Type',
  PageInfo: 'PageInfo',
  CommentEdge: 'IssueCommentEdge',
  Comment: 'IssueComment',
};

interface Executor {
  errors: Array<{ message: string }>;
  variables: Record<string, unknown>;
}

function stateOfIssue(issue: Issue): 'OPEN' | 'CLOSED' {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function stateOfPull(pull: Pull): 'OPEN' | 'CLOSED' | 'MERGED' {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function issueConnection(repo: Repo, args: Record<string, unknown>): Parent {
  let issues = [...repo.issues];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state)));
    issues = issues.filter((issue) => wanted.has(stateOfIssue(issue)));
  }
  const orderBy = args.orderBy;
  let direction: 'ASC' | 'DESC' = 'ASC';
  if (orderBy !== null && typeof orderBy === 'object' && !Array.isArray(orderBy)) {
    const record = orderBy as Record<string, unknown>;
    if (record.direction === 'DESC') direction = 'DESC';
  }
  issues.sort((a, b) => (direction === 'DESC' ? b.createdSeq - a.createdSeq : a.createdSeq - b.createdSeq));
  const after = args.after;
  if (typeof after === 'string' && after !== '') {
    try {
      const cursorSeq = Number.parseInt(Buffer.from(after, 'base64').toString('utf8'), 10);
      if (Number.isInteger(cursorSeq)) {
        issues = issues.filter((issue) => (direction === 'DESC' ? issue.createdSeq < cursorSeq : issue.createdSeq > cursorSeq));
      }
    } catch {
      // An unreadable cursor behaves like no cursor.
    }
  }
  const first = typeof args.first === 'number' && args.first >= 0 ? args.first : issues.length;
  const page = issues.slice(0, first);
  const hasNextPage = issues.length > page.length;
  const endCursor = page.length === 0 ? null : Buffer.from(String(page[page.length - 1]!.createdSeq), 'utf8').toString('base64');
  return { type: 'IssueConnection', repo, issues: page, pageInfo: { hasNextPage, endCursor } };
}

function resolveField(
  executor: Executor,
  parent: Parent,
  field: Extract<Selection, { kind: 'field' }>,
): unknown {
  const args = resolveArgs(field.args, executor.variables);
  const child = field.selections;

  const error = (message: string): null => {
    executor.errors.push({ message });
    return null;
  };

  switch (parent.type) {
    case 'Query': {
      if (field.name === 'viewer') {
        return child === null ? { login: VIEWER_LOGIN } : resolveSelections(executor, { type: 'Viewer' }, child);
      }
      if (field.name === 'repository') {
        const owner = args.owner;
        const name = args.name;
        const repo = typeof owner === 'string' && typeof name === 'string' ? store.getRepo(owner, name) : undefined;
        if (repo === undefined || repo.owner !== VIEWER_LOGIN) return null;
        return child === null ? {} : resolveSelections(executor, { type: 'Repository', repo }, child);
      }
      if (field.name === 'node') {
        const decoded = decodeGlobalId(args.id);
        if (decoded !== null && decoded.kind === 'R') {
          const repo = findRepoByGlobalId(args.id);
          if (repo !== null) {
            return child === null ? { id: repoGlobalId(repo) } : resolveSelections(executor, { type: 'Repository', repo }, child);
          }
        }
        return null;
      }
      if (field.name === '__type') {
        const name = args.name;
        if (typeof name !== 'string') return null;
        return child === null ? {} : resolveSelections(executor, { type: 'Type', name }, child);
      }
      if (field.name === 'createIssue') {
        const input = args.input;
        if (input === null || typeof input !== 'object' || Array.isArray(input)) return error('createIssue needs an input object');
        const record = input as Record<string, unknown>;
        const repo = findRepoByGlobalId(record.repositoryId);
        if (repo === null) return error('createIssue names an unknown repository');
        const title = record.title;
        if (typeof title !== 'string' || title === '') return error('createIssue needs a title');
        const issue = store.createIssue(repo, title, typeof record.body === 'string' ? record.body : '', []);
        if ('error' in issue) return error(issue.message);
        return { issue: { number: issue.number, id: issueGlobalId(issue) } };
      }
      if (field.name === 'closeIssue') {
        const input = args.input;
        if (input === null || typeof input !== 'object' || Array.isArray(input)) return error('closeIssue needs an input object');
        const record = input as Record<string, unknown>;
        const found = findIssueByGlobalId(record.issueId);
        if (found === null) return error('closeIssue names an unknown issue');
        found.issue.state = 'closed';
        return { issue: { number: found.issue.number, id: issueGlobalId(found.issue), state: 'CLOSED' } };
      }
      if (field.name === 'createPullRequest') {
        const input = args.input;
        if (input === null || typeof input !== 'object' || Array.isArray(input)) return error('createPullRequest needs an input object');
        const record = input as Record<string, unknown>;
        const repo = findRepoByGlobalId(record.repositoryId);
        if (repo === null) return error('createPullRequest names an unknown repository');
        const head = record.headRefName;
        const base = record.baseRefName;
        const title = record.title;
        if (typeof head !== 'string' || typeof base !== 'string' || typeof title !== 'string') {
          return error('createPullRequest needs headRefName, baseRefName and title');
        }
        const pull = store.createPull(repo, head, base, title, '');
        if ('error' in pull) return error(pull.message);
        return {
          pullRequest: {
            number: pull.number,
            id: pullGlobalId(pull),
            state: 'OPEN',
            headRefName: pull.head.ref,
            baseRefName: pull.base.ref,
          },
        };
      }
      if (field.name === 'mergePullRequest') {
        const input = args.input;
        if (input === null || typeof input !== 'object' || Array.isArray(input)) return error('mergePullRequest needs an input object');
        const record = input as Record<string, unknown>;
        const found = findPullByGlobalId(record.pullRequestId);
        if (found === null) return error('mergePullRequest names an unknown pull request');
        const result = store.mergePull(found.repo, found.pull);
        if ('error' in result) return error(result.message);
        return { pullRequest: { number: found.pull.number, merged: true, state: 'CLOSED' } };
      }
      if (field.name === 'addComment') {
        const input = args.input;
        if (input === null || typeof input !== 'object' || Array.isArray(input)) return error('addComment needs an input object');
        const record = input as Record<string, unknown>;
        const body = record.body;
        if (typeof body !== 'string') return error('addComment needs a body');
        const found = findIssueByGlobalId(record.subjectId) ?? null;
        if (found === null) return error('addComment names an unknown subject');
        const comment = store.addComment(found.repo, found.issue, body);
        return { commentEdge: { node: { id: globalId('C', comment.id), body: comment.body } } };
      }
      return error(`Cannot query field "${field.name}" on type "Query".`);
    }
    case 'Viewer':
    case 'User': {
      if (field.name === 'login') return VIEWER_LOGIN;
      return error(`Cannot query field "${field.name}" on type "User".`);
    }
    case 'Repository': {
      const repo = parent.repo;
      switch (field.name) {
        case 'id':
          return repoGlobalId(repo);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner}/${repo.name}`;
        case 'owner':
          return child === null ? { login: repo.owner } : resolveSelections(executor, { type: 'User', login: repo.owner }, child);
        case 'defaultBranchRef':
          return child === null ? { name: repo.defaultBranch } : resolveSelections(executor, { type: 'Ref', name: repo.defaultBranch }, child);
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'issue': {
          const number = args.number;
          if (typeof number !== 'number') return null;
          const issue = store.getIssue(repo, number);
          if (issue === undefined) return null;
          return child === null ? {} : resolveSelections(executor, { type: 'Issue', repo, issue }, child);
        }
        case 'issues':
          return child === null ? {} : resolveSelections(executor, issueConnection(repo, args), child);
        case 'pullRequests': {
          const pulls = [...repo.pulls].filter((pull) => pull.state === 'open').sort((a, b) => b.createdSeq - a.createdSeq);
          const first = typeof args.first === 'number' && args.first >= 0 ? args.first : pulls.length;
          const connection: Parent = { type: 'PullRequestConnection', repo, pulls: pulls.slice(0, first) };
          return child === null ? {} : resolveSelections(executor, connection, child);
        }
        case 'pullRequest': {
          const number = args.number;
          if (typeof number !== 'number') return null;
          const pull = store.getPull(repo, number);
          if (pull === undefined) return null;
          return child === null ? {} : resolveSelections(executor, { type: 'PullRequest', repo, pull }, child);
        }
        default:
          return error(`Cannot query field "${field.name}" on type "Repository".`);
      }
    }
    case 'Ref': {
      if (field.name === 'name') return parent.name;
      return error(`Cannot query field "${field.name}" on type "Ref".`);
    }
    case 'Issue': {
      const issue = parent.issue;
      switch (field.name) {
        case 'id':
          return issueGlobalId(issue);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'body':
          return issue.body;
        case 'state':
          return stateOfIssue(issue);
        case 'url':
          return `https://example.invalid/${parent.repo.owner}/${parent.repo.name}/issues/${issue.number}`;
        default:
          return error(`Cannot query field "${field.name}" on type "Issue".`);
      }
    }
    case 'PullRequest': {
      const pull = parent.pull;
      switch (field.name) {
        case 'id':
          return pullGlobalId(pull);
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return stateOfPull(pull);
        case 'merged':
          return pull.merged;
        case 'headRefName':
          return pull.head.ref;
        case 'baseRefName':
          return pull.base.ref;
        case 'headRefOid':
          return pull.head.sha;
        case 'baseRefOid':
          return pull.base.sha;
        case 'mergeable':
          return store.mergeable(parent.repo, pull);
        case 'files': {
          const files = store.diffCommits(parent.repo, pull.base.sha, pull.head.sha);
          const first = typeof args.first === 'number' && args.first >= 0 ? args.first : files.length;
          const connection: Parent = { type: 'FileConnection', files: files.slice(0, first) };
          return child === null ? {} : resolveSelections(executor, connection, child);
        }
        default:
          return error(`Cannot query field "${field.name}" on type "PullRequest".`);
      }
    }
    case 'IssueConnection': {
      if (field.name === 'nodes') {
        return parent.issues.map((issue) =>
          child === null ? { number: issue.number } : resolveSelections(executor, { type: 'Issue', repo: parent.repo, issue }, child),
        );
      }
      if (field.name === 'pageInfo') {
        return child === null
          ? { hasNextPage: parent.pageInfo.hasNextPage, endCursor: parent.pageInfo.endCursor }
          : resolveSelections(executor, { type: 'PageInfo', ...parent.pageInfo }, child);
      }
      if (field.name === 'totalCount') return parent.issues.length;
      return error(`Cannot query field "${field.name}" on type "IssueConnection".`);
    }
    case 'PullRequestConnection': {
      if (field.name === 'nodes') {
        return parent.pulls.map((pull) =>
          child === null ? { number: pull.number } : resolveSelections(executor, { type: 'PullRequest', repo: parent.repo, pull }, child),
        );
      }
      if (field.name === 'totalCount') return parent.pulls.length;
      return error(`Cannot query field "${field.name}" on type "PullRequestConnection".`);
    }
    case 'FileConnection': {
      if (field.name === 'nodes') {
        return parent.files.map((file) => ({ path: file.filename, additions: file.additions, deletions: file.deletions, status: file.status }));
      }
      if (field.name === 'totalCount') return parent.files.length;
      return error(`Cannot query field "${field.name}" on type "PullRequestChangedFileConnection".`);
    }
    case 'Type': {
      const fields = TYPE_FIELDS[parent.name] ?? [];
      const enumValues = TYPE_ENUM_VALUES[parent.name] ?? [];
      if (field.name === 'fields') {
        return fields.map((name) => ({ name }));
      }
      if (field.name === 'enumValues') {
        return enumValues.map((name) => ({ name }));
      }
      if (field.name === 'name') return parent.name;
      return error(`Cannot query field "${field.name}" on type "__Type".`);
    }
    case 'PageInfo': {
      if (field.name === 'hasNextPage') return parent.hasNextPage;
      if (field.name === 'endCursor') return parent.endCursor;
      return error(`Cannot query field "${field.name}" on type "PageInfo".`);
    }
    case 'CommentEdge': {
      if (field.name === 'node') {
        return child === null ? { id: globalId('C', parent.comment.id), body: parent.comment.body } : resolveSelections(executor, { type: 'Comment', comment: parent.comment }, child);
      }
      return error(`Cannot query field "${field.name}" on type "IssueCommentEdge".`);
    }
    case 'Comment': {
      if (field.name === 'id') return globalId('C', parent.comment.id);
      if (field.name === 'body') return parent.comment.body;
      return error(`Cannot query field "${field.name}" on type "IssueComment".`);
    }
  }
}

function resolveSelections(executor: Executor, parent: Parent, selections: Selection[]): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      const typeName = TYPE_NAMES[parent.type];
      if (selection.typeCondition !== null && selection.typeCondition !== typeName) continue;
      const nested = resolveSelections(executor, parent, selection.selections);
      for (const [key, value] of Object.entries(nested)) record[key] = value;
      continue;
    }
    const key = selection.alias ?? selection.name;
    record[key] = resolveField(executor, parent, selection);
  }
  return record;
}

function executeOperation(operation: Operation, variables: Record<string, unknown>): { data: Record<string, unknown> | null; errors: Array<{ message: string }> } {
  const executor: Executor = { errors: [], variables };
  const data = resolveSelections(executor, { type: 'Query' }, operation.selections);
  return { data, errors: executor.errors };
}

export async function handleGraphql(req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<void> {
  if (!authorized(req)) {
    unauthorized(res);
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    sendJson(res, 400, { message: 'Problems parsing JSON' });
    return;
  }
  const operations = Array.isArray(parsed) ? parsed : [parsed];
  const results: Array<{ data: Record<string, unknown> | null; errors?: Array<{ message: string }> }> = [];
  for (const operationBody of operations) {
    if (operationBody === null || typeof operationBody !== 'object' || Array.isArray(operationBody)) {
      results.push({ data: null, errors: [{ message: 'a GraphQL operation must be an object' }] });
      continue;
    }
    const record = operationBody as Record<string, unknown>;
    const query = record.query;
    if (typeof query !== 'string') {
      results.push({ data: null, errors: [{ message: 'a GraphQL operation needs a query string' }] });
      continue;
    }
    const variables = record.variables;
    const variableRecord: Record<string, unknown> =
      variables !== null && typeof variables === 'object' && !Array.isArray(variables) ? (variables as Record<string, unknown>) : {};
    let document: Operation[];
    try {
      document = new Parser(tokenize(query)).parseDocument();
    } catch (err) {
      results.push({ data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] });
      continue;
    }
    const operation = document[0];
    if (operation === undefined) {
      results.push({ data: null, errors: [{ message: 'the GraphQL document holds no operation' }] });
      continue;
    }
    // A batched document runs its first operation; the suite batches single operations.
    const result = executeOperation(operation, variableRecord);
    results.push(result.errors.length > 0 ? { data: result.data, errors: result.errors } : { data: result.data });
  }
  sendJson(res, 200, Array.isArray(parsed) ? results : results[0]!);
}
