const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const logDir = process.env.RUNTIME_LOG_DIR || path.join(process.cwd(), "logs");
const logFile = path.join(logDir, "frontend-build.log");
fs.mkdirSync(logDir, { recursive: true });

const npmCommand = process.platform === "win32" ? "npx.cmd" : "npx";
const child = spawn(npmCommand, ["tsc", "--noEmit"], {
  cwd: process.cwd(),
  shell: false,
  env: process.env,
});

let output = "";
child.stdout.on("data", (chunk) => { output += chunk.toString(); process.stdout.write(chunk); });
child.stderr.on("data", (chunk) => { output += chunk.toString(); process.stderr.write(chunk); });

child.on("close", (code) => {
  if (code !== 0) {
    fs.appendFileSync(
      logFile,
      JSON.stringify({
        time: new Date().toISOString(),
        message: output.trim() || `TypeScript check failed with exit code ${code}`,
      }) + "\n",
      "utf8"
    );
  }
  process.exitCode = code || 0;
});
