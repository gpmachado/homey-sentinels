'use strict';

// Starts something that needs the Homey API (subscribing a monitor to its device) and, if that
// fails, tries again with growing waits. Right after a Homey reboot the apps come up before the
// devices do, so the first attempt can fail through no fault of the monitor; without a retry the
// monitor stayed silent until the app's next restart, and the only trace was one log line.
const DEFAULT_DELAYS_MS = [10 * 1000, 30 * 1000, 2 * 60 * 1000, 5 * 60 * 1000, 10 * 60 * 1000];

// start()         -> a promise that resolves when the monitor is watching
// isStillWanted() -> false once the monitor was deleted meanwhile, which ends the retries
// schedule(fn,ms) -> setTimeout-alike
// shouldGiveUp(failure, attempt) -> true stops retrying (a device Homey says does not exist will not appear by
//                                   waiting); onGiveUp(failure) is then called once
// onStarted()                    -> called each time the start works
// onAbandoned()                  -> the start worked but isStillWanted() went false while it was in flight (deleted,
//                                   flagged missing, replaced): onStarted is NOT called, so it cannot clear a flag that
//                                   was just set, and this is the place to undo what the start set up
function resumeWithRetry({ label, start, isStillWanted = () => true, schedule, log = () => {}, error = () => {}, delays = DEFAULT_DELAYS_MS, shouldGiveUp = () => false, onGiveUp = () => {}, onStarted = () => {}, onAbandoned = () => {} }) {
  let attempt = 0;
  const run = () => {
    Promise.resolve().then(start).then(() => {
      if (!isStillWanted()) { onAbandoned(); return; }
      onStarted();
      if (attempt > 0) log(`${label} is being watched now (after ${attempt} ${attempt === 1 ? 'retry' : 'retries'})`);
    }).catch((failure) => {
      if (!isStillWanted()) return;
      if (shouldGiveUp(failure, attempt)) {
        error(`${label} gave up watching (${failure && failure.message ? failure.message : failure}) after ${attempt + 1} attempts`);
        onGiveUp(failure);
        return;
      }
      const wait = delays[Math.min(attempt, delays.length - 1)];
      attempt += 1;
      error(`${label} could not start watching (${failure && failure.message ? failure.message : failure}); retrying in ${Math.round(wait / 1000)} s`);
      schedule(run, wait);
    });
  };
  run();
}

module.exports = { resumeWithRetry, DEFAULT_DELAYS_MS };
