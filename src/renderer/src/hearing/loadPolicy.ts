export function shouldKeepPendingRecord(previousPath: string | undefined, nextPath: string): boolean {
  return previousPath === undefined || previousPath === nextPath
}
