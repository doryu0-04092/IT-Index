/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Google Cloud ConsoleでdeveloperがWeb発行するOAuthクライアントID。秘密情報ではない（docs/drive-sync.md §2） */
  readonly VITE_GOOGLE_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
