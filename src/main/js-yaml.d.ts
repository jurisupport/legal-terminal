declare module 'js-yaml' {
  export const JSON_SCHEMA: object
  export function load(input: string, options?: {schema?: object}): unknown
  export function dump(input: unknown, options?: {noRefs?: boolean; lineWidth?: number}): string
}
