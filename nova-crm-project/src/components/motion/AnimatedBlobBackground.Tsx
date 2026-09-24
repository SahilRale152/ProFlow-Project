import { useEffect, useRef } from "react";
import gsap from "gsap";

/**
 * Soft, slow-moving beige/caramel blobs drifting behind a hero or auth
 * panel. Purely decorative — pointer-events are disabled. Built with GSAP
 * timelines (rather than Framer Motion) to demonstrate a continuous,
 * scroll-independent ambient animation.
 */
export function AnimatedBlobBackground() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const blobs = el.querySelectorAll<HTMLDivElement>("[data-blob]");
    const tweens = Array.from(blobs).map((blob, i) =>
      gsap.to(blob, {
        x: `random(-40, 40)`,
        y: `random(-30, 30)`,
        duration: 8 + i * 2,
        repeat: -1,
        yoyo: true,
        ease: "sine.inOut",
      }),
    );

    return () => {
      tweens.forEach((t) => t.kill());
    };
  }, []);

  return (
    <div ref={containerRef} aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      <div
        data-blob
        className="absolute -left-24 -top-24 h-72 w-72 rounded-full opacity-40 blur-3xl"
        style={{ background: "radial-gradient(circle, #cf9e4e, transparent 70%)" }}
      />
      <div
        data-blob
        className="absolute right-[-6rem] top-1/3 h-80 w-80 rounded-full opacity-30 blur-3xl"
        style={{ background: "radial-gradient(circle, #a97142, transparent 70%)" }}
      />
      <div
        data-blob
        className="absolute bottom-[-6rem] left-1/3 h-64 w-64 rounded-full opacity-30 blur-3xl"
        style={{ background: "radial-gradient(circle, #8a9a5b, transparent 70%)" }}
      />
    </div>
  );
}