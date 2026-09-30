import { useEffect, useRef, useState } from "react";
import { CharacterEngine, NilaCharacter } from "./character";
import type { CharacterSnapshot } from "./character";
import { ONBOARDING } from "./lib/strings";

/**
 * Nila companion window: a floating, transparent window showing the
 * character. Click the character for a greeting; the full reminder
 * bubble experience lands in Phase 8.
 */
export default function App() {
  const engineRef = useRef<CharacterEngine | null>(null);
  if (!engineRef.current) engineRef.current = new CharacterEngine();
  const [snap, setSnap] = useState<CharacterSnapshot>(() => engineRef.current!.snapshot());
  const [greeted, setGreeted] = useState(false);

  useEffect(() => {
    const engine = engineRef.current!;
    const off = engine.onChange(setSnap);
    // First-launch greeting: the character waves hello.
    const t = setTimeout(() => {
      engine.wave();
      setGreeted(true);
      setTimeout(() => engine.returnToIdle(), 2500);
    }, 600);
    return () => {
      off();
      clearTimeout(t);
    };
  }, []);

  const handleClick = () => {
    const engine = engineRef.current!;
    engine.wave();
    setTimeout(() => engine.returnToIdle(), 1800);
  };

  const dark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;

  return (
    <div
      className="companion"
      onClick={handleClick}
      onDoubleClick={() => engineRef.current!.playAnimation("happy-bounce")}
      role="button"
      aria-label="നില"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") handleClick();
      }}
    >
      <NilaCharacter
        state={snap.state}
        animation={snap.animation}
        size={snap.size}
        dark={dark}
      />
      {greeted && snap.state === "waving" && (
        <div className="bubble" role="status">
          {ONBOARDING.hello}
        </div>
      )}
    </div>
  );
}
