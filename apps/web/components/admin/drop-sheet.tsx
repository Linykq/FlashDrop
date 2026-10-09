'use client';

import type { AdminDropListing, AdminProductOption, AdminRoom } from '@flashdrop/contracts';
import { useRouter } from 'next/navigation';
import { type FormEvent, type TransitionStartFunction, useId, useState, useTransition } from 'react';
import { createDrop, editDrop } from '../../app/admin/_lib/actions';
import { Banner } from '../ui/banner';
import { Button } from '../ui/button';
import { Sheet } from '../ui/sheet';
import { SelectField, TextField } from '../ui/text-field';
import { toast } from '../ui/toast';
import { AffixField } from './affix-field';
import {
  type DropField,
  type DropFormErrors,
  type DropFormValues,
  initialDropForm,
  serverFieldErrors,
  validateDropForm,
} from './drop-form';

export type DropSheetMode =
  | { kind: 'create'; productId: string | null }
  | { kind: 'edit'; drop: AdminDropListing };

type DropSheetProps = {
  /** `null` while closed. */
  mode: DropSheetMode | null;
  onClose: () => void;
  products: readonly AdminProductOption[];
  rooms: readonly AdminRoom[];
};

/**
 * "New drop" and "Edit drop" (design system §10.8, §9.14): a sheet with the drop's product, room, window,
 * price (typed by the admin, never by the model, SD §3), stock, limit and timings. It checks every field
 * before sending and words each problem under its field; api's refusals land in a banner at the top. A
 * created draft opens its own page, where it can be armed. While a field has changed, a click on the
 * backdrop doesn't close the sheet (§9.14).
 */
export function DropSheet({ mode, onClose, products, rooms }: DropSheetProps) {
  const [pending, startTransition] = useTransition();
  const [dirty, setDirty] = useState(false);
  const formId = useId();
  const editing = mode?.kind === 'edit';

  function close() {
    setDirty(false);
    onClose();
  }

  return (
    <Sheet
      open={mode !== null}
      onClose={close}
      dismissible={!dirty && !pending}
      title={editing ? 'Edit drop' : 'New drop'}
      footer={
        <>
          <Button variant="gray" onClick={close}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={formId}
            loading={pending}
            reserve={editing ? ['Save changes', 'Saving…'] : ['Create draft', 'Creating…']}
          >
            {editing ? (pending ? 'Saving…' : 'Save changes') : pending ? 'Creating…' : 'Create draft'}
          </Button>
        </>
      }
    >
      {mode && (
        <DropForm
          // A new mode is a fresh form: its own initial values, nothing left over from the last one.
          key={mode.kind === 'edit' ? mode.drop.id : `new:${mode.productId ?? ''}`}
          id={formId}
          mode={mode}
          pending={pending}
          startTransition={startTransition}
          onChange={() => setDirty(true)}
          onDone={close}
          products={products}
          rooms={rooms}
        />
      )}
    </Sheet>
  );
}

type DropFormProps = {
  id: string;
  mode: DropSheetMode;
  pending: boolean;
  startTransition: TransitionStartFunction;
  onChange: () => void;
  onDone: () => void;
  products: readonly AdminProductOption[];
  rooms: readonly AdminRoom[];
};

function DropForm({ id, mode, pending, startTransition, onChange, onDone, products, rooms }: DropFormProps) {
  const router = useRouter();
  const [values, setValues] = useState<DropFormValues>(() =>
    initialDropForm(mode.kind === 'edit' ? mode.drop : { productId: mode.productId }, Date.now()),
  );
  const [errors, setErrors] = useState<DropFormErrors>({});
  const [failure, setFailure] = useState<string | null>(null);

  const field = (name: DropField) => ({
    id: `${id}-${name}`,
    name,
    value: values[name],
    error: errors[name],
    onChange: (event: { currentTarget: { value: string } }) => {
      const value = event.currentTarget.value;
      setValues((current) => ({ ...current, [name]: value }));
      // A field the admin is fixing stops shouting at once; the others keep their messages until the next try.
      setErrors((current) => (current[name] ? { ...current, [name]: undefined } : current));
      onChange();
    },
  });

  const openDropId = products.find((product) => product.id === values.productId)?.openDropId ?? null;
  const openElsewhere = openDropId !== null && !(mode.kind === 'edit' && openDropId === mode.drop.id);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = event.currentTarget;
    const result = validateDropForm(values);
    if (!result.ok) {
      setErrors(result.errors);
      setFailure(null);
      focusFirstError(form);
      return;
    }
    startTransition(async () => {
      const outcome =
        mode.kind === 'edit' ? await editDrop(mode.drop.id, result.body) : await createDrop(result.body);
      if (!outcome.ok) {
        setErrors(serverFieldErrors(outcome.failure.fields));
        setFailure(outcome.failure.message);
        return;
      }
      onDone();
      if (mode.kind === 'edit') {
        toast({ message: 'Changes saved.' });
        return;
      }
      toast({ message: 'Draft created.' });
      router.push(`/admin/drops/${outcome.value.id}`);
    });
  }

  return (
    <form
      id={id}
      noValidate
      aria-busy={pending || undefined}
      onSubmit={submit}
      className="flex flex-col gap-4 pt-2"
    >
      {failure && (
        <Banner tone="danger" alert>
          {failure}
        </Banner>
      )}
      <SelectField
        {...field('productId')}
        label="Product"
        required
        helper={
          openElsewhere
            ? 'This product has an open drop. You can arm this one once that one ends.'
            : undefined
        }
      >
        <option value="" disabled>
          Choose a product
        </option>
        {products.map((product) => (
          <option key={product.id} value={product.id}>
            {product.title}
          </option>
        ))}
      </SelectField>
      <SelectField {...field('roomId')} label="Live room" helper="Optional. Buyers can watch it sell there.">
        <option value="">None</option>
        {rooms.map((room) => (
          <option key={room.id} value={room.id}>
            {room.title}
          </option>
        ))}
      </SelectField>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField {...field('startsAt')} label="Starts" type="datetime-local" required />
        <TextField {...field('endsAt')} label="Ends" type="datetime-local" required />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <AffixField
          {...field('price')}
          label="Price"
          prefix="$"
          inputMode="decimal"
          autoComplete="off"
          required
          helper="Buyers pay this. A listing never sets it."
        />
        <AffixField
          {...field('stock')}
          label="Total units"
          suffix="units"
          inputMode="numeric"
          autoComplete="off"
          required
        />
      </div>
      <SelectField {...field('perUserLimit')} label="Limit per person">
        {Array.from({ length: 10 }, (_, index) => String(index + 1)).map((limit) => (
          <option key={limit} value={limit}>
            {limit}
          </option>
        ))}
      </SelectField>
      <div className="grid gap-4 sm:grid-cols-2">
        <AffixField
          {...field('holdSeconds')}
          label="Hold at checkout"
          suffix="seconds"
          inputMode="numeric"
          autoComplete="off"
          helper="10 to 900. Buyers can add 60 seconds once."
        />
        <AffixField
          {...field('paymentSeconds')}
          label="Payment window"
          suffix="seconds"
          inputMode="numeric"
          autoComplete="off"
          helper="10 to 1,800."
        />
      </div>
    </form>
  );
}

/** After a failed check, focus goes to the first field with a problem, in document order. */
function focusFirstError(form: HTMLFormElement): void {
  // The fields are marked invalid in the render this state change starts.
  requestAnimationFrame(() => form.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
}
