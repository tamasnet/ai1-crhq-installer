// Sample service — a trivial HTTP server bound to localhost. Under --sandbox it is skipped
// (services aren't modelled); a real install deploys it via nginx (127.0.0.1 proxy) + PM2.
import { createServer } from 'http';

const port = process.env.PORT || 4310;
createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('ai1-sample-svc ok\n');
}).listen(port, '127.0.0.1', () => console.log(`ai1-sample-svc listening on 127.0.0.1:${port}`));
