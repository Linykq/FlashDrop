'use client';

import { CreateListingResponse, LISTING_UPLOAD_LIMITS } from '@flashdrop/contracts';
import { CircleAlert, ImageUp, Sparkles, Trash, TriangleAlert } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { type DragEvent, useEffect, useId, useRef, useState } from 'react';
import { cx } from '../../lib/cx';
import { announce } from '../ui/announcer';
import { Banner } from '../ui/banner';
import { Button } from '../ui/button';
import { IconButton } from '../ui/icon-button';
import { addFiles, choiceAnnouncement, resolutionNote, uploadFailure } from './listing-upload';
import { ProgressBar } from './progress-bar';
import { TextAreaField } from './text-area-field';

/** A chosen photo, its thumbnail's object URL, and once the thumbnail decoded, whether it is too small. */
type Chosen = { file: File; url: string; note?: string | null };

type UploadState =
  | { kind: 'idle' }
  | { kind: 'uploading'; percent: number }
  | { kind: 'failed'; message: string; warning: boolean };

const ACCEPT = 'image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp';

/**
 * Sends the photos and hints as multipart with `XMLHttpRequest`, the one browser API with upload progress
 * events (design system §10.9). Resolves with api's status and parsed body; status 0 when it never answered.
 */
function upload(
  body: FormData,
  onProgress: (percent: number) => void,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve) => {
    const request = new XMLHttpRequest();
    request.open('POST', '/api/v1/admin/listings');
    request.responseType = 'json';
    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) onProgress((event.loaded / event.total) * 100);
    });
    request.addEventListener('load', () => resolve({ status: request.status, body: request.response }));
    for (const failure of ['error', 'abort', 'timeout'] as const) {
      request.addEventListener(failure, () => resolve({ status: 0, body: null }));
    }
    request.send(body);
  });
}

/**
 * The new listing form (design system §10.9): photos by "Choose photos" (the primary path) or by dropping
 * them on the zone (WCAG 2.5.7 keeps dragging optional), checked here before anything is sent, then the
 * upload with its progress and the job page once api accepts it (202).
 */
export function ListingUploadForm() {
  const router = useRouter();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [chosen, setChosen] = useState<Chosen[]>([]);
  const [problems, setProblems] = useState<string[]>([]);
  const [hints, setHints] = useState('');
  const [dragging, setDragging] = useState(false);
  const [state, setState] = useState<UploadState>({ kind: 'idle' });
  const uploading = state.kind === 'uploading';
  const ready = chosen.length > 0 && !uploading;

  // Object URLs live as long as their thumbnail.
  const urls = useRef(new Set<string>());
  useEffect(() => {
    const live = urls.current;
    return () => {
      for (const url of live) URL.revokeObjectURL(url);
    };
  }, []);

  function choose(files: readonly File[]) {
    if (uploading || files.length === 0) return;
    const result = addFiles(
      chosen.map((entry) => entry.file),
      files,
    );
    const next = result.files.map((file) => {
      const existing = chosen.find((entry) => entry.file === file);
      if (existing) return existing;
      const url = URL.createObjectURL(file);
      urls.current.add(url);
      measure(file, url);
      return { file, url };
    });
    setChosen(next);
    setProblems(result.problems);
    if (state.kind === 'failed') setState({ kind: 'idle' });
    // One announcement for the whole choice, what was refused included: a second one would cut off the first.
    const said = choiceAnnouncement(next.length - chosen.length, next.length, result.problems);
    if (said !== null) announce(said);
  }

  /** Decodes a chosen photo from its object URL for its size, which the note about small photos needs. */
  function measure(file: File, url: string) {
    const image = new Image();
    image.addEventListener('load', () => {
      const note = resolutionNote(file.name, image.naturalWidth, image.naturalHeight);
      setChosen((current) => current.map((entry) => (entry.url === url ? { ...entry, note } : entry)));
    });
    image.src = url;
  }

  function remove(index: number) {
    const entry = chosen[index];
    if (!entry || uploading) return;
    URL.revokeObjectURL(entry.url);
    urls.current.delete(entry.url);
    setChosen(chosen.filter((_, at) => at !== index));
    setProblems([]);
    announce(`Photo ${index + 1} removed.`);
    // Focus stays in the list: on the next photo's remove button, or the chooser when none is left.
    requestAnimationFrame(() => {
      const buttons = document.querySelectorAll<HTMLButtonElement>(`[data-remove-photo="${id}"]`);
      const next = buttons[Math.min(index, buttons.length - 1)];
      (next ?? input.current?.closest('form')?.querySelector<HTMLElement>('[data-choose]'))?.focus();
    });
  }

  async function generate() {
    if (!ready) return;
    const body = new FormData();
    for (const { file } of chosen) body.append('images', file, file.name);
    if (hints.trim() !== '') body.append('hints', hints);
    setState({ kind: 'uploading', percent: 0 });
    const result = await upload(body, (percent) => setState({ kind: 'uploading', percent }));
    const accepted = result.status === 202 ? CreateListingResponse.safeParse(result.body) : null;
    if (accepted?.success) {
      // The upload is done; the job page shows the generation from here.
      setState({ kind: 'uploading', percent: 100 });
      router.push(`/admin/listings/${accepted.data.jobId}`);
      return;
    }
    const message = uploadFailure(
      result.status,
      typeof result.body === 'object' ? (result.body as { code?: unknown; errors?: unknown } | null) : null,
      chosen.map((entry) => entry.file.name),
    );
    setState({ kind: 'failed', message, warning: result.status === 429 });
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    choose([...event.dataTransfer.files]);
  }

  const percent = state.kind === 'uploading' ? Math.round(state.percent) : 0;
  const statusId = `${id}-status`;
  const problemsId = `${id}-problems`;
  const notesId = `${id}-notes`;
  const notes = chosen.flatMap((entry) => (entry.note ? [entry.note] : []));
  const describedBy =
    [chosen.length === 0 && `${id}-needs`, problems.length > 0 && problemsId, notes.length > 0 && notesId]
      .filter(Boolean)
      .join(' ') || undefined;

  return (
    <form
      className="mt-8 flex max-w-text flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        void generate();
      }}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/noNoninteractiveElementInteractions: dropping is an extra path; "Choose photos" is the control (WCAG 2.5.7). */}
      <div
        onDragEnter={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={onDrop}
        className={cx(
          'flex min-h-60 flex-col items-center justify-center rounded-lg border-2 border-dashed bg-surface px-6 py-10 text-center',
          'transition-colors duration-200 ease-standard',
          dragging ? 'border-accent bg-accent-tint' : 'border-control',
        )}
      >
        <ImageUp size={40} strokeWidth={1.5} className="text-label-tertiary" />
        <p className="mt-3 flex flex-wrap items-center justify-center gap-x-3 gap-y-2 text-body">
          <span>Drag photos here or</span>
          <Button variant="tinted" data-choose disabled={uploading} onClick={() => input.current?.click()}>
            Choose photos
          </Button>
        </p>
        <p className="mt-3 text-footnote text-label-secondary">
          JPEG, PNG or WebP · up to 8 MB each · 1 to {LISTING_UPLOAD_LIMITS.maxImages} photos
        </p>
        <input
          ref={input}
          type="file"
          accept={ACCEPT}
          multiple
          tabIndex={-1}
          aria-hidden="true"
          className="sr-only"
          onChange={(event) => {
            choose([...(event.currentTarget.files ?? [])]);
            // The same file can be chosen again after it was removed.
            event.currentTarget.value = '';
          }}
        />
      </div>

      {problems.length > 0 && (
        <ul id={problemsId} className="-mt-2 flex flex-col gap-1">
          {problems.map((problem) => (
            <li key={problem} className="flex items-start gap-1.5 text-footnote text-danger">
              <CircleAlert size={16} className="mt-px shrink-0" />
              {problem}
            </li>
          ))}
        </ul>
      )}

      {chosen.length > 0 && (
        <div>
          <ul aria-label="Chosen photos" className="flex flex-wrap gap-4">
            {chosen.map((entry, index) => (
              <li key={entry.url} className="relative size-30 overflow-clip rounded-md bg-bg-secondary">
                <img src={entry.url} alt={entry.file.name} className="size-full object-cover" />
                {/* Controls never sit on a photo directly: the button floats on a material (§1.1, §2.5). */}
                <span className="material-thick absolute top-1.5 right-1.5 rounded-full">
                  <IconButton
                    label={`Remove photo ${index + 1}`}
                    icon={Trash}
                    size="sm"
                    data-remove-photo={id}
                    disabled={uploading}
                    onClick={() => remove(index)}
                  />
                </span>
              </li>
            ))}
          </ul>
          {notes.length > 0 && (
            // Advice, not a refusal: the photos still upload, so it is quiet and isn't announced.
            <ul id={notesId} className="mt-3 flex flex-col gap-1">
              {notes.map((note) => (
                <li key={note} className="flex items-start gap-1.5 text-footnote text-label-secondary">
                  <TriangleAlert size={16} className="mt-px shrink-0 text-warning" />
                  {note}
                </li>
              ))}
            </ul>
          )}
          {uploading && <ProgressBar value={percent} labelledBy={statusId} className="mt-4 max-w-120" />}
        </div>
      )}

      <TextAreaField
        id={`${id}-hints`}
        label="Notes for the generator (optional)"
        helper="For example the size, or what's in the box. Treated as hints, not instructions."
        value={hints}
        maxLength={LISTING_UPLOAD_LIMITS.maxHintsLength}
        counter={{ count: hints.length, max: LISTING_UPLOAD_LIMITS.maxHintsLength }}
        disabled={uploading}
        onChange={(event) => setHints(event.currentTarget.value)}
      />

      {state.kind === 'failed' && (
        <Banner tone={state.warning ? 'warning' : 'danger'} alert className="animate-fade-in">
          {state.message}
        </Banner>
      )}

      <div>
        <Button
          type="submit"
          size="lg"
          icon={Sparkles}
          disabled={chosen.length === 0}
          loading={uploading}
          reserve={['Generate listing', 'Uploading… 100%']}
          aria-describedby={describedBy}
        >
          <span id={statusId}>{uploading ? `Uploading… ${percent}%` : 'Generate listing'}</span>
        </Button>
        {chosen.length === 0 && (
          <p id={`${id}-needs`} className="mt-2 text-footnote text-label-secondary">
            Choose at least one photo.
          </p>
        )}
      </div>
    </form>
  );
}
