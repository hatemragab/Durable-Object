import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const cwd = fileURLToPath(new URL("..", import.meta.url));
async function run(command, args, workdir = cwd) {
  const child = spawn(command, args, { cwd: workdir, stdio: "inherit" });
  const code = await new Promise((r, j) => {
    child.on("error", j);
    child.on("close", r);
  });
  if (code) throw new Error(`${command} ${args.join(" ")} failed (${code}).`);
}
await run("npm", ["--prefix", "shared", "ci"]);
await run("npm", ["--prefix", "shared", "run", "build"]);
await Promise.all([
  run("npm", ["--prefix", "nestjs", "ci"]),
  run("npm", ["--prefix", "cloudflare", "ci"]),
]);
await run("flutter", ["pub", "get"], `${cwd}/flutter`);
