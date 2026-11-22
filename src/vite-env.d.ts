/// <reference types="vite/client" />

declare const Deno: {
  env: {
    get(key: string): string | undefined;
  };
};
