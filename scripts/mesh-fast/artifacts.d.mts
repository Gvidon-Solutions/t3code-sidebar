import type { Ownership } from "./lifecycle.mjs";
export function prunePassed(directory: string): Promise<void>;
export function pruneRuns(base: string, current: Ownership): Promise<string[]>;
export function finishRun(directory: string, current: Ownership, failed: boolean): Promise<string>;
