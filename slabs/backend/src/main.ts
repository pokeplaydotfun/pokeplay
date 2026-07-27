/**
 * The production entrypoint: the fulfilment worker AND the public API in one process.
 *
 * They share a single set of dependencies on purpose. Two processes would mean two `Db`
 * handles on one SQLite file, so two write paths to the same order rows — the API would be
 * reading state the worker had already moved on from, and both could write it.
 *
 * `worker.ts` remains runnable on its own (fulfilment with no API) and `demo.ts` remains the
 * mocked local server. This is the only one that should ever run on the VPS.
 *
 *   node --experimental-strip-types src/main.ts
 */
import { startWorker } from "./worker.ts";
import { createApi } from "./api/server.ts";
import { loadConfig } from "./config.ts";

const cfg = loadConfig();

// The worker refuses to boot unless every dependency is real and reachable, so this throws
// rather than coming up degraded. systemd will restart it; a crash-loop is the correct,
// visible failure for an unreachable RPC.
const worker = await startWorker(cfg);

const server = createApi({
  db: worker.db,
  cc: worker.cc,
  pipeline: worker.pipeline,
  cfg: worker.cfg,
  escrowAddress: worker.escrowAddress,
  isPaused: worker.isPaused,
  enabledMachineIds: worker.enabledMachineIds,
  // Serves /token/stats. Reports live:false until PONS_TOKEN_ADDRESS is set.
  pons: worker.pons,
  mirrorOwners: worker.mirrorOwners,
  // Serves /deposit/cards, /deposit/claim and /deposit/:mint.
  deposits: worker.deposits,
  // Never true here. `demo` exposes /demo/rip, which fulfils an order without payment.
  demo: false,
});

server.listen(cfg.api.port, "127.0.0.1", () => {
  // Bound to loopback deliberately: Caddy terminates TLS and proxies in. ufw allows only
  // 22/80/443, but binding publicly would still expose the API to anything else on the box.
  console.log(`api up  http://127.0.0.1:${cfg.api.port}  public=${cfg.api.publicUrl}  mocks=${cfg.useMocks}`);
});

/**
 * systemd sends SIGTERM on restart. Finish in-flight requests and close the database
 * cleanly, or a redeploy mid-write can leave SQLite with a hot journal.
 */
let shuttingDown = false;
const shutdown = (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);

  const done = () => {
    worker.stop();
    process.exit(0);
  };

  server.close(done);
  // Do not hang forever on a slow client holding a connection open.
  setTimeout(() => {
    console.warn("shutdown timed out, exiting anyway");
    done();
  }, 10_000).unref();
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
