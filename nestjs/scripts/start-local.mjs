import { readEnvironment } from "./environment.mjs";
import { readConfig } from "../dist/src/config/config.js";
import { createApp } from "../dist/src/app.js";
const env = await readEnvironment();
const config = readConfig({
  ...env,
  REALTIME_BASE_URL: "http://127.0.0.1:8787",
});
const app = await createApp(config);
await app.listen(config.port, config.host);
console.log(
  `Local-only development API ready at http://${config.host}:${config.port}/api/v1; realtime uses local workerd, not Cloudflare deployment.`,
);
