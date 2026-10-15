import { ImageUp } from 'lucide-react';
import { type ChangeEvent, useId, useState } from 'react';
import { cn } from '../lib/utils';

export const IMAGE_TYPES = ['image/png', 'image/svg+xml', 'image/jpeg', 'image/webp'];
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

export interface PickedImage {
  file: File;
  /** A data: URL for previews (the CSP allows data: images, not blob: ones). */
  dataUrl: string;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * A labelled file input for badge images and logos. It checks the type and size before upload
 * (the server checks the file's bytes again) and shows the chosen image.
 */
export function ImagePicker({
  label,
  description,
  currentUrl,
  picked,
  onPick,
  error,
  readOnly,
  alt,
  className,
}: {
  label: string;
  description?: string;
  /** The image already saved (128 or 512 px URL). */
  currentUrl: string | null;
  picked: PickedImage | null;
  onPick: (image: PickedImage | null) => void;
  error?: string;
  readOnly?: boolean;
  /** Text alternative for the preview. */
  alt: string;
  className?: string;
}) {
  const id = useId();
  const [localError, setLocalError] = useState<string | null>(null);
  const shown = picked?.dataUrl ?? currentUrl;
  const message = localError ?? error;

  async function onChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    setLocalError(null);
    if (!file) return;
    if (file.type && !IMAGE_TYPES.includes(file.type)) {
      setLocalError('Choose a PNG, SVG, JPEG or WebP image.');
      onPick(null);
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setLocalError('The image is larger than 2 MB.');
      onPick(null);
      return;
    }
    onPick({ file, dataUrl: await readAsDataUrl(file) });
  }

  const describedBy = [`${id}-hint`, message && `${id}-error`].filter(Boolean).join(' ');
  return (
    <div className={cn('grid gap-2', className)}>
      {readOnly ? (
        <p className="text-sm leading-none font-semibold text-foreground">{label}</p>
      ) : (
        <label htmlFor={id} className="text-sm leading-none font-semibold text-foreground">
          {label}
        </label>
      )}
      <p id={`${id}-hint`} className="text-sm text-muted-foreground">
        {description ?? 'PNG, SVG, JPEG or WebP, up to 2 MB.'}
      </p>
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex size-24 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-muted">
          {shown ? (
            <img src={shown} alt={alt} className="size-full object-contain" />
          ) : (
            <ImageUp className="size-8 text-muted-foreground" aria-hidden="true" />
          )}
        </div>
        {!readOnly && (
          <input
            id={id}
            type="file"
            accept={IMAGE_TYPES.join(',')}
            onChange={onChange}
            aria-describedby={describedBy}
            aria-invalid={message ? true : undefined}
            className="max-w-full text-sm text-muted-foreground file:mr-3 file:h-9 file:cursor-pointer file:rounded-md file:border file:border-input file:bg-card file:px-3 file:text-sm file:font-semibold file:text-foreground hover:file:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          />
        )}
      </div>
      {message && (
        <p id={`${id}-error`} className="text-sm font-medium text-destructive">
          {message}
        </p>
      )}
    </div>
  );
}
