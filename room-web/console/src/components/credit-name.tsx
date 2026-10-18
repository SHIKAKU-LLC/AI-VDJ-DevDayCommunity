import { useEffect, useMemo, useState } from "react";
import { useReducedMotion } from "../hooks/use-reduced-motion";

const CHARACTER_MS = 50;
const REFRESH_MS = 64;
const SWEEP_MARGIN = 10;
const segmenter = new Intl.Segmenter("ja", { granularity: "grapheme" });

export function CreditName({ name }: { name: string }) {
  const reducedMotion = useReducedMotion();
  const [elapsed, setElapsed] = useState(0);
  const letters = useMemo(
    () => Array.from(segmenter.segment(name), ({ segment }) => segment),
    [name],
  );

  useEffect(() => {
    if (reducedMotion) return;
    // A shared monotonic clock keeps the sweep moving when the credited name changes.
    const refresh = () => setElapsed(performance.now());
    refresh();
    const timer = window.setInterval(refresh, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [reducedMotion]);

  const center = Math.floor(elapsed / CHARACTER_MS) % (letters.length + SWEEP_MARGIN * 2) - SWEEP_MARGIN;

  return (
    <strong className="stage-credit-name" title={name}>
      <span className="sr-only">{name}</span>
      <span className="stage-credit-text" aria-hidden="true">
        {letters.map((letter, index) => (
          <span
            key={index}
            className="stage-credit-letter"
            data-tone={index % 7}
            data-highlighted={!reducedMotion && Math.abs(index - center) <= 1}
          >
            {letter}
          </span>
        ))}
      </span>
    </strong>
  );
}
