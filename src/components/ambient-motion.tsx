"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type MotionContextValue = {
  paused: boolean;
  allowed: boolean;
  available: boolean;
  reduced: boolean;
  toggle: () => void;
};

const MotionContext = createContext<MotionContextValue>({
  paused: false,
  allowed: true,
  available: true,
  reduced: false,
  toggle: () => undefined,
});

const SESSION_KEY = "useomnis-ambient-motion-paused";

function getConnection() {
  if (typeof navigator === "undefined") return undefined;
  return (navigator as Navigator & {
    connection?: { saveData?: boolean; effectiveType?: string };
  }).connection;
}

export function MotionProvider({ children }: { children: ReactNode }) {
  const [paused, setPaused] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    const storedPauseTimer = window.setTimeout(() => {
      try {
        setPaused(window.sessionStorage.getItem(SESSION_KEY) === "true");
      } catch {
        // Storage can be unavailable in privacy-restricted contexts.
      }
    }, 0);

    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const transparency = window.matchMedia(
      "(prefers-reduced-transparency: reduce)",
    );
    const colors = window.matchMedia("(forced-colors: active)");
    const connection = getConnection();

    const sync = () => {
      const slowConnection = ["slow-2g", "2g"].includes(
        connection?.effectiveType ?? "",
      );
      setReduced(motion.matches);
      setBlocked(
        transparency.matches ||
          colors.matches ||
          connection?.saveData === true ||
          slowConnection,
      );
    };

    sync();
    motion.addEventListener("change", sync);
    transparency.addEventListener("change", sync);
    colors.addEventListener("change", sync);
    return () => {
      window.clearTimeout(storedPauseTimer);
      motion.removeEventListener("change", sync);
      transparency.removeEventListener("change", sync);
      colors.removeEventListener("change", sync);
    };
  }, []);

  const toggle = useCallback(() => {
    setPaused((current) => {
      const next = !current;
      try {
        window.sessionStorage.setItem(SESSION_KEY, String(next));
      } catch {
        // Keep the control functional even when storage is unavailable.
      }
      return next;
    });
  }, []);

  const value = useMemo(
    () => ({
      paused,
      allowed: !paused && !reduced && !blocked,
      available: !reduced && !blocked,
      reduced,
      toggle,
    }),
    [blocked, paused, reduced, toggle],
  );

  return (
    <MotionContext.Provider value={value}>{children}</MotionContext.Provider>
  );
}

export function useAmbientMotion() {
  return useContext(MotionContext);
}

export function AmbientMotionToggle() {
  const { paused, allowed, available, toggle } = useAmbientMotion();
  if (!available) return null;

  return (
    <button
      type="button"
      className="ambient-motion-toggle"
      aria-pressed={paused}
      data-motion-toggle
      data-motion-state={allowed ? "playing" : "paused"}
      onClick={toggle}
    >
      <span className="ambient-motion-toggle-dot" aria-hidden="true" />
      {paused ? "play ambient motion" : "pause ambient motion"}
    </button>
  );
}

type AmbientVideoProps = {
  variant: "hero" | "cta";
};

export function AmbientVideo({ variant }: AmbientVideoProps) {
  const { allowed } = useAmbientMotion();
  const layerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [nearby, setNearby] = useState(false);
  const [attached, setAttached] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    const observer = new IntersectionObserver(
      ([entry]) => setNearby(entry.isIntersecting),
      { rootMargin: "180px" },
    );
    observer.observe(layer);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !allowed || !nearby || attached || failed) return;

    const attach = () => {
      const mobile = window.matchMedia("(max-width: 767px)").matches;
      video.src = mobile
        ? "/media/omnis-galaxy-loop-mobile.mp4"
        : "/media/omnis-galaxy-loop.mp4";
      video.dataset.motionSource = mobile ? "mobile" : "native";
      video.load();
      setAttached(true);
      void video.play().catch(() => setFailed(true));
    };

    if ("requestIdleCallback" in window) {
      const idle = window.requestIdleCallback(attach, { timeout: 900 });
      return () => window.cancelIdleCallback(idle);
    }
    const timer = globalThis.setTimeout(attach, 120);
    return () => globalThis.clearTimeout(timer);
  }, [allowed, attached, failed, nearby]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const sync = () => {
      if (!allowed || !nearby || document.hidden || failed) {
        video.pause();
        return;
      }
      if (attached) void video.play().catch(() => setFailed(true));
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, [allowed, attached, failed, nearby]);

  return (
    <div
      ref={layerRef}
      className={`ambient-video-layer ambient-video-${variant}`}
      data-motion-video={variant}
      data-motion-state={failed ? "poster" : allowed && nearby ? "playing" : "poster"}
      aria-hidden="true"
    >
      <video
        ref={videoRef}
        className="ambient-video"
        muted
        loop
        playsInline
        preload="none"
        poster="/media/omnis-galaxy-poster.webp"
        tabIndex={-1}
        onError={() => setFailed(true)}
      />
      <span className="ambient-video-veil" />
    </div>
  );
}
