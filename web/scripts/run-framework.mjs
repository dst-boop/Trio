import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readExecutionProfile } from "./execution-profile.mjs";

// Both execution profiles build with vinext. The managed Sites profile ("managed-linux",
// chosen by the Sites plugin in .sites-runtime/execution-profile.json) only wraps that same
// `vinext build` in build-verified.sh for its environment and time limit; clean clones and CI
// ("portable") call vinext directly. Only the dev server differs: managed-linux runs Vite with
// the vinext plugin from vite.config.ts, portable uses the vinext CLI. The production build is
// the same either way, so CI's build checks what Sites publishes.
const [command, ...args] = process.argv.slice(2);
if (!["dev", "build"].includes(command)) throw new Error("Expected dev or build.");
const managedLinux = readExecutionProfile() === "managed-linux";

if (managedLinux && command === "build") {
  const result = spawnSync("bash", [
    fileURLToPath(new URL("./build-verified.sh", import.meta.url)), ...args,
  ], { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

// Import in this process so the preview owner retains its PID and signals.
const cli = new URL(managedLinux
  ? "../node_modules/vite/bin/vite.js"
  : "../node_modules/vinext/dist/cli.js", import.meta.url);
process.argv = [process.execPath, fileURLToPath(cli), command,
  ...(!managedLinux && command === "dev" ? ["--port", "5173"] : []), ...args];
await import(cli.href);
