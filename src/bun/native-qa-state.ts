// Set only by the guarded build's bootstrap, never from a parent env flag.
let root: string | undefined;
export function enableNativeQa(value: string): void { root = value; }
export function nativeQaRoot(): string | undefined { return root; }
