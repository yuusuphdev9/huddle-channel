declare module '*.module.css' {
  const classes: { [key: string]: string };
  export default classes;
}

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_LOGIN_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

