import fs from "node:fs";
import path from "node:path";
import { X509Certificate } from "node:crypto";
import type { ServerOptions } from "node:https";

export type TlsMode = "auto" | "custom" | "off";

export function getTlsMode(): TlsMode {
  const mode = (process.env.DRAM_TLS || "off").toLowerCase();
  if (mode === "auto" || mode === "custom") return mode;
  return "off";
}

function isCertExpiringSoon(pem: string, thresholdDays = 30): boolean {
  try {
    const cert = new X509Certificate(pem);
    const expiresAt = new Date(cert.validTo);
    const daysLeft =
      (expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    return daysLeft < thresholdDays;
  } catch {
    return true;
  }
}

async function generateSelfSigned(
  certsDir: string
): Promise<{ cert: string; key: string }> {
  const { generate } = await import("selfsigned");

  const attrs = [{ name: "commonName", value: "dram-server" }];
  const pems = await generate(attrs, {
    keySize: 2048,
    algorithm: "sha256",
    extensions: [
      {
        name: "subjectAltName",
        altNames: [
          { type: 2, value: "localhost" },
          { type: 7, ip: "127.0.0.1" },
          { type: 7, ip: "::1" },
        ],
      },
    ],
  });

  fs.mkdirSync(certsDir, { recursive: true });
  fs.writeFileSync(path.join(certsDir, "cert.pem"), pems.cert, {
    mode: 0o644,
  });
  fs.writeFileSync(path.join(certsDir, "key.pem"), pems.private, {
    mode: 0o600,
  });

  return { cert: pems.cert, key: pems.private };
}

export async function loadTlsOptions(
  rootDir: string
): Promise<ServerOptions | null> {
  const mode = getTlsMode();
  if (mode === "off") return null;

  if (mode === "custom") {
    const certPath = process.env.DRAM_TLS_CERT;
    const keyPath = process.env.DRAM_TLS_KEY;
    if (!certPath || !keyPath) {
      throw new Error(
        "DRAM_TLS=custom requires DRAM_TLS_CERT and DRAM_TLS_KEY"
      );
    }
    if (!fs.existsSync(certPath))
      throw new Error(`TLS certificate not found: ${certPath}`);
    if (!fs.existsSync(keyPath))
      throw new Error(`TLS private key not found: ${keyPath}`);

    return {
      cert: fs.readFileSync(certPath, "utf-8"),
      key: fs.readFileSync(keyPath, "utf-8"),
    };
  }

  // auto mode — load cached cert or generate a new one
  const certsDir = process.env.DRAM_TLS_DIR || path.join(rootDir, "certs");
  const certPath = path.join(certsDir, "cert.pem");
  const keyPath = path.join(certsDir, "key.pem");

  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    const certPem = fs.readFileSync(certPath, "utf-8");
    if (!isCertExpiringSoon(certPem)) {
      return {
        cert: certPem,
        key: fs.readFileSync(keyPath, "utf-8"),
      };
    }
    process.stderr.write(
      "dram: TLS certificate expiring soon, regenerating\n"
    );
  }

  process.stderr.write(
    `dram: generating self-signed TLS certificate in ${certsDir}\n`
  );
  const { cert, key } = await generateSelfSigned(certsDir);
  return { cert, key };
}
