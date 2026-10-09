import { redirect } from 'next/navigation';

/** `/admin` has no page of its own: the drops list is where admin starts (design system §10.7). */
export default function AdminIndex() {
  redirect('/admin/drops');
}
