import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, relative } from 'node:path';

const [rootArgument, portArgument] = process.argv.slice(2);
if (!rootArgument || !portArgument) {
  throw new Error('Usage: node scripts/serve-static.mjs <directory> <port>');
}

const root = resolve(rootArgument);
const port = Number(portArgument);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error('The static server port must be an integer from 1 through 65535.');
}
await stat(root);

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

async function fileFor(requestUrl) {
  const pathname = decodeURIComponent(new URL(requestUrl, 'http://localhost').pathname);
  const candidate = resolve(root, `.${pathname}`);
  const candidateRelativePath = relative(root, candidate);
  if (candidateRelativePath.startsWith('..') || candidateRelativePath.includes(':')) {
    return null;
  }
  try {
    const details = await stat(candidate);
    if (details.isFile()) return candidate;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return resolve(root, 'index.html');
}

const server = createServer((request, response) => {
  void fileFor(request.url ?? '/')
    .then((file) => {
      if (!file) {
        response.writeHead(404).end('Not found');
        return;
      }
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Type': contentTypes.get(extname(file)) ?? 'application/octet-stream',
      });
      createReadStream(file).on('error', () => response.destroy()).pipe(response);
    })
    .catch(() => response.writeHead(500).end('Internal server error'));
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Serving ${root} at http://127.0.0.1:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
