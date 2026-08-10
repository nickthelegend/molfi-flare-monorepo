// GSAP ships its types as a GLOBAL namespace plus `GSAP*` aliases; it does not
// export `gsap` as a TS namespace, so `import type { gsap as GsapType }` gave
// "Cannot find namespace 'GsapType'" on every use. Use the globals.
import { ensureGsapPlugins, gsap } from "@/lib/animation/gsap-config";
import { prefersReducedMotion } from "@/lib/animation/counter";

export const fadeUpPreset = {
  y: 14,
  opacity: 0,
  duration: 0.55,
  ease: "power2.out",
} as const;

export const fadeInPreset = {
  opacity: 0,
  duration: 0.4,
  ease: "power1.out",
} as const;

export function revealFromHidden(
  targets: GSAPTweenTarget,
  preset: typeof fadeUpPreset | typeof fadeInPreset = fadeUpPreset,
  overrides: GSAPTweenVars = {},
): GSAPTween | null {
  ensureGsapPlugins();

  if (prefersReducedMotion()) {
    gsap.set(targets, { clearProps: "all", opacity: 1, y: 0 });
    return null;
  }

  const y = (overrides.y ?? ("y" in preset ? preset.y : 0)) as number;
  const { y: _y, ...restOverrides } = overrides;

  return gsap.fromTo(
    targets,
    { opacity: 0, y },
    {
      opacity: 1,
      y: 0,
      duration: preset.duration,
      ease: preset.ease,
      ...restOverrides,
    },
  );
}

export function staggerReveal(
  targets: GSAPTweenTarget,
  overrides: GSAPTweenVars = {},
): GSAPTween | null {
  return revealFromHidden(targets, fadeUpPreset, {
    stagger: 0.07,
    ...overrides,
  });
}
