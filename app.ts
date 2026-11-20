// The forge's HTTP server: routing, auth, and the git smart-HTTP surface.
// REST v3, GraphQL v4 and MCP live in rest.ts, graphql.ts and mcp.ts; this file owns the transport
// (body reading, JSON answers, request ids) and the git protocol endpoints.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  ZERO_OID,
  computeFetch,
  decodePktLines,
  encodePktLine,
  encodePktLines,
  hashObject,
  isAncestor,
  isObjectId,
  parseTag,
  pktLineFlush,
  readPack,
  writePack,
  type GitObject,
} from './git.ts';
import { VIEWER_LOGIN, VIEWER_ID, VIEWER_NAME, VIEWER_EMAIL, type Repo } from './store.ts';
import { authorized, nextRequestId, pathOf, readBody, sendJson, store, unauthorized } from './http.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const FORGE_AGENT = 'forge/1.0';

// ---------------------------------------------------------------------------------------------
// git smart HTTP
// ---------------------------------------------------------------------------------------------

const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

/** The v0 capability list for an advertisement's first line. */
function v0Capabilities(service: 'git-upload-pack' | 'git-receive-pack'): string {
  const common = 'symref=HEAD:refs/heads/main report-status report-status-v2 delete-refs side-band-64k ofs-delta';
  if (service === 'git-upload-pack') {
    return `${common} thin-pack multi_ack_detailed shallow agent=${FORGE_AGENT} object-format=sha1`;
  }
  return `${common} agent=${FORGE_AGENT}`;
}

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
}

/** Every ref of a repo, sorted by name, with peeled targets for annotated tags. */
function refLines(repo: Repo): RefLine[] {
  const lines: RefLine[] = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const object = repo.objects.get(oid);
    if (!object) continue;
    const line: RefLine = { oid, name };
    if (name.startsWith('refs/tags/') && object.type === 'tag') {
      const target = parseTag(object.data).object;
      const targetObject = repo.objects.get(target);
      if (targetObject && targetObject.type === 'commit') line.peeled = target;
    }
    lines.push(line);
  }
  return lines;
}

/** The v0 advertisement body for a service. */
function v0Advertisement(service: 'git-upload-pack' | 'git-receive-pack', repo: Repo): Buffer {
  const lines: Array<string | 'flush'> = [`# service=${service}\n`];
  const refs = refLines(repo);
  const caps = v0Capabilities(service);
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\u0000${caps}\n`);
  } else {
    const headTip = repo.refs.get('refs/heads/main');
    const headOid = headTip ?? refs[0]!.oid;
    lines.push(`${headOid} HEAD\u0000${caps}\n`);
    for (const ref of refs) {
      lines.push(`${ref.oid} ${ref.name}\n`);
      if (ref.peeled) lines.push(`${ref.peeled} ${ref.name}^{}\n`);
    }
  }
  lines.push('flush');
  return encodePktLines(lines);
}

/** The v2 advertisement body for upload-pack. */
function v2Advertisement(): Buffer {
  const lines: Array<string | 'flush'> = [
    '# service=git-upload-pack\n',
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow wait-for-done\n',
    'object-format=sha1\n',
    `agent=${FORGE_AGENT}\n`,
    'flush',
  ];
  return encodePktLines(lines);
}

/** GET /:owner/:repo.git/info/refs?service=... */
function handleInfoRefs(req: IncomingMessage, res: ServerResponse, owner: string, name: string, service: string): void {
  if (!authorized(req)) {
    unauthorized(res);
    return;
  }
  const repo = store.getRepo(owner, name);
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  if (service === 'git-upload-pack') {
    const protocol = req.headers['git-protocol'];
    if (typeof protocol === 'string' && protocol.includes('version=2')) {
      const body = v2Advertisement();
      res.writeHead(200, { 'content-type': UPLOAD_AD, 'content-length': body.length, 'x-github-request-id': nextRequestId() });
      res.end(body);
      return;
    }
    const body = v0Advertisement('git-upload-pack', repo);
    res.writeHead(200, { 'content-type': UPLOAD_AD, 'content-length': body.length, 'x-github-request-id': nextRequestId() });
    res.end(body);
    return;
  }
  if (service === 'git-receive-pack') {
    const body = v0Advertisement('git-receive-pack', repo);
    res.writeHead(200, { 'content-type': RECEIVE_AD, 'content-length': body.length, 'x-github-request-id': nextRequestId() });
    res.end(body);
    return;
  }
  sendJson(res, 400, { message: `unknown service ${service}` });
}

/** The ls-refs answer for a v2 upload-pack request. */
function handleLsRefs(repo: Repo, args: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: Array<string | 'flush'> = [];
  const refs = refLines(repo);
  const headTip = repo.refs.get('refs/heads/main');
  if (refs.length === 0) {
    // An empty repo: only the unborn HEAD line, never an unborn branch (the empty-clone check
    // counts any refs/ line as a real ref).
    if (unborn && keep('HEAD')) lines.push(`unborn HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`);
  } else {
    if (keep('HEAD')) {
      lines.push(`${headTip ?? refs[0]!.oid} HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`);
    }
    for (const ref of refs) {
      if (!keep(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (peel && ref.peeled) line += ` peeled:${ref.peeled}`;
      lines.push(`${line}\n`);
    }
  }
  lines.push('flush');
  return encodePktLines(lines);
}

/** The fetch answer for a v2 upload-pack request. */
function handleFetch(repo: Repo, args: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowIn: string[] = [];
  let depth: number | null = null;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallowIn.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const n = Number.parseInt(arg.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    }
  }
  const { send, shallow, unshallow } = computeFetch(wants, haves, shallowIn, depth, (oid) => repo.objects.get(oid));
  const parts: Buffer[] = [];
  const ackLines: Array<string | 'delim'> = ['acknowledgments\n', 'NAK\n', 'ready\n', 'delim'];
  parts.push(encodePktLines(ackLines));
  if (shallow.length > 0 || unshallow.length > 0) {
    const infoLines: Array<string | 'delim'> = ['shallow-info\n'];
    for (const oid of shallow) infoLines.push(`shallow ${oid}\n`);
    for (const oid of unshallow) infoLines.push(`unshallow ${oid}\n`);
    infoLines.push('delim');
    parts.push(encodePktLines(infoLines));
  }
  if (send.size > 0) {
    const pack = writePack(send.values());
    const packLines: Array<string | Buffer | 'flush'> = ['packfile\n'];
    const chunkSize = 65515; // pkt-line max 65520, minus 4 header bytes, minus 1 band byte
    for (let offset = 0; offset < pack.length; offset += chunkSize) {
      const chunk = pack.subarray(offset, Math.min(pack.length, offset + chunkSize));
      packLines.push(Buffer.concat([Buffer.from([1]), chunk]));
    }
    packLines.push('flush');
    parts.push(encodePktLines(packLines));
  } else {
    parts.push(pktLineFlush());
  }
  return Buffer.concat(parts);
}

/** POST /:owner/:repo.git/git-upload-pack (protocol v2). */
function handleUploadPack(req: IncomingMessage, res: ServerResponse, repo: Repo, body: Buffer): void {
  let packets;
  try {
    packets = decodePktLines(body).packets;
  } catch {
    sendJson(res, 400, { message: 'malformed pkt-line stream' });
    return;
  }
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
    else if (packet.kind === 'delim') lines.push('\u0001');
    else if (packet.kind === 'flush') break;
  }
  const command = lines[0] ?? '';
  const args = lines.slice(1).filter((line) => line !== '\u0001');
  let out: Buffer;
  if (command === 'command=ls-refs') {
    out = handleLsRefs(repo, args);
  } else if (command === 'command=fetch') {
    out = handleFetch(repo, args);
  } else {
    sendJson(res, 400, { message: `unknown upload-pack command ${JSON.stringify(command)}` });
    return;
  }
  res.writeHead(200, { 'content-type': UPLOAD_RESULT, 'content-length': out.length, 'x-github-request-id': nextRequestId() });
  res.end(out);
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** POST /:owner/:repo.git/git-receive-pack (protocol v0). */
function handleReceivePack(req: IncomingMessage, res: ServerResponse, repo: Repo, body: Buffer): void {
  let commands: PushCommand[] = [];
  let packBytes: Buffer = Buffer.alloc(0);
  try {
    const decoded = decodePktLines(body);
    const flushIndex = decoded.packets.findIndex((packet) => packet.kind === 'flush');
    if (flushIndex < 0) throw new Error('the command list has no flush');
    // The framed section ends at the flush; everything after it is the raw pack.
    packBytes = body.subarray(decoded.endOffset);
    for (const packet of decoded.packets.slice(0, flushIndex)) {
      if (packet.kind !== 'data') continue;
      let text = packet.payload.toString('utf8').replace(/\n$/, '');
      const nul = text.indexOf('\u0000');
      if (nul >= 0) text = text.slice(0, nul); // capabilities ride the first line
      const parts = text.split(' ');
      if (parts.length < 3) throw new Error(`bad push command ${JSON.stringify(text)}`);
      commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts.slice(2).join(' ') });
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const report = encodePktLines([`unpack ${detail}\n`, 'flush']);
    const out = Buffer.concat([encodePktLine(Buffer.concat([Buffer.from([1]), report])), pktLineFlush()]);
    res.writeHead(200, { 'content-type': RECEIVE_RESULT, 'content-length': out.length, 'x-github-request-id': nextRequestId() });
    res.end(out);
    return;
  }

  // Unpack first: every object lands in the store, even for a refused ref.
  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, { resolveBase: (oid) => repo.objects.get(oid) });
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }

  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  const applied: PushCommand[] = [];
  for (const command of commands) {
    if (unpackError !== null) {
      results.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
      continue;
    }
    const current = repo.refs.get(command.ref);
    const check = (): string | null => {
      if (!command.ref.startsWith('refs/')) return 'invalid ref';
      if (!isObjectId(command.oldOid) || !isObjectId(command.newOid)) return 'invalid object id';
      if (command.newOid === ZERO_OID) {
        if (current === undefined) return 'no such ref';
        if (command.oldOid !== current) return 'old value mismatch';
        return null;
      }
      const target = repo.objects.get(command.newOid);
      if (!target) return 'missing object';
      if (command.ref.startsWith('refs/heads/') && target.type !== 'commit') return 'not a commit';
      if (command.oldOid === ZERO_OID) {
        if (current !== undefined) return 'already exists';
        return null;
      }
      if (current === undefined) return 'no such ref';
      if (command.oldOid !== current) return 'old value mismatch';
      if (!isAncestor(lookup, current, command.newOid)) return 'non-fast-forward';
      return null;
    };
    const reason = check();
    if (reason !== null) {
      results.push({ ref: command.ref, ok: false, reason });
      continue;
    }
    results.push({ ref: command.ref, ok: true, reason: '' });
    applied.push(command);
  }
  for (const command of applied) {
    if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
    else repo.refs.set(command.ref, command.newOid);
  }

  const reportLines: string[] = [unpackError !== null ? `unpack ${unpackError}\n` : 'unpack ok\n'];
  for (const result of results) {
    reportLines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  const report = encodePktLines([...reportLines, 'flush']);
  const out = Buffer.concat([encodePktLine(Buffer.concat([Buffer.from([1]), report])), pktLineFlush()]);
  res.writeHead(200, { 'content-type': RECEIVE_RESULT, 'content-length': out.length, 'x-github-request-id': nextRequestId() });
  res.end(out);
}

// ---------------------------------------------------------------------------------------------
// the server
// ---------------------------------------------------------------------------------------------

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const path = pathOf(req);
    const method = req.method ?? 'GET';
    try {
      // The env's boot check calls this twice: 200 {"ok":true}.
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (path === '/api/graphql' && method === 'POST') {
        const body = await readBody(req);
        await handleGraphql(req, res, body);
        return;
      }
      if (path === '/mcp') {
        if (method !== 'POST') {
          sendJson(res, 405, { message: 'Method Not Allowed' });
          return;
        }
        const body = await readBody(req);
        await handleMcp(req, res, body);
        return;
      }
      if (path.startsWith('/api/v3')) {
        const body = await readBody(req);
        await handleRest(req, res, body);
        return;
      }

      // Git smart HTTP: /<owner>/<repo>.git/<service>
      const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
      if (gitMatch) {
        const owner = decodeURIComponent(gitMatch[1]!);
        const name = decodeURIComponent(gitMatch[2]!);
        const service = gitMatch[3]!;
        if (service === 'info/refs' && method === 'GET') {
          const url = new URL(req.url ?? '/', 'http://entry');
          handleInfoRefs(req, res, owner, name, url.searchParams.get('service') ?? '');
          return;
        }
        if (!authorized(req)) {
          unauthorized(res);
          return;
        }
        const repo = store.getRepo(owner, name);
        if (repo === undefined) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        if (service === 'git-upload-pack' && method === 'POST') {
          const body = await readBody(req);
          handleUploadPack(req, res, repo, body);
          return;
        }
        if (service === 'git-receive-pack' && method === 'POST') {
          const body = await readBody(req);
          handleReceivePack(req, res, repo, body);
          return;
        }
        sendJson(res, 405, { message: 'Method Not Allowed' });
        return;
      }

      // Everything else, every method: GitHub's 404 body.
      sendJson(res, 404, { message: 'Not Found' });
    } catch (err) {
      // A handler must never take the process down: answer 500 and stay up.
      try {
        sendJson(res, 500, { message: err instanceof Error ? err.message : String(err) });
      } catch {
        // The socket is already gone; nothing more to do.
      }
    }
  });
}

// Re-exported for the API layers' tests and diagnostics.
export { VIEWER_LOGIN, VIEWER_ID, VIEWER_NAME, VIEWER_EMAIL };
export type { Repo };
export { hashObject };
