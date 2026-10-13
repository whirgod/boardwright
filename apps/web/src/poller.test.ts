import { assertEquals } from "@std/assert";
import { poll } from "./poller.ts";

Deno.test("poll: loads until done, reporting each value", async () => {
  let n = 0;
  const values: number[] = [];
  await poll({
    load: () => Promise.resolve(++n),
    onValue: (v) => values.push(v),
    onError: () => {},
    done: (v) => v === 3,
    intervalMs: 1,
    signal: new AbortController().signal,
  });
  assertEquals(values, [1, 2, 3]);
});

Deno.test("poll: errors are reported and polling continues", async () => {
  let n = 0;
  const errors: unknown[] = [];
  await poll({
    load: () => ++n === 1 ? Promise.reject("down") : Promise.resolve(n),
    onValue: () => {},
    onError: (e) => errors.push(e),
    done: () => true,
    intervalMs: 1,
    signal: new AbortController().signal,
  });
  assertEquals(errors, ["down"]);
  assertEquals(n, 2);
});

Deno.test("poll: aborting stops it, also mid-load", async () => {
  const abort = new AbortController();
  const values: number[] = [];
  let n = 0;
  await poll({
    load: () => {
      n++;
      if (n === 2) abort.abort();
      return Promise.resolve(n);
    },
    onValue: (v) => values.push(v),
    onError: () => {},
    intervalMs: 1,
    signal: abort.signal,
  });
  assertEquals(values, [1]); // The load in flight when aborted is dropped.

  const failing = new AbortController();
  const errors: unknown[] = [];
  await poll({
    load: () => {
      failing.abort();
      return Promise.reject("late");
    },
    onValue: () => {},
    onError: (e) => errors.push(e),
    intervalMs: 1,
    signal: failing.signal,
  });
  assertEquals(errors, []);
});

Deno.test("poll: an already aborted signal loads nothing", async () => {
  let loads = 0;
  await poll({
    load: () => Promise.resolve(++loads),
    onValue: () => {},
    onError: () => {},
    intervalMs: 1,
    signal: AbortSignal.abort(),
  });
  assertEquals(loads, 0);
});

Deno.test("poll: waits intervalMs between loads", async () => {
  const abort = new AbortController();
  const times: number[] = [];
  const done = poll({
    load: () => Promise.resolve(times.push(performance.now())),
    onValue: () => {},
    onError: () => {},
    intervalMs: 30,
    signal: abort.signal,
  });
  await new Promise((r) => setTimeout(r, 80));
  abort.abort();
  await done;
  assertEquals(times.length >= 2, true);
  assertEquals(times[1]! - times[0]! >= 25, true);
});
