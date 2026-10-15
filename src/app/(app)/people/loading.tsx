import { ScreenSkeleton } from '@/components/screen/screen-skeleton';

// People (Lekiu) has its own layout, so the app-level (app)/loading.tsx boundary
// sits above the shared layout for navigations between People pages and can't fall
// back there. This boundary gives those navigations the same skeleton.
export default function Loading() {
  return <ScreenSkeleton />;
}
