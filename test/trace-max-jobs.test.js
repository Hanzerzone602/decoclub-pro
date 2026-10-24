"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const start = src.indexOf("function hostParallelism()");
const end = src.indexOf("const TRACE_MAX_JOBS = readTraceMaxJobs();");
assert.ok(start >= 0 && end > start, "trace job cap helpers missing from server.js");

function load(mocks) {
  const sandbox = {
    require: function (name) {
      if (mocks && mocks[name]) return mocks[name];
      return require(name);
    },
    process: { env: (mocks && mocks.env) || {} },
  };
  vm.runInNewContext(
    src.slice(start, end) + "\nthis.api = { hostParallelism: hostParallelism, jobsFromCpuMax: jobsFromCpuMax, resolveTraceMaxJobs: resolveTraceMaxJobs, readTraceMaxJobs: readTraceMaxJobs };",
    sandbox
  );
  return sandbox.api;
}

const api = load();
const resolve = api.resolveTraceMaxJobs;

assert.strictEqual(resolve("6", "100000 100000", 4), 6, "env TRACE_MAX_JOBS wins");
assert.strictEqual(resolve("0", "800000 100000", 8), 1, "set env is at least 1");
assert.strictEqual(resolve("  3  ", null, 8), 3, "numeric env ignores a missing cpu.max");
assert.strictEqual(resolve("", "200000 100000", 8), 2, "blank env falls through to cgroup");
assert.strictEqual(resolve(undefined, "200000 100000", 8), 2, "floor(quota/period)");
assert.strictEqual(resolve(undefined, "250000 100000", 8), 2, "fractional cpus floor");
assert.strictEqual(resolve(undefined, "50000 100000", 8), 1, "under 1 cpu still allows 1 job");
assert.strictEqual(resolve(undefined, "800000 100000", 4), 4, "cgroup cap is also capped by parallelism");
assert.strictEqual(resolve(undefined, "100000 100000", 4), 1, "one cpu");
assert.strictEqual(resolve(undefined, "max 100000", 8), 2, "quota max is unlimited, fall back to 2");
assert.strictEqual(resolve(undefined, null, 8), 2, "missing file falls back to 2");
assert.strictEqual(resolve(undefined, "", 8), 2, "empty file falls back to 2");
assert.strictEqual(resolve(undefined, "nope", 8), 2, "unreadable contents fall back to 2");
assert.strictEqual(resolve(undefined, "100 0", 8), 2, "zero period falls back to 2");
assert.strictEqual(resolve("nope", "300000 100000", 8), 3, "non-numeric env falls through to cgroup");

const limited = load({
  env: {},
  fs: { readFileSync: function () { return "800000 100000"; } },
  os: { availableParallelism: function () { return 4; }, cpus: function () { return []; } },
});
assert.strictEqual(limited.readTraceMaxJobs(), 4, "read path caps cgroup quota by availableParallelism");

const unlimited = load({
  env: {},
  fs: { readFileSync: function () { return "max 100000\n"; } },
  os: { availableParallelism: function () { return 8; }, cpus: function () { return []; } },
});
assert.strictEqual(unlimited.readTraceMaxJobs(), 2, "unlimited cpu.max falls back to 2");

const missing = load({
  env: { TRACE_MAX_JOBS: "5" },
  fs: { readFileSync: function () { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; } },
  os: { availableParallelism: function () { return 8; }, cpus: function () { return []; } },
});
assert.strictEqual(missing.readTraceMaxJobs(), 5, "env override does not need cpu.max");

const unreadable = load({
  env: {},
  fs: { readFileSync: function () { throw new Error("EACCES"); } },
  os: { availableParallelism: function () { throw new Error("no"); }, cpus: function () { return [{}, {}]; } },
});
assert.strictEqual(unreadable.readTraceMaxJobs(), 2, "unreadable cpu.max falls back to 2");

console.log("ok trace max jobs follows env, then cgroup cpu.max, else 2");
