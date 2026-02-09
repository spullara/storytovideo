/**
 * Shared signal state to avoid circular dependency between cli.ts and orchestrator.ts
 */

export let interrupted = false;

export function setInterrupted(value: boolean): void {
  interrupted = value;
}

