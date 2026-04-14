#!/usr/bin/env node
// ============================================================
// AgentBoard — binary entry point
// ============================================================

// The daemon spawns a child of this same binary with --daemon so that
// it can run inside the child without pulling in Commander in
// the hot path. We must check for this flag BEFORE Commander parses argv.
if (process.argv.includes('--daemon')) {
  const { runDaemon } = await import('../daemon/index.js');
  const {
    AGENTBOARD_DAEMON_CONFIG: configFile = '',
    AGENTBOARD_DAEMON_DB: dbPath = '',
    AGENTBOARD_DAEMON_SOCKET: socketPath = '',
    AGENTBOARD_DAEMON_LOG: logFile = '',
    AGENTBOARD_DAEMON_STATE_DIR: stateDir = '',
  } = process.env;

  await runDaemon({ configFile, dbPath, socketPath, logFile, stateDir });
  process.exit(0);
} else {
  const { buildCli } = await import('../cli/index.js');
  buildCli().parse(process.argv);
}
