/**
 * The first focusable element on every page (§9.25): visually hidden until focused, then a filled sm button
 * in the top-left corner. Its target is the page's <main id="main">.
 */
export function SkipLink({
  label = 'Skip to content',
  target = 'main',
}: {
  label?: string;
  target?: string;
}) {
  return (
    <a
      href={`#${target}`}
      className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-(--z-skip-link) focus:inline-flex focus:h-8 focus:items-center focus:rounded-full focus:bg-accent focus:px-3 focus:text-footnote focus:font-medium focus:text-label-on-color"
    >
      {label}
    </a>
  );
}
