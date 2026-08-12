// Wrapper around `node --test`, so that `npm test` means the same thing
// everywhere and CI needs no special command of its own.
//
// The one difference it makes: test files run one at a time, everywhere.
//
// Node's default runs test/api.test.js and test/ui.test.js in parallel. On
// a two-core GitHub runner that starves the browser badly enough that
// loginPage() times out even at the 25s ui.test.js allows itself, which
// failed roughly half the UI suite on every run - main included - for a
// whole day before anyone read past the red cross. So CI was pinned to one
// file at a time and local runs kept the parallel default, on the argument
// that they had cores to spare and it took half as long.
//
// That argument no longer holds. Measured on 2026-08-12 with the suite at
// 206 tests: 116s serial against 120s parallel on a developer machine with
// other work on it. Two WebKit matrices contending for the same cores cost
// more than they save, and the price of the difference was a different test
// dropping out of nearly every run - each of which passed alone, and each
// of which had to be chased down before anyone could trust the red.
// Serial is not the careful-but-slow option here. It is simply the faster
// one, and it is honest.
//
// This lives here rather than as a --test-concurrency=1 flag in the
// workflow because there is no environment variable for that flag, and
// editing .github/workflows/ needs a token scope the deploy credentials
// don't carry.
import { spawn } from 'node:child_process';

const args = ['--disable-warning=ExperimentalWarning', '--test', '--test-concurrency=1'];
args.push(...process.argv.slice(2));

spawn(process.execPath, args, { stdio: 'inherit' })
  .on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
