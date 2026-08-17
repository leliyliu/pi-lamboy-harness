// perf-lab remote command assembly — pure string building, no execution.
// Builds the remote bench-loop bash script, the ssh command array, and the
// nvidia-smi environment snapshot query. No host imports.
//
// bench loop contract (consumed by perf/index.ts adapter):
//   - exports each env var
//   - runs `warmup` silent iterations
//   - runs `runs` measured iterations, each emitting ONE collectable stdout line:
//     `eval "$CMD" | grep -oP 'PERF_VAL \K[\d.]+'` extracts the number the bench
//     prints after the PERF_VAL marker; on a bench that emits no marker, the
//     `|| eval "$CMD" | tail -1` fallback grabs the last line as a bare number.
export interface BenchScriptSpec {
  runs: number;
  warmup: number;
  env?: Record<string, string>;
}

export function buildBenchScript(spec: BenchScriptSpec, cmd: string): string {
  const envExports = Object.entries(spec.env ?? {})
    .map(([k, v]) => `export ${k}=${v}`)
    .join("\n");
  return [
    "set -e",
    envExports,
    `CMD='${cmd}'`,
    "# warmup (silent)",
    `for i in $(seq 1 ${spec.warmup}); do`,
    '  eval "$CMD" >/dev/null 2>&1',
    "done",
    "# measured runs",
    `for i in $(seq 1 ${spec.runs}); do`,
    `  eval "$CMD" | grep -oP 'PERF_VAL \\K[\\d.]+' || eval "$CMD" | tail -1`,
    "done",
  ].filter(Boolean).join("\n");
}

// Returns ["ssh", host, "bash -lc '<cd workdir && script>'"] with inner single
// quotes escaped via the classic '\'' idiom so the whole body stays inside one
// single-quoted argument on the remote shell.
export function buildSshCommand(host: string, workdir: string, script: string): string[] {
  const body = `cd ${workdir} && ${script}`;
  const escaped = body.replace(/'/g, `'\\''`);
  return ["ssh", host, `bash -lc '${escaped}'`];
}

export function buildEnvSnapshotCmd(): string {
  return "nvidia-smi --query-gpu=name,driver_version,clocks.sm,clocks.max.sm --format=csv";
}
