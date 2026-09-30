const { spawn } = require("node:child_process");
const depth = Number(process.argv[2] || 0);
console.log(`tree-pid:${process.pid}`);
if (depth < 2) {
  spawn(process.execPath, [__filename, String(depth + 1)], {
    stdio: ["ignore", "inherit", "inherit"],
    windowsHide: true,
  });
} else {
  console.log("tree-ready");
}
// Bound failed-test cleanup even if the tested termination code regresses.
setTimeout(() => process.exit(0), 30_000);
