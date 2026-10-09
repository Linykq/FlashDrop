import Image from 'next/image';
import { cx } from '../../lib/cx';

const sizeClass = {
  /** Table rows (§10.8). */
  sm: 'size-10 rounded-sm',
  /** A drop's title row (§10.8). */
  md: 'size-14 rounded-md',
} as const;

/**
 * A product's first photo as a square thumbnail, on a well while it decodes (§6.4 Images), or with none. The
 * well is a translucent fill rather than `bg-secondary`: thumbnails sit on `surface` cards, which are the same
 * colour as `bg-secondary` in dark mode, so an empty well vanished and left only a gap. Decorative: the title
 * beside it names the product. Keys are api's content addresses under `/uploads`.
 */
export function ProductThumb({
  imageKey,
  size = 'sm',
  className,
}: {
  imageKey: string | undefined;
  size?: keyof typeof sizeClass;
  className?: string;
}) {
  return (
    <span
      className={cx('relative block shrink-0 overflow-clip bg-fill-tertiary', sizeClass[size], className)}
    >
      {imageKey && (
        <Image
          src={`/uploads/${imageKey}`}
          alt=""
          fill
          sizes={size === 'sm' ? '40px' : '56px'}
          className="object-cover"
        />
      )}
    </span>
  );
}
