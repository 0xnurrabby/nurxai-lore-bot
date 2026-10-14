import http from "node:http";

// The one thing this process listens for, and the reason it listens at all.
//
// Render's free tier only runs web services: it expects a bound port and a health
// check, and it stops the instance after fifteen minutes without an HTTP request.
// A long-polling bot makes no inbound requests, so without this it would be killed
// every fifteen minutes and the Telegram poll would die with it. An external
// uptime ping every few minutes keeps it alive, and the ping needs something to
// hit.
//
// What this listener is:
//   - one path, chosen by HEALTH_PATH, answering a constant "ok"
//   - GET and HEAD only
//   - no body is read, no query string is parsed, no header is trusted
//   - nothing about the bot is reported: no version, no state, no topic names,
//     no uptime, no counts. The response is identical for every caller.
// What it is not:
//   - a control surface. It cannot start, stop, pause, ask or file anything.
//   - a data surface. It has no access to the store and returns nothing from it.
//
// The path is a shared secret rather than a guessable convention, so a scanner
// sees 404 on `/`, 404 on `/health` and cannot tell this apart from a host with
// nothing on it.

const MAX_HEADERS = 20;

export type HealthServer = { close: () => void; port: number };

/**
 * The handler, separated from the socket so it can be tested without binding a
 * port — the behaviour worth testing here is exactly what it refuses.
 */
export function createHealthHandler(healthPath: string) {
  return function handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const method = (req.method || "").toUpperCase();
    const url = req.url || "";

    if ((method === "GET" || method === "HEAD") && url === healthPath) {
      res.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "content-length": "2"
      });
      // A HEAD response must not carry a body.
      if (method === "HEAD") res.end();
      else res.end("ok");
      return;
    }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    res.end(method === "HEAD" ? undefined : "not found");
  };
}

export function startHealthServer(options: { port: number; path: string }): HealthServer {
  const server = http.createServer(createHealthHandler(options.path));

  // Nothing here needs to be patient. These caps make a connection that dawdles
  // or floods headers a closed connection rather than a held slot.
  server.headersTimeout = 5_000;
  server.requestTimeout = 5_000;
  server.keepAliveTimeout = 2_000;
  server.maxHeadersCount = MAX_HEADERS;
  // Requests are answered and forgotten; a log line per ping is 288 lines a day
  // of nothing.
  server.on("clientError", (_error, socket) => socket.destroy());

  server.listen(options.port, "0.0.0.0");

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  return { close: () => server.close(), port };
}
