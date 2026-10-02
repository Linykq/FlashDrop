import { Fragment } from 'react';

/**
 * A product title in any heading: page titles, tiles and cards (§3.2). Browsers may wrap after a hyphen, which
 * splits words like "Over-Ear" across lines ("Over-" / "Ear"); hyphenated words are kept whole instead. The
 * text content is unchanged, so copying, search and screen readers see the title as written.
 */
export function TitleText({ text }: { text: string }) {
  // Index keys are stable: the parts of one fixed string never reorder.
  return text.split(/(\s+)/).map((part, index) =>
    part.includes('-') ? (
      <span key={index} className="whitespace-nowrap">
        {part}
      </span>
    ) : (
      <Fragment key={index}>{part}</Fragment>
    ),
  );
}
