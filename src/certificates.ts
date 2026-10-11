/**
 * The certificate authority of Roach.
 *
 * The proxy intercepts HTTPS. It signs one certificate for each host when a
 * client first connects to that host, and signs it again before it
 * expires. Clients must trust the authority certificate. The service loads
 * a fixed one, so that clients can trust it across restarts.
 */
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import tls from "node:tls";

function openssl(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("openssl", args, (error, _stdout, stderr) => {
      if (error)
        reject(new Error(`openssl failed: ${stderr || error.message}`));
      else resolve();
    });
  });
}

/** A certificate authority that signs a certificate for each host. */
export interface CertificateAuthority {
  /** The PEM certificate that clients must trust. */
  caCert: string;
  /** The TLS context for a host. Signs its certificate on first use. */
  contextFor(host: string): Promise<tls.SecureContext>;
  /** Delete the keys and certificates. */
  close(): Promise<void>;
}

/** A PEM certificate authority, such as the one of a deployed service. */
export interface CertificateAuthorityPem {
  cert: string;
  key: string;
}

/** Days that a host certificate is valid. */
const HOST_DAYS = 7;
/** Sign a host again when its certificate is older than this. */
const RESIGN_MS = (HOST_DAYS - 1) * 24 * 60 * 60 * 1000;

/**
 * Create a certificate authority in a new temporary directory. Without
 * `pem`, it creates a new authority that is valid for 7 days.
 */
export async function createCertificateAuthority(
  pem?: CertificateAuthorityPem,
): Promise<CertificateAuthority> {
  const directory = await mkdtemp(path.join(tmpdir(), "roach-ca-"));
  const caKey = path.join(directory, "ca.key");
  const caCertFile = path.join(directory, "ca.crt");
  const hostKey = path.join(directory, "host.key");
  if (pem) {
    await writeFile(caKey, pem.key, { mode: 0o600 });
    await writeFile(caCertFile, pem.cert);
  } else {
    await createAuthority(caKey, caCertFile);
  }
  // All hosts share one key. Only their certificates differ.
  await openssl(["genrsa", "-out", hostKey, "2048"]);
  const hostKeyPem = await readFile(hostKey, "utf8");
  const contexts = new Map<
    string,
    { signed: number; context: Promise<tls.SecureContext> }
  >();

  const sign = async (host: string): Promise<tls.SecureContext> => {
    const name = createHash("sha256").update(host).digest("hex").slice(0, 16);
    const csr = path.join(directory, `${name}.csr`);
    const extensions = path.join(directory, `${name}.ext`);
    const cert = path.join(directory, `${name}.crt`);
    const bare = host.replace(/^\[|\]$/g, "");
    const altName = isIP(bare) ? `IP:${bare}` : `DNS:${host}`;
    await writeFile(
      extensions,
      `subjectAltName=${altName}\nextendedKeyUsage=serverAuth\n`,
    );
    await openssl([
      "req",
      "-new",
      "-key",
      hostKey,
      "-subj",
      "/CN=Roach host",
      "-out",
      csr,
    ]);
    await openssl([
      "x509",
      "-req",
      "-in",
      csr,
      "-CA",
      caCertFile,
      "-CAkey",
      caKey,
      "-set_serial",
      `0x${randomBytes(8).toString("hex")}`,
      "-days",
      String(HOST_DAYS),
      "-extfile",
      extensions,
      "-out",
      cert,
    ]);
    return tls.createSecureContext({
      cert: await readFile(cert, "utf8"),
      key: hostKeyPem,
    });
  };

  return {
    caCert: await readFile(caCertFile, "utf8"),
    contextFor(host) {
      const now = Date.now();
      let entry = contexts.get(host);
      if (!entry || now - entry.signed > RESIGN_MS) {
        const fresh = { signed: now, context: sign(host) };
        // A failed signature must not stay in the cache.
        fresh.context.catch(() => {
          if (contexts.get(host) === fresh) contexts.delete(host);
        });
        contexts.set(host, fresh);
        entry = fresh;
      }
      return entry.context;
    },
    close: () => rm(directory, { force: true, recursive: true }),
  };
}

/** Create a new authority that is valid for 7 days. */
async function createAuthority(caKey: string, caCertFile: string) {
  await openssl([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    caKey,
    "-out",
    caCertFile,
    "-days",
    "7",
    "-subj",
    "/CN=Roach CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
  ]);
}
