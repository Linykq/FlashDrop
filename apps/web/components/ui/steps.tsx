import { CircleCheck, LoaderCircle } from 'lucide-react';
import { cx } from '../../lib/cx';

export type StepState = 'done' | 'current' | 'running' | 'upcoming';

/**
 * Progress through a fixed sequence (§9.26), as an ordered list: vertical on phones with 24 px between steps,
 * horizontal from 735 px with the connectors stretching between. Markers differ in shape, so colour is never
 * the only signal: a check when done, an accent ring (or a spinner while the step runs) when current, a thin
 * ring when upcoming. The current step is `aria-current="step"`; done steps end with a hidden ", done".
 */
export function Steps({
  steps,
  label,
}: {
  steps: readonly { label: string; state: StepState }[];
  label: string;
}) {
  return (
    <ol aria-label={label} className="flex flex-col gap-6 sm:flex-row sm:items-center sm:gap-3">
      {steps.map((step, index) => {
        const last = index === steps.length - 1;
        return (
          <li
            key={step.label}
            aria-current={step.state === 'current' || step.state === 'running' ? 'step' : undefined}
            className={cx('relative flex items-center gap-2 text-footnote', !last && 'sm:flex-1')}
          >
            <Marker state={step.state} />
            <span
              className={cx('shrink-0', step.state === 'upcoming' ? 'text-label-secondary' : 'text-label')}
            >
              {step.label}
              {step.state === 'done' && <span className="sr-only">, done</span>}
            </span>
            {!last && (
              // Between this marker and the next: down to it on phones, across to it from 735 px.
              <span
                aria-hidden="true"
                className="absolute top-5 left-1.75 h-5 w-0.5 rounded-full bg-separator sm:static sm:ml-1 sm:h-0.5 sm:w-auto sm:flex-1"
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

function Marker({ state }: { state: StepState }) {
  return (
    <span aria-hidden="true" className="grid size-4 shrink-0 place-items-center">
      {state === 'done' && <CircleCheck size={16} className="text-label" />}
      {state === 'running' && <LoaderCircle size={16} className="animate-spin text-accent-label" />}
      {state === 'current' && <span className="size-3 rounded-full border-2 border-accent" />}
      {state === 'upcoming' && <span className="size-3 rounded-full border border-control" />}
    </span>
  );
}
