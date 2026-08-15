import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const DSH_BRIDGE_TOKEN_FILE = "dsh-bridge.token";
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

export function bridgeTokenPath(dataRoot: string): string {
  return path.join(dataRoot, DSH_BRIDGE_TOKEN_FILE);
}

async function readToken(file: string): Promise<string> {
  const token = (await fs.readFile(file, "utf8")).trim();
  if (!TOKEN_PATTERN.test(token)) {
    throw new Error("DeepSeek Harness bridge token file is invalid.");
  }
  return token;
}

/** Create once with owner-only permissions where the platform supports them. */
export async function ensureBridgeToken(dataRoot: string): Promise<string> {
  await fs.mkdir(dataRoot, { recursive: true });
  const file = bridgeTokenPath(dataRoot);
  try {
    return await readToken(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }

  const token = crypto.randomBytes(32).toString("hex");
  try {
    const handle = await fs.open(file, "wx", 0o600);
    try {
      await handle.writeFile(`${token}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
      return readToken(file);
    }
    throw error;
  }
}
