/// <reference types="vite/client" />
export {};

declare global {
  interface Window {
    api: {
      getProxy(): Promise<string>;
    };
  }
}