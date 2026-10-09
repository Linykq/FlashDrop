'use client';

import type { AdminDropAction, AdminDropListing, DropStatus } from '@flashdrop/contracts';
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore, useTransition } from 'react';
import { runDropAction } from '../../app/admin/_lib/actions';
import { focusPageStart } from '../../lib/focus';
import { AlertDialog } from '../ui/alert-dialog';
import { Button } from '../ui/button';
import { toast } from '../ui/toast';
import { AdminTime } from './admin-time';
import type { ActionFailure } from './problem-copy';

/** An ended drop stays tracked (reconcilable) for 24 h after its end (SD §4.1). */
const TRACKED_AFTER_END_MS = 24 * 60 * 60 * 1000;

type Confirmable = 'arm' | 'end' | 'reconcile';

/** One filled action at most; the rest gray, and "End drop" destructive tinted (§10.8). */
type ActionStyle = { variant: 'filled' } | { variant: 'gray' } | { variant: 'tinted'; tone: 'destructive' };

const isConfirmable = (action: AdminDropAction): action is Confirmable =>
  action === 'arm' || action === 'end' || action === 'reconcile';

/** The actions the dashboard offers beside its numbers: the ones a running sale needs (§10.10). */
export const SALE_ACTIONS: readonly AdminDropAction[] = ['pause', 'resume', 'end'];

const DONE: Readonly<Record<AdminDropAction, string>> = {
  arm: 'Drop armed.',
  pause: 'Drop paused.',
  resume: 'Drop resumed.',
  end: 'Drop ended.',
  reconcile: 'Live stock rebuilt.',
};

const RUNNING: Readonly<Record<AdminDropAction, string>> = {
  arm: 'Arming…',
  pause: 'Pausing…',
  resume: 'Resuming…',
  end: 'Ending…',
  reconcile: 'Rebuilding…',
};

const subscribeNever = () => () => {};

/** Whether an ended drop can still be reconciled; the client's clock is good enough for offering it. */
function useTracked(endsAt: string): boolean {
  return useSyncExternalStore(
    subscribeNever,
    () => Date.now() < Date.parse(endsAt) + TRACKED_AFTER_END_MS,
    () => true,
  );
}

/**
 * The drop's actions (design system §10.8): only the ones its status allows, at most three, one filled.
 * Arming, ending and reconciling confirm in an alert dialog first (§9.14, §12.2); pausing and resuming act at
 * once. A scheduled drop can be held or cancelled before it opens (api allows pause and end from SCHEDULED), so
 * a drop armed with a mistake never has to open to be stopped; cancelling it is the same `end`, worded as what
 * it means before the start. An ended drop can be run again in a new draft. api decides what is legal and
 * serializes every action on the drop lock, so a refusal (409 `DROP_ARMED`, `DROP_BUSY`, a status that changed)
 * is reported as it is, for the page's banner.
 */
export function DropActions({
  drop,
  onEdit,
  onRunAgain,
  only,
  saleWording = false,
  onFailure,
}: {
  drop: Pick<AdminDropListing, 'id' | 'status' | 'startsAt' | 'endsAt'>;
  /** "Edit" on a draft; left out where the page can't edit (the dashboard). */
  onEdit?: () => void;
  /** "Run again" on an ended drop; left out where the page can't open the sheet. */
  onRunAgain?: () => void;
  /** Offer only these (the dashboard's `SALE_ACTIONS`); every legal one by default. */
  only?: readonly AdminDropAction[];
  /**
   * "Pause sale" and "Resume sale": on the dashboard they sit beside "Pause updates", which pauses only the
   * view, and the two must never be mistaken for each other.
   */
  saleWording?: boolean;
  /** Each run reports its refusal, or `null` as it starts, which clears the last one. */
  onFailure: (failure: ActionFailure | null) => void;
}) {
  const [confirming, setConfirming] = useState<Confirmable | null>(null);
  const [running, setRunning] = useState<AdminDropAction | null>(null);
  const [, startTransition] = useTransition();
  const tracked = useTracked(drop.endsAt);
  const busy = running !== null;
  // The status an action moved the drop away from, until the page shows its new status.
  const movedFrom = useRef<DropStatus | null>(null);

  function run(action: AdminDropAction) {
    if (busy) return;
    setRunning(action);
    onFailure(null);
    startTransition(async () => {
      const result = await runDropAction(drop.id, action);
      setRunning(null);
      setConfirming(null);
      if (result.ok) {
        toast({ message: action === 'end' && scheduled ? 'Drop cancelled.' : DONE[action] });
        if (action !== 'reconcile') movedFrom.current = drop.status;
      } else {
        onFailure(result.failure);
      }
    });
  }

  // A new status brings another set of actions: arming or ending replaces the buttons, so the one that had
  // focus, or the one the closing dialog hands focus back to, is gone and focus falls to <body>. Once the
  // new status shows and no dialog is open, focus goes to the first action, or to the title when none is left.
  useEffect(() => {
    if (movedFrom.current === null || movedFrom.current === drop.status || confirming !== null) return;
    movedFrom.current = null;
    if (document.activeElement === null || document.activeElement === document.body) focusPageStart();
  }, [drop.status, confirming]);

  // Adaptive: three md pills wrapped on a 390 px phone, leaving "End drop" alone on a row of its own.
  const button = (action: AdminDropAction, label: string, style: ActionStyle = { variant: 'gray' }) =>
    (only === undefined || only.includes(action)) && (
      <Button
        {...style}
        size="adaptive"
        loading={running === action}
        disabled={busy && running !== action}
        reserve={[label, RUNNING[action]]}
        onClick={() => (isConfirmable(action) ? setConfirming(action) : run(action))}
      >
        {running === action ? RUNNING[action] : label}
      </Button>
    );
  const scheduled = drop.status === 'SCHEDULED';

  let actions: ReactNode;
  switch (drop.status) {
    case 'DRAFT':
      actions = (
        <>
          {button('arm', 'Arm drop', { variant: 'filled' })}
          {onEdit && (
            <Button variant="gray" size="adaptive" disabled={busy} onClick={onEdit}>
              Edit
            </Button>
          )}
        </>
      );
      break;
    case 'SCHEDULED':
      actions = (
        <>
          {button('pause', 'Pause')}
          {button('reconcile', 'Reconcile')}
          {button('end', 'Cancel drop', { variant: 'tinted', tone: 'destructive' })}
        </>
      );
      break;
    case 'LIVE':
      actions = (
        <>
          {button('pause', saleWording ? 'Pause sale' : 'Pause')}
          {button('reconcile', 'Reconcile')}
          {button('end', 'End drop', { variant: 'tinted', tone: 'destructive' })}
        </>
      );
      break;
    case 'PAUSED':
      actions = (
        <>
          {button('resume', saleWording ? 'Resume sale' : 'Resume', { variant: 'filled' })}
          {button('reconcile', 'Reconcile')}
          {button('end', 'End drop', { variant: 'tinted', tone: 'destructive' })}
        </>
      );
      break;
    case 'ENDED':
      actions = (
        <>
          {onRunAgain && only === undefined && (
            <Button variant="gray" size="adaptive" disabled={busy} onClick={onRunAgain}>
              Run again
            </Button>
          )}
          {tracked && button('reconcile', 'Reconcile')}
        </>
      );
      break;
  }

  const cancel = () => {
    if (!busy) setConfirming(null);
  };

  return (
    <>
      {actions}
      <AlertDialog
        open={confirming === 'arm'}
        onCancel={cancel}
        title="Arm this drop?"
        description={
          <p>
            You can't edit it after arming. It opens <AdminTime iso={drop.startsAt} format="at" />.
          </p>
        }
      >
        <Button
          shape="rounded"
          loading={running === 'arm'}
          reserve={['Arm drop', RUNNING.arm]}
          onClick={() => run('arm')}
        >
          {running === 'arm' ? RUNNING.arm : 'Arm drop'}
        </Button>
        <Button variant="gray" shape="rounded" data-autofocus disabled={busy} onClick={cancel}>
          Cancel
        </Button>
      </AlertDialog>
      <AlertDialog
        open={confirming === 'end'}
        onCancel={cancel}
        title={scheduled ? 'Cancel this drop?' : 'End this drop now?'}
        description={
          scheduled ? (
            <p>It won't open, and you can't undo this.</p>
          ) : (
            <p>Buyers can't reserve after it ends. Reservations already made can still check out.</p>
          )
        }
      >
        <Button shape="rounded" data-autofocus disabled={busy} onClick={cancel}>
          {scheduled ? 'Keep drop' : 'Cancel'}
        </Button>
        <Button
          variant="plain"
          tone="destructive"
          shape="rounded"
          loading={running === 'end'}
          reserve={[scheduled ? 'Cancel drop' : 'End drop', RUNNING.end]}
          onClick={() => run('end')}
        >
          {running === 'end' ? RUNNING.end : scheduled ? 'Cancel drop' : 'End drop'}
        </Button>
      </AlertDialog>
      <AlertDialog
        open={confirming === 'reconcile'}
        onCancel={cancel}
        title="Rebuild live stock?"
        description={
          <p>
            We'll rebuild this drop's live stock from the database. Buyers may be asked to try again for 1–3
            seconds.
          </p>
        }
      >
        <Button
          shape="rounded"
          loading={running === 'reconcile'}
          reserve={['Rebuild', RUNNING.reconcile]}
          onClick={() => run('reconcile')}
        >
          {running === 'reconcile' ? RUNNING.reconcile : 'Rebuild'}
        </Button>
        <Button variant="gray" shape="rounded" data-autofocus disabled={busy} onClick={cancel}>
          Cancel
        </Button>
      </AlertDialog>
    </>
  );
}
