/**
 * `@metamask/jazzicon` ships no type declarations, so importing it was an
 * implicit-any error under `noImplicitAny`. It has exactly one export.
 */
declare module "@metamask/jazzicon" {
  /** Renders a deterministic identicon for `seed` at `diameter` px. */
  export default function jazzicon(diameter: number, seed: number): HTMLElement;
}
