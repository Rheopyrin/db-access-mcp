import net from 'node:net';

export function tcpProbe(port: number, host = '127.0.0.1', timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

export async function waitForTcp(
  port: number,
  opts: { host?: string; deadlineMs?: number; intervalMs?: number; aborted?: () => boolean } = {},
): Promise<boolean> {
  const deadline = Date.now() + (opts.deadlineMs ?? 20_000);
  const interval = opts.intervalMs ?? 250;
  while (Date.now() < deadline) {
    if (opts.aborted?.()) return false;
    if (await tcpProbe(port, opts.host)) return true;
    await new Promise((r) => setTimeout(r, interval));
  }
  return false;
}
