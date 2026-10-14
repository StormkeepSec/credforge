// Serves a sample's public/ folder for the 1EdTech validator check, e.g. behind a temporary tunnel.
//
//   pnpm --filter @credforge/ob3 serve-sample [-- --dir path/to/sample/public] [--port 8787]
//
// Extensionless files (issuer profiles, status lists) are sent as application/json. `/` answers
// with a short page, because the validator checks that the issuer's `url` is reachable. Every
// request is logged so you can see what a validator fetched.

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  // pnpm passes the `--` separator through to the script.
  args: process.argv.slice(2).filter((arg) => arg !== '--'),
  options: {
    dir: { type: 'string' },
    port: { type: 'string', default: '8787' },
  },
});
const root = values.dir
  ? resolve(process.env.INIT_CWD ?? process.cwd(), values.dir)
  : fileURLToPath(new URL('../fixtures/sample/public/', import.meta.url));
const port = Number(values.port);

if (!existsSync(root)) {
  console.error(`No such folder: ${root}`);
  process.exit(1);
}

const contentTypes: Record<string, string> = {
  '': 'application/json',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const server = createServer((request, response) => {
  const path = decodeURIComponent(new URL(request.url ?? '/', 'http://sample').pathname);
  const send = (status: number, type: string, body?: string) => {
    response.writeHead(status, {
      'content-type': type,
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    });
    response.end(request.method === 'HEAD' ? undefined : body);
    console.log(`${status} ${request.method} ${path}  (${request.headers['user-agent'] ?? '-'})`);
  };

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return send(405, 'text/plain', 'Method not allowed');
  }
  if (path === '/') {
    return send(200, 'text/html; charset=utf-8', '<!doctype html><title>credforge sample</title>');
  }

  const file = resolve(root, `.${path}`);
  const insideRoot = file.startsWith(root.endsWith(sep) ? root : root + sep);
  const type = contentTypes[extname(file)];
  if (!insideRoot || !type || !existsSync(file) || !statSync(file).isFile()) {
    return send(404, 'application/json', '{"error":"not found"}');
  }

  response.writeHead(200, {
    'content-type': type,
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  if (request.method === 'HEAD') {
    response.end();
  } else {
    createReadStream(file).pipe(response);
  }
  console.log(`200 ${request.method} ${path}  (${request.headers['user-agent'] ?? '-'})`);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Serving ${root} on http://127.0.0.1:${port}`);
  console.log(`Expose it with: cloudflared tunnel --url http://127.0.0.1:${port}`);
});
