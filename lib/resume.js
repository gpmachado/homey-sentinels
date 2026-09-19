'use strict';

// Starts something that needs the Homey API (subscribing a monitor to its device) and, if that
// fails, tries again with growing waits. Right after a Homey reboot the apps come up before the
// devices do, so the first attempt can fail through no fault of the monitor; without a retry the
// monitor stayed silent until the app's next restart, and the only trace was one log line.
const DEFAULT_DELAYS_MS = [10 * 1000, 30 * 1000, 2 * 60 * 1000, 5 * 60 * 1000, 10 * 60 * 1000];

// start()         -> a promise that resolves when the monitor is watching
// isStillWanted() -> false once the monitor was deleted meanwhile, which ends the retries
// schedule(fn,ms) -> setTimeout-alike
function resumeWithRetry({ label, start, isStillWanted = () => true, schedule, log = () => {}, error = () => {}, delays = DEFAULT_DELAYS_MS }) {
  let attempt = 0;
  const run = () => {
    Promise.resolve().then(start).then(() => {
      if (attempt > 0) log(`${label} is being watched now (after ${attempt} ${attempt === 1 ? 'retry' : 'retries'})`);
    }).catch((failure) => {
      if (!isStillWanted()) return;
      const wait = delays[Math.min(attempt, delays.length - 1)];
      attempt += 1;
      error(`${label} could not start watching (${failure && failure.message ? failure.message : failure}); retrying in ${Math.round(wait / 1000)} s`);
      schedule(run, wait);
    });
  };
  run();
}

module.exports = { resumeWithRetry, DEFAULT_DELAYS_MS };
