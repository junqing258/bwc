import { spawn } from "node:child_process";
const children = [
  spawn("npm", ["run", "server"], { stdio: "inherit" }),
  spawn("npm", ["run", "web"], { stdio: "inherit" }),
];
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  children.forEach((p) => p.kill("SIGTERM"));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
children.forEach((p) =>
  p.on("exit", (code) => {
    stop();
    process.exitCode = code ?? 0;
  }),
);
