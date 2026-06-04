// Fixture service app (never actually started by the tests).
import { createServer } from 'http';
createServer((_req, res) => res.end('ai1-demo-svc ok')).listen(process.env.PORT || 4399, '127.0.0.1');
