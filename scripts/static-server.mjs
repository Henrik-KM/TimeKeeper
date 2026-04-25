import { createReadStream, existsSync, statSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import process from 'node:process';

const port = Number(process.argv[2] || 4173);
const rootDir = process.cwd();

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8'
};

function getContentType(filePath) {
  return (
    mimeTypes[path.extname(filePath).toLowerCase()] ||
    'application/octet-stream'
  );
}

function resolvePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const relativePath = decoded === '/' ? '/index.html' : decoded;
  const normalized = path.normalize(relativePath).replace(/^([/\\])+/, '');
  return path.join(rootDir, normalized);
}

const server = createServer(async (req, res) => {
  try {
    const targetPath = resolvePath(req.url || '/');
    if (!targetPath.startsWith(rootDir)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    let filePath = targetPath;
    if (existsSync(filePath) && statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }

    await fs.access(filePath);
    res.writeHead(200, {
      'Content-Type': getContentType(filePath),
      'Cache-Control': 'no-store'
    });
    createReadStream(filePath).pipe(res);
  } catch (error) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`TimeKeeper static server listening on ${port}\n`);
});
