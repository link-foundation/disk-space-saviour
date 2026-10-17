#!/usr/bin/env node

// Scans are bound by file system calls, which run on libuv's thread pool
// (4 threads by default). It is sized on first use, so set it before any
// module that may touch the file system is loaded.
process.env.UV_THREADPOOL_SIZE ??= '32';
const { runCli } = await import('../src/cli.js');

const controller = new AbortController();
let received = null,
  fallback;
const abort = (signal) => {
  const code = signal === 'SIGTERM' ? 143 : 130;
  if (received) {
    process.exit(code);
  }
  received = code;
  controller.abort(new Error(`interrupted by ${signal}`));
  fallback = setTimeout(() => process.exit(code), 5000);
  fallback.unref();
};
const interrupt = () => abort('SIGINT'),
  terminate = () => abort('SIGTERM');
process.on('SIGINT', interrupt);
process.on('SIGTERM', terminate);
try {
  process.exitCode = await runCli(process.argv.slice(2), {
    signal: controller.signal,
  });
  if (received) {
    process.exitCode = received;
  }
} finally {
  clearTimeout(fallback);
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', terminate);
}
