import type { LucideIcon } from 'lucide-react';
import { type Ref, useId } from 'react';
import { ButtonLink } from '../ui/button';

type OutcomeCardProps = {
  icon: LucideIcon;
  title: string;
  description: string;
  action: { href: string; label: string };
  /**
   * Set when the outcome replaced the hold while the buyer watched: the heading takes focus (SD §8.3,
   * design-system §13.2), and that one focus event reads it with its description. No alert role as well: a
   * region inserted with its text and focused at once would be read twice (§13.3). A page that loads in this
   * state reads in order instead.
   */
  headingRef?: Ref<HTMLHeadingElement>;
};

/**
 * One card that says how a reservation ended and what to do next (design-system §10.4): the glyph in a 72 px
 * circle, the heading, one sentence and one filled action. Calm and neutral: an ending is nobody's error.
 */
export function OutcomeCard({ icon: Icon, title, description, action, headingRef }: OutcomeCardProps) {
  const descriptionId = useId();
  return (
    <section className="flex flex-col items-center rounded-lg bg-surface px-5 py-10 text-center elevation-1 sm:px-6 sm:py-12">
      <span className="grid size-18 place-items-center rounded-full bg-fill-tertiary text-label-secondary">
        <Icon size={40} strokeWidth={1.5} />
      </span>
      <h2
        ref={headingRef}
        tabIndex={headingRef ? -1 : undefined}
        aria-describedby={descriptionId}
        className="mt-5 text-title-2 outline-none"
      >
        {title}
      </h2>
      <p id={descriptionId} className="mt-2 max-w-100 text-body text-label-secondary">
        {description}
      </p>
      <ButtonLink href={action.href} size="lg" className="mt-8">
        {action.label}
      </ButtonLink>
    </section>
  );
}
