// In-memory JSONL peer for catalog/UI tests. Native transport/decoder tests live
// in the independent core repository; this fixture never opens a real account.
export function nativeProcess(host, record) {
  let closed = false, waiting = null;
  const lines = [];
  let state = { status: "idle", position: 0, duration: 0, volume: 100 };
  let finish;
  const done = new Promise(resolve => { finish = resolve; });
  const push = value => { if (waiting) { const f = waiting; waiting = null; f(value); } else lines.push(value); };
  const end = () => { if (!closed) { closed = true; push(null); finish(0); } };
  return {
    write(text) {
      record.stdin += text;
      for (const line of text.trim().split("\n")) {
        const request = JSON.parse(line);
        void (async () => {
          try {
            const p = request.params || {};
            let result = true;
            if (host._nativeBehavior) result = await host._nativeBehavior(request);
            else switch (request.method) {
              case "hello": result = { protocol: 1 }; break;
              case "auth": {
                const behavior = host._nativeAuthBehavior;
                if (behavior instanceof Error) throw behavior;
                host._nativeToken = typeof behavior === "function" ? await behavior({ native: true }) : "mock_mut_subscriber_jwt_token_2026";
                break;
              }
              case "session": if(host._nativeSessionBehavior) {result=await host._nativeSessionBehavior();break;} result = { mediaUserToken: host._nativeToken ?? "mock_mut_subscriber_jwt_token_2026", developerToken: "SYNTHETIC_NATIVE_DEVELOPER" }; break;
              case "logout": host._nativeToken = ""; state = { status: "idle", volume: state.volume }; break;
              case "play": state = { status: "playing", trackId: p.trackId, position: p.position, duration: 256613, volume: state.volume }; break;
              case "pause": state.status = "paused"; break;
              case "resume": state.status = "playing"; break;
              case "seek": state.position = p.position; break;
              case "volume": state.volume = p.percent; break;
              case "stop": state.status = "idle"; break;
              case "state": result = { ...state }; break;
            }
            if (!closed) push(JSON.stringify({ id: request.id, ok: true, result }));
          } catch (error) { if (!closed) push(JSON.stringify({ id: request.id, ok: false, error: { code: error.code || "signIn", message: "fixture failure" } })); }
        })();
      }
    },
    readLine() { if (lines.length) return Promise.resolve(lines.shift()); if (closed) return Promise.resolve(null); return new Promise(resolve => { waiting = resolve; }); },
    closeStdin: end,
    kill() { record.killed = true; end(); },
    wait: () => done,
    errorOutput: () => "",
  };
}
