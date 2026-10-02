'use client';

import { ChevronRight, Layers, Volume2, VolumeX, WifiOff } from 'lucide-react';
import { useState } from 'react';
import { AlertDialog } from '../../../../components/ui/alert-dialog';
import { Banner } from '../../../../components/ui/banner';
import { Button } from '../../../../components/ui/button';
import { IconButton } from '../../../../components/ui/icon-button';
import { QuantityStepper } from '../../../../components/ui/quantity-stepper';
import { SegmentedControl } from '../../../../components/ui/segmented-control';
import { Sheet } from '../../../../components/ui/sheet';
import { toast } from '../../../../components/ui/toast';

/*
 * The stateful specimens of the component gallery. Nothing here talks to api: the Buy button only previews
 * its states.
 */

export function SegmentedDemo() {
  const [filter, setFilter] = useState<'live' | 'scheduled' | 'all'>('live');
  return (
    <SegmentedControl
      legend="Show drops"
      value={filter}
      onChange={setFilter}
      options={[
        { value: 'live', label: 'Live' },
        { value: 'scheduled', label: 'Scheduled' },
        { value: 'all', label: 'All' },
      ]}
      className="w-full max-w-90"
    />
  );
}

export function StepperDemo({ max, size }: { max: number; size?: 'md' | 'lg' }) {
  const [quantity, setQuantity] = useState(1);
  return <QuantityStepper value={quantity} max={max} size={size} onChange={setQuantity} />;
}

type BuyState = 'idle' | 'reserving' | 'reserved';

/** The drop card's purchase row: stepper and Buy, previewing the in-flight and confirmed labels. */
export function PurchaseRow({ max, disabledLabel }: { max: number; disabledLabel?: string }) {
  const [quantity, setQuantity] = useState(1);
  const [state, setState] = useState<BuyState>('idle');

  function buy() {
    setState('reserving');
    setTimeout(() => setState('reserved'), 1600);
    setTimeout(() => setState('idle'), 3200);
  }

  const label =
    disabledLabel ??
    { idle: quantity > 1 ? `Buy ${quantity}` : 'Buy', reserving: 'Reserving…', reserved: 'Reserved' }[state];

  return (
    <>
      <QuantityStepper value={quantity} max={max} size="lg" onChange={setQuantity} />
      <Button
        size="lg"
        className="flex-1"
        disabled={disabledLabel !== undefined}
        loading={state === 'reserving'}
        reserve={['Buy 2', 'Reserving…', 'Reserved']}
        onClick={buy}
      >
        {label}
      </Button>
    </>
  );
}

export function MuteToggle() {
  const [muted, setMuted] = useState(true);
  return (
    <IconButton
      label="Mute"
      icon={muted ? VolumeX : Volume2}
      variant="overlay"
      pressed={muted}
      onClick={() => setMuted(!muted)}
    />
  );
}

export function ToastDemo() {
  return (
    <div className="flex flex-wrap gap-3">
      <Button variant="gray" onClick={() => toast({ message: 'Published.' })}>
        Success toast
      </Button>
      <Button variant="gray" onClick={() => toast({ message: 'Order id copied.', tone: 'info' })}>
        Info toast
      </Button>
      <Button
        variant="gray"
        onClick={() =>
          toast({
            message: '1 minute added',
            action: {
              label: 'View order',
              onAction: () => toast({ message: 'Order opened.', tone: 'info' }),
            },
          })
        }
      >
        Toast with action
      </Button>
    </div>
  );
}

export function DismissibleBanner() {
  const [visible, setVisible] = useState(true);
  if (!visible) {
    return (
      <Button variant="plain" size="sm" onClick={() => setVisible(true)}>
        Show the banner again
      </Button>
    );
  }
  return (
    <Banner tone="info" icon={WifiOff} title="Live updates paused" onDismiss={() => setVisible(false)}>
      This page updates again when the connection returns.
    </Banner>
  );
}

export function DialogDemo() {
  const [dialog, setDialog] = useState<'leave' | 'arm' | null>(null);
  const close = () => setDialog(null);
  return (
    <div className="flex flex-wrap gap-3">
      <Button variant="tinted" tone="destructive" onClick={() => setDialog('leave')}>
        Leave checkout
      </Button>
      <Button variant="gray" onClick={() => setDialog('arm')}>
        Arm drop
      </Button>

      <AlertDialog
        open={dialog === 'leave'}
        onCancel={close}
        title="Leave checkout?"
        description="Your reservation will be released."
      >
        <Button shape="rounded" data-autofocus onClick={close}>
          Stay
        </Button>
        <Button variant="plain" tone="destructive" shape="rounded" onClick={close}>
          Leave
        </Button>
      </AlertDialog>

      <AlertDialog
        open={dialog === 'arm'}
        onCancel={close}
        title="Arm this drop?"
        description="You can't edit it after arming. It opens Tue, Oct 6 at 7:00 PM."
      >
        <Button shape="rounded" onClick={close}>
          Arm drop
        </Button>
        <Button variant="gray" shape="rounded" data-autofocus onClick={close}>
          Cancel
        </Button>
      </AlertDialog>
    </div>
  );
}

export function SheetDemo() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="gray" icon={Layers} onClick={() => setOpen(true)}>
        New drop
      </Button>
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title="New drop"
        footer={
          <>
            <Button variant="gray" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => setOpen(false)}>Create drop</Button>
          </>
        }
      >
        <div className="flex flex-col gap-4 text-body">
          <p>
            A drop sells a fixed number of units of one published product, from its start time until it sells
            out or ends.
          </p>
          <p className="text-label-secondary">
            Below 735 px this is a bottom sheet: drag it down by its header, press Esc or tap outside to close
            it. From 735 px it is a centred dialog.
          </p>
          {['Product', 'Units', 'Price', 'Limit per person', 'Starts', 'Ends'].map((field) => (
            <div key={field} className="flex items-center justify-between border-separator border-b py-3">
              <span>{field}</span>
              <ChevronRight size={16} className="text-label-tertiary" />
            </div>
          ))}
        </div>
      </Sheet>
    </>
  );
}
