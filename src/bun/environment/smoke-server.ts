/**
 * Temporary loopback HTTP fixture for the environment-manager live smoke.
 * Not imported by the app. Tests copy it into a temp project and launch it
 * through EnvironmentManager. It listens only on 127.0.0.1 and exits on
 * SIGTERM, SIGINT, or GET /quit.
 */

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("fo-smoke-bad-port");
  process.exit(1);
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(req) {
    const pathname = new URL(req.url).pathname;
    if (pathname === "/quit") {
      // Let this response flush before the process exits. Stopping active
      // connections in the same turn resets the client before it sees 200.
      setTimeout(() => {
        void server.stop(true);
        process.exit(0);
      }, 50);
      return new Response("bye\n", { status: 200 });
    }
    if (pathname === "/health" || pathname === "/") {
      return new Response("ok\n", { status: 200 });
    }
    return new Response("not found\n", { status: 404 });
  },
});

console.log(`fo-smoke-ready ${server.port}`);

function shutdown(): void {
  void server.stop(true);
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
