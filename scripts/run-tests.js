// Wrapper around `node --test`, so that `npm test` means the same thing
// everywhere and CI needs no special command of its own.
//
// The one difference it makes: on CI, test files run one at a time.
// Node's default runs test/api.test.js and test/ui.test.js in parallel,
// and a two-core GitHub runner driving the full WebKit matrix at the same
// time starves the browser badly enough that loginPage() times out - even
// at the 25s timeout ui.test.js already allows itself on CI. That failed
// roughly half the UI suite on every run, main included, for a whole day
// before anyone read past the red cross.
//
// Locally, with cores to spare, the parallel default stays: the suite takes
// about half as long that way, and it is run far more often than CI is.
//
// This lives here rather than as a --test-concurrency=1 flag in the
// workflow because there is no environment variable for that flag, and
// editing .github/workflows/ needs a token scope the deploy credentials
// don't carry.
import { spawn } from 'node:child_process';

const args = ['--disable-warning=ExperimentalWarning', '--test'];
if (process.env.CI) args.push('--test-concurrency=1');
args.push(...process.argv.slice(2));

spawn(process.execPath, args, { stdio: 'inherit' })
  .on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
