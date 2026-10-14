'use client';

import { useRef } from 'react';
import { cn } from '@/lib/utils';
import { useAnimeEffect } from './use-anime-effect';

type GridFieldProps = {
  cols: number;
  rows: number;
  className?: string;
};

/**
 * Decorative field of dots that ripples outward from a random cell, over and
 * over. Purely ambient: hidden from assistive tech and still under reduced motion.
 */
export function GridField({ cols, rows, className }: GridFieldProps) {
  const root = useRef<HTMLDivElement>(null);

  useAnimeEffect(({ animate, stagger, utils }) => {
    const el = root.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const cells = el.querySelectorAll<HTMLElement>('[data-cell]');
    let alive = true;
    let current: ReturnType<typeof animate> | null = null;

    const ripple = () => {
      if (!alive) return;
      current = animate(cells, {
        scale: [{ to: 2.4, duration: 380 }, { to: 1, duration: 620 }],
        opacity: [{ to: 0.95, duration: 380 }, { to: 0.16, duration: 620 }],
        ease: 'inOutQuad',
        delay: stagger(42, {
          grid: [cols, rows],
          from: utils.random(0, cols * rows - 1),
        }),
        onComplete: ripple,
      });
    };
    ripple();

    return () => {
      alive = false;
      current?.revert();
    };
  }, [cols, rows]);

  return (
    <div
      ref={root}
      aria-hidden
      className={cn('pointer-events-none grid', className)}
      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
    >
      {Array.from({ length: cols * rows }, (_, i) => (
        <span key={i} className="grid aspect-square place-items-center">
          <span
            data-cell
            className="size-[3px] rounded-full bg-mk-accent opacity-[0.16]"
          />
        </span>
      ))}
    </div>
  );
}
