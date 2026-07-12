import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { isPortFree, pickLocalPort, PORT_RANGE_MAX, PORT_RANGE_MIN } from '../../src/tunnels/ports';

function occupy(port?: number): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port ?? 0, '127.0.0.1', () => {
      resolve({ port: (server.address() as net.AddressInfo).port, close: () => server.close() });
    });
  });
}

describe('ports', () => {
  it('detects an occupied port', async () => {
    const { port, close } = await occupy();
    try {
      expect(await isPortFree(port)).toBe(false);
    } finally {
      close();
    }
  });

  it('honors an explicit free port', async () => {
    const { port, close } = await occupy();
    close();
    await new Promise((r) => setTimeout(r, 50));
    expect(await pickLocalPort(port)).toBe(port);
  });

  it('fails on an explicit occupied port instead of moving silently', async () => {
    const { port, close } = await occupy();
    try {
      await expect(pickLocalPort(port)).rejects.toMatchObject({ code: 'TUNNEL_FAILED' });
    } finally {
      close();
    }
  });

  it('picks a random port inside the range', async () => {
    const port = await pickLocalPort();
    expect(port).toBeGreaterThanOrEqual(PORT_RANGE_MIN);
    expect(port).toBeLessThanOrEqual(PORT_RANGE_MAX);
    expect(await isPortFree(port)).toBe(true);
  });
});
