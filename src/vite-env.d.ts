/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly MY_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}