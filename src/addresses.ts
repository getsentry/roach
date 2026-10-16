/**
 * The addresses that the proxy can send requests to.
 *
 * A run names its own origins (`service.ts`). So without this check, a run
 * could make the service send requests into its own network: to the GCP
 * metadata server, which gives tokens of the VM service account, or to
 * other hosts in the VPC. The proxy sends requests only to public
 * addresses.
 *
 * The check is on the address that the connection uses, after DNS. A host
 * name that resolves to a public address for the check and to a private
 * one for the connection (DNS rebinding) thus does not get through.
 */
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";

/**
 * Addresses that are not on the public internet: this host, private
 * networks, link-local (with the metadata server), shared, documentation,
 * multicast, and reserved ranges. IPv6 forms that hold an IPv4 address
 * (NAT64, 6to4, Teredo) are refused too, because they can lead to a
 * private IPv4 address. `BlockList` checks IPv4-mapped IPv6 addresses,
 * such as `::ffff:127.0.0.1`, as IPv4.
 */
const NOT_PUBLIC = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  NOT_PUBLIC.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  NOT_PUBLIC.addSubnet(network, prefix, "ipv6");
}

/** Check that an IP address is on the public internet. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return !NOT_PUBLIC.check(address, family === 6 ? "ipv6" : "ipv4");
}

/** The error of a request to an address that is not public. */
export const notPublicError = (host: string, address: string) =>
  Object.assign(
    new Error(
      `Roach does not send requests to ${host}, because ${address} is not a public address`,
    ),
    { status: 403, code: "ERR_ROACH_NOT_PUBLIC" },
  );

/**
 * A DNS lookup for `http.request()` that fails when the host has an
 * address that is not public. It checks all addresses of the host, so the
 * choice of the connection does not matter.
 */
export const publicLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) {
      callback(error, "", 0);
      return;
    }
    const blocked = addresses.find(({ address }) => !isPublicAddress(address));
    if (blocked) {
      callback(notPublicError(hostname, blocked.address), "", 0);
      return;
    }
    if (options.all) {
      // The type has only the single-address form of the callback.
      (callback as unknown as (e: null, list: LookupAddress[]) => void)(
        null,
        addresses,
      );
      return;
    }
    callback(null, addresses[0]!.address, addresses[0]!.family);
  });
};
