import { execSync } from "node:child_process";
import { join } from "node:path";

const label = "com.cc-butler.service";
const plistPath = join(
  process.env.HOME,
  "Library",
  "LaunchAgents",
  `${label}.plist`
);

try {
  execSync(`launchctl unload ${plistPath}`, { stdio: "pipe" });
  console.log(`service unloaded: ${label}`);
  console.log(`\ncc-butler service stopped`);
  console.log(`  Restart:  npm run enable:mac-service`);
} catch (err) {
  const msg = err.stderr?.toString() || err.message;
  if (msg.includes("Could not find specified service") || msg.includes("not loaded")) {
    console.log(`service was not running: ${label}`);
  } else {
    console.log(`unload failed: ${msg}`);
    process.exit(1);
  }
}
