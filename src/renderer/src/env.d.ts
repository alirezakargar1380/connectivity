/// <reference types="vite/client" />
export {};

declare global {
  interface Window {
    api: {
      getProxy(): Promise<boolean>;
      getProxyServer(): Promise<string>;
      getVpn(): Promise;
      getDns(): Promise;
    };
  }
}