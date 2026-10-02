import { LoaderCircle } from 'lucide-react';

/**
 * The activity indicator. Decorative: the control or region that owns it announces the busy state. It keeps
 * spinning under reduced motion, because it is the only signal of progress (§6.5).
 */
export function Spinner({ size = 16 }: { size?: 16 | 20 }) {
  return <LoaderCircle size={size} className="shrink-0 animate-spin" />;
}
