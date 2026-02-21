/**
 * Stub for https-proxy-agent when the package or its types are not installed.
 * Used so plugin-sdk dts build passes; at runtime the package is a normal dependency.
 */
declare module "https-proxy-agent" {
  export class HttpsProxyAgent {
    constructor(proxy: string | URL);
  }
}
