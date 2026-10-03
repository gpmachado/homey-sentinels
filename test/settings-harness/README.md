# Settings page harness (manual)

`npm test` does not load the Settings page. This folder lets you run the real `settings/index.html` and
`settings/settings.js` in any browser, without a Homey: `homey.js` is a stand-in for Homey's settings runtime
(fixtures for every list, every API call and every confirm recorded in `window.__log`), and `trace.js` plays a
scripted session through it — open, cancel, save and stale-submit every edit/message form, insert tokens at the
caret, Reset and Delete on every list — and returns everything observable as one list.

Use it to check a change to `settings/settings.js` is behaviour-preserving: run it before and after and compare.

```bash
# from the repository root: a throwaway copy of the page with the stand-in in place of /homey.js
mkdir -p /tmp/settings-check && cp settings/* /tmp/settings-check/
cp test/settings-harness/homey.js /tmp/settings-check/homey.js
cp test/settings-harness/trace.js /tmp/settings-check/trace.js
cd /tmp/settings-check && python3 -m http.server 8765
```

Open `http://localhost:8765/index.html`, then in the browser console:

```js
var s = document.createElement('script'); s.src = '/trace.js'; document.head.appendChild(s);
// once loaded:
var trace = await window.runTrace(); JSON.stringify(trace).length; window.__log.filter(x => x.alert)
```

For a before/after comparison, serve the old copy (`git show <commit>:settings/settings.js`) on another port and
compare `JSON.stringify(trace)` of the two: they should be identical. At the time it was written the trace had 51
steps and no alerts. The fixtures are small and made up; add to them when the page grows a new list or form.

This does not replace trying the page on a Homey (it cannot show Homey's own button styles, for example).
