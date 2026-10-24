import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { delimiter, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [command, ...args] = process.argv.slice(2);
const env = { ...process.env };
const pathKey =
  Object.keys(env).find((key) => key.toLowerCase() === "path") || "PATH";
env[pathKey] = [
  resolve(homedir(), ".cargo/bin"),
  dirname(process.execPath),
  env[pathKey] || "",
].join(delimiter);

const pathFile = resolve(root, ".local/game-path.txt");
if (command === "dev" && !env.WAW_ROOT && existsSync(pathFile)) {
  env.WAW_ROOT = readFileSync(pathFile, "utf8").trim();
}

const child = spawn(
  process.execPath,
  [resolve(root, "node_modules/@tauri-apps/cli/tauri.js"), command, ...args],
  {
    cwd: root,
    env,
    stdio: "inherit",
  },
);
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
  if (code === 0 && command === "build") {
    mkdirSync(resolve(root, "release"), { recursive: true });
    copyFileSync(
      resolve(root, "src-tauri/target/release/waw-hud-editor.exe"),
      resolve(root, "release/waw-hud-editor.exe"),
    );
    console.log("Ready: release/waw-hud-editor.exe");
  }
});
