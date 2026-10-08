import { Socket } from "node:net";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";

// Pure tests must inject I/O. Fail rather than accidentally using host credentials/network.
const denied = () => {
  throw new Error("PURE_TEST_NETWORK_FORBIDDEN");
};
globalThis.fetch = denied;
Socket.prototype.connect = denied;
dns.lookup = denied;
dnsPromises.lookup = denied;
syncBuiltinESMExports();
