import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createPrivateKey, sign as cryptoSign } from "node:crypto";

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    args[key] = value;
  }
  return args;
}

function expandHome(path) {
  if (!path) return path;
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

function base64url(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(typeof input === "string" ? input : JSON.stringify(input));
  return buffer
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

async function main() {
  const args = parseArgs(process.argv);
  const teamId = args["team-id"] || process.env.APPLE_TEAM_ID;
  const keyId = args["key-id"] || process.env.APPLE_KEY_ID;
  const privateKeyPath = expandHome(args["private-key"] || process.env.APPLE_PRIVATE_KEY_PATH);
  const durationDays = Number(args["days"] || process.env.APPLE_TOKEN_DAYS || "180");

  if (!teamId || !keyId || !privateKeyPath) {
    console.error("Usage: node scripts/generate-developer-token.mjs --team-id <TEAM_ID> --key-id <KEY_ID> --private-key <PATH_TO_P8> [--days 180]");
    process.exit(1);
  }

  const now = Math.floor(Date.now() / 1000);
  const exp = now + Math.floor(durationDays * 24 * 60 * 60);

  const header = {
    alg: "ES256",
    kid: keyId,
    typ: "JWT",
  };

  const payload = {
    iss: teamId,
    iat: now,
    exp,
    aud: "appstoreconnect-v1",
  };

  const encodedHeader = base64url(header);
  const encodedPayload = base64url(payload);
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const privateKeyPem = await readFile(privateKeyPath, "utf8");
  const privateKey = createPrivateKey(privateKeyPem);
  const signature = cryptoSign("sha256", Buffer.from(signingInput), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });

  const token = `${signingInput}.${base64url(signature)}`;

  console.log(token);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
