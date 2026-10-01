import { X509Certificate } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveSystemBin } from "../infra/resolve-system-bin.js";
import { ensureSecretEgressProxyCa, generateLocalProxyLeaf } from "./ca.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const opensslAvailable = Boolean(resolveSystemBin("openssl"));

describe.skipIf(!opensslAvailable)("generateLocalProxyLeaf", () => {
  it.each([
    { hostname: "api.example.com", kind: "DNS" },
    // Valid DNS name whose full length exceeds the X.520 Common Name limit.
    { hostname: `${"a".repeat(58)}.run.app`, kind: "DNS" },
    { hostname: "127.0.0.1", kind: "IP" },
  ] as const)("generates a valid leaf for $kind host $hostname", async ({ hostname, kind }) => {
    const certDir = tempDirs.make("openclaw-proxy-leaf-");
    const ca = await ensureSecretEgressProxyCa(certDir);

    const leaf = await generateLocalProxyLeaf({ certDir, ca, hostname });
    const certificate = new X509Certificate(leaf.cert);

    expect(certificate.subjectAltName).toContain(hostname);
    expect(kind === "IP" ? certificate.checkIP(hostname) : certificate.checkHost(hostname)).toBe(
      hostname,
    );
  });
});
