#!/usr/bin/env node
/**
 * A self-signed HTTPS certificate for this computer, so phones and tablets on the same Wi-Fi can use the
 * microphone (browsers allow it only on https:// or localhost).  Written to web/.cert/ (not committed),
 * valid for localhost and this computer's current network addresses; made again when those change.
 *
 *   node scripts/cert.mjs        prints the certificate's folder
 *
 * Browsers will warn once per device that the certificate is not from a known authority: that is
 * expected for a computer on a local network (choose Advanced → Proceed / Visit the website).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = fileURLToPath(new URL("..", import.meta.url));
export const CERT_DIR = join(WEB, ".cert");

export function lanAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => i.address);
}

/** Make sure a certificate for the current addresses exists; returns { key, cert } file paths. */
export function ensureCert() {
  const key = join(CERT_DIR, "key.pem");
  const cert = join(CERT_DIR, "cert.pem");
  const stamp = join(CERT_DIR, "addresses.txt");
  const ips = lanAddresses().sort();
  const want = ["127.0.0.1", ...ips].join(",");
  if (existsSync(key) && existsSync(cert) && existsSync(stamp) && readFileSync(stamp, "utf8") === want) return { key, cert };
  mkdirSync(CERT_DIR, { recursive: true });
  const san = ["DNS:localhost", "IP:127.0.0.1", ...ips.map((ip) => `IP:${ip}`)].join(",");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "397",
    "-subj", "/CN=CAIRN hab (local)",
    "-addext", `subjectAltName=${san}`,
    "-addext", "extendedKeyUsage=serverAuth",
    "-keyout", key, "-out", cert,
  ], { stdio: "ignore" });
  writeFileSync(stamp, want);
  console.log(`made an HTTPS certificate for localhost${ips.length ? `, ${ips.join(", ")}` : ""}`);
  return { key, cert };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ensureCert();
  console.log(CERT_DIR);
}
