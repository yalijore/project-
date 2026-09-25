// Tests run on Node; the app's tsconfig deliberately has no Node types. This is the one
// Node API a test uses (reading an end-to-end fixture).
declare module 'node:fs' {
  export function readFileSync(path: URL | string): Uint8Array;
}
