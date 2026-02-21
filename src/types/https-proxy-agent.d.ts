/**
 * Stub for https-proxy-agent when the package or its types are not installed.
 * Used so plugin-sdk dts build passes; at runtime the package is a normal dependency.
 */
import type { Agent } from "node:http";
declare module "https-proxy-agent" {
  export class HttpsProxyAgent<RequestOptions = unknown> extends Agent {
    constructor(proxy: string | URL);
  }
}
