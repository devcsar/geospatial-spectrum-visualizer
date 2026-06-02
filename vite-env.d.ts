/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PROTOMAPS_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module '*.glsl' {
  const src: string;
  export default src;
}

declare module '*.vert.glsl' {
  const src: string;
  export default src;
}

declare module '*.frag.glsl' {
  const src: string;
  export default src;
}
