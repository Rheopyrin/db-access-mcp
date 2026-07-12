import net from 'node:net';
import { DbAccessError } from '../errors';

export const PORT_RANGE_MIN = 20_000;
export const PORT_RANGE_MAX = 45_000;
const MAX_ATTEMPTS = 25;

export function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

/**
 * Picks a local port for a tunnel. An explicitly configured port is a contract:
 * if it is taken we fail instead of silently moving. Otherwise a random port in
 * [20000, 45000] is bind-checked (random start point minimizes collisions
 * between concurrently starting MCP instances).
 */
export async function pickLocalPort(preferred?: number): Promise<number> {
  if (preferred !== undefined) {
    if (await isPortFree(preferred)) return preferred;
    throw new DbAccessError('TUNNEL_FAILED', `configured localPort ${preferred} is already in use`, {
      hint: 'Free the port or remove "localPort" to let db-access-mcp pick a free one.',
    });
  }
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const port = PORT_RANGE_MIN + Math.floor(Math.random() * (PORT_RANGE_MAX - PORT_RANGE_MIN + 1));
    if (await isPortFree(port)) return port;
  }
  throw new DbAccessError('TUNNEL_FAILED', `could not find a free local port in [${PORT_RANGE_MIN}, ${PORT_RANGE_MAX}]`);
}
