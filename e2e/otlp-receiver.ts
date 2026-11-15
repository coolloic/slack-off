// Phase 4c Task 5: a local OTLP/HTTP receiver for the e2e (127.0.0.1, a random port; nothing leaves the machine).
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

export interface Received {
  headers: IncomingHttpHeaders;
  body: string;
}

export async function otlpReceiver(): Promise<{ url: string; host: string; received: Received[]; close: () => Promise<void> }> {
  const received: Received[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1/traces`,
    host: `127.0.0.1:${port}`,
    received,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

export const spansIn = (r: Received): unknown[] =>
  (JSON.parse(r.body) as { resourceSpans: Array<{ scopeSpans: Array<{ spans: unknown[] }> }> }).resourceSpans[0]!.scopeSpans[0]!.spans;
