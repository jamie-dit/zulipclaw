import { spawn } from "node:child_process";

export type IptablesResult = {
  code: number;
  stdout: string;
  stderr: string;
};

/**
 * Execute an iptables command on the host.
 * Always allows failure (returns exit code) so callers can check rule existence.
 */
export function execIptables(args: string[]): Promise<IptablesResult> {
  return new Promise<IptablesResult>((resolve, reject) => {
    const child = spawn("iptables", args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code: code ?? 0,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });

    child.stdin?.end();
  });
}
