import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// 动态解析当前 node 路径（兼容 homebrew/nvm/volta）
const nodePath = process.execPath;

// 从 import.meta.url 推导项目根目录
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");

// 配置
const label = "com.cc-butler.service";
const plistPath = join(
  process.env.HOME,
  "Library",
  "LaunchAgents",
  `${label}.plist`
);
const dataDir = join(projectRoot, "data");
const stdoutLog = join(dataDir, "service.stdout.log");
const stderrLog = join(dataDir, "service.stderr.log");
const port = process.env.PORT || "8118";

// 生成 PATH：继承当前 PATH + 确保 node 所在目录可用
const nodeDir = dirname(nodePath);
const envPath = process.env.PATH
  ? `${nodeDir}:${process.env.PATH}`
  : nodeDir;

// plist 模板
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${join(projectRoot, "src", "server.js")}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${projectRoot}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CC_BUTLER_ROOT</key>
    <string>${projectRoot}</string>
    <key>PORT</key>
    <string>${port}</string>
    <key>PATH</key>
    <string>${envPath}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${stdoutLog}</string>
  <key>StandardErrorPath</key>
  <string>${stderrLog}</string>
</dict>
</plist>
`;

// 确保 data 目录存在
mkdirSync(dataDir, { recursive: true });

// 写入 plist
writeFileSync(plistPath, plist, "utf-8");
console.log(`plist written: ${plistPath}`);

// 加载服务（-w 覆盖 disabled 状态）
try {
  execSync(`launchctl load -w ${plistPath}`, { stdio: "pipe" });
  console.log(`service loaded: ${label}`);
} catch (err) {
  const msg = err.stderr?.toString() || err.message;
  if (msg.includes("already loaded")) {
    // 先卸载再重新加载，确保配置更新生效
    try {
      execSync(`launchctl unload ${plistPath}`, { stdio: "pipe" });
      execSync(`launchctl load -w ${plistPath}`, { stdio: "pipe" });
      console.log(`service reloaded: ${label}`);
    } catch (retryErr) {
      console.log(`reload failed: ${retryErr.message}`);
      process.exit(1);
    }
  } else {
    console.log(`load failed: ${msg}`);
    process.exit(1);
  }
}

console.log(`\ncc-butler service is running`);
console.log(`  URL:      http://localhost:${port}`);
console.log(`  Logs:     ${stdoutLog}`);
console.log(`  Stop:     npm run disable:mac-service`);
